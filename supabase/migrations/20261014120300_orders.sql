-- Phase 2 · Orders, order items (price snapshots), events, pickup codes, daily tokens,
-- and the explicit order state machine.

create type public.order_status as enum (
  'payment_pending', 'placed', 'confirmed', 'preparing', 'ready_for_pickup',
  'completed', 'cancelled', 'rejected'
);
create type public.payment_status as enum ('unpaid', 'paid');
-- Refunds are tracked separately from status so the order keeps why it ended
-- (cancelled vs rejected). 'refunded' is set by the Phase 5 refund workflow.
create type public.refund_status as enum ('none', 'required', 'refunded');
create type public.order_actor as enum ('student', 'staff', 'system');

-- ---------------------------------------------------------------------------
-- The state machine. A transition not listed here is illegal. No transition is reversible.
-- ---------------------------------------------------------------------------
create table public.order_status_transitions (
  from_status public.order_status not null,
  to_status public.order_status not null,
  actor public.order_actor not null,
  requires_paid boolean not null default false,
  requires_reason boolean not null default false,
  requires_pickup_code boolean not null default false,
  releases_stock boolean not null default false,
  releases_slot boolean not null default false,
  -- When the order was paid, moving through this transition owes the student a refund.
  marks_refund_required boolean not null default false,
  description text not null,
  primary key (from_status, to_status, actor)
);

insert into public.order_status_transitions
  (from_status, to_status, actor, requires_paid, requires_reason, requires_pickup_code,
   releases_stock, releases_slot, marks_refund_required, description)
values
  ('payment_pending', 'placed', 'system', false, false, false, false, false, false,
   'Verified payment received (app.confirm_order_payment only)'),
  ('payment_pending', 'cancelled', 'student', false, false, false, true, true, false,
   'Student abandons an unpaid order'),
  ('payment_pending', 'cancelled', 'system', false, false, false, true, true, false,
   'Unpaid reservation expired'),
  ('placed', 'confirmed', 'staff', true, false, false, false, false, false,
   'Kitchen accepts the order'),
  ('placed', 'rejected', 'staff', true, true, false, true, true, true,
   'Kitchen rejects the order before accepting it'),
  ('placed', 'cancelled', 'student', true, false, false, true, true, true,
   'Student cancels before the kitchen accepts'),
  ('confirmed', 'preparing', 'staff', true, false, false, false, false, false,
   'Kitchen starts preparing'),
  ('confirmed', 'cancelled', 'staff', true, true, false, true, true, true,
   'Kitchen cancels an accepted order before preparation (exception)'),
  ('preparing', 'ready_for_pickup', 'staff', true, false, false, false, false, false,
   'Food is ready at the counter'),
  ('preparing', 'cancelled', 'staff', true, true, false, false, true, true,
   'Kitchen cancels during preparation; ingredients are consumed so stock is not released'),
  ('ready_for_pickup', 'completed', 'staff', true, false, true, false, false, false,
   'Student collected the food (pickup code verified; app.verify_pickup only)');

revoke all on public.order_status_transitions from anon, authenticated;
grant select on public.order_status_transitions to anon, authenticated;
alter table public.order_status_transitions enable row level security;
create policy order_status_transitions_select on public.order_status_transitions
  for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT: financial history is retained; a user with orders cannot be hard-deleted.
  user_id uuid not null references auth.users (id) on delete restrict,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  pickup_slot_id uuid not null,
  status public.order_status not null default 'payment_pending',
  payment_status public.payment_status not null default 'unpaid',
  refund_status public.refund_status not null default 'none',
  subtotal_paise integer not null constraint orders_subtotal_positive check (subtotal_paise > 0),
  total_paise integer not null constraint orders_total_positive check (total_paise > 0),
  item_count integer not null constraint orders_item_count_positive check (item_count > 0),
  -- Digital token, assigned when payment is confirmed (report: "once paid, the student gets a token").
  business_date date,
  token_number integer,
  token_label text,
  idempotency_key text not null
    constraint orders_idempotency_key_length check (char_length(idempotency_key) between 8 and 100),
  request_hash text not null,
  payment_reference text
    constraint orders_payment_reference_length check (char_length(payment_reference) <= 200),
  reservation_expires_at timestamptz,
  placed_at timestamptz,
  confirmed_at timestamptz,
  preparing_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text constraint orders_cancel_reason_length check (char_length(cancel_reason) <= 300),
  cancelled_by public.order_actor,
  -- Incremented on every change; clients use it to drop stale/duplicate Realtime events.
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (pickup_slot_id, outlet_id)
    references public.pickup_slots (id, outlet_id) on delete restrict,
  unique (user_id, idempotency_key),
  unique (outlet_id, business_date, token_number),
  constraint orders_pending_has_expiry
    check (status <> 'payment_pending' or reservation_expires_at is not null),
  constraint orders_past_pending_are_paid
    check (payment_status = 'paid' or status in ('payment_pending', 'cancelled')),
  constraint orders_token_only_when_paid
    check (token_number is null or payment_status = 'paid'),
  constraint orders_refund_only_when_paid
    check (refund_status = 'none' or payment_status = 'paid')
);

create index orders_user_created_idx on public.orders (user_id, created_at desc, id desc);
create index orders_outlet_active_idx on public.orders (outlet_id, status)
  where status in ('placed', 'confirmed', 'preparing', 'ready_for_pickup');
create index orders_slot_idx on public.orders (pickup_slot_id);
create index orders_pending_expiry_idx on public.orders (reservation_expires_at)
  where status = 'payment_pending';

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function private.set_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  -- Snapshot fields below keep history intact if the menu item later changes or is deleted.
  menu_item_id uuid references public.menu_items (id) on delete set null,
  item_name text not null,
  unit_price_paise integer not null constraint order_items_unit_price_positive check (unit_price_paise > 0),
  quantity integer not null constraint order_items_quantity_range check (quantity between 1 and 20),
  line_total_paise integer not null,
  prep_minutes smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint order_items_line_total check (line_total_paise = unit_price_paise * quantity)
);

create index order_items_order_idx on public.order_items (order_id);
create index order_items_menu_item_idx on public.order_items (menu_item_id);

-- Append-only order history (also serves as status history).
create table public.order_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders (id) on delete cascade,
  event_type text not null constraint order_events_type check (
    event_type in ('created', 'payment_confirmed', 'status_changed', 'expired', 'pickup_verified')),
  from_status public.order_status,
  to_status public.order_status not null,
  actor public.order_actor not null,
  actor_id uuid references auth.users (id) on delete set null,
  reason text constraint order_events_reason_length check (char_length(reason) <= 300),
  created_at timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id, id);
create index order_events_actor_idx on public.order_events (actor_id);

-- Secret pickup code shown only to the order owner (QR on the Digital Food Pass). Staff
-- verify it with app.verify_pickup but can never read it. Not published to Realtime.
create table public.order_pickup_codes (
  order_id uuid primary key references public.orders (id) on delete cascade,
  code text not null constraint order_pickup_codes_format check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  failed_attempts smallint not null default 0,
  created_at timestamptz not null default now()
);

-- Per-outlet daily token counters (server-internal).
create table private.outlet_token_counters (
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  business_date date not null,
  last_number integer not null,
  primary key (outlet_id, business_date)
);
revoke all on private.outlet_token_counters from public, anon, authenticated;

alter table public.inventory_movements
  add constraint inventory_movements_order_fk
  foreign key (order_id) references public.orders (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Privileges: clients read under RLS; every write goes through app.* functions.
-- ---------------------------------------------------------------------------
revoke all on public.orders, public.order_items, public.order_events, public.order_pickup_codes
  from anon, authenticated;
grant select on public.orders, public.order_items, public.order_events, public.order_pickup_codes
  to authenticated;

alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_events enable row level security;
alter table public.order_pickup_codes enable row level security;

create policy orders_select on public.orders
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.is_outlet_staff(outlet_id))
    or (select private.is_admin())
  );

create policy order_items_select on public.order_items
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

create policy order_events_select on public.order_events
  for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id));

create policy order_pickup_codes_select_owner on public.order_pickup_codes
  for select to authenticated
  using (exists (
    select 1 from public.orders o where o.id = order_id and o.user_id = (select auth.uid())
  ));

-- Order history must stay readable even if its outlet or pickup slot is later deactivated:
-- a user can always see the outlet and slot of their own orders (permissive policies OR
-- together with the public visibility policies).
create policy outlets_select_for_own_orders on public.outlets
  for select to authenticated
  using (exists (
    select 1 from public.orders o where o.outlet_id = outlets.id and o.user_id = (select auth.uid())
  ));

create policy pickup_slots_select_for_own_orders on public.pickup_slots
  for select to authenticated
  using (exists (
    select 1 from public.orders o where o.pickup_slot_id = pickup_slots.id and o.user_id = (select auth.uid())
  ));
