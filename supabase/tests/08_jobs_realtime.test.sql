-- Reservation expiry, break expiry, scheduled jobs, and the Realtime publication.
begin;
\ir _helpers.psql
select plan(12);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);

insert into t_ids values
  ('stale', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":2}]', 'jobs-stale-key')),
  ('paid', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000001","quantity":1}]', 'jobs-paid-key'));
select tests.pay((select id from t_ids where name = 'paid'));
update public.orders set reservation_expires_at = now() - interval '1 second'
  where id = (select id from t_ids where name = 'stale');

select is(tests.stock('30000000-0000-4000-d000-000000000001'), 2, 'before expiry: 5 − 2 − 1 = 2 left');

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.expire_pending_orders() $$, '42501', null, 'end users cannot run the expiry job');
select tests.as_superuser();

select is(app.expire_pending_orders(), 1, 'one overdue unpaid order is expired');
select results_eq(
  $$ select status::text, cancelled_by::text, reservation_expires_at from public.orders where id = (select id from t_ids where name = 'stale') $$,
  $$ values ('cancelled', 'system', null::timestamptz) $$,
  'the expired order is cancelled by the system'
);
select is(tests.stock('30000000-0000-4000-d000-000000000001'), 4, 'its stock is released');
select is(tests.reserved('40000000-0000-4000-e000-000000000001'), 1, 'its slot place is released; the paid order keeps its place');
select is((select status::text from public.orders where id = (select id from t_ids where name = 'paid')), 'placed',
  'the paid order is untouched');
select is(app.expire_pending_orders(), 0, 'running the job again changes nothing');

update public.outlets set status = 'on_break', break_until = now() - interval '1 second', status_reason = 'Tea'
  where id = '20000000-0000-4000-b000-00000000000a';
select is(app.end_expired_breaks(), 1, 'the break job reopens outlets whose break ended');
select results_eq(
  $$ select status::text, break_until, status_reason from public.outlets where id = '20000000-0000-4000-b000-00000000000a' $$,
  $$ values ('open', null::timestamptz, null::text) $$,
  'status, end time and reason are reset'
);

select set_eq(
  $$ select tablename::text from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' $$,
  array['outlets', 'menu_items', 'inventory', 'pickup_slots', 'orders', 'order_events'],
  'exactly the intended tables are published to Realtime (no carts, codes or ledgers)'
);
select set_eq(
  $$ select jobname::text from cron.job $$,
  array['campuscart-expire-pending-orders', 'campuscart-end-expired-breaks', 'campuscart-generate-upcoming-slots'],
  'the scheduled jobs are registered'
);

select * from finish();
rollback;
