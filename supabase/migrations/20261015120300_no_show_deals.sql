-- Phase 4 · No-show policy (REQUIREMENTS.md D-19, decided by the product owner 2026-10-14).
--
-- A paid order that is ready but not collected by its pickup deadline (the later of "ready"
-- and "end of pickup slot", plus the outlet's grace period, default 15 min) becomes `no_show`:
--   * no refund for the student who ordered;
--   * packaged items (menu_items.is_packaged) go back into stock (ledger reason no_show_return);
--   * the prepared items become one surplus deal at the outlet's discount (default 50% off what
--     the student paid), listed for `deal_ttl_minutes` (default 30), then recorded as unsold.
-- Another student can buy the deal. Once their payment is verified, the deal order goes straight
-- to ready_for_pickup with a new token and pickup code, so the counter sees the new owner.
-- An uncollected deal order also becomes no_show, but is not listed again.
--
-- Lock order extends the Phase 2 rule: outlet → inventory (by item id) → pickup slot → order → deal.

create type public.surplus_deal_status as enum ('available', 'reserved', 'sold', 'expired', 'withdrawn');

create table public.surplus_deals (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  source_order_id uuid not null unique references public.orders (id) on delete restrict,
  status public.surplus_deal_status not null default 'available',
  discount_percent smallint not null constraint surplus_deals_discount_range check (discount_percent between 1 and 99),
  original_price_paise integer not null constraint surplus_deals_original_positive check (original_price_paise > 0),
  price_paise integer not null constraint surplus_deals_price_positive check (price_paise > 0),
  item_count integer not null constraint surplus_deals_item_count_positive check (item_count > 0),
  listed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- The unpaid order currently holding the deal, and the paid order that bought it.
  reserved_order_id uuid references public.orders (id) on delete set null,
  sold_order_id uuid references public.orders (id) on delete restrict,
  closed_at timestamptz,
  close_reason text constraint surplus_deals_close_reason_length check (char_length(close_reason) <= 300),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint surplus_deals_price_discounted check (price_paise <= original_price_paise),
  constraint surplus_deals_expiry_after_listing check (expires_at > listed_at),
  constraint surplus_deals_reserved_consistent check ((status = 'reserved') = (reserved_order_id is not null)),
  constraint surplus_deals_sold_consistent check ((status = 'sold') = (sold_order_id is not null)),
  constraint surplus_deals_closed_consistent check ((status in ('expired', 'withdrawn', 'sold')) = (closed_at is not null))
);

create index surplus_deals_outlet_idx on public.surplus_deals (outlet_id, listed_at desc);
create index surplus_deals_available_idx on public.surplus_deals (expires_at) where status = 'available';
create index surplus_deals_reserved_order_idx on public.surplus_deals (reserved_order_id);
create index surplus_deals_sold_order_idx on public.surplus_deals (sold_order_id);

create trigger surplus_deals_set_updated_at
  before update on public.surplus_deals
  for each row execute function private.set_updated_at();

create table public.surplus_deal_items (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references public.surplus_deals (id) on delete cascade,
  menu_item_id uuid references public.menu_items (id) on delete set null,
  item_name text not null,
  diet public.diet_type,
  quantity integer not null constraint surplus_deal_items_quantity_range check (quantity between 1 and 20),
  original_unit_price_paise integer not null constraint surplus_deal_items_original_positive check (original_unit_price_paise > 0),
  deal_unit_price_paise integer not null constraint surplus_deal_items_deal_positive check (deal_unit_price_paise > 0),
  constraint surplus_deal_items_discounted check (deal_unit_price_paise <= original_unit_price_paise)
);

create index surplus_deal_items_deal_idx on public.surplus_deal_items (deal_id);
create index surplus_deal_items_menu_item_idx on public.surplus_deal_items (menu_item_id);

-- Orders: a deal order has no pickup slot (the food is already at the counter).
alter table public.orders
  alter column pickup_slot_id drop not null,
  add column source_deal_id uuid references public.surplus_deals (id) on delete restrict,
  add column no_show_at timestamptz,
  add constraint orders_slot_or_deal check ((pickup_slot_id is null) <> (source_deal_id is null));

create index orders_source_deal_idx on public.orders (source_deal_id);
-- A deal can be paid for only once.
create unique index orders_one_paid_order_per_deal on public.orders (source_deal_id)
  where source_deal_id is not null and payment_status = 'paid';
create index orders_ready_idx on public.orders (outlet_id, ready_at) where status = 'ready_for_pickup';

-- Deal order lines never count as packaged (they come from the prepared part of an order).
create or replace function private.snapshot_order_item_packaging()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.orders o where o.id = new.order_id and o.source_deal_id is not null) then
    new.is_packaged := false;
  else
    new.is_packaged := coalesce(
      (select m.is_packaged from public.menu_items m where m.id = new.menu_item_id), false);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- State machine additions
-- ---------------------------------------------------------------------------
insert into public.order_status_transitions
  (from_status, to_status, actor, requires_paid, requires_reason, requires_pickup_code,
   releases_stock, releases_slot, marks_refund_required, description)
values
  ('ready_for_pickup', 'no_show', 'system', true, false, false, false, false, false,
   'Not collected by the pickup deadline: no refund; packaged items restocked, prepared items offered as a deal (app.process_no_shows only)'),
  ('payment_pending', 'ready_for_pickup', 'system', false, false, false, false, false, false,
   'Verified payment for a surplus deal; the food is already at the counter (app.confirm_order_payment only)');

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------
revoke all on public.surplus_deals, public.surplus_deal_items from anon, authenticated;
grant select on public.surplus_deals, public.surplus_deal_items to anon, authenticated;
alter table public.surplus_deals enable row level security;
alter table public.surplus_deal_items enable row level security;

-- Public: deals on sale at active outlets.
create policy surplus_deals_select_public on public.surplus_deals
  for select to anon, authenticated
  using (
    status = 'available' and expires_at > now()
    and exists (select 1 from public.outlets o where o.id = outlet_id and o.is_active)
  );

-- Staff of the outlet and admins see every deal; a buyer sees deals they hold or bought.
create policy surplus_deals_select_involved on public.surplus_deals
  for select to authenticated
  using (
    (select private.is_outlet_staff(outlet_id))
    or (select private.is_admin())
    or exists (select 1 from public.orders o where o.source_deal_id = surplus_deals.id and o.user_id = (select auth.uid()))
  );

create policy surplus_deal_items_select on public.surplus_deal_items
  for select to anon, authenticated
  using (exists (select 1 from public.surplus_deals d where d.id = deal_id));

-- ---------------------------------------------------------------------------
-- Reservations: a deal order holds the deal (not stock or a slot). Releasing it puts the deal
-- back on sale, or closes it if its listing time has passed meanwhile.
-- ---------------------------------------------------------------------------
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
  end if;

  if p_release_slot then
    update public.pickup_slots
    set reserved_count = reserved_count - 1
    where id = p_order.pickup_slot_id and reserved_count > 0;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- No-show processing (pg_cron, every minute).
-- ---------------------------------------------------------------------------
create function app.process_no_shows(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_outlet public.outlets;
  v_line record;
  v_qty_after integer;
  v_deal_id uuid;
  v_restocked integer;
  v_deal_items integer;
  v_note text;
  v_count integer := 0;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;

  -- FOR UPDATE re-checks the WHERE clause under the lock, so an order collected concurrently
  -- (no longer ready_for_pickup) is skipped; SKIP LOCKED avoids waiting on a pickup in flight.
  for v_order in
    select o.* from public.orders o
    join public.outlets ot on ot.id = o.outlet_id
    left join public.pickup_slots s on s.id = o.pickup_slot_id
    where o.status = 'ready_for_pickup'
      and private.pickup_deadline(o.ready_at, s.ends_at, ot.no_show_grace_minutes) <= now()
    order by o.ready_at
    limit p_limit
    for update of o skip locked
  loop
    select * into v_outlet from public.outlets where id = v_order.outlet_id;
    v_restocked := 0;
    v_deal_items := 0;
    v_deal_id := null;

    -- Packaged items back on the shelf (only tracked items have a count to restore).
    for v_line in
      select oi.menu_item_id, sum(oi.quantity)::integer as quantity
      from public.order_items oi
      join public.menu_items m on m.id = oi.menu_item_id and m.track_quantity
      where oi.order_id = v_order.id and oi.is_packaged
      group by oi.menu_item_id
      order by oi.menu_item_id
    loop
      update public.inventory set quantity_available = quantity_available + v_line.quantity
      where menu_item_id = v_line.menu_item_id
      returning quantity_available into v_qty_after;
      if found then
        insert into public.inventory_movements (menu_item_id, outlet_id, delta, quantity_after, reason, order_id, note)
        values (v_line.menu_item_id, v_order.outlet_id, v_line.quantity, v_qty_after, 'no_show_return', v_order.id,
                'Packaged item from an uncollected order');
        v_restocked := v_restocked + v_line.quantity;
      end if;
    end loop;

    -- Prepared items become one deal (orders that were themselves deals are not relisted).
    if v_order.source_deal_id is null
       and exists (select 1 from public.order_items where order_id = v_order.id and not is_packaged) then
      v_deal_id := gen_random_uuid();
      with lines as (
        select oi.menu_item_id, oi.item_name, m.diet, oi.quantity, oi.unit_price_paise,
               -- Integer paise, rounded half up, never below one paisa.
               greatest(1, (oi.unit_price_paise * (100 - v_outlet.no_show_deal_discount_percent) + 50) / 100) as deal_unit
        from public.order_items oi
        left join public.menu_items m on m.id = oi.menu_item_id
        where oi.order_id = v_order.id and not oi.is_packaged
      )
      insert into public.surplus_deals (
        id, outlet_id, source_order_id, discount_percent, original_price_paise, price_paise, item_count,
        listed_at, expires_at
      )
      select v_deal_id, v_order.outlet_id, v_order.id, v_outlet.no_show_deal_discount_percent,
             sum(unit_price_paise * quantity), sum(deal_unit * quantity), sum(quantity),
             now(), now() + make_interval(mins => v_outlet.deal_ttl_minutes)
      from lines;

      insert into public.surplus_deal_items (
        deal_id, menu_item_id, item_name, diet, quantity, original_unit_price_paise, deal_unit_price_paise
      )
      select v_deal_id, oi.menu_item_id, oi.item_name, m.diet, oi.quantity, oi.unit_price_paise,
             greatest(1, (oi.unit_price_paise * (100 - v_outlet.no_show_deal_discount_percent) + 50) / 100)
      from public.order_items oi
      left join public.menu_items m on m.id = oi.menu_item_id
      where oi.order_id = v_order.id and not oi.is_packaged;
      get diagnostics v_deal_items = row_count;
    end if;

    v_note := format('Not collected within %s minutes of the pickup deadline; no refund (outlet policy).',
                     v_outlet.no_show_grace_minutes);
    if v_restocked > 0 then
      v_note := v_note || format(' %s packaged item(s) returned to stock.', v_restocked);
    end if;
    if v_deal_id is not null then
      v_note := v_note || format(' Prepared food offered to other students at %s%% off.',
                                 v_outlet.no_show_deal_discount_percent);
    end if;

    update public.orders set status = 'no_show', no_show_at = now(), version = version + 1
    where id = v_order.id;
    insert into public.order_events (order_id, event_type, from_status, to_status, actor, reason)
    values (v_order.id, 'no_show', 'ready_for_pickup', 'no_show', 'system', v_note);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Deals nobody bought in time are recorded as unsold (pg_cron, every minute).
create function app.expire_surplus_deals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  update public.surplus_deals set
    status = 'expired', closed_at = now(), close_reason = 'Not sold before the listing ended',
    version = version + 1
  where status = 'available' and expires_at <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Student: buy a deal. Creates an unpaid order that holds the deal until payment or expiry.
-- Idempotent per (student, key) like app.create_order.
-- ---------------------------------------------------------------------------
create function app.claim_deal(p_deal_id uuid, p_idempotency_key text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_hash text := 'deal:' || p_deal_id::text;
  v_existing record;
  v_outlet_id uuid;
  v_outlet public.outlets;
  v_deal public.surplus_deals;
  v_order_id uuid := gen_random_uuid();
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in to buy a deal');
  end if;
  if p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 100 then
    perform private.fail(422, 'invalid_idempotency_key', 'Idempotency key must be 8–100 characters');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || p_idempotency_key, 0));
  select id, request_hash into v_existing
  from public.orders where user_id = v_user and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.request_hash is distinct from v_hash then
      perform private.fail(409, 'idempotency_key_reused', 'This idempotency key was already used for a different order');
    end if;
    return v_existing.id;
  end if;

  if (select count(*) from public.orders where user_id = v_user and status = 'payment_pending') >= 3 then
    perform private.fail(409, 'too_many_pending_orders', 'Finish or cancel your unpaid orders before placing another');
  end if;

  select outlet_id into v_outlet_id from public.surplus_deals where id = p_deal_id;
  if v_outlet_id is null then
    perform private.fail(404, 'deal_not_found', 'Deal not found');
  end if;
  select * into v_outlet from public.outlets where id = v_outlet_id for share;
  select * into v_deal from public.surplus_deals where id = p_deal_id for update;

  if not v_outlet.is_active then
    perform private.fail(404, 'deal_not_found', 'Deal not found');
  end if;
  if v_outlet.status = 'closed' then
    perform private.fail(409, 'outlet_not_accepting_orders', 'The outlet is closed, so the counter can''t hand this over');
  end if;
  if v_deal.status <> 'available' or v_deal.expires_at <= now() then
    perform private.fail(409, 'deal_unavailable', 'Someone else got this deal first, or it has ended');
  end if;
  if exists (select 1 from public.orders where id = v_deal.source_order_id and user_id = v_user) then
    perform private.fail(409, 'own_deal', 'This food came from your own uncollected order');
  end if;

  insert into public.orders (
    id, user_id, outlet_id, pickup_slot_id, source_deal_id, subtotal_paise, total_paise, item_count,
    idempotency_key, request_hash, reservation_expires_at
  ) values (
    v_order_id, v_user, v_deal.outlet_id, null, v_deal.id, v_deal.price_paise, v_deal.price_paise, v_deal.item_count,
    p_idempotency_key, v_hash, now() + make_interval(mins => v_outlet.reservation_ttl_minutes)
  );

  insert into public.order_items (order_id, menu_item_id, item_name, unit_price_paise, quantity, line_total_paise, prep_minutes)
  select v_order_id, menu_item_id, item_name, deal_unit_price_paise, quantity, deal_unit_price_paise * quantity, 0
  from public.surplus_deal_items where deal_id = v_deal.id;

  update public.surplus_deals set status = 'reserved', reserved_order_id = v_order_id, version = version + 1
  where id = v_deal.id;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id, reason)
  values (v_order_id, 'created', null, 'payment_pending', 'student', v_user,
          format('Surplus deal (%s%% off)', v_deal.discount_percent));
  return v_order_id;
end;
$$;

-- Staff take a deal off sale (e.g. the food was given away or is no longer fit to serve).
create function app.withdraw_deal(p_deal_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deal public.surplus_deals;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select * into v_deal from public.surplus_deals where id = p_deal_id for update;
  if not found or not (private.is_outlet_staff(v_deal.outlet_id) or private.is_admin()) then
    perform private.fail(404, 'deal_not_found', 'Deal not found');
  end if;
  if v_reason is null then
    perform private.fail(422, 'reason_required', 'Please give a reason');
  end if;
  if char_length(v_reason) > 300 then
    perform private.fail(422, 'reason_too_long', 'Reason must be at most 300 characters');
  end if;
  if v_deal.status <> 'available' then
    perform private.fail(409, 'deal_not_available', 'Only a deal that is on sale can be withdrawn');
  end if;
  update public.surplus_deals set
    status = 'withdrawn', closed_at = now(), close_reason = v_reason, version = version + 1
  where id = p_deal_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment confirmation, extended for deal orders: the food is already made, so a paid deal
-- order goes straight to ready_for_pickup, and the deal is marked sold.
-- ---------------------------------------------------------------------------
create or replace function app.confirm_order_payment(p_order_id uuid, p_payment_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_outlet public.outlets;
  v_deal public.surplus_deals;
  v_business_date date;
  v_token integer;
  v_code text;
  v_to public.order_status := 'placed';
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'Only the payment service can confirm payments');
  end if;
  if nullif(btrim(p_payment_reference), '') is null then
    perform private.fail(422, 'payment_reference_required', 'A payment reference is required');
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;

  if v_order.payment_status = 'paid' then
    if v_order.payment_reference = p_payment_reference then
      return; -- idempotent replay of the same confirmation
    end if;
    perform private.fail(409, 'already_paid', 'Order is already paid with a different reference');
  end if;
  if v_order.status <> 'payment_pending' then
    perform private.fail(409, 'order_not_pending', 'Order is no longer awaiting payment');
  end if;
  if v_order.reservation_expires_at <= now() then
    perform private.fail(409, 'reservation_expired', 'The reservation for this order has expired');
  end if;

  if v_order.source_deal_id is not null then
    select * into v_deal from public.surplus_deals where id = v_order.source_deal_id for update;
    if v_deal.status <> 'reserved' or v_deal.reserved_order_id is distinct from v_order.id then
      perform private.fail(409, 'deal_unavailable', 'This deal is no longer held for this order');
    end if;
    update public.surplus_deals set
      status = 'sold', sold_order_id = v_order.id, reserved_order_id = null, closed_at = now(),
      version = version + 1
    where id = v_deal.id;
    v_to := 'ready_for_pickup';
  end if;

  select * into v_outlet from public.outlets where id = v_order.outlet_id;
  v_business_date := (now() at time zone v_outlet.timezone)::date;

  insert into private.outlet_token_counters as c (outlet_id, business_date, last_number)
  values (v_order.outlet_id, v_business_date, 1)
  on conflict (outlet_id, business_date) do update set last_number = c.last_number + 1
  returning last_number into v_token;

  bytes := extensions.gen_random_bytes(6);
  v_code := '';
  for i in 0..5 loop
    v_code := v_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;

  update public.orders set
    status = v_to,
    payment_status = 'paid',
    payment_reference = p_payment_reference,
    placed_at = now(),
    ready_at = case when v_to = 'ready_for_pickup' then now() else ready_at end,
    reservation_expires_at = null,
    business_date = v_business_date,
    token_number = v_token,
    token_label = v_outlet.token_prefix || '-' || v_token,
    version = version + 1
  where id = p_order_id;

  insert into public.order_pickup_codes (order_id, code) values (p_order_id, v_code);

  insert into public.order_events (order_id, event_type, from_status, to_status, actor)
  values (p_order_id, 'payment_confirmed', 'payment_pending', v_to, 'system');
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges, Realtime and jobs
-- ---------------------------------------------------------------------------
revoke all on function
  app.process_no_shows(integer),
  app.expire_surplus_deals(),
  app.claim_deal(uuid, text),
  app.withdraw_deal(uuid, text)
from public;

grant execute on function app.claim_deal(uuid, text), app.withdraw_deal(uuid, text)
  to authenticated, service_role;
grant execute on function app.process_no_shows(integer), app.expire_surplus_deals() to service_role;

alter publication supabase_realtime add table public.surplus_deals;

select cron.schedule('campuscart-process-no-shows', '* * * * *', $$select app.process_no_shows()$$);
select cron.schedule('campuscart-expire-surplus-deals', '* * * * *', $$select app.expire_surplus_deals()$$);
