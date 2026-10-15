-- Group orders, party bookings, bill splits. Students …0005 (stu1) / …0006 (stu2); manager B …0004
-- also orders as a customer at outlet A; admin …0001 plays an outsider; manager A …0002.
begin;
\ir _helpers.psql
select plan(38);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
update public.pickup_slots set capacity = 50;

create function pg_temp.fund(p_user uuid, p_ref text) returns void language sql as $$
  select app.register_payment(p_user, 'wallet_topup', null, 500000, p_ref);
  select app.capture_payment(p_ref, 'pay-' || p_ref, 500000);
$$;
create function pg_temp.balance(p_user uuid) returns integer language sql as $$
  select coalesce((select balance_paise from public.wallet_accounts where user_id = p_user), 0);
$$;
create function pg_temp.points(p_user uuid) returns integer language sql as $$
  select coalesce((select balance_points from public.loyalty_accounts where user_id = p_user), 0);
$$;

-- Group order (by dish) ----------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
insert into t_ids values ('g1', app.create_group('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001'));
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.group_sessions $$, 'nobody outside the group can read it (or its invite code)');
select throws_ok($$ select app.join_group('ZZZZZZ') $$, 'CC404', null, 'a wrong code finds nothing');
select tests.as_superuser();
select set_config('test.code', (select invite_code from public.group_sessions where id = (select id from t_ids where name = 'g1')), true);
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is(app.join_group(lower(current_setting('test.code'))), (select id from t_ids where name = 'g1'), 'a friend joins with the code');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select app.join_group(current_setting('test.code'));

select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select is_empty($$ select 1 from public.group_sessions $$, 'outsiders can''t see the group');
select throws_ok($$ select app.set_group_item((select id from t_ids where name = 'g1'), auth.uid(), '30000000-0000-4000-d000-000000000002', 1) $$,
  'CC404', null, 'or add to it');

select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select lives_ok($$ select app.set_group_item((select id from t_ids where name = 'g1'), auth.uid(), '30000000-0000-4000-d000-000000000002', 1) $$,
  'a member adds their own dish');
select throws_ok($$ select app.set_group_item((select id from t_ids where name = 'g1'), '10000000-0000-4000-a000-000000000005', '30000000-0000-4000-d000-000000000002', 1) $$,
  'CC403', null, 'members can''t change other people''s items');
select throws_ok($$ select app.lock_group((select id from t_ids where name = 'g1')) $$, 'CC403', null, 'only the host checks out');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select lives_ok($$ select app.set_group_item((select id from t_ids where name = 'g1'), '10000000-0000-4000-a000-000000000004', '30000000-0000-4000-d000-000000000001', 1) $$,
  'the host adds a dish for a member');
select app.set_group_item((select id from t_ids where name = 'g1'), auth.uid(), '30000000-0000-4000-d000-000000000002', 1);
insert into t_ids values ('g1_order', app.lock_group((select id from t_ids where name = 'g1')));
select results_eq(
  $$ select user_id, amount_paise from public.group_shares where session_id = (select id from t_ids where name = 'g1') order by user_id $$,
  $$ values ('10000000-0000-4000-a000-000000000004'::uuid, 2000), ('10000000-0000-4000-a000-000000000005'::uuid, 7000),
            ('10000000-0000-4000-a000-000000000006'::uuid, 7000) $$,
  'by-dish shares: each pays for their own items'
);
select is((select total_paise from public.orders where id = (select id from t_ids where name = 'g1_order')), 16000,
  'one order for the whole tray, priced by the server');
select throws_ok($$ select app.set_group_item((select id from t_ids where name = 'g1'), auth.uid(), '30000000-0000-4000-d000-000000000002', 2) $$,
  'CC409', null, 'the tray is frozen after checkout');

select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is((select count(*)::int from public.orders where id = (select id from t_ids where name = 'g1_order')), 1,
  'members can follow the group''s order');
select throws_ok($$ select app.pay_group_share((select id from t_ids where name = 'g1')) $$, 'CC409', null,
  'a member with an empty wallet can''t pay');

select tests.as_superuser();
select pg_temp.fund('10000000-0000-4000-a000-000000000005', 'soc-1');
select pg_temp.fund('10000000-0000-4000-a000-000000000006', 'soc-2');
select pg_temp.fund('10000000-0000-4000-a000-000000000004', 'soc-3');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.pay_group_share((select id from t_ids where name = 'g1'));
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select app.pay_group_share((select id from t_ids where name = 'g1'));
select app.pay_group_share((select id from t_ids where name = 'g1'));
select is((select status::text from public.orders where id = (select id from t_ids where name = 'g1_order')), 'payment_pending',
  'the kitchen waits until every share is paid (a retry didn''t pay twice)');
select is(pg_temp.balance(auth.uid()), 500000 - 7000, 'the member paid their share once');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select app.pay_group_share((select id from t_ids where name = 'g1'));
select tests.as_superuser();
select results_eq(
  $$ select o.status::text, o.payment_status::text, o.token_label is not null, s.status::text
     from public.orders o join public.group_sessions s on s.order_id = o.id where o.id = (select id from t_ids where name = 'g1_order') $$,
  $$ values ('placed', 'paid', true, 'paid') $$,
  'the last share sends the order to the kitchen'
);
select results_eq(
  $$ select pg_temp.points('10000000-0000-4000-a000-000000000005'), pg_temp.points('10000000-0000-4000-a000-000000000006'),
            pg_temp.points('10000000-0000-4000-a000-000000000004') $$,
  $$ values (57, 57, 52) $$, 'each member earns points on their own share (+50 each for the ₹5,000 top-up)');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.order_pickup_codes $$, 'the pickup code stays with the host');

-- A paid group order that the kitchen rejects refunds every member's share.
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select app.transition_order((select id from t_ids where name = 'g1_order'), 'rejected', 'Gas ran out');
select tests.as_superuser();
select app.payout_refunds();
select results_eq(
  $$ select pg_temp.balance('10000000-0000-4000-a000-000000000005'), pg_temp.balance('10000000-0000-4000-a000-000000000006'),
            pg_temp.balance('10000000-0000-4000-a000-000000000004') $$,
  $$ values (500000, 500000, 500000) $$, 'every member gets their own share back');
select results_eq(
  $$ select pg_temp.points('10000000-0000-4000-a000-000000000005'), pg_temp.points('10000000-0000-4000-a000-000000000006'),
            pg_temp.points('10000000-0000-4000-a000-000000000004') $$,
  $$ values (50, 50, 50) $$, 'and the order points are reversed once each');

-- Percent split, then the payment window runs out --------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
insert into t_ids values ('g2', app.create_group('20000000-0000-4000-b000-00000000000a', '40000000-0000-4000-e000-000000000001'));
select tests.as_superuser();
select set_config('test.code2', (select invite_code from public.group_sessions where id = (select id from t_ids where name = 'g2')), true);
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select app.join_group(current_setting('test.code2'));
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.set_group_item((select id from t_ids where name = 'g2'), auth.uid(), '30000000-0000-4000-d000-000000000002', 2);
select throws_ok($$ select app.set_group_split((select id from t_ids where name = 'g2'), 'percent',
  '{"10000000-0000-4000-a000-000000000005": 70, "10000000-0000-4000-a000-000000000006": 20}') $$,
  'CC422', 'Percentages must add up to 100', 'percentages must add up to 100');
select lives_ok($$ select app.set_group_split((select id from t_ids where name = 'g2'), 'percent',
  '{"10000000-0000-4000-a000-000000000005": 70, "10000000-0000-4000-a000-000000000006": 30}') $$, 'a 70/30 split');
insert into t_ids values ('g2_order', app.lock_group((select id from t_ids where name = 'g2')));
select results_eq($$ select amount_paise from public.group_shares where session_id = (select id from t_ids where name = 'g2') order by user_id $$,
  $$ values (9800), (4200) $$, '70% and 30% of ₹140 in integer paise');
select app.pay_group_share((select id from t_ids where name = 'g2'));
select tests.as_superuser();
update public.orders set reservation_expires_at = now() - interval '1 second' where id = (select id from t_ids where name = 'g2_order');
select app.expire_pending_orders();
select results_eq(
  $$ select s.status::text, pg_temp.balance('10000000-0000-4000-a000-000000000005'), pg_temp.points('10000000-0000-4000-a000-000000000005')
     from public.group_sessions s where s.id = (select id from t_ids where name = 'g2') $$,
  $$ values ('cancelled', 500000, 50) $$,
  'if not everyone pays in time, paid shares (and their points) are returned'
);

-- Party bookings -------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.request_party('20000000-0000-4000-b000-00000000000a', 'Hackathon', now() + interval '2 hours', 30,
  '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":30}]') $$, 'CC422', null, 'book at least 24 hours ahead');
insert into t_ids values ('party', app.request_party('20000000-0000-4000-b000-00000000000a', 'Hackathon finale',
  now() + interval '3 days', 30, '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":30}]', 'Veg only'));
select is((select total_paise from public.party_bookings where id = (select id from t_ids where name = 'party')), 210000,
  'the quote is 30 × ₹70 from the menu');
select throws_ok($$ select app.pay_party((select id from t_ids where name = 'party')) $$, 'CC409', null,
  'it can''t be paid before the outlet accepts');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.party_bookings $$, 'other students can''t see it');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.decide_party((select id from t_ids where name = 'party'), true) $$, 'CC404', null,
  'another outlet''s manager can''t accept it');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select lives_ok($$ select app.decide_party((select id from t_ids where name = 'party'), true, 'See you there') $$, 'the manager accepts');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.pay_party((select id from t_ids where name = 'party'));
select is(pg_temp.balance(auth.uid()), 500000 - 210000, 'paid from the wallet');
select lives_ok($$ select app.cancel_party((select id from t_ids where name = 'party')) $$, 'cancelled more than 24 h ahead');
select is(pg_temp.balance(auth.uid()), 500000, 'fully refunded');

-- Bill splits ---------------------------------------------------------------------------------
select throws_ok($$ select app.create_bill_split('Cab to town', 30000, '[{"email":"nobody@fixture.test","amount_paise":10000}]') $$,
  'CC422', null, 'everyone in a split needs an account');
insert into t_ids values ('split', app.create_bill_split('Cab to town', 30000, '[{"email":"STU.2@fixture.test","amount_paise":10000}]'));
select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select is_empty($$ select 1 from public.bill_splits $$, 'outsiders can''t see the split');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select ok(exists (select 1 from public.notifications where title = 'You owe ₹100.00'), 'the friend is told what they owe');
select app.settle_bill_share((select id from t_ids where name = 'split'));
select app.settle_bill_share((select id from t_ids where name = 'split'));
select tests.as_superuser();
select results_eq(
  $$ select pg_temp.balance('10000000-0000-4000-a000-000000000006'), pg_temp.balance('10000000-0000-4000-a000-000000000005'),
            (select settled_at is not null from public.bill_splits) $$,
  $$ values (490000, 510000, true) $$, 'settled once by a wallet transfer to the creator');

select * from finish();
rollback;
