-- Transactional order creation: pricing, reservations, atomicity, idempotency, validation.
-- Items: Chai …d001 (tracked 5, ₹20), Sandwich …d002 (untracked, ₹70), Samosa …d003 (tracked 1),
-- Coffee …d004 (outlet B). Slots: S1 …e001 (+1h cap 2), S2 …e002 (+2h cap 1), S3 …e003 (too soon),
-- S4 …e004 (outlet B).
begin;
\ir _helpers.psql
select plan(29);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;

-- Happy path ------------------------------------------------------------------------------
-- A cart that should be cleared by checkout.
insert into public.carts (user_id, outlet_id) values ('10000000-0000-4000-a000-000000000005', '20000000-0000-4000-b000-00000000000a');
insert into public.cart_items (user_id, outlet_id, menu_item_id, quantity)
  values ('10000000-0000-4000-a000-000000000005', '20000000-0000-4000-b000-00000000000a', '30000000-0000-4000-d000-000000000002', 1);

insert into t_ids select 'first', tests.order_as('10000000-0000-4000-a000-000000000005',
  '40000000-0000-4000-e000-000000000001',
  '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1},
    {"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1},
    {"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1}]', 'key-first-0001');

select results_eq(
  $$ select status::text, payment_status::text, subtotal_paise, total_paise, item_count, token_label
     from public.orders where id = (select id from t_ids where name = 'first') $$,
  $$ values ('payment_pending', 'unpaid', 11000, 11000, 3, null::text) $$,
  'order is created unpaid with server-computed totals (2×₹20 + ₹70)'
);
select results_eq(
  $$ select item_name, unit_price_paise, quantity, line_total_paise from public.order_items
     where order_id = (select id from t_ids where name = 'first') order by item_name $$,
  $$ values ('Fixture Chai', 2000, 2, 4000), ('Fixture Sandwich', 7000, 1, 7000) $$,
  'duplicate lines are merged and prices/names are snapshotted'
);
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 3, 'tracked stock is reserved (5 → 3)');
select is(tests.reserved('40000000-0000-4000-e000-000000000001'), 1, 'pickup capacity is reserved');
select ok(
  (select reservation_expires_at between now() + interval '9 minutes' and now() + interval '11 minutes'
   from public.orders where id = (select id from t_ids where name = 'first')),
  'reservation expires after the outlet''s TTL (10 min)'
);
select results_eq(
  $$ select delta, quantity_after, reason::text from public.inventory_movements
     where order_id = (select id from t_ids where name = 'first') $$,
  $$ values (-2, 3, 'order_reserved') $$,
  'the reservation is recorded in the stock ledger (untracked items are not)'
);
select results_eq(
  $$ select event_type, to_status::text, actor::text from public.order_events
     where order_id = (select id from t_ids where name = 'first') $$,
  $$ values ('created', 'payment_pending', 'student') $$,
  'a created event is recorded'
);
select is_empty($$ select 1 from public.carts where user_id = '10000000-0000-4000-a000-000000000005' $$,
  'checkout clears the cart for that outlet');

-- Idempotency -----------------------------------------------------------------------------
select is(
  tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
    '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":2}]', 'key-first-0001'),
  (select id from t_ids where name = 'first'),
  'replaying the same idempotency key returns the original order'
);
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 3, 'a replay reserves nothing more');
select is(tests.reserved('40000000-0000-4000-e000-000000000001'), 1, 'a replay takes no extra slot capacity');

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-first-0001', 'different-hash') $$,
  'CC409', 'This idempotency key was already used for a different order',
  'reusing a key for a different request is rejected'
);

-- Atomicity: a later line failing must undo earlier reservations --------------------------------
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1},
         {"menu_item_id":"30000000-0000-4000-d000-000000000003","quantity":2}]', 'key-atomic-0001', 'h') $$,
  'CC409', 'Not enough Fixture Samosa left',
  'an order exceeding stock on any line is rejected'
);
select tests.as_superuser();
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 3, 'the chai reserved before the failing line was released');
select is(tests.stock('30000000-0000-4000-d000-000000000003'), 1, 'samosa stock is untouched');
select is(tests.reserved('40000000-0000-4000-e000-000000000001'), 1, 'no slot capacity was taken');
select is((select count(*)::int from public.orders where outlet_id = '20000000-0000-4000-b000-00000000000a'), 1,
  'no order row was left behind');

-- Slot rules --------------------------------------------------------------------------------
select lives_ok(
  $$ select tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000002',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-s2-student2') $$,
  'the last place in a slot can be taken'
);
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000002',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-s2-student1', 'h') $$,
  'CC409', 'That pickup slot is full', 'a full slot is rejected'
);
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000003',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-s3-toosoon', 'h') $$,
  'CC409', 'That pickup slot is too soon for the kitchen to prepare your order',
  'a slot sooner than the longest prep time is rejected'
);
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000004',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-s4-otheroutlet', 'h') $$,
  'CC409', 'That pickup slot is not available', 'a slot belonging to another outlet is rejected'
);

-- Item and outlet rules -----------------------------------------------------------------------
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000004","quantity":1}]', 'key-foreign-item', 'h') $$,
  'CC422', null, 'an item from another outlet is rejected'
);
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":21}]', 'key-too-many-qty', 'h') $$,
  'CC422', null, 'quantities above 20 are rejected'
);
select tests.as_superuser();
update public.menu_items set manual_status = 'sold_out' where id = '30000000-0000-4000-d000-000000000002';
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-sold-out-01', 'h') $$,
  'CC409', 'Fixture Sandwich is sold out', 'a sold-out item is rejected'
);
select tests.as_superuser();
update public.menu_items set manual_status = 'available' where id = '30000000-0000-4000-d000-000000000002';
update public.outlets set status = 'closed', status_reason = 'Exam week' where id = '20000000-0000-4000-b000-00000000000a';
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-closed-0001', 'h') $$,
  'CC409', 'Outlet is not accepting orders: Exam week', 'a closed outlet blocks new orders and says why'
);
select tests.as_superuser();
update public.outlets set status = 'on_break', break_until = now() - interval '1 minute'
  where id = '20000000-0000-4000-b000-00000000000a';
select lives_ok(
  $$ select tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-break-over-1') $$,
  'a break whose end time has passed no longer blocks orders'
);

-- Abuse control: at most 3 unpaid orders per student -------------------------------------------
select lives_ok(
  $$ select tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000004',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000004","quantity":1}]', 'key-pending-0003',
       '20000000-0000-4000-b000-00000000000b') $$,
  'third unpaid order is allowed'
);
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000b', '40000000-0000-4000-e000-000000000004',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000004","quantity":1}]', 'key-pending-0004', 'h') $$,
  'CC409', null, 'a fourth unpaid order is refused'
);

-- Privileges ------------------------------------------------------------------------------------
select tests.as_anon();
select throws_ok(
  $$ select app.create_order('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001',
       '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'key-anon-000001', 'h') $$,
  '42501', null, 'signed-out visitors cannot place orders'
);

select * from finish();
rollback;
