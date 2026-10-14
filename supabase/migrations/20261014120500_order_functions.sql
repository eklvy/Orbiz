-- Phase 2 · Transactional business operations.
--
-- `app` holds the operations the CampusCart API calls. It is NOT exposed through PostgREST /
-- GraphQL, so clients cannot invoke these directly; the API calls them inside a transaction
-- that has adopted the caller's identity (auth.uid()). Every function is SECURITY DEFINER
-- (so it can lock and update rows clients may not write) and therefore performs its own
-- explicit authorization.
--
-- Errors use SQLSTATE 'CC' || <HTTP status> (e.g. CC409) with a machine-readable reason in
-- HINT; the API maps them to its error envelope (app/core/db.py).
--
-- Lock order (deadlock avoidance) for every function that touches several rows:
--   outlet (share/update) → inventory rows ordered by menu_item_id → pickup slot → order.

create schema app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create function private.fail(p_status integer, p_reason text, p_message text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'CC' || p_status::text, message = p_message, hint = p_reason;
end;
$$;

-- True only for trusted server-side callers (cron, service_role system transactions,
-- direct postgres sessions) — never for an end-user session, which always carries a uid.
-- `role` is the session's SET ROLE value and is unaffected by SECURITY DEFINER.
create function private.is_system_caller()
returns boolean
language sql
stable
set search_path = ''
as $$
  select auth.uid() is null
    and coalesce(nullif(current_setting('role', true), ''), 'none') in ('none', 'service_role', 'postgres');
$$;

create function private.require_outlet_manager(p_outlet_id uuid)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not (private.is_system_caller() or private.is_admin() or private.is_outlet_manager(p_outlet_id)) then
    perform private.fail(403, 'forbidden', 'Only this outlet''s managers can do that');
  end if;
end;
$$;

-- Returns stock and/or pickup capacity held by an order. Caller holds the order row lock.
create function private.release_order_reservations(
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
-- Order creation (student). Atomic: any failure rolls back every reservation.
-- p_items: [{"menu_item_id": uuid, "quantity": int}, …]
-- ---------------------------------------------------------------------------
create function app.create_order(
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

  -- Serialise retries of the same request, then replay if it already succeeded.
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

  -- Abuse control: a student cannot hoard stock with many unpaid orders.
  if (select count(*) from public.orders where user_id = v_user and status = 'payment_pending') >= 3 then
    perform private.fail(409, 'too_many_pending_orders',
      'Finish or cancel your unpaid orders before placing another');
  end if;

  -- FOR SHARE: a concurrent status change (FOR UPDATE) waits for us, and vice versa.
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

  -- Validate and reserve stock, item by item, in a fixed order.
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
      -- Atomic conditional decrement: under concurrency only buyers who fit get a row back.
      update public.inventory
      set quantity_available = quantity_available - v_line.quantity
      where menu_item_id = v_line.item_id and quantity_available >= v_line.quantity
      returning quantity_available into v_qty_after;
      if not found then
        perform private.fail(409, 'insufficient_stock', 'Not enough ' || v_line.name || ' left');
      end if;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'menu_item_id', v_line.item_id, 'name', v_line.name, 'unit_price', v_line.price_paise,
      'quantity', v_line.quantity, 'prep', v_line.prep_minutes,
      'tracked', v_line.track_quantity, 'qty_after', v_qty_after);
    v_subtotal := v_subtotal + v_line.price_paise * v_line.quantity;
    v_count := v_count + v_line.quantity;
    v_max_prep := greatest(v_max_prep, v_line.prep_minutes);
  end loop;

  -- Reserve pickup capacity.
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

  insert into public.order_items (order_id, menu_item_id, item_name, unit_price_paise, quantity, line_total_paise, prep_minutes)
  select v_order_id, (l ->> 'menu_item_id')::uuid, l ->> 'name', (l ->> 'unit_price')::integer,
         (l ->> 'quantity')::integer, (l ->> 'unit_price')::integer * (l ->> 'quantity')::integer, (l ->> 'prep')::smallint
  from jsonb_array_elements(v_lines) l;

  insert into public.inventory_movements (menu_item_id, outlet_id, delta, quantity_after, reason, order_id, actor_id)
  select (l ->> 'menu_item_id')::uuid, p_outlet_id, -(l ->> 'quantity')::integer, (l ->> 'qty_after')::integer,
         'order_reserved', v_order_id, v_user
  from jsonb_array_elements(v_lines) l
  where (l ->> 'tracked')::boolean;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id)
  values (v_order_id, 'created', null, 'payment_pending', 'student', v_user);

  -- The cart has become an order.
  delete from public.carts where user_id = v_user and outlet_id = p_outlet_id;

  return v_order_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Status transitions (staff and student). Pickup completion and payment confirmation have
-- dedicated functions and are refused here.
-- ---------------------------------------------------------------------------
create function app.transition_order(p_order_id uuid, p_to public.order_status, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_order public.orders;
  v_rule public.order_status_transitions;
  v_actor public.order_actor;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;

  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;

  -- Staff rules take precedence; a staff member who owns the order may still act as student.
  if private.is_outlet_staff(v_order.outlet_id) then
    select * into v_rule from public.order_status_transitions
    where from_status = v_order.status and to_status = p_to and actor = 'staff';
    v_actor := 'staff';
  end if;
  if v_rule is null and v_order.user_id = v_user then
    select * into v_rule from public.order_status_transitions
    where from_status = v_order.status and to_status = p_to and actor = 'student';
    v_actor := 'student';
  end if;
  if v_actor is null then
    -- Neither staff of this outlet nor the owner: don't reveal that the order exists.
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_rule is null then
    perform private.fail(409, 'invalid_transition',
      format('An order cannot move from %s to %s', v_order.status, p_to));
  end if;
  if v_rule.requires_pickup_code then
    perform private.fail(409, 'pickup_code_required', 'Completing an order requires verifying its pickup code');
  end if;
  if v_rule.requires_paid and v_order.payment_status <> 'paid' then
    perform private.fail(409, 'payment_required', 'The order has not been paid');
  end if;
  if v_rule.requires_reason and v_reason is null then
    perform private.fail(422, 'reason_required', 'Please give a reason');
  end if;
  if char_length(v_reason) > 300 then
    perform private.fail(422, 'reason_too_long', 'Reason must be at most 300 characters');
  end if;

  perform private.release_order_reservations(v_order, v_rule.releases_stock, v_rule.releases_slot, v_user);

  update public.orders set
    status = p_to,
    version = version + 1,
    refund_status = case when v_rule.marks_refund_required and payment_status = 'paid'
                         then 'required'::public.refund_status else refund_status end,
    reservation_expires_at = null,
    confirmed_at = case when p_to = 'confirmed' then now() else confirmed_at end,
    preparing_at = case when p_to = 'preparing' then now() else preparing_at end,
    ready_at = case when p_to = 'ready_for_pickup' then now() else ready_at end,
    cancelled_at = case when p_to in ('cancelled', 'rejected') then now() else cancelled_at end,
    cancel_reason = case when p_to in ('cancelled', 'rejected') then v_reason else cancel_reason end,
    cancelled_by = case when p_to in ('cancelled', 'rejected') then v_actor else cancelled_by end
  where id = p_order_id;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id, reason)
  values (p_order_id, 'status_changed', v_order.status, p_to, v_actor, v_user, v_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Payment confirmation — the ONLY way an order becomes paid. Callable by trusted server
-- code only (service_role), never by end users. Phase 5 calls it after verifying a payment
-- with the provider; until then it is exercised only by tests.
-- ---------------------------------------------------------------------------
create function app.confirm_order_payment(p_order_id uuid, p_payment_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_outlet public.outlets;
  v_business_date date;
  v_token integer;
  v_code text;
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
    status = 'placed',
    payment_status = 'paid',
    payment_reference = p_payment_reference,
    placed_at = now(),
    reservation_expires_at = null,
    business_date = v_business_date,
    token_number = v_token,
    token_label = v_outlet.token_prefix || '-' || v_token,
    version = version + 1
  where id = p_order_id;

  insert into public.order_pickup_codes (order_id, code) values (p_order_id, v_code);

  insert into public.order_events (order_id, event_type, from_status, to_status, actor)
  values (p_order_id, 'payment_confirmed', 'payment_pending', 'placed', 'system');
end;
$$;

-- ---------------------------------------------------------------------------
-- Pickup verification (staff). Returns 'completed', 'invalid_code' or 'locked'.
-- Wrong attempts are counted (and persisted, hence no exception) and lock after 5.
-- ---------------------------------------------------------------------------
create function app.verify_pickup(p_order_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_order public.orders;
  v_pickup public.order_pickup_codes;
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or not private.is_outlet_staff(v_order.outlet_id) then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.status <> 'ready_for_pickup' then
    perform private.fail(409, 'not_ready_for_pickup', 'Order is not ready for pickup');
  end if;

  select * into v_pickup from public.order_pickup_codes where order_id = p_order_id for update;
  if v_pickup.failed_attempts >= 5 then
    return 'locked';
  end if;
  if upper(btrim(coalesce(p_code, ''))) <> v_pickup.code then
    update public.order_pickup_codes set failed_attempts = failed_attempts + 1 where order_id = p_order_id;
    return 'invalid_code';
  end if;

  update public.orders set status = 'completed', completed_at = now(), version = version + 1
  where id = p_order_id;
  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id)
  values (p_order_id, 'pickup_verified', 'ready_for_pickup', 'completed', 'staff', v_user);
  return 'completed';
end;
$$;

-- ---------------------------------------------------------------------------
-- Background jobs (pg_cron; also callable by the server's system role).
-- ---------------------------------------------------------------------------
create function app.expire_pending_orders(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_count integer := 0;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  -- FOR UPDATE re-checks the WHERE clause after acquiring the lock, so an order paid
  -- concurrently (status no longer payment_pending) is never expired. SKIP LOCKED lets the
  -- job move on instead of waiting on an in-flight payment confirmation.
  for v_order in
    select * from public.orders
    where status = 'payment_pending' and reservation_expires_at <= now()
    order by reservation_expires_at
    limit p_limit
    for update skip locked
  loop
    perform private.release_order_reservations(v_order, true, true, null);
    update public.orders set
      status = 'cancelled', cancelled_at = now(), cancelled_by = 'system',
      cancel_reason = 'Payment was not completed in time', reservation_expires_at = null,
      version = version + 1
    where id = v_order.id;
    insert into public.order_events (order_id, event_type, from_status, to_status, actor, reason)
    values (v_order.id, 'expired', 'payment_pending', 'cancelled', 'system', 'Reservation expired');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create function app.end_expired_breaks()
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
  update public.outlets set status = 'open', break_until = null, status_reason = null
  where status = 'on_break' and break_until <= now();
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outlet operations (managers / admins)
-- ---------------------------------------------------------------------------
create function app.set_outlet_status(
  p_outlet_id uuid, p_status public.outlet_status, p_reason text default null, p_break_minutes integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := nullif(btrim(p_reason), '');
begin
  perform private.require_outlet_manager(p_outlet_id);
  perform 1 from public.outlets where id = p_outlet_id for update;
  if not found then
    perform private.fail(404, 'outlet_not_found', 'Outlet not found');
  end if;
  if p_status = 'on_break' and (p_break_minutes is null or p_break_minutes not between 5 and 240) then
    perform private.fail(422, 'invalid_break_minutes', 'A break must last between 5 and 240 minutes');
  end if;
  if p_status <> 'on_break' and p_break_minutes is not null then
    perform private.fail(422, 'invalid_break_minutes', 'Break minutes only apply to a break');
  end if;
  if char_length(v_reason) > 200 then
    perform private.fail(422, 'reason_too_long', 'Reason must be at most 200 characters');
  end if;

  update public.outlets set
    status = p_status,
    status_reason = case when p_status = 'open' then null else v_reason end,
    break_until = case when p_status = 'on_break' then now() + make_interval(mins => p_break_minutes) end
  where id = p_outlet_id;
end;
$$;

create function private.item_outlet_for_manager(p_menu_item_id uuid)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_outlet uuid;
begin
  select outlet_id into v_outlet from public.menu_items where id = p_menu_item_id;
  if v_outlet is null then
    perform private.fail(404, 'item_not_found', 'Menu item not found');
  end if;
  perform private.require_outlet_manager(v_outlet);
  return v_outlet;
end;
$$;

-- Restock (+) or correct (+/-) a tracked item's quantity. Returns the new quantity.
create function app.adjust_stock(
  p_menu_item_id uuid, p_delta integer, p_reason public.inventory_movement_reason, p_note text default null
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outlet uuid := private.item_outlet_for_manager(p_menu_item_id);
  v_after integer;
begin
  if p_reason not in ('restock', 'manual_adjustment') then
    perform private.fail(422, 'invalid_reason', 'Use restock or manual_adjustment');
  end if;
  if p_delta is null or p_delta = 0 then
    perform private.fail(422, 'invalid_delta', 'Quantity change must be non-zero');
  end if;
  if p_reason = 'restock' and p_delta < 0 then
    perform private.fail(422, 'invalid_delta', 'A restock must add stock');
  end if;
  if not (select track_quantity from public.menu_items where id = p_menu_item_id) then
    perform private.fail(409, 'not_tracked', 'This item does not track quantity');
  end if;

  insert into public.inventory (menu_item_id) values (p_menu_item_id) on conflict do nothing;
  update public.inventory set quantity_available = quantity_available + p_delta
  where menu_item_id = p_menu_item_id and quantity_available + p_delta >= 0
  returning quantity_available into v_after;
  if not found then
    perform private.fail(409, 'negative_stock', 'Stock cannot go below zero');
  end if;

  insert into public.inventory_movements (menu_item_id, outlet_id, delta, quantity_after, reason, actor_id, note)
  values (p_menu_item_id, v_outlet, p_delta, v_after, p_reason, auth.uid(), nullif(btrim(p_note), ''));
  return v_after;
end;
$$;

-- Turn quantity tracking on/off and/or set an absolute quantity and low-stock threshold.
create function app.set_stock_tracking(
  p_menu_item_id uuid, p_track boolean, p_quantity integer default null, p_low_threshold integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outlet uuid := private.item_outlet_for_manager(p_menu_item_id);
  v_before integer;
begin
  if p_quantity is not null and p_quantity < 0 then
    perform private.fail(422, 'invalid_quantity', 'Quantity cannot be negative');
  end if;
  if p_low_threshold is not null and p_low_threshold < 0 then
    perform private.fail(422, 'invalid_threshold', 'Threshold cannot be negative');
  end if;

  insert into public.inventory (menu_item_id) values (p_menu_item_id) on conflict do nothing;
  select quantity_available into v_before from public.inventory where menu_item_id = p_menu_item_id for update;

  update public.inventory set
    quantity_available = coalesce(p_quantity, quantity_available),
    low_stock_threshold = coalesce(p_low_threshold, low_stock_threshold)
  where menu_item_id = p_menu_item_id;

  if p_quantity is not null and p_quantity <> v_before then
    insert into public.inventory_movements (menu_item_id, outlet_id, delta, quantity_after, reason, actor_id, note)
    values (p_menu_item_id, v_outlet, p_quantity - v_before, p_quantity, 'manual_adjustment', auth.uid(), 'Set stock level');
  end if;

  update public.menu_items set track_quantity = p_track where id = p_menu_item_id;
end;
$$;

create function app.set_item_manual_status(p_menu_item_id uuid, p_status public.stock_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.item_outlet_for_manager(p_menu_item_id);
  update public.menu_items set manual_status = p_status where id = p_menu_item_id;
end;
$$;

-- Creates the outlet's pickup slots for one local date from its operating hours.
-- Idempotent: existing slots are left untouched. Returns the number created.
create function app.generate_pickup_slots(p_outlet_id uuid, p_date date)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outlet public.outlets;
  v_count integer;
begin
  perform private.require_outlet_manager(p_outlet_id);
  select * into v_outlet from public.outlets where id = p_outlet_id;
  if not found then
    perform private.fail(404, 'outlet_not_found', 'Outlet not found');
  end if;

  insert into public.pickup_slots (outlet_id, starts_at, ends_at, capacity)
  -- Local wall-clock timestamps converted to absolute time in the outlet's time zone.
  select p_outlet_id,
         t at time zone v_outlet.timezone,
         (t + make_interval(mins => v_outlet.slot_minutes)) at time zone v_outlet.timezone,
         v_outlet.default_slot_capacity
  from public.outlet_hours h
  cross join lateral generate_series(
    p_date + h.opens_at,
    p_date + h.closes_at - make_interval(mins => v_outlet.slot_minutes),
    make_interval(mins => v_outlet.slot_minutes)
  ) as t
  where h.outlet_id = p_outlet_id and h.day_of_week = extract(dow from p_date)
  on conflict (outlet_id, starts_at) do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function app.generate_upcoming_slots(p_days integer default 2)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outlet record;
  v_total integer := 0;
  v_day integer;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  for v_outlet in select id, timezone from public.outlets where is_active loop
    for v_day in 0..greatest(p_days, 0) loop
      v_total := v_total + app.generate_pickup_slots(
        v_outlet.id, ((now() at time zone v_outlet.timezone)::date + v_day));
    end loop;
  end loop;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- Read helpers exposing aggregates only (no other students' data).
-- ---------------------------------------------------------------------------

-- Kitchen backlog due within the next hour → transparent wait estimate (D-17):
-- each active order takes its longest item's prep time; the kitchen works on
-- `concurrent_orders` orders at once.
create function app.outlet_queue_stats(p_outlet_id uuid)
returns table (active_orders integer, estimated_wait_minutes integer)
language sql
stable
security definer
set search_path = ''
as $$
  with active as (
    select o.id, coalesce(max(oi.prep_minutes), 0) as prep
    from public.orders o
    join public.pickup_slots s on s.id = o.pickup_slot_id
    left join public.order_items oi on oi.order_id = o.id
    where o.outlet_id = p_outlet_id
      and o.status in ('placed', 'confirmed', 'preparing')
      and s.starts_at <= now() + interval '60 minutes'
    group by o.id
  )
  select count(*)::integer,
         ceil(coalesce(sum(prep), 0)::numeric / (select concurrent_orders from public.outlets where id = p_outlet_id))::integer
  from active;
$$;

-- Orders ahead of this one in its outlet's queue: earlier slot, then earlier placement, then
-- lower token (tokens are unique and increasing per outlet and day, so ties are impossible).
-- Visible to the order's owner and the outlet's staff; NULL when the order is not queued.
create function app.order_queue_position(p_order_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_slot_start timestamptz;
  v_ahead integer;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found or not (v_order.user_id = auth.uid() or private.is_outlet_staff(v_order.outlet_id) or private.is_admin()) then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.status not in ('placed', 'confirmed', 'preparing') then
    return null;
  end if;
  select starts_at into v_slot_start from public.pickup_slots where id = v_order.pickup_slot_id;

  select count(*) into v_ahead
  from public.orders o
  join public.pickup_slots s on s.id = o.pickup_slot_id
  where o.outlet_id = v_order.outlet_id
    and o.id <> v_order.id
    and o.status in ('placed', 'confirmed', 'preparing')
    and (s.starts_at, o.placed_at, o.token_number) < (v_slot_start, v_order.placed_at, v_order.token_number);
  return v_ahead;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on all functions in schema app from public;
revoke all on function private.fail(integer, text, text) from public;
revoke all on function private.is_system_caller() from public;
revoke all on function private.require_outlet_manager(uuid) from public;
revoke all on function private.release_order_reservations(public.orders, boolean, boolean, uuid) from public;
revoke all on function private.item_outlet_for_manager(uuid) from public;

-- End-user operations (each function authorizes the caller itself).
grant execute on function
  app.create_order(uuid, uuid, jsonb, text, text),
  app.transition_order(uuid, public.order_status, text),
  app.verify_pickup(uuid, text),
  app.set_outlet_status(uuid, public.outlet_status, text, integer),
  app.adjust_stock(uuid, integer, public.inventory_movement_reason, text),
  app.set_stock_tracking(uuid, boolean, integer, integer),
  app.set_item_manual_status(uuid, public.stock_status),
  app.generate_pickup_slots(uuid, date),
  app.order_queue_position(uuid)
to authenticated, service_role;

grant execute on function app.outlet_queue_stats(uuid) to anon, authenticated, service_role;

-- System-only operations: never granted to authenticated/anon.
grant execute on function
  app.confirm_order_payment(uuid, text),
  app.expire_pending_orders(integer),
  app.end_expired_breaks(),
  app.generate_upcoming_slots(integer)
to service_role;
