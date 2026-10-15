-- Notification Center: written by triggers on real events only; private; read state; push queue.
begin;
\ir _helpers.psql
select plan(14);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'nt-o1-key'));
select tests.pay((select id from t_ids where name = 'o1'));

select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select app.transition_order((select id from t_ids where name = 'o1'), 'confirmed');
select app.transition_order((select id from t_ids where name = 'o1'), 'preparing');
select app.transition_order((select id from t_ids where name = 'o1'), 'cancelled', 'Gas ran out');
select tests.as_superuser();
select app.payout_refunds();

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select set_eq(
  $$ select category::text, title from public.notifications $$,
  $$ values ('loyalty', 'You earned 7 points'), ('orders', 'Order A-1 placed'),
     ('orders', 'A-1 is being prepared'), ('orders', 'A-1 was cancelled'), ('refunds', 'Refund paid') $$,
  'real events produce the student''s notifications'
);
select ok((select body like '%Reason: Gas ran out%refunded to your wallet%' from public.notifications where title = 'A-1 was cancelled'),
  'the cancellation explains why and what happens to the money');
select is((select data ->> 'order_id' from public.notifications where title = 'Order A-1 placed'),
  (select id::text from t_ids where name = 'o1'), 'notifications link to the order');
select throws_ok($$ insert into public.notifications (user_id, category, title, body) values (auth.uid(), 'orders', 'Fake', 'x') $$,
  '42501', null, 'clients cannot create notifications');
select throws_ok($$ update public.notifications set read_at = now() $$, '42501', null, 'or edit them directly');
select is(app.mark_notifications_read(array[(select id from public.notifications where title = 'Order A-1 placed')]), 1,
  'a student marks one as read');
select is(app.mark_notifications_read(), 4, 'and the rest at once');
select is((select count(*)::int from public.notifications where read_at is null), 0, 'nothing unread');

select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.notifications $$, 'other students see none of them');
select is(app.mark_notifications_read(), 0, 'and cannot mark them read');

-- Push tokens and the push queue --------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.register_push_token('not-a-token', 'ios') $$, 'CC422', null, 'only Expo push tokens are accepted');
select lives_ok($$ select app.register_push_token('ExponentPushToken[abcdefghij123]', 'ios') $$, 'a device registers for push');
select throws_ok($$ select * from app.claim_pending_pushes() $$, '42501', null, 'students cannot drain the push queue');
select tests.as_superuser();
select is((select count(*)::int from app.claim_pending_pushes()), 5, 'the sender takes each pending notification once');

select * from finish();
rollback;
