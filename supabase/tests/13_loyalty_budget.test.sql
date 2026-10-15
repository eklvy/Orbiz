-- Loyalty (D-15), vouchers, budgets. Students …0005 (stu1) / …0006 (stu2); kitchen A …0003.
begin;
\ir _helpers.psql
select plan(27);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
update public.pickup_slots set capacity = 20;

-- ₹999 top-up (+50 bonus), then a ₹70 order paid from the wallet (+7).
select app.register_payment('10000000-0000-4000-a000-000000000005', 'wallet_topup', null, 99900, 'lb_topup');
select app.capture_payment('lb_topup', 'lb_pay', 99900);
insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'lb-o1-key')),
  ('o2', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'lb-o2-key')),
  ('o3', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'lb-o3-key'));

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.pay_order_with_wallet((select id from t_ids where name = 'o1'));
select results_eq(
  $$ select balance_points, lifetime_points, private.loyalty_tier(lifetime_points) from public.loyalty_accounts $$,
  $$ values (57, 57, 'silver') $$,
  '+50 for a ₹999 top-up and +7 for a ₹70 order; Silver tier'
);
select results_eq($$ select reason::text, points from public.loyalty_ledger order by id $$,
  $$ values ('topup_bonus', 50), ('order_paid', 7) $$, 'each award is in the ledger');
select throws_ok($$ select app.redeem_points_for_voucher() $$, 'CC409', 'Not enough loyalty points',
  'a voucher needs 100 points');
select throws_ok($$ insert into public.loyalty_ledger (user_id, points, reason) values (auth.uid(), 1000, 'review') $$,
  '42501', null, 'students cannot award themselves points');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.loyalty_ledger $$, 'other students see none of it');

-- Tiers and vouchers ----------------------------------------------------------------------------
select tests.as_superuser();
select private.loyalty_post('10000000-0000-4000-a000-000000000005', 1000, 'review');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select is((select private.loyalty_tier(lifetime_points) from public.loyalty_accounts), 'gold', '1,000+ lifetime points is Gold');
insert into t_ids values ('v1', app.redeem_points_for_voucher());
select results_eq(
  $$ select v.value_paise, v.status::text, v.code ~ '^CC-[A-HJ-NP-Z2-9]{8}$', a.balance_points, a.lifetime_points
     from public.vouchers v, public.loyalty_accounts a where v.id = (select id from t_ids where name = 'v1') $$,
  $$ values (1000, 'available', true, 957, 1057) $$,
  '100 points become a ₹10 voucher; redeeming does not lower the tier'
);

-- Applying a voucher -----------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok(
  $$ select app.apply_voucher((select id from t_ids where name = 'o2'), (select code from public.vouchers limit 1)) $$,
  'CC404', null, 'another student cannot use the order (or learn of it)');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.apply_voucher((select id from t_ids where name = 'o2'), 'CC-AAAAAAAA') $$,
  'CC404', null, 'an unknown voucher code is rejected');
select lives_ok(
  $$ select app.apply_voucher((select id from t_ids where name = 'o2'),
       lower((select code from public.vouchers where id = (select id from t_ids where name = 'v1')))) $$,
  'the owner applies their voucher (code is case-insensitive)');
select results_eq(
  $$ select subtotal_paise, discount_paise, total_paise from public.orders where id = (select id from t_ids where name = 'o2') $$,
  $$ values (7000, 1000, 6000) $$, 'the server lowers the total by the voucher value');
select throws_ok(
  $$ select app.apply_voucher((select id from t_ids where name = 'o3'),
       (select code from public.vouchers where id = (select id from t_ids where name = 'v1'))) $$,
  'CC409', null, 'an applied voucher cannot be used on a second order');
select throws_ok($$ update public.orders set total_paise = 1 $$, '42501', null, 'nobody changes totals directly');
select tests.as_superuser();
select throws_ok($$ update public.orders set total_paise = 1 where id = (select id from t_ids where name = 'o3') $$,
  '23514', null, 'even the server cannot break total = subtotal − discount');

-- Paying with a voucher -------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.pay_order_with_wallet((select id from t_ids where name = 'o2'));
select results_eq(
  $$ select (select status::text from public.vouchers where id = (select id from t_ids where name = 'v1')),
            (select balance_paise from public.wallet_accounts),
            (select points from public.loyalty_ledger where order_id = (select id from t_ids where name = 'o2')) $$,
  $$ values ('used', 99900 - 7000 - 6000, 6) $$,
  'the voucher is used, ₹60 is charged, and 6 points are earned on what was paid'
);

-- A voucher on an order that expires unpaid comes back ------------------------------------------
select tests.as_superuser();
select private.loyalty_post('10000000-0000-4000-a000-000000000005', 100, 'review');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
insert into t_ids values ('v2', app.redeem_points_for_voucher());
select app.apply_voucher((select id from t_ids where name = 'o3'),
  (select code from public.vouchers where id = (select id from t_ids where name = 'v2')));
select tests.as_superuser();
-- A card checkout started before the voucher was applied would now over-charge: money kept in wallet.
select app.register_payment('10000000-0000-4000-a000-000000000005', 'order', (select id from t_ids where name = 'o3'), 7000, 'lb_stale');
select is(app.capture_payment('lb_stale', 'lb_stale_pay', 7000), 'credited_to_wallet',
  'a payment for an out-of-date total is not applied to the order');
update public.orders set reservation_expires_at = now() - interval '1 second' where id = (select id from t_ids where name = 'o3');
select app.expire_pending_orders();
select results_eq(
  $$ select status::text, order_id from public.vouchers where id = (select id from t_ids where name = 'v2') $$,
  $$ values ('available', null::uuid) $$, 'the voucher is released when the unpaid order expires');

-- Refund reverses the order's points -------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select app.transition_order((select id from t_ids where name = 'o1'), 'rejected', 'Out of coffee');
select tests.as_superuser();
select app.payout_refunds();
select is((select points from public.loyalty_ledger where order_id = (select id from t_ids where name = 'o1') and reason = 'order_refunded'),
  -7, 'a refunded order''s points are taken back');
select is((select count(*)::int from public.loyalty_ledger where order_id = (select id from t_ids where name = 'o1')), 2,
  'earned once, reversed once');
select throws_ok($$ delete from public.loyalty_ledger $$, '42501', null, 'the points ledger is append-only');

-- Budget -----------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.set_budget(500) $$, 'CC422', null, 'a monthly budget under ₹100 is rejected');
select lives_ok($$ select app.set_budget(300000, 20000, 75) $$, 'a student sets a ₹3,000 monthly budget');
select results_eq($$ select monthly_limit_paise, daily_limit_paise, warn_at_percent::int from public.budgets $$,
  $$ values (300000, 20000, 75) $$, 'it is stored');
select lives_ok($$ select app.set_budget(400000) $$, 'and can be changed');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.budgets $$, 'budgets are private');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select lives_ok($$ select app.clear_budget() $$, 'a student can remove their budget');
select is_empty($$ select 1 from public.budgets $$, 'and it is gone');

select * from finish();
rollback;
