-- Payment boundary, tokens, visibility, state machine, pickup verification, refunds-due.
-- Students …0005 / …0006; manager A …0002; kitchen A …0003; manager B …0004.
begin;
\ir _helpers.psql
select plan(38);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
update public.pickup_slots set capacity = 20;

insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1}]', 'life-o1-key')),
  ('o2', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1}]', 'life-o2-key'));

-- Payment confirmation boundary ---------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.confirm_order_payment((select id from t_ids where name = 'o1'), 'forged') $$,
  '42501', null, 'end users cannot confirm payments');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ select app.confirm_order_payment((select id from t_ids where name = 'o1'), 'forged') $$,
  '42501', null, 'managers cannot confirm payments');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'confirmed') $$,
  'CC409', 'An order cannot move from payment_pending to confirmed', 'kitchen cannot accept an unpaid order');

select tests.as_superuser();
select tests.pay((select id from t_ids where name = 'o1'));
select tests.pay((select id from t_ids where name = 'o2'));
select results_eq(
  $$ select status::text, payment_status::text, token_label, reservation_expires_at is null
     from public.orders where id in (select id from t_ids) order by token_number $$,
  $$ values ('placed', 'paid', 'A-1', true), ('placed', 'paid', 'A-2', true) $$,
  'paid orders are placed and get sequential daily tokens'
);
select ok((select code ~ '^[A-HJ-NP-Z2-9]{6}$' from public.order_pickup_codes
  where order_id = (select id from t_ids where name = 'o1')), 'a 6-character pickup code is issued');
select lives_ok($$ select tests.pay((select id from t_ids where name = 'o1')) $$,
  'confirming again with the same reference is an idempotent no-op');
select is((select token_label from public.orders where id = (select id from t_ids where name = 'o1')), 'A-1',
  'replay did not issue a new token');
select throws_ok($$ select app.confirm_order_payment((select id from t_ids where name = 'o1'), 'other-ref') $$,
  'CC409', null, 'a different payment reference for a paid order is rejected');

-- Visibility ------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select results_eq($$ select id from public.orders $$, $$ select id from t_ids where name = 'o1' $$,
  'a student sees only their own order');
select is((select count(*)::int from public.order_pickup_codes), 1, 'the owner can read their pickup code');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is((select count(*)::int from public.orders), 2, 'kitchen staff see their outlet''s orders');
select is_empty($$ select 1 from public.order_pickup_codes $$, 'staff can never read pickup codes');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select is_empty($$ select 1 from public.orders $$, 'a manager of another outlet sees none of them');
select throws_ok($$ update public.orders set status = 'completed' $$,
  '42501', null, 'nobody can update orders directly');

-- Authorization of transitions -----------------------------------------------------------------
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'confirmed') $$,
  'CC404', null, 'staff of another outlet cannot act on the order (and learn nothing)');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'cancelled') $$,
  'CC404', null, 'another student cannot cancel someone else''s order');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'confirmed') $$,
  'CC409', 'An order cannot move from placed to confirmed', 'a student cannot accept their own order');

-- Queue position ---------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is(app.order_queue_position((select id from t_ids where name = 'o2')), 1,
  'the second order has one order ahead of it');
select throws_ok($$ select app.order_queue_position((select id from t_ids where name = 'o1')) $$,
  'CC404', null, 'students cannot probe other students'' orders');

-- Happy path through the kitchen ------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select lives_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'confirmed') $$, 'placed → confirmed');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'ready_for_pickup') $$,
  'CC409', 'An order cannot move from confirmed to ready_for_pickup', 'steps cannot be skipped');
select lives_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'preparing') $$, 'confirmed → preparing');
select lives_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'ready_for_pickup') $$, 'preparing → ready');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'completed') $$,
  'CC409', 'Completing an order requires verifying its pickup code', 'completion needs the pickup code');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'o1'), 'preparing') $$,
  'CC409', null, 'transitions are not reversible');

select is(app.verify_pickup((select id from t_ids where name = 'o1'), 'WRONG1'), 'invalid_code', 'a wrong code is refused');
select tests.as_superuser();
select is((select failed_attempts::int from public.order_pickup_codes where order_id = (select id from t_ids where name = 'o1')),
  1, 'the failed attempt is counted');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is(
  app.verify_pickup((select id from t_ids where name = 'o1'),
    lower((select code from public.order_pickup_codes c where c.order_id = (select id from t_ids where name = 'o1')))),
  'invalid_code',
  'staff cannot look the code up themselves (RLS hides it), so a guessed lookup fails'
);
select tests.as_superuser();
create temporary table t_code as
  select code from public.order_pickup_codes where order_id = (select id from t_ids where name = 'o1');
grant select on t_code to authenticated;
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is(app.verify_pickup((select id from t_ids where name = 'o1'), lower((select code from t_code))), 'completed',
  'the student''s code (case-insensitive) completes the pickup');
select tests.as_superuser();
select results_eq(
  $$ select array_agg(to_status::text order by id) from public.order_events
     where order_id = (select id from t_ids where name = 'o1') $$,
  $$ values (array['payment_pending','placed','confirmed','preparing','ready_for_pickup','completed']) $$,
  'the full history is recorded in order'
);
select ok((select completed_at is not null and version = 6 from public.orders where id = (select id from t_ids where name = 'o1')),
  'completion is timestamped and every change bumped the version');

-- Lockout after 5 wrong codes ----------------------------------------------------------------------
update public.orders set status = 'ready_for_pickup' where id = (select id from t_ids where name = 'o2');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select app.verify_pickup((select id from t_ids where name = 'o2'), 'BAD' || g) from generate_series(1, 5) g;
select tests.as_superuser();
create temporary table t_code2 as
  select code from public.order_pickup_codes where order_id = (select id from t_ids where name = 'o2');
grant select on t_code2 to authenticated;
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is(app.verify_pickup((select id from t_ids where name = 'o2'), (select code from t_code2)), 'locked',
  'after 5 wrong attempts even the right code is refused');

-- Cancellations, rejections and what they release --------------------------------------------------
select tests.as_superuser();
insert into t_ids values
  ('pending', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":2}]', 'life-pending-key')),
  ('reject', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000002',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000003","quantity":1}]', 'life-reject-key'));
select tests.pay((select id from t_ids where name = 'reject'));

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select lives_ok($$ select app.transition_order((select id from t_ids where name = 'pending'), 'cancelled') $$,
  'a student can abandon an unpaid order');
select tests.as_superuser();
select results_eq(
  $$ select status::text, refund_status::text, cancelled_by::text from public.orders where id = (select id from t_ids where name = 'pending') $$,
  $$ values ('cancelled', 'none', 'student') $$,
  'an unpaid cancellation owes no refund'
);
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 3, 'its stock went back (5 − o1 − o2 = 3)');

select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.transition_order((select id from t_ids where name = 'reject'), 'rejected', '  ') $$,
  'CC422', 'Please give a reason', 'rejecting needs a reason');
select lives_ok($$ select app.transition_order((select id from t_ids where name = 'reject'), 'rejected', 'Fryer broken') $$,
  'kitchen rejects a paid order with a reason');
select tests.as_superuser();
select results_eq(
  $$ select o.status::text, o.refund_status::text, o.cancel_reason,
            (select quantity_available from public.inventory where menu_item_id = '30000000-0000-4000-d000-000000000003'),
            (select reserved_count from public.pickup_slots where id = '40000000-0000-4000-e000-000000000002')
     from public.orders o where o.id = (select id from t_ids where name = 'reject') $$,
  $$ values ('rejected', 'required', 'Fryer broken', 1, 0) $$,
  'rejection marks a refund as owed and releases stock and the slot'
);

select * from finish();
rollback;
