-- D-19 no-show policy: deadline, no refund, packaged items restocked, prepared items listed as a
-- discounted deal, buying a deal (hold, cancel, pay → ready with a new owner), expiry, withdrawal.
-- Students …0005 (stu1) / …0006 (stu2); kitchen A …0003; manager B …0004 (also buys as a customer).
begin;
\ir _helpers.psql
select plan(45);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
update public.pickup_slots set capacity = 20;
-- Chai is packaged (tracked, 5 in stock); Sandwich is prepared food (untracked, ₹70).
update public.menu_items set is_packaged = true where id = '30000000-0000-4000-d000-000000000001';

insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1},
       {"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":2}]', 'ns-o1-key')),
  ('o3', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'ns-o3-key')),
  ('o4', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'ns-o4-key')),
  ('o5', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'ns-o5-key')),
  -- Packaged only: no deal should be created for it.
  ('o6', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1}]', 'ns-o6-key'));

select results_eq(
  $$ select item_name, is_packaged from public.order_items where order_id = (select id from t_ids where name = 'o1') order by item_name $$,
  $$ values ('Fixture Chai', true), ('Fixture Sandwich', false) $$,
  'order lines snapshot whether each item is packaged'
);
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 3, 'two packaged chai are reserved by orders');

select tests.pay(id) from t_ids;
select tests.kitchen_ready(id) from t_ids;

-- Before the deadline nothing happens -----------------------------------------------------------
select is(app.process_no_shows(), 0, 'orders still inside their pickup window are left alone');
select is((select count(*)::int from public.orders where status = 'ready_for_pickup'
  and outlet_id = '20000000-0000-4000-b000-00000000000a'), 5, 'all five stay ready');

-- Deadline = later of (ready, slot end) + grace. Ready long ago but slot not over yet → not due.
update public.orders set ready_at = now() - interval '2 hours' where id = (select id from t_ids where name = 'o1');
select is(app.process_no_shows(), 0, 'an order ready early is not a no-show before its slot has ended');

select tests.make_overdue(id) from t_ids;

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.process_no_shows() $$, '42501', null, 'students cannot run the no-show job');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ select app.process_no_shows() $$, '42501', null, 'managers cannot run the no-show job');
select tests.as_superuser();

select is(app.process_no_shows(), 5, 'overdue ready orders are processed');
select is(app.process_no_shows(), 0, 'processing again does nothing (idempotent)');

select results_eq(
  $$ select status::text, refund_status::text, payment_status::text, no_show_at is not null
     from public.orders where id = (select id from t_ids where name = 'o1') $$,
  $$ values ('no_show', 'none', 'paid', true) $$,
  'the order is a no-show, still paid, with no refund owed'
);
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 5, 'packaged chai from both orders went back into stock');
select results_eq(
  $$ select delta, reason::text from public.inventory_movements
     where order_id = (select id from t_ids where name = 'o1') order by id $$,
  $$ values (-1, 'order_reserved'), (1, 'no_show_return') $$,
  'the stock ledger records the return'
);
select ok(
  (select reason like '%no refund%' and reason like '%50% off%' from public.order_events
   where order_id = (select id from t_ids where name = 'o1') and event_type = 'no_show'),
  'the order history explains the outcome'
);

insert into t_ids select 'deal1', id from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o1');
select results_eq(
  $$ select status::text, discount_percent::int, original_price_paise, price_paise, item_count,
            expires_at between now() + interval '29 minutes' and now() + interval '31 minutes'
     from public.surplus_deals where id = (select id from t_ids where name = 'deal1') $$,
  $$ values ('available', 50, 14000, 7000, 2, true) $$,
  'prepared food is listed at 50% of what was paid, for 30 minutes'
);
select results_eq(
  $$ select item_name, quantity, original_unit_price_paise, deal_unit_price_paise
     from public.surplus_deal_items where deal_id = (select id from t_ids where name = 'deal1') $$,
  $$ values ('Fixture Sandwich', 2, 7000, 3500) $$,
  'only the prepared items are in the deal'
);
select is_empty(
  $$ select 1 from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o6') $$,
  'an order with only packaged items creates no deal'
);

-- Visibility ------------------------------------------------------------------------------------
select tests.as_anon();
select is((select count(*)::int from public.surplus_deals), 4, 'signed-out visitors see the deals on sale');
select ok((select count(*) > 0 from public.surplus_deal_items), 'and their items');
select throws_ok($$ select 1 from public.orders $$, '42501', null, 'but never the orders they came from');
select tests.as_superuser();

-- Buying a deal ------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.claim_deal((select id from t_ids where name = 'deal1'), 'claim-own-key') $$,
  'CC409', null, 'the student who did not collect cannot buy their own food back as a deal');

select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
insert into t_ids values ('d1', app.claim_deal((select id from t_ids where name = 'deal1'), 'claim-d1-key'));
select is(app.claim_deal((select id from t_ids where name = 'deal1'), 'claim-d1-key'), (select id from t_ids where name = 'd1'),
  'retrying with the same idempotency key returns the same order');
select results_eq(
  $$ select status::text, total_paise, item_count, pickup_slot_id is null, source_deal_id
     from public.orders where id = (select id from t_ids where name = 'd1') $$,
  $$ select 'payment_pending', 7000, 2, true, (select id from t_ids where name = 'deal1') $$,
  'the deal order is unpaid, priced by the server, with no pickup slot'
);
select is((select count(*)::int from public.surplus_deals where id = (select id from t_ids where name = 'deal1')), 1,
  'the buyer can still see the deal they hold');
select tests.as_superuser();
select results_eq(
  $$ select status::text, reserved_order_id from public.surplus_deals where id = (select id from t_ids where name = 'deal1') $$,
  $$ select 'reserved', (select id from t_ids where name = 'd1') $$,
  'the deal is held for that order'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.claim_deal((select id from t_ids where name = 'deal1'), 'claim-mgrb-key') $$,
  'CC409', 'Someone else got this deal first, or it has ended', 'a held deal cannot be bought by anyone else');

-- Cancelling the unpaid deal order puts the deal back on sale (and touches no stock).
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select lives_ok($$ select app.transition_order((select id from t_ids where name = 'd1'), 'cancelled') $$,
  'the buyer can abandon the unpaid deal order');
select tests.as_superuser();
select is((select status::text from public.surplus_deals where id = (select id from t_ids where name = 'deal1')), 'available',
  'the deal is on sale again');
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 5, 'cancelling a deal order does not change stock');

-- An unpaid hold that times out also releases the deal.
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
insert into t_ids values ('d_mgr', app.claim_deal((select id from t_ids where name = 'deal1'), 'claim-mgrb-2-key'));
select tests.as_superuser();
update public.orders set reservation_expires_at = now() - interval '1 second' where id = (select id from t_ids where name = 'd_mgr');
select is(app.expire_pending_orders(), 1, 'the unpaid deal order expires');
select is((select status::text from public.surplus_deals where id = (select id from t_ids where name = 'deal1')), 'available',
  'its deal is back on sale');

-- Paying: the food is already there, so the order goes straight to the counter with a new owner.
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
insert into t_ids values ('d2', app.claim_deal((select id from t_ids where name = 'deal1'), 'claim-d2-key'));
select tests.as_superuser();
select tests.pay((select id from t_ids where name = 'd2'));
select results_eq(
  $$ select status::text, payment_status::text, token_label is not null, ready_at is not null
     from public.orders where id = (select id from t_ids where name = 'd2') $$,
  $$ values ('ready_for_pickup', 'paid', true, true) $$,
  'a paid deal order is ready for pickup with its own token'
);
select is((select count(*)::int from public.order_pickup_codes where order_id = (select id from t_ids where name = 'd2')), 1,
  'the new owner gets their own pickup code');
select results_eq(
  $$ select status::text, sold_order_id, closed_at is not null from public.surplus_deals where id = (select id from t_ids where name = 'deal1') $$,
  $$ select 'sold', (select id from t_ids where name = 'd2'), true $$,
  'the deal is sold to that order'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select results_eq(
  $$ select customer_name from app.order_customer_names(array[(select id from t_ids where name = 'd2')]) $$,
  $$ values ('Student Two') $$,
  'the counter sees the new owner''s name'
);
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select is_empty($$ select 1 from app.order_customer_names(array[(select id from t_ids where name = 'd2')]) $$,
  'staff of another outlet see no customer names');
select tests.as_superuser();

-- Expiry and withdrawal -------------------------------------------------------------------------
update public.surplus_deals set listed_at = now() - interval '40 minutes', expires_at = now() - interval '10 minutes'
where source_order_id = (select id from t_ids where name = 'o3');
select is(app.expire_surplus_deals(), 1, 'an unsold deal past its listing time expires');
select results_eq(
  $$ select status::text, close_reason from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o3') $$,
  $$ values ('expired', 'Not sold before the listing ended') $$,
  'and is recorded as unsold'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ select app.withdraw_deal((select id from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o4')), 'gone') $$,
  'CC404', null, 'students cannot withdraw deals');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok(
  $$ select app.withdraw_deal((select id from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o4')), ' ') $$,
  'CC422', null, 'withdrawing needs a reason');
select lives_ok(
  $$ select app.withdraw_deal((select id from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o4')), 'Given to staff meal') $$,
  'kitchen staff can withdraw a deal');
select tests.as_superuser();
select is((select status::text from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o4')), 'withdrawn',
  'the deal is off sale');

-- An uncollected deal order becomes a no-show too, but is not listed again.
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
insert into t_ids values ('d5', app.claim_deal((select id from public.surplus_deals where source_order_id = (select id from t_ids where name = 'o5')), 'claim-d5-key'));
select tests.as_superuser();
select tests.pay((select id from t_ids where name = 'd5'));
update public.orders set ready_at = now() - interval '20 minutes' where id = (select id from t_ids where name = 'd5');
select is(app.process_no_shows(), 1, 'the uncollected deal order is processed');
select is((select status::text from public.orders where id = (select id from t_ids where name = 'd5')), 'no_show', 'it is a no-show');
select is_empty($$ select 1 from public.surplus_deals where source_order_id = (select id from t_ids where name = 'd5') $$,
  'food from a deal order is not relisted');

select ok(exists (select 1 from public.order_status_transitions
  where from_status = 'ready_for_pickup' and to_status = 'no_show' and actor = 'system' and not marks_refund_required),
  'the state machine lists the no-show transition (system only, no refund)');

select * from finish();
rollback;
