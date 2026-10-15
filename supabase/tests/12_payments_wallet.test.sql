-- Payments, wallet and refund payout. Students …0005 (stu1) / …0006 (stu2); kitchen A …0003.
begin;
\ir _helpers.psql
select plan(32);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
update public.pickup_slots set capacity = 20;

insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'pay-o1-key')),
  ('o2', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'pay-o2-key')),
  ('o3', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'pay-o3-key'));

-- Privileges --------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.capture_payment('x', 'y', 100) $$, '42501', null, 'students cannot capture payments');
select throws_ok($$ select app.register_payment(auth.uid(), 'wallet_topup', null, 10000, 'x') $$, '42501', null,
  'students cannot register provider payments');
select throws_ok($$ select app.payout_refunds() $$, '42501', null, 'students cannot run refund payouts');
select throws_ok($$ insert into public.wallet_accounts (user_id, balance_paise) values (auth.uid(), 100000) $$,
  '42501', null, 'students cannot give themselves money');
select throws_ok($$ insert into public.wallet_ledger (user_id, kind, amount_paise, balance_after_paise)
  values (auth.uid(), 'topup', 100000, 100000) $$, '42501', null, 'students cannot write the ledger');

-- Wallet pay without money -----------------------------------------------------------------------
select throws_ok($$ select app.pay_order_with_wallet((select id from t_ids where name = 'o1')) $$,
  'CC409', 'Not enough money in your CampusCart wallet', 'an empty wallet cannot pay');
select tests.as_superuser();
select is((select status::text from public.orders where id = (select id from t_ids where name = 'o1')),
  'payment_pending', 'the failed attempt left the order unpaid');

-- Top-up through the provider path ----------------------------------------------------------------
select throws_ok($$ select app.register_payment('10000000-0000-4000-a000-000000000005', 'wallet_topup', null, 4999, 'rp_small') $$,
  'CC422', null, 'top-ups below ₹50 are rejected');
select throws_ok($$ select app.register_payment('10000000-0000-4000-a000-000000000005', 'wallet_topup', null, 500001, 'rp_big') $$,
  'CC422', null, 'top-ups above ₹5,000 are rejected');
select lives_ok($$ select app.register_payment('10000000-0000-4000-a000-000000000005', 'wallet_topup', null, 20000, 'rp_order_1') $$,
  'a ₹200 top-up is registered');
select is(app.capture_payment('rp_order_1', 'rp_pay_1', 19999), 'amount_mismatch', 'a different captured amount is refused');
select is((select status::text from public.payments where provider_order_id = 'rp_order_1'), 'failed', 'and marked failed');
select lives_ok($$ select app.register_payment('10000000-0000-4000-a000-000000000005', 'wallet_topup', null, 20000, 'rp_order_2') $$,
  'another top-up is registered');
select is(app.capture_payment('rp_order_2', 'rp_pay_2', 20000), 'wallet_credited', 'capture credits the wallet');
select is(app.capture_payment('rp_order_2', 'rp_pay_2', 20000), 'wallet_credited', 'a replayed capture is a no-op');
select throws_ok($$ select app.capture_payment('rp_order_2', 'rp_pay_other', 20000) $$, 'CC409', null,
  'the same provider order cannot be captured by a different payment');
select is((select balance_paise from public.wallet_accounts where user_id = '10000000-0000-4000-a000-000000000005'), 20000,
  'the wallet holds ₹200 (credited once)');

-- Pay from the wallet ------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.pay_order_with_wallet((select id from t_ids where name = 'o1')) $$,
  'CC404', null, 'nobody can pay (or probe) another student''s order from their wallet');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select lives_ok($$ select app.pay_order_with_wallet((select id from t_ids where name = 'o1')) $$, 'the owner pays from the wallet');
select lives_ok($$ select app.pay_order_with_wallet((select id from t_ids where name = 'o1')) $$, 'paying again is a no-op');
select results_eq(
  $$ select o.status::text, o.payment_status::text, o.token_label is not null, w.balance_paise
     from public.orders o, public.wallet_accounts w
     where o.id = (select id from t_ids where name = 'o1') and w.user_id = auth.uid() $$,
  $$ values ('placed', 'paid', true, 13000) $$,
  'the order is placed with a token and ₹70 left the wallet once'
);
select is((select count(*)::int from public.wallet_ledger), 2, 'the student sees their own two ledger entries');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.wallet_ledger $$, 'other students see none of them');
select tests.as_superuser();
select throws_ok($$ update public.wallet_ledger set amount_paise = 1 $$, '42501', null,
  'the ledger is append-only even for the server');

-- A provider payment for an order that can no longer be paid goes to the wallet ------------------
select app.register_payment('10000000-0000-4000-a000-000000000006', 'order',
  (select id from t_ids where name = 'o3'), 7000, 'rp_order_3');
update public.orders set reservation_expires_at = now() - interval '1 second' where id = (select id from t_ids where name = 'o3');
select app.expire_pending_orders();
select is(app.capture_payment('rp_order_3', 'rp_pay_3', 7000), 'credited_to_wallet',
  'money captured for an expired order is kept in the wallet');
select results_eq(
  $$ select o.status::text, o.payment_status::text, w.balance_paise from public.orders o, public.wallet_accounts w
     where o.id = (select id from t_ids where name = 'o3') and w.user_id = o.user_id $$,
  $$ values ('cancelled', 'unpaid', 7000) $$,
  'the order stays cancelled and the student has their ₹70'
);

-- Provider payment for a live order ----------------------------------------------------------------
select app.register_payment('10000000-0000-4000-a000-000000000005', 'order',
  (select id from t_ids where name = 'o2'), 7000, 'rp_order_4');
select is(app.capture_payment('rp_order_4', 'rp_pay_4', 7000), 'order_paid', 'a captured card payment pays the order');
select is((select payment_reference from public.orders where id = (select id from t_ids where name = 'o2')),
  'razorpay:rp_pay_4', 'with the provider payment as the reference');

-- Refund payout ------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select app.transition_order((select id from t_ids where name = 'o1'), 'rejected', 'Out of stock');
select tests.as_superuser();
select is(app.payout_refunds(), 1, 'the owed refund is paid out');
select is(app.payout_refunds(), 0, 'and only once');
select results_eq(
  $$ select o.refund_status::text, w.balance_paise from public.orders o, public.wallet_accounts w
     where o.id = (select id from t_ids where name = 'o1') and w.user_id = o.user_id $$,
  $$ values ('refunded', 20000) $$,
  'the order is refunded and the wallet is back to ₹200'
);

-- Webhook de-duplication ---------------------------------------------------------------------------
select ok(app.claim_webhook_event('evt_1', 'payment.captured') and not app.claim_webhook_event('evt_1', 'payment.captured'),
  'each webhook event is handled once');

select * from finish();
rollback;
