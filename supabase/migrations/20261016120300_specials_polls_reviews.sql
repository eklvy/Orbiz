-- Phase 5 · Daily specials (F12), polls for tomorrow's special, reviews and the outlet leaderboard
-- (F16), and "popular with your classmates" (F26, D-9: aggregates only, k ≥ 5 students).
--
-- D-16: a special's discount is configured by the manager, never hardcoded. Special prices are
-- computed by the server (one SQL definition used by the menu, the cart and order creation) and
-- portions are reserved atomically with the order, like stock.

-- ---------------------------------------------------------------------------
-- Daily specials
-- ---------------------------------------------------------------------------
create table public.daily_specials (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  menu_item_id uuid not null,
  special_date date not null,
  discount_percent smallint not null constraint daily_specials_discount_range check (discount_percent between 1 and 90),
  portions_total integer not null constraint daily_specials_portions_range check (portions_total between 1 and 1000),
  portions_left integer not null,
  headline text constraint daily_specials_headline_length check (char_length(headline) <= 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (menu_item_id, outlet_id) references public.menu_items (id, outlet_id) on delete cascade,
  unique (menu_item_id, special_date),
  constraint daily_specials_portions_left check (portions_left between 0 and portions_total)
);
create index daily_specials_outlet_idx on public.daily_specials (outlet_id, special_date);
create index daily_specials_created_by_idx on public.daily_specials (created_by);
create trigger daily_specials_set_updated_at
  before update on public.daily_specials
  for each row execute function private.set_updated_at();

alter table public.order_items
  add column special_id uuid references public.daily_specials (id) on delete set null;
create index order_items_special_idx on public.order_items (special_id);

-- Today's special for an item (outlet-local date): the discounted unit price in integer paise
-- (rounded half up, at least 1 paisa) and the portions left. No row = no special.
create function app.item_special(p_menu_item_id uuid)
returns table (special_id uuid, unit_price_paise integer, discount_percent integer, portions_left integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.id,
         greatest(1, (m.price_paise * (100 - s.discount_percent) + 50) / 100),
         s.discount_percent::integer, s.portions_left
  from public.menu_items m
  join public.outlets o on o.id = m.outlet_id
  join public.daily_specials s on s.menu_item_id = m.id
   and s.special_date = (now() at time zone o.timezone)::date
  where m.id = p_menu_item_id;
$$;

-- ---------------------------------------------------------------------------
-- Order creation with specials (replaces Phase 2's): a line for today's special is priced at the
-- special price and takes portions from it, in the same transaction as stock and slot.
-- Lock order: outlet → inventory/special rows (by item id) → slot → order.
-- ---------------------------------------------------------------------------
create or replace function app.create_order(
  p_outlet_id uuid,
  p_pickup_slot_id uuid,
  p_items jsonb,
  p_idempotency_key text,
  p_request_hash text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_existing record;
  v_outlet public.outlets;
  v_slot public.pickup_slots;
  v_order_id uuid := gen_random_uuid();
  v_line record;
  v_special record;
  v_unit integer;
  v_special_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_subtotal integer := 0;
  v_count integer := 0;
  v_max_prep integer := 0;
  v_qty_after integer;
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in to place an order');
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then
    perform private.fail(422, 'invalid_idempotency_key', 'Idempotency key must be 8–100 characters');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_idempotency_key, 0));
  select id, request_hash into v_existing
  from public.orders where user_id = v_user and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash is distinct from p_request_hash then
      perform private.fail(409, 'idempotency_key_reused',
        'This idempotency key was already used for a different order');
    end if;
    return v_existing.id;
  end if;

  if (select count(*) from public.orders where user_id = v_user and status = 'payment_pending') >= 3 then
    perform private.fail(409, 'too_many_pending_orders',
      'Finish or cancel your unpaid orders before placing another');
  end if;

  select * into v_outlet from public.outlets where id = p_outlet_id for share;
  if not found or not v_outlet.is_active then
    perform private.fail(404, 'outlet_not_found', 'Outlet not found');
  end if;
  if not private.outlet_accepting_orders(v_outlet) then
    perform private.fail(409, 'outlet_not_accepting_orders',
      coalesce('Outlet is not accepting orders: ' || v_outlet.status_reason, 'Outlet is not accepting orders right now'));
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' then
    perform private.fail(422, 'invalid_items', 'Items must be a list');
  end if;
  if jsonb_array_length(p_items) not between 1 and 20 then
    perform private.fail(422, 'invalid_items', 'An order needs between 1 and 20 lines');
  end if;

  for v_line in
    with requested as (
      select (e ->> 'menu_item_id')::uuid as menu_item_id, (e ->> 'quantity')::integer as quantity
      from jsonb_array_elements(p_items) e
    ), aggregated as (
      select menu_item_id, sum(quantity)::integer as quantity
      from requested group by menu_item_id
    )
    select a.menu_item_id, a.quantity, m.id as item_id, m.outlet_id, m.name, m.price_paise,
           m.prep_minutes, m.manual_status, m.track_quantity, m.is_active
    from aggregated a
    left join public.menu_items m on m.id = a.menu_item_id
    order by a.menu_item_id
  loop
    if v_line.item_id is null or v_line.outlet_id <> p_outlet_id or not v_line.is_active then
      perform private.fail(422, 'item_not_found', 'An item in your order is not on this outlet''s menu');
    end if;
    if v_line.quantity is null or v_line.quantity not between 1 and 20 then
      perform private.fail(422, 'invalid_quantity', 'Quantity must be between 1 and 20 per item');
    end if;
    if v_line.manual_status = 'sold_out' then
      perform private.fail(409, 'item_unavailable', v_line.name || ' is sold out');
    end if;

    if v_line.track_quantity then
      update public.inventory
      set quantity_available = quantity_available - v_line.quantity
      where menu_item_id = v_line.item_id and quantity_available >= v_line.quantity
      returning quantity_available into v_qty_after;
      if not found then
        perform private.fail(409, 'insufficient_stock', 'Not enough ' || v_line.name || ' left');
      end if;
    else
      v_qty_after := null;
    end if;

    -- Today's special: atomic conditional decrement of its portions.
    v_unit := v_line.price_paise;
    v_special_id := null;
    select * into v_special from app.item_special(v_line.item_id);
    if v_special.special_id is not null then
      update public.daily_specials set portions_left = portions_left - v_line.quantity
      where id = v_special.special_id and portions_left >= v_line.quantity;
      if not found then
        perform private.fail(409, 'special_portions_left',
          format('Only %s special portion(s) of %s left today', v_special.portions_left, v_line.name));
      end if;
      v_unit := v_special.unit_price_paise;
      v_special_id := v_special.special_id;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id', v_line.item_id, 'name', v_line.name, 'unit_price', v_unit,
      'quantity', v_line.quantity, 'prep', v_line.prep_minutes,
      'tracked', v_line.track_quantity, 'qty_after', v_qty_after, 'special_id', v_special_id);
    v_subtotal := v_subtotal + v_unit * v_line.quantity;
    v_count := v_count + v_line.quantity;
    v_max_prep := greatest(v_max_prep, v_line.prep_minutes);
  end loop;

  select * into v_slot from public.pickup_slots
  where id = p_pickup_slot_id and outlet_id = p_outlet_id
  for update;
  if not found or not v_slot.is_active then
    perform private.fail(409, 'slot_unavailable', 'That pickup slot is not available');
  end if;
  if v_slot.starts_at < now() + make_interval(mins => v_max_prep) then
    perform private.fail(409, 'slot_too_soon', 'That pickup slot is too soon for the kitchen to prepare your order');
  end if;
  if v_slot.reserved_count >= v_slot.capacity then
    perform private.fail(409, 'slot_full', 'That pickup slot is full');
  end if;
  update public.pickup_slots set reserved_count = reserved_count + 1 where id = v_slot.id;

  insert into public.orders (
    id, user_id, outlet_id, pickup_slot_id, subtotal_paise, total_paise, item_count,
    idempotency_key, request_hash, reservation_expires_at
  ) values (
    v_order_id, v_user, p_outlet_id, p_pickup_slot_id, v_subtotal, v_subtotal, v_count,
    p_idempotency_key, p_request_hash, now() + make_interval(mins => v_outlet.reservation_ttl_minutes)
  );

  insert into public.order_items (order_id, menu_item_id, item_name, unit_price_paise, quantity, line_total_paise, prep_minutes, special_id)
  select v_order_id, (l ->> 'menu_item_id')::uuid, l ->> 'name', (l ->> 'unit_price')::integer,
         (l ->> 'quantity')::integer, (l ->> 'unit_price')::integer * (l ->> 'quantity')::integer, (l ->> 'prep')::smallint,
         (l ->> 'special_id')::uuid
  from jsonb_array_elements(v_lines) l;

  insert into public.inventory_movements (menu_item_id, outlet_id, delta, quantity_after, reason, order_id, actor_id)
  select (l ->> 'menu_item_id')::uuid, p_outlet_id, -(l ->> 'quantity')::integer, (l ->> 'qty_after')::integer,
         'order_reserved', v_order_id, v_user
  from jsonb_array_elements(v_lines) l
  where (l ->> 'tracked')::boolean;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id)
  values (v_order_id, 'created', null, 'payment_pending', 'student', v_user);

  delete from public.carts where user_id = v_user and outlet_id = p_outlet_id;
  return v_order_id;
end;
$$;

-- Releasing an order's stock also gives back its special portions.
create or replace function private.release_order_reservations(
  p_order public.orders, p_release_stock boolean, p_release_slot boolean, p_actor uuid
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  line record;
  qty_after integer;
begin
  if p_order.source_deal_id is not null then
    update public.surplus_deals set
      status = case when expires_at > now() then 'available'::public.surplus_deal_status else 'expired' end,
      reserved_order_id = null,
      closed_at = case when expires_at > now() then null else now() end,
      close_reason = case when expires_at > now() then null else 'Listing ended while a payment was pending' end,
      version = version + 1
    where id = p_order.source_deal_id and reserved_order_id = p_order.id;
    return;
  end if;

  if p_release_stock then
    for line in
      select oi.menu_item_id, sum(oi.quantity)::integer as quantity
      from public.order_items oi
      join public.menu_items m on m.id = oi.menu_item_id and m.track_quantity
      where oi.order_id = p_order.id
      group by oi.menu_item_id
      order by oi.menu_item_id
    loop
      update public.inventory
      set quantity_available = quantity_available + line.quantity
      where menu_item_id = line.menu_item_id
      returning quantity_available into qty_after;

      if found then
        insert into public.inventory_movements
          (menu_item_id, outlet_id, delta, quantity_after, reason, order_id, actor_id)
        values (line.menu_item_id, p_order.outlet_id, line.quantity, qty_after, 'order_released', p_order.id, p_actor);
      end if;
    end loop;

    update public.daily_specials s
    set portions_left = least(s.portions_total, s.portions_left + l.quantity)
    from (select special_id, sum(quantity)::integer as quantity from public.order_items
          where order_id = p_order.id and special_id is not null group by special_id) l
    where s.id = l.special_id;
  end if;

  if p_release_slot then
    update public.pickup_slots
    set reserved_count = reserved_count - 1
    where id = p_order.pickup_slot_id and reserved_count > 0;
  end if;
end;
$$;

-- Manager: create or change a special. Portions can't drop below those already sold.
create function app.save_special(
  p_outlet_id uuid, p_menu_item_id uuid, p_date date, p_discount integer, p_portions integer, p_headline text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_sold integer;
  v_today date;
  v_item text;
begin
  perform private.require_outlet_manager(p_outlet_id);
  select name into v_item from public.menu_items where id = p_menu_item_id and outlet_id = p_outlet_id and is_active;
  if v_item is null then
    perform private.fail(422, 'item_not_found', 'That item is not on this outlet''s menu');
  end if;
  select (now() at time zone timezone)::date into v_today from public.outlets where id = p_outlet_id;
  if p_date < v_today then
    perform private.fail(422, 'date_in_past', 'Specials can be set for today or later');
  end if;
  if p_discount is null or p_discount not between 1 and 90 then
    perform private.fail(422, 'invalid_discount', 'Discount must be 1–90%');
  end if;
  if p_portions is null or p_portions not between 1 and 1000 then
    perform private.fail(422, 'invalid_portions', 'Portions must be 1–1000');
  end if;

  select id, portions_total - portions_left into v_id, v_sold
  from public.daily_specials where menu_item_id = p_menu_item_id and special_date = p_date for update;
  if v_id is null then
    insert into public.daily_specials (outlet_id, menu_item_id, special_date, discount_percent, portions_total, portions_left, headline, created_by)
    values (p_outlet_id, p_menu_item_id, p_date, p_discount, p_portions, p_portions, nullif(btrim(p_headline), ''), auth.uid())
    returning id into v_id;
    -- Flash special for today: tell students who ordered here in the last 30 days.
    if p_date = v_today then
      insert into public.notifications (user_id, category, title, body, data)
      select distinct o.user_id, 'specials'::public.notification_category, 'Special today: ' || left(v_item, 90),
             p_discount || '% off, ' || p_portions || ' portions at ' || (select name from public.outlets where id = p_outlet_id),
             jsonb_build_object('outlet_id', p_outlet_id, 'special_id', v_id)
      from public.orders o
      where o.outlet_id = p_outlet_id and o.payment_status = 'paid' and o.created_at > now() - interval '30 days'
      limit 1000;
    end if;
  else
    if p_portions < v_sold then
      perform private.fail(409, 'portions_below_sold', format('%s portion(s) are already sold', v_sold));
    end if;
    update public.daily_specials set
      discount_percent = p_discount, portions_total = p_portions, portions_left = p_portions - v_sold,
      headline = nullif(btrim(p_headline), '')
    where id = v_id;
  end if;
  return v_id;
end;
$$;

create function app.delete_special(p_special_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_special public.daily_specials;
begin
  select * into v_special from public.daily_specials where id = p_special_id;
  if not found then
    perform private.fail(404, 'special_not_found', 'Special not found');
  end if;
  perform private.require_outlet_manager(v_special.outlet_id);
  if v_special.portions_left < v_special.portions_total then
    perform private.fail(409, 'special_has_sales', 'Portions were already sold; set portions to the number sold instead');
  end if;
  delete from public.daily_specials where id = p_special_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Polls for tomorrow's special (one vote per student; live counts; the manager decides)
-- ---------------------------------------------------------------------------
create type public.poll_status as enum ('open', 'closed', 'published');

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  question text not null constraint polls_question_length check (char_length(btrim(question)) between 3 and 200),
  status public.poll_status not null default 'open',
  closes_at timestamptz not null,
  -- What the winner becomes (D-16: manager-configured, not a hardcoded 20%).
  special_date date not null,
  special_discount_percent smallint not null constraint polls_discount_range check (special_discount_percent between 1 and 90),
  special_portions integer not null constraint polls_portions_range check (special_portions between 1 and 1000),
  winner_option_id uuid,
  special_id uuid references public.daily_specials (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index polls_outlet_idx on public.polls (outlet_id, created_at desc);
create index polls_special_idx on public.polls (special_id);
create index polls_created_by_idx on public.polls (created_by);
create trigger polls_set_updated_at
  before update on public.polls
  for each row execute function private.set_updated_at();

create table public.poll_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  -- Maintained by app.vote (a count, never who voted).
  vote_count integer not null default 0 constraint poll_options_votes_non_negative check (vote_count >= 0),
  sort_order smallint not null default 0,
  unique (poll_id, menu_item_id)
);
create index poll_options_poll_idx on public.poll_options (poll_id);
create index poll_options_item_idx on public.poll_options (menu_item_id);
alter table public.polls
  add constraint polls_winner_fk foreign key (winner_option_id) references public.poll_options (id) on delete set null;
create index polls_winner_idx on public.polls (winner_option_id);

create table public.poll_votes (
  poll_id uuid not null references public.polls (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  option_id uuid not null references public.poll_options (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id)
);
create index poll_votes_user_idx on public.poll_votes (user_id);
create index poll_votes_option_idx on public.poll_votes (option_id);

create function app.create_poll(
  p_outlet_id uuid, p_question text, p_menu_item_ids uuid[], p_closes_at timestamptz,
  p_special_date date, p_discount integer, p_portions integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_outlet_manager(p_outlet_id);
  if coalesce(array_length(p_menu_item_ids, 1), 0) not between 2 and 6 then
    perform private.fail(422, 'invalid_options', 'A poll needs 2–6 dishes');
  end if;
  if (select count(distinct x) from unnest(p_menu_item_ids) x) <> array_length(p_menu_item_ids, 1)
     or (select count(*) from public.menu_items where id = any(p_menu_item_ids) and outlet_id = p_outlet_id and is_active)
        <> array_length(p_menu_item_ids, 1) then
    perform private.fail(422, 'invalid_options', 'Choose different dishes from this outlet''s menu');
  end if;
  if p_closes_at <= now() or p_closes_at > now() + interval '14 days' then
    perform private.fail(422, 'invalid_close_time', 'Voting must close within the next 14 days');
  end if;
  if p_special_date < (p_closes_at at time zone (select timezone from public.outlets where id = p_outlet_id))::date then
    perform private.fail(422, 'invalid_special_date', 'The special must be on or after the day voting closes');
  end if;
  insert into public.polls (outlet_id, question, closes_at, special_date, special_discount_percent, special_portions, created_by)
  values (p_outlet_id, btrim(p_question), p_closes_at, p_special_date, p_discount, p_portions, auth.uid())
  returning id into v_id;
  insert into public.poll_options (poll_id, menu_item_id, sort_order)
  select v_id, item, ord::smallint from unnest(p_menu_item_ids) with ordinality as t(item, ord);
  return v_id;
exception when check_violation then
  perform private.fail(422, 'invalid_poll', 'Check the discount (1–90%) and portions (1–1000)');
end;
$$;

create function app.vote(p_poll_id uuid, p_option_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_poll public.polls;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in to vote');
  end if;
  select * into v_poll from public.polls where id = p_poll_id for share;
  if not found or not exists (select 1 from public.outlets where id = v_poll.outlet_id and is_active) then
    perform private.fail(404, 'poll_not_found', 'Poll not found');
  end if;
  if v_poll.status <> 'open' or v_poll.closes_at <= now() then
    perform private.fail(409, 'poll_closed', 'Voting has closed');
  end if;
  if not exists (select 1 from public.poll_options where id = p_option_id and poll_id = p_poll_id) then
    perform private.fail(422, 'option_not_found', 'That dish is not in this poll');
  end if;
  begin
    insert into public.poll_votes (poll_id, user_id, option_id) values (p_poll_id, auth.uid(), p_option_id);
  exception when unique_violation then
    perform private.fail(409, 'already_voted', 'You have already voted in this poll');
  end;
  update public.poll_options set vote_count = vote_count + 1 where id = p_option_id;
end;
$$;

-- Manager publishes the winner (default: most votes; the manager may pick another — the vote is a
-- guide, the decision is theirs) as a special on the poll's date. Voters are notified.
create function app.publish_poll_winner(p_poll_id uuid, p_option_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_poll public.polls;
  v_option public.poll_options;
  v_special uuid;
  v_item text;
begin
  select * into v_poll from public.polls where id = p_poll_id for update;
  if not found then
    perform private.fail(404, 'poll_not_found', 'Poll not found');
  end if;
  perform private.require_outlet_manager(v_poll.outlet_id);
  if v_poll.status = 'published' then
    perform private.fail(409, 'poll_published', 'This poll''s winner is already published');
  end if;
  if p_option_id is null then
    select * into v_option from public.poll_options where poll_id = p_poll_id
    order by vote_count desc, sort_order limit 1;
  else
    select * into v_option from public.poll_options where id = p_option_id and poll_id = p_poll_id;
  end if;
  if v_option.id is null then
    perform private.fail(422, 'option_not_found', 'That dish is not in this poll');
  end if;
  v_special := app.save_special(v_poll.outlet_id, v_option.menu_item_id, greatest(v_poll.special_date,
    (select (now() at time zone timezone)::date from public.outlets where id = v_poll.outlet_id)),
    v_poll.special_discount_percent, v_poll.special_portions, 'Chosen by students');
  update public.polls set status = 'published', winner_option_id = v_option.id, special_id = v_special
  where id = p_poll_id;
  select name into v_item from public.menu_items where id = v_option.menu_item_id;
  insert into public.notifications (user_id, category, title, body, data)
  select v.user_id, 'specials'::public.notification_category, 'Poll result: ' || left(v_item, 100),
         v_item || ' will be ' || v_poll.special_discount_percent || '% off on ' || to_char(v_poll.special_date, 'Dy DD Mon') || '.',
         jsonb_build_object('poll_id', p_poll_id, 'outlet_id', v_poll.outlet_id)
  from public.poll_votes v where v.poll_id = p_poll_id;
  return v_special;
end;
$$;

create function app.close_poll(p_poll_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outlet uuid;
begin
  select outlet_id into v_outlet from public.polls where id = p_poll_id;
  if v_outlet is null then
    perform private.fail(404, 'poll_not_found', 'Poll not found');
  end if;
  perform private.require_outlet_manager(v_outlet);
  update public.polls set status = 'closed' where id = p_poll_id and status = 'open';
end;
$$;

-- ---------------------------------------------------------------------------
-- Reviews (one per collected order, within 7 days; +15 points; staff reply as the outlet)
-- ---------------------------------------------------------------------------
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  taste smallint not null constraint reviews_taste check (taste between 1 and 5),
  hygiene smallint not null constraint reviews_hygiene check (hygiene between 1 and 5),
  speed smallint not null constraint reviews_speed check (speed between 1 and 5),
  value smallint not null constraint reviews_value check (value between 1 and 5),
  comment text constraint reviews_comment_length check (char_length(comment) <= 1000),
  reply text constraint reviews_reply_length check (char_length(reply) <= 1000),
  replied_by uuid references auth.users (id) on delete set null,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  constraint reviews_reply_consistent check ((reply is null) = (replied_at is null))
);
create index reviews_outlet_idx on public.reviews (outlet_id, created_at desc);
create index reviews_user_idx on public.reviews (user_id);
create index reviews_replied_by_idx on public.reviews (replied_by);

alter table public.loyalty_ledger
  add constraint loyalty_ledger_review_fk foreign key (review_id) references public.reviews (id) on delete restrict;
create index loyalty_ledger_review_idx on public.loyalty_ledger (review_id);
create unique index loyalty_ledger_once_per_review on public.loyalty_ledger (review_id) where reason = 'review';

create function app.submit_review(
  p_order_id uuid, p_taste integer, p_hygiene integer, p_speed integer, p_value integer, p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_id uuid;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id is distinct from auth.uid() then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.status <> 'completed' then
    perform private.fail(409, 'review_not_allowed', 'You can review an order after collecting it');
  end if;
  if v_order.completed_at < now() - interval '7 days' then
    perform private.fail(409, 'review_window_closed', 'Reviews are open for 7 days after pickup');
  end if;
  if exists (select 1 from public.reviews where order_id = p_order_id) then
    perform private.fail(409, 'already_reviewed', 'You already reviewed this order');
  end if;
  if p_taste not between 1 and 5 or p_hygiene not between 1 and 5 or p_speed not between 1 and 5
     or p_value not between 1 and 5 then
    perform private.fail(422, 'invalid_rating', 'Each rating is 1–5 stars');
  end if;
  insert into public.reviews (order_id, user_id, outlet_id, taste, hygiene, speed, value, comment)
  values (p_order_id, v_order.user_id, v_order.outlet_id, p_taste, p_hygiene, p_speed, p_value, nullif(btrim(p_comment), ''))
  returning id into v_id;
  perform private.loyalty_post(v_order.user_id, 15, 'review', p_order_id, null, null, v_id);
  return v_id;
exception when check_violation then
  perform private.fail(422, 'invalid_review', 'Comments are at most 1000 characters');
end;
$$;

create function app.reply_to_review(p_review_id uuid, p_reply text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_review public.reviews;
  v_reply text := nullif(btrim(p_reply), '');
begin
  select * into v_review from public.reviews where id = p_review_id for update;
  if not found or not (private.is_outlet_staff(v_review.outlet_id) or private.is_admin()) then
    perform private.fail(404, 'review_not_found', 'Review not found');
  end if;
  if v_reply is null or char_length(v_reply) > 1000 then
    perform private.fail(422, 'invalid_reply', 'Write a reply of up to 1000 characters');
  end if;
  update public.reviews set reply = v_reply, replied_by = auth.uid(), replied_at = now() where id = p_review_id;
  perform private.notify(v_review.user_id, 'orders', 'The kitchen replied to your review',
    left(v_reply, 200), jsonb_build_object('order_id', v_review.order_id, 'review_id', p_review_id));
end;
$$;

-- Public outlet leaderboard: averages per dimension and overall (aggregates only).
create function app.outlet_ratings()
returns table (outlet_id uuid, review_count integer, taste numeric, hygiene numeric, speed numeric, value numeric, overall numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select r.outlet_id, count(*)::integer,
         round(avg(r.taste), 2), round(avg(r.hygiene), 2), round(avg(r.speed), 2), round(avg(r.value), 2),
         round(avg((r.taste + r.hygiene + r.speed + r.value) / 4.0), 2)
  from public.reviews r join public.outlets o on o.id = r.outlet_id and o.is_active
  group by r.outlet_id;
$$;

-- ---------------------------------------------------------------------------
-- Popular with your classmates (D-9): items ordered by at least 5 different students in the last
-- 14 days — from your department if enough classmates ordered, otherwise campus-wide.
-- Returns counts only; never who ordered.
-- ---------------------------------------------------------------------------
create function app.popular_items(p_limit integer default 5)
returns table (menu_item_id uuid, item_name text, outlet_id uuid, outlet_name text, students integer, scope text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_department text;
begin
  select department into v_department from public.profiles where id = auth.uid();
  if v_department is not null then
    return query
      select m.id, m.name, o.id, o.name, count(distinct ord.user_id)::integer, 'department'::text
      from public.orders ord
      join public.profiles p on p.id = ord.user_id and p.department = v_department
      join public.order_items oi on oi.order_id = ord.id
      join public.menu_items m on m.id = oi.menu_item_id and m.is_active
      join public.outlets o on o.id = m.outlet_id and o.is_active
      where ord.payment_status = 'paid' and ord.created_at > now() - interval '14 days'
      group by m.id, m.name, o.id, o.name
      having count(distinct ord.user_id) >= 5
      order by 5 desc, 2 limit least(greatest(p_limit, 1), 20);
    if found then
      return;
    end if;
  end if;
  return query
    select m.id, m.name, o.id, o.name, count(distinct ord.user_id)::integer, 'campus'::text
    from public.orders ord
    join public.order_items oi on oi.order_id = ord.id
    join public.menu_items m on m.id = oi.menu_item_id and m.is_active
    join public.outlets o on o.id = m.outlet_id and o.is_active
    where ord.payment_status = 'paid' and ord.created_at > now() - interval '14 days'
    group by m.id, m.name, o.id, o.name
    having count(distinct ord.user_id) >= 5
    order by 5 desc, 2 limit least(greatest(p_limit, 1), 20);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on public.daily_specials, public.polls, public.poll_options, public.poll_votes, public.reviews
  from anon, authenticated;
grant select on public.daily_specials, public.polls, public.poll_options to anon, authenticated;
grant select on public.poll_votes to authenticated;
-- Reviews are public but anonymous: who wrote one (user_id) and which staff member replied are
-- not readable by clients.
grant select (id, order_id, outlet_id, taste, hygiene, speed, value, comment, reply, replied_at, created_at)
  on public.reviews to anon, authenticated;

alter table public.daily_specials enable row level security;
alter table public.polls enable row level security;
alter table public.poll_options enable row level security;
alter table public.poll_votes enable row level security;
alter table public.reviews enable row level security;

create policy daily_specials_select on public.daily_specials for select to anon, authenticated
  using (exists (select 1 from public.outlets o where o.id = outlet_id));
create policy polls_select on public.polls for select to anon, authenticated
  using (exists (select 1 from public.outlets o where o.id = outlet_id));
create policy poll_options_select on public.poll_options for select to anon, authenticated
  using (exists (select 1 from public.polls p where p.id = poll_id));
create policy poll_votes_select_own on public.poll_votes for select to authenticated
  using (user_id = (select auth.uid()));
create policy reviews_select on public.reviews for select to anon, authenticated
  using (exists (select 1 from public.outlets o where o.id = outlet_id));

revoke all on function
  app.item_special(uuid), app.save_special(uuid, uuid, date, integer, integer, text), app.delete_special(uuid),
  app.create_poll(uuid, text, uuid[], timestamptz, date, integer, integer), app.vote(uuid, uuid),
  app.publish_poll_winner(uuid, uuid), app.close_poll(uuid),
  app.submit_review(uuid, integer, integer, integer, integer, text), app.reply_to_review(uuid, text),
  app.outlet_ratings(), app.popular_items(integer)
from public;
grant execute on function app.item_special(uuid), app.outlet_ratings() to anon, authenticated, service_role;
grant execute on function
  app.save_special(uuid, uuid, date, integer, integer, text), app.delete_special(uuid),
  app.create_poll(uuid, text, uuid[], timestamptz, date, integer, integer), app.vote(uuid, uuid),
  app.publish_poll_winner(uuid, uuid), app.close_poll(uuid),
  app.submit_review(uuid, integer, integer, integer, integer, text), app.reply_to_review(uuid, text),
  app.popular_items(integer)
to authenticated, service_role;

-- Not reviews: Realtime would ship whole rows, including the reviewer's id that column grants hide.
alter publication supabase_realtime add table public.daily_specials, public.polls, public.poll_options;
