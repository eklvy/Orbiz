-- Phase 5 · Social & group hub (F17 group orders, F18 party sessions, F19 bill splits).
--
-- Money between students only ever moves through the wallet ledger (transfer_out / transfer_in,
-- order_payment, refund), in one transaction with locks: order → wallet accounts (by user id).
-- Defaults chosen by us (REQUIREMENTS.md D-22): group size ≤ 10; group payment window 15 min after
-- the host locks the order; party bookings 24 h – 60 days ahead, refundable until 24 h before;
-- bill splits ≤ 10 people.

create type public.group_status as enum ('open', 'locked', 'paid', 'cancelled');
create type public.split_mode as enum ('by_dish', 'equal', 'percent');

-- ---------------------------------------------------------------------------
-- Group orders
-- ---------------------------------------------------------------------------
create table public.group_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users (id) on delete restrict,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  pickup_slot_id uuid not null,
  invite_code text not null unique constraint group_sessions_code_format check (invite_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  status public.group_status not null default 'open',
  split_mode public.split_mode not null default 'by_dish',
  order_id uuid unique references public.orders (id) on delete restrict,
  -- Bumped on every change to the tray, members or shares; clients refetch on Realtime events.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (pickup_slot_id, outlet_id) references public.pickup_slots (id, outlet_id) on delete restrict,
  constraint group_sessions_order_when_locked check ((status = 'open') = (order_id is null) or status = 'cancelled')
);
create index group_sessions_host_idx on public.group_sessions (host_id, created_at desc);
create index group_sessions_outlet_idx on public.group_sessions (outlet_id);
create index group_sessions_slot_idx on public.group_sessions (pickup_slot_id);
create trigger group_sessions_set_updated_at
  before update on public.group_sessions
  for each row execute function private.set_updated_at();

create table public.group_members (
  session_id uuid not null references public.group_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete restrict,
  percent smallint constraint group_members_percent_range check (percent between 0 and 100),
  joined_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create table public.group_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  member_id uuid not null,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  quantity integer not null constraint group_items_quantity_range check (quantity between 1 and 20),
  added_by uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (session_id, member_id) references public.group_members (session_id, user_id) on delete cascade,
  unique (session_id, member_id, menu_item_id)
);
create index group_items_session_idx on public.group_items (session_id);
create index group_items_member_idx on public.group_items (session_id, member_id);
create index group_items_menu_item_idx on public.group_items (menu_item_id);
create index group_items_added_by_idx on public.group_items (added_by);

create table public.group_shares (
  session_id uuid not null references public.group_sessions (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  amount_paise integer not null constraint group_shares_amount_non_negative check (amount_paise >= 0),
  paid_at timestamptz,
  wallet_entry_id bigint references public.wallet_ledger (id) on delete restrict,
  refunded_at timestamptz,
  primary key (session_id, user_id),
  constraint group_shares_paid_consistent check ((paid_at is null) = (wallet_entry_id is null) or amount_paise = 0)
);
create index group_shares_user_idx on public.group_shares (user_id);
create index group_shares_wallet_idx on public.group_shares (wallet_entry_id);

alter table public.orders
  add column group_session_id uuid references public.group_sessions (id) on delete restrict;
create index orders_group_session_idx on public.orders (group_session_id);

-- Each member earns points on their own share; the ledger's once-per-order rule becomes
-- once per order per student.
drop index public.loyalty_ledger_once_per_order;
create unique index loyalty_ledger_once_per_order on public.loyalty_ledger (order_id, user_id, reason)
  where reason in ('order_paid', 'order_refunded');

create function private.is_group_member(p_session uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.group_members where session_id = p_session and user_id = (select auth.uid()));
$$;
revoke all on function private.is_group_member(uuid) from public;
grant execute on function private.is_group_member(uuid) to authenticated, service_role;

-- Members can follow the group's order (status, token); the pickup code stays the host's.
create policy orders_select_group_members on public.orders
  for select to authenticated
  using (group_session_id is not null and (select private.is_group_member(group_session_id)));

create function private.bump_group(p_session uuid)
returns void
language sql
set search_path = ''
as $$ update public.group_sessions set version = version + 1 where id = p_session; $$;
revoke all on function private.bump_group(uuid) from public;

create function private.require_open_group(p_session uuid, p_host_only boolean)
returns public.group_sessions
language plpgsql
set search_path = ''
as $$
declare
  v_session public.group_sessions;
begin
  select * into v_session from public.group_sessions where id = p_session for update;
  if not found or not exists (select 1 from public.group_members where session_id = p_session and user_id = auth.uid()) then
    perform private.fail(404, 'group_not_found', 'Group order not found');
  end if;
  if p_host_only and v_session.host_id <> auth.uid() then
    perform private.fail(403, 'forbidden', 'Only the host can do that');
  end if;
  if v_session.status <> 'open' then
    perform private.fail(409, 'group_locked', 'This group order is already checked out');
  end if;
  return v_session;
end;
$$;
revoke all on function private.require_open_group(uuid, boolean) from public;

create function app.create_group(p_outlet_id uuid, p_pickup_slot_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_code text := '';
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(6);
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  if not exists (select 1 from public.pickup_slots s join public.outlets o on o.id = s.outlet_id
                 where s.id = p_pickup_slot_id and s.outlet_id = p_outlet_id and s.is_active and o.is_active
                   and s.starts_at > now()) then
    perform private.fail(409, 'slot_unavailable', 'Pick an upcoming pickup slot at this outlet');
  end if;
  if (select count(*) from public.group_sessions where host_id = auth.uid() and status = 'open') >= 3 then
    perform private.fail(409, 'too_many_groups', 'Finish your open group orders first');
  end if;
  for i in 0..5 loop
    v_code := v_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.group_sessions (id, host_id, outlet_id, pickup_slot_id, invite_code)
  values (v_id, auth.uid(), p_outlet_id, p_pickup_slot_id, v_code);
  insert into public.group_members (session_id, user_id) values (v_id, auth.uid());
  return v_id;
end;
$$;

create function app.join_group(p_code text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.group_sessions;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select * into v_session from public.group_sessions where invite_code = upper(btrim(coalesce(p_code, ''))) for update;
  if not found or v_session.status <> 'open' then
    perform private.fail(404, 'group_not_found', 'No open group order with that code');
  end if;
  if exists (select 1 from public.group_members where session_id = v_session.id and user_id = auth.uid()) then
    return v_session.id;
  end if;
  if (select count(*) from public.group_members where session_id = v_session.id) >= 10 then
    perform private.fail(409, 'group_full', 'A group order can have at most 10 people');
  end if;
  insert into public.group_members (session_id, user_id) values (v_session.id, auth.uid());
  perform private.bump_group(v_session.id);
  return v_session.id;
end;
$$;

-- Set a member's quantity of an item (0 removes it). Members edit their own lines; the host can
-- add or change lines for anyone in the group.
create function app.set_group_item(p_session uuid, p_member uuid, p_menu_item_id uuid, p_quantity integer)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.group_sessions;
begin
  v_session := private.require_open_group(p_session, false);
  if p_member <> auth.uid() and v_session.host_id <> auth.uid() then
    perform private.fail(403, 'forbidden', 'Only the host can change other members'' items');
  end if;
  if not exists (select 1 from public.group_members where session_id = p_session and user_id = p_member) then
    perform private.fail(422, 'member_not_found', 'That person is not in this group');
  end if;
  if p_quantity is null or p_quantity not between 0 and 20 then
    perform private.fail(422, 'invalid_quantity', 'Quantity must be 0–20');
  end if;
  if p_quantity = 0 then
    delete from public.group_items where session_id = p_session and member_id = p_member and menu_item_id = p_menu_item_id;
  else
    if not exists (select 1 from public.menu_items where id = p_menu_item_id and outlet_id = v_session.outlet_id and is_active) then
      perform private.fail(422, 'item_not_found', 'That item is not on this outlet''s menu');
    end if;
    insert into public.group_items (session_id, member_id, menu_item_id, quantity, added_by)
    values (p_session, p_member, p_menu_item_id, p_quantity, auth.uid())
    on conflict (session_id, member_id, menu_item_id) do update set quantity = excluded.quantity, added_by = excluded.added_by;
  end if;
  perform private.bump_group(p_session);
end;
$$;

create function app.leave_group(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.group_sessions;
begin
  v_session := private.require_open_group(p_session, false);
  if v_session.host_id = auth.uid() then
    update public.group_sessions set status = 'cancelled' where id = p_session;
  else
    delete from public.group_members where session_id = p_session and user_id = auth.uid();
    perform private.bump_group(p_session);
  end if;
end;
$$;

-- p_percents: {"<user id>": <whole percent>, …} for percent mode (must cover every member who
-- pays and add up to 100).
create function app.set_group_split(p_session uuid, p_mode public.split_mode, p_percents jsonb default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  perform private.require_open_group(p_session, true);
  if p_mode = 'percent' then
    if jsonb_typeof(p_percents) is distinct from 'object' then
      perform private.fail(422, 'invalid_percents', 'Give a percentage for each member');
    end if;
    if exists (select 1 from jsonb_object_keys(p_percents) k
               where not exists (select 1 from public.group_members where session_id = p_session and user_id::text = k)) then
      perform private.fail(422, 'invalid_percents', 'Percentages can only be for group members');
    end if;
    select coalesce(sum((value)::integer), 0) into v_total from jsonb_each_text(p_percents);
    if v_total <> 100 then
      perform private.fail(422, 'invalid_percents', 'Percentages must add up to 100');
    end if;
    update public.group_members m set percent = coalesce((p_percents ->> m.user_id::text)::smallint, 0)
    where m.session_id = p_session;
  else
    update public.group_members set percent = null where session_id = p_session;
  end if;
  update public.group_sessions set split_mode = p_mode where id = p_session;
  perform private.bump_group(p_session);
exception when check_violation or invalid_text_representation then
  perform private.fail(422, 'invalid_percents', 'Percentages are whole numbers from 0 to 100');
end;
$$;

-- Host checks out: one order for the whole tray (same stock, slot and special rules as any order,
-- via app.create_order), then each member's share in integer paise. Remainders go to the host.
create function app.lock_group(p_session uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.group_sessions;
  v_items jsonb;
  v_order_id uuid;
  v_order public.orders;
  v_members integer;
  v_assigned integer;
begin
  v_session := private.require_open_group(p_session, true);
  select jsonb_agg(jsonb_build_object('menu_item_id', menu_item_id, 'quantity', quantity))
  into v_items
  from (select menu_item_id, sum(quantity)::integer as quantity from public.group_items
        where session_id = p_session group by menu_item_id) t;
  if v_items is null then
    perform private.fail(422, 'group_empty', 'Add some items first');
  end if;
  if exists (select 1 from (select menu_item_id, sum(quantity) q from public.group_items where session_id = p_session group by 1) t where q > 20) then
    perform private.fail(422, 'invalid_quantity', 'At most 20 of one item per group order');
  end if;

  v_order_id := app.create_order(
    v_session.outlet_id, v_session.pickup_slot_id, v_items, 'group:' || p_session::text, 'group:' || p_session::text);
  select * into v_order from public.orders where id = v_order_id;
  -- Everyone gets 15 minutes to pay their share.
  update public.orders set group_session_id = p_session,
    reservation_expires_at = greatest(reservation_expires_at, now() + interval '15 minutes')
  where id = v_order.id;

  select count(*) into v_members from public.group_members where session_id = p_session;
  if v_session.split_mode = 'by_dish' then
    insert into public.group_shares (session_id, user_id, amount_paise)
    select p_session, m.user_id, coalesce(sum(gi.quantity * oi.unit_price_paise), 0)::integer
    from public.group_members m
    left join public.group_items gi on gi.session_id = p_session and gi.member_id = m.user_id
    left join public.order_items oi on oi.order_id = v_order.id and oi.menu_item_id = gi.menu_item_id
    where m.session_id = p_session
    group by m.user_id;
  elsif v_session.split_mode = 'equal' then
    insert into public.group_shares (session_id, user_id, amount_paise)
    select p_session, user_id, v_order.total_paise / v_members from public.group_members where session_id = p_session;
  else
    insert into public.group_shares (session_id, user_id, amount_paise)
    select p_session, user_id, (v_order.total_paise * coalesce(percent, 0)) / 100
    from public.group_members where session_id = p_session;
  end if;
  select sum(amount_paise) into v_assigned from public.group_shares where session_id = p_session;
  update public.group_shares set amount_paise = amount_paise + (v_order.total_paise - v_assigned)
  where session_id = p_session and user_id = v_session.host_id;
  -- A zero share has nothing to pay.
  update public.group_shares set paid_at = now() where session_id = p_session and amount_paise = 0;

  update public.group_sessions set status = 'locked', order_id = v_order.id where id = p_session;
  perform private.bump_group(p_session);
  return v_order.id;
end;
$$;

-- A member pays their share from the wallet. The last share marks the order paid.
create function app.pay_group_share(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.group_sessions;
  v_share public.group_shares;
  v_entry bigint;
begin
  select * into v_session from public.group_sessions where id = p_session;
  if not found or not exists (select 1 from public.group_members where session_id = p_session and user_id = auth.uid()) then
    perform private.fail(404, 'group_not_found', 'Group order not found');
  end if;
  if v_session.status <> 'locked' then
    perform private.fail(409, 'group_not_payable', 'This group order is not waiting for payment');
  end if;
  -- Lock order: order → session → share → wallet.
  perform 1 from public.orders where id = v_session.order_id and status = 'payment_pending'
    and reservation_expires_at > now() for update;
  if not found then
    perform private.fail(409, 'reservation_expired', 'The group order''s hold has expired');
  end if;
  select * into v_session from public.group_sessions where id = p_session for update;
  select * into v_share from public.group_shares where session_id = p_session and user_id = auth.uid() for update;
  if v_share.paid_at is not null then
    return; -- already paid (retry)
  end if;
  v_entry := private.wallet_post(auth.uid(), 'order_payment', -v_share.amount_paise, v_session.order_id, null, null,
                                 'Group order share');
  update public.group_shares set paid_at = now(), wallet_entry_id = v_entry where session_id = p_session and user_id = auth.uid();
  perform private.loyalty_post(auth.uid(), v_share.amount_paise / 1000, 'order_paid', v_session.order_id);
  if not exists (select 1 from public.group_shares where session_id = p_session and paid_at is null) then
    perform private.mark_order_paid(v_session.order_id, 'group:' || p_session::text);
    update public.group_sessions set status = 'paid' where id = p_session;
  end if;
  perform private.bump_group(p_session);
end;
$$;

-- Money follows the order (replaces the loyalty migration's version): group orders earn per share
-- (above), and if a group order ends unpaid, every share already paid goes back to its payer.
-- Refund payout for a paid group order also goes back share by share (app.payout_refunds below).
create or replace function private.on_order_money_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_share record;
  v_user uuid;
  v_earned integer;
  v_balance integer;
begin
  if new.payment_status = 'paid' and old.payment_status <> 'paid' then
    if new.voucher_id is not null then
      update public.vouchers set status = 'used' where id = new.voucher_id;
    end if;
    if new.group_session_id is null then
      perform private.loyalty_post(new.user_id, new.total_paise / 1000, 'order_paid', new.id);
    end if;
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' and new.payment_status = 'unpaid' then
    if new.voucher_id is not null then
      update public.vouchers set status = 'available', order_id = null where id = new.voucher_id and status = 'applied';
    end if;
    if new.group_session_id is not null then
      for v_share in
        select * from public.group_shares
        where session_id = new.group_session_id and paid_at is not null and refunded_at is null and amount_paise > 0
        order by user_id for update
      loop
        perform private.wallet_post(v_share.user_id, 'refund', v_share.amount_paise, new.id, null, null,
                                    'Group order was not completed');
        update public.group_shares set refunded_at = now() where session_id = v_share.session_id and user_id = v_share.user_id;
      end loop;
      update public.group_sessions set status = 'cancelled', version = version + 1 where id = new.group_session_id;
    end if;
  end if;
  if new.refund_status = 'refunded' and old.refund_status <> 'refunded' then
    -- Everyone who earned on this order gives those points back (unless already reversed, e.g. a
    -- group share refunded first), never below zero.
    for v_user, v_earned, v_balance in
      select l.user_id, l.points, coalesce(a.balance_points, 0)
      from public.loyalty_ledger l
      left join public.loyalty_accounts a on a.user_id = l.user_id
      where l.order_id = new.id and l.reason = 'order_paid'
        and not exists (select 1 from public.loyalty_ledger r
                        where r.order_id = new.id and r.user_id = l.user_id and r.reason = 'order_refunded')
    loop
      perform private.loyalty_post(v_user, -least(v_earned, v_balance), 'order_refunded', new.id);
    end loop;
  end if;
  return null;
end;
$$;

-- Refund payout, extended for group orders: each member gets their own share back.
create or replace function app.payout_refunds(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_share record;
  v_count integer := 0;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  for v_order in
    select * from public.orders where refund_status = 'required'
    order by updated_at limit p_limit
    for update skip locked
  loop
    if v_order.group_session_id is null then
      perform private.wallet_post(v_order.user_id, 'refund', v_order.total_paise, v_order.id, null, null,
                                  'Refund for order ' || coalesce(v_order.token_label, ''));
    else
      for v_share in
        select * from public.group_shares where session_id = v_order.group_session_id
          and amount_paise > 0 and refunded_at is null order by user_id for update
      loop
        perform private.wallet_post(v_share.user_id, 'refund', v_share.amount_paise, v_order.id, null, null,
                                    'Refund for group order ' || coalesce(v_order.token_label, ''));
        update public.group_shares set refunded_at = now() where session_id = v_share.session_id and user_id = v_share.user_id;
      end loop;
    end if;
    update public.orders set refund_status = 'refunded', version = version + 1 where id = v_order.id;
    insert into public.order_events (order_id, event_type, from_status, to_status, actor, reason)
    values (v_order.id, 'refund_paid', v_order.status, v_order.status, 'system', 'Refunded to your CampusCart wallet');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Reverse points for members whose shares were refunded because the group order expired.
create function private.on_group_share_refund()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order uuid;
  v_earned integer;
  v_balance integer;
begin
  select order_id into v_order from public.group_sessions where id = new.session_id;
  select l.points, coalesce(a.balance_points, 0) into v_earned, v_balance
  from public.loyalty_ledger l left join public.loyalty_accounts a on a.user_id = l.user_id
  where l.order_id = v_order and l.user_id = new.user_id and l.reason = 'order_paid';
  if v_earned is not null and not exists (
    select 1 from public.loyalty_ledger where order_id = v_order and user_id = new.user_id and reason = 'order_refunded') then
    perform private.loyalty_post(new.user_id, -least(v_earned, v_balance), 'order_refunded', v_order);
  end if;
  return null;
end;
$$;
revoke all on function private.on_group_share_refund() from public;
create trigger group_shares_refund_points
  after update of refunded_at on public.group_shares
  for each row when (old.refunded_at is null and new.refunded_at is not null)
  execute function private.on_group_share_refund();

-- ---------------------------------------------------------------------------
-- Party sessions (pre-booked catering)
-- ---------------------------------------------------------------------------
create type public.party_status as enum ('requested', 'accepted', 'declined', 'paid', 'cancelled', 'fulfilled');

create table public.party_bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  event_name text not null constraint party_event_name_length check (char_length(btrim(event_name)) between 3 and 120),
  event_at timestamptz not null,
  headcount integer not null constraint party_headcount_range check (headcount between 5 and 500),
  notes text constraint party_notes_length check (char_length(notes) <= 1000),
  status public.party_status not null default 'requested',
  total_paise integer not null constraint party_total_positive check (total_paise > 0),
  manager_note text constraint party_manager_note_length check (char_length(manager_note) <= 500),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  paid_at timestamptz,
  wallet_entry_id bigint references public.wallet_ledger (id) on delete restrict,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index party_bookings_user_idx on public.party_bookings (user_id, created_at desc);
create index party_bookings_outlet_idx on public.party_bookings (outlet_id, event_at);
create index party_bookings_decided_by_idx on public.party_bookings (decided_by);
create index party_bookings_wallet_idx on public.party_bookings (wallet_entry_id);
create trigger party_bookings_set_updated_at
  before update on public.party_bookings
  for each row execute function private.set_updated_at();
create trigger party_bookings_audit
  after insert or update on public.party_bookings
  for each row execute function private.write_audit_log();

create table public.party_items (
  booking_id uuid not null references public.party_bookings (id) on delete cascade,
  menu_item_id uuid references public.menu_items (id) on delete set null,
  item_name text not null,
  unit_price_paise integer not null constraint party_items_price_positive check (unit_price_paise > 0),
  quantity integer not null constraint party_items_quantity_range check (quantity between 1 and 1000),
  primary key (booking_id, item_name)
);
create index party_items_menu_item_idx on public.party_items (menu_item_id);

-- Student requests a booking. Prices are the menu prices now (the quote); p_items like orders.
create function app.request_party(
  p_outlet_id uuid, p_event_name text, p_event_at timestamptz, p_headcount integer, p_items jsonb, p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_total integer;
  v_lines integer;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  if not exists (select 1 from public.outlets where id = p_outlet_id and is_active) then
    perform private.fail(404, 'outlet_not_found', 'Outlet not found');
  end if;
  if p_event_at < now() + interval '24 hours' or p_event_at > now() + interval '60 days' then
    perform private.fail(422, 'invalid_event_time', 'Book between 24 hours and 60 days ahead');
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 30 then
    perform private.fail(422, 'invalid_items', 'Choose 1–30 dishes');
  end if;
  insert into public.party_bookings (id, user_id, outlet_id, event_name, event_at, headcount, notes, total_paise)
  values (v_id, auth.uid(), p_outlet_id, btrim(p_event_name), p_event_at, p_headcount, nullif(btrim(p_notes), ''), 1);
  insert into public.party_items (booking_id, menu_item_id, item_name, unit_price_paise, quantity)
  select v_id, m.id, m.name, m.price_paise, sum((e ->> 'quantity')::integer)::integer
  from jsonb_array_elements(p_items) e
  join public.menu_items m on m.id = (e ->> 'menu_item_id')::uuid and m.outlet_id = p_outlet_id and m.is_active
  group by m.id, m.name, m.price_paise;
  get diagnostics v_lines = row_count;
  if v_lines <> (select count(distinct e ->> 'menu_item_id') from jsonb_array_elements(p_items) e) then
    perform private.fail(422, 'item_not_found', 'A dish is not on this outlet''s menu');
  end if;
  select sum(unit_price_paise * quantity) into v_total from public.party_items where booking_id = v_id;
  update public.party_bookings set total_paise = v_total where id = v_id;
  return v_id;
exception when check_violation or invalid_text_representation then
  perform private.fail(422, 'invalid_party', 'Check the event name, headcount (5–500) and quantities (1–1000)');
end;
$$;

create function app.decide_party(p_booking uuid, p_accept boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.party_bookings;
begin
  select * into v_booking from public.party_bookings where id = p_booking for update;
  if not found or not (private.is_outlet_manager(v_booking.outlet_id) or private.is_admin()) then
    perform private.fail(404, 'party_not_found', 'Booking not found');
  end if;
  if v_booking.status <> 'requested' then
    perform private.fail(409, 'already_decided', 'This booking was already decided');
  end if;
  if not p_accept and nullif(btrim(p_note), '') is null then
    perform private.fail(422, 'reason_required', 'Tell the student why');
  end if;
  update public.party_bookings set
    status = case when p_accept then 'accepted'::public.party_status else 'declined' end,
    manager_note = nullif(btrim(p_note), ''), decided_by = auth.uid(), decided_at = now()
  where id = p_booking;
  perform private.notify(v_booking.user_id, 'social',
    case when p_accept then 'Party booking accepted' else 'Party booking declined' end,
    v_booking.event_name || case when p_accept then ': pay from your wallet to confirm.' else coalesce(': ' || btrim(p_note), '') end,
    jsonb_build_object('party_id', p_booking));
end;
$$;

create function app.pay_party(p_booking uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.party_bookings;
  v_entry bigint;
begin
  select * into v_booking from public.party_bookings where id = p_booking for update;
  if not found or v_booking.user_id <> auth.uid() then
    perform private.fail(404, 'party_not_found', 'Booking not found');
  end if;
  if v_booking.status = 'paid' then
    return;
  end if;
  if v_booking.status <> 'accepted' then
    perform private.fail(409, 'party_not_payable', 'Only an accepted booking can be paid');
  end if;
  if v_booking.event_at < now() + interval '24 hours' then
    perform private.fail(409, 'party_too_late', 'Payment closed 24 hours before the event');
  end if;
  v_entry := private.wallet_post(auth.uid(), 'order_payment', -v_booking.total_paise, null, null, null,
                                 'Party booking: ' || left(v_booking.event_name, 100));
  update public.party_bookings set status = 'paid', paid_at = now(), wallet_entry_id = v_entry where id = p_booking;
  perform private.loyalty_post(auth.uid(), v_booking.total_paise / 1000, 'order_paid');
end;
$$;

-- Student cancels: free before payment; after payment, a full refund until 24 h before the event.
create function app.cancel_party(p_booking uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.party_bookings;
begin
  select * into v_booking from public.party_bookings where id = p_booking for update;
  if not found or v_booking.user_id <> auth.uid() then
    perform private.fail(404, 'party_not_found', 'Booking not found');
  end if;
  if v_booking.status in ('requested', 'accepted') then
    update public.party_bookings set status = 'cancelled' where id = p_booking;
  elsif v_booking.status = 'paid' then
    if v_booking.event_at < now() + interval '24 hours' then
      perform private.fail(409, 'party_too_late', 'Paid bookings can be cancelled until 24 hours before the event');
    end if;
    perform private.wallet_post(auth.uid(), 'refund', v_booking.total_paise, null, null, null,
                                'Party booking cancelled: ' || left(v_booking.event_name, 100));
    update public.party_bookings set status = 'cancelled', refunded_at = now() where id = p_booking;
  else
    perform private.fail(409, 'party_not_cancellable', 'This booking can no longer be cancelled');
  end if;
end;
$$;

create function app.fulfil_party(p_booking uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_booking public.party_bookings;
begin
  select * into v_booking from public.party_bookings where id = p_booking for update;
  if not found or not (private.is_outlet_manager(v_booking.outlet_id) or private.is_admin()) then
    perform private.fail(404, 'party_not_found', 'Booking not found');
  end if;
  if v_booking.status <> 'paid' then
    perform private.fail(409, 'party_not_paid', 'Only a paid booking can be marked delivered');
  end if;
  update public.party_bookings set status = 'fulfilled' where id = p_booking;
end;
$$;

-- ---------------------------------------------------------------------------
-- Bill splits (informal shared expenses, settled by wallet transfer to the creator)
-- ---------------------------------------------------------------------------
create table public.bill_splits (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references auth.users (id) on delete restrict,
  title text not null constraint bill_splits_title_length check (char_length(btrim(title)) between 2 and 120),
  total_paise integer not null constraint bill_splits_total_range check (total_paise between 100 and 5000000),
  settled_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz not null default now()
);
create index bill_splits_creator_idx on public.bill_splits (creator_id, created_at desc);

create table public.bill_split_shares (
  split_id uuid not null references public.bill_splits (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete restrict,
  amount_paise integer not null constraint bill_split_shares_amount_positive check (amount_paise > 0),
  paid_at timestamptz,
  transfer_entry_id bigint references public.wallet_ledger (id) on delete restrict,
  primary key (split_id, user_id)
);
create index bill_split_shares_user_idx on public.bill_split_shares (user_id);
create index bill_split_shares_entry_idx on public.bill_split_shares (transfer_entry_id);

create function private.is_split_participant(p_split uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.bill_splits where id = p_split and creator_id = (select auth.uid()))
      or exists (select 1 from public.bill_split_shares where split_id = p_split and user_id = (select auth.uid()));
$$;
revoke all on function private.is_split_participant(uuid) from public;
grant execute on function private.is_split_participant(uuid) to authenticated, service_role;

-- p_shares: [{"email": "...", "amount_paise": n}, …] — what each other person owes the creator.
-- People are looked up by their CampusCart email (1–10 of them).
create function app.create_bill_split(p_title text, p_total integer, p_shares jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_count integer;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  if jsonb_typeof(p_shares) is distinct from 'array' or jsonb_array_length(p_shares) not between 1 and 10 then
    perform private.fail(422, 'invalid_shares', 'Split with 1–10 people');
  end if;
  insert into public.bill_splits (id, creator_id, title, total_paise) values (v_id, auth.uid(), btrim(p_title), p_total);
  insert into public.bill_split_shares (split_id, user_id, amount_paise)
  select v_id, u.id, (e ->> 'amount_paise')::integer
  from jsonb_array_elements(p_shares) e
  join auth.users u on lower(u.email) = lower(btrim(e ->> 'email'))
  where u.id <> auth.uid();
  get diagnostics v_count = row_count;
  if v_count <> jsonb_array_length(p_shares) then
    perform private.fail(422, 'participant_not_found',
      'Every person must have a CampusCart account (and you can''t owe yourself)');
  end if;
  if (select sum(amount_paise) from public.bill_split_shares where split_id = v_id) > p_total then
    perform private.fail(422, 'invalid_shares', 'Shares can''t add up to more than the total');
  end if;
  insert into public.notifications (user_id, category, title, body, data)
  select s.user_id, 'social', 'You owe ₹' || to_char(s.amount_paise / 100.0, 'FM999999990.00'),
         'For "' || btrim(p_title) || '". Settle it from your wallet.', jsonb_build_object('split_id', v_id)
  from public.bill_split_shares s where s.split_id = v_id;
  return v_id;
exception when check_violation or invalid_text_representation or unique_violation then
  perform private.fail(422, 'invalid_shares', 'Check the title, total (₹1–₹50,000) and each person''s amount');
end;
$$;

create function app.settle_bill_share(p_split uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_split public.bill_splits;
  v_share public.bill_split_shares;
  v_out bigint;
  v_me uuid := auth.uid();
begin
  select * into v_split from public.bill_splits where id = p_split for update;
  select * into v_share from public.bill_split_shares where split_id = p_split and user_id = v_me for update;
  if v_split.id is null or v_share.split_id is null then
    perform private.fail(404, 'split_not_found', 'Bill split not found');
  end if;
  if v_share.paid_at is not null then
    return;
  end if;
  if v_split.cancelled_at is not null then
    perform private.fail(409, 'split_cancelled', 'This split was cancelled');
  end if;
  -- Wallet locks in user-id order so two people settling with each other never deadlock.
  if v_me < v_split.creator_id then
    v_out := private.wallet_post(v_me, 'transfer_out', -v_share.amount_paise, null, null, v_split.creator_id, 'Bill split: ' || left(v_split.title, 100));
    perform private.wallet_post(v_split.creator_id, 'transfer_in', v_share.amount_paise, null, null, v_me, 'Bill split: ' || left(v_split.title, 100));
  else
    perform private.wallet_post(v_split.creator_id, 'transfer_in', v_share.amount_paise, null, null, v_me, 'Bill split: ' || left(v_split.title, 100));
    v_out := private.wallet_post(v_me, 'transfer_out', -v_share.amount_paise, null, null, v_split.creator_id, 'Bill split: ' || left(v_split.title, 100));
  end if;
  update public.bill_split_shares set paid_at = now(), transfer_entry_id = v_out where split_id = p_split and user_id = v_me;
  if not exists (select 1 from public.bill_split_shares where split_id = p_split and paid_at is null) then
    update public.bill_splits set settled_at = now() where id = p_split;
  end if;
  perform private.notify(v_split.creator_id, 'social', 'Bill split payment received',
    'Someone settled their share of "' || v_split.title || '".', jsonb_build_object('split_id', p_split));
end;
$$;

create function app.cancel_bill_split(p_split uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bill_splits set cancelled_at = now()
  where id = p_split and creator_id = auth.uid() and settled_at is null and cancelled_at is null;
  if not found then
    perform private.fail(404, 'split_not_found', 'No open bill split of yours with that id');
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges, RLS, Realtime
-- ---------------------------------------------------------------------------
revoke all on public.group_sessions, public.group_members, public.group_items, public.group_shares,
  public.party_bookings, public.party_items, public.bill_splits, public.bill_split_shares from anon, authenticated;
grant select on public.group_sessions, public.group_members, public.group_items, public.group_shares,
  public.party_bookings, public.party_items, public.bill_splits, public.bill_split_shares to authenticated;

alter table public.group_sessions enable row level security;
alter table public.group_members enable row level security;
alter table public.group_items enable row level security;
alter table public.group_shares enable row level security;
alter table public.party_bookings enable row level security;
alter table public.party_items enable row level security;
alter table public.bill_splits enable row level security;
alter table public.bill_split_shares enable row level security;

create policy group_sessions_select on public.group_sessions for select to authenticated
  using ((select private.is_group_member(id)));
create policy group_members_select on public.group_members for select to authenticated
  using ((select private.is_group_member(session_id)));
create policy group_items_select on public.group_items for select to authenticated
  using ((select private.is_group_member(session_id)));
create policy group_shares_select on public.group_shares for select to authenticated
  using ((select private.is_group_member(session_id)));
create policy party_bookings_select on public.party_bookings for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_outlet_manager(outlet_id)) or (select private.is_admin()));
create policy party_items_select on public.party_items for select to authenticated
  using (exists (select 1 from public.party_bookings b where b.id = booking_id));
create policy bill_splits_select on public.bill_splits for select to authenticated
  using ((select private.is_split_participant(id)));
create policy bill_split_shares_select on public.bill_split_shares for select to authenticated
  using ((select private.is_split_participant(split_id)));

revoke all on function
  app.create_group(uuid, uuid), app.join_group(text), app.set_group_item(uuid, uuid, uuid, integer),
  app.leave_group(uuid), app.set_group_split(uuid, public.split_mode, jsonb), app.lock_group(uuid),
  app.pay_group_share(uuid),
  app.request_party(uuid, text, timestamptz, integer, jsonb, text), app.decide_party(uuid, boolean, text),
  app.pay_party(uuid), app.cancel_party(uuid), app.fulfil_party(uuid),
  app.create_bill_split(text, integer, jsonb), app.settle_bill_share(uuid), app.cancel_bill_split(uuid)
from public;
grant execute on function
  app.create_group(uuid, uuid), app.join_group(text), app.set_group_item(uuid, uuid, uuid, integer),
  app.leave_group(uuid), app.set_group_split(uuid, public.split_mode, jsonb), app.lock_group(uuid),
  app.pay_group_share(uuid),
  app.request_party(uuid, text, timestamptz, integer, jsonb, text), app.decide_party(uuid, boolean, text),
  app.pay_party(uuid), app.cancel_party(uuid), app.fulfil_party(uuid),
  app.create_bill_split(text, integer, jsonb), app.settle_bill_share(uuid), app.cancel_bill_split(uuid)
to authenticated, service_role;

-- Only the session row (its version) is published; members refetch the tray on each change.
-- (group_items has deletes, and Realtime doesn't apply RLS to delete events.)
alter publication supabase_realtime add table public.group_sessions;
