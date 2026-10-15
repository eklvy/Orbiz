-- Refunds & cancellations desk: student requests, manager decisions, bulk approval, visibility.
-- Manager A …0002; kitchen A …0003; manager B …0004; students …0005 (stu1) / …0006 (stu2).
begin;
\ir _helpers.psql
select plan(24);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;
update public.pickup_slots set capacity = 20;

-- Kitchen A verifies the owner's real pickup code (read here as superuser).
create function pg_temp.collect(p_order uuid) returns void language plpgsql as $$
declare v_code text;
begin
  select code into v_code from public.order_pickup_codes where order_id = p_order;
  perform tests.authenticate_as('10000000-0000-4000-a000-000000000003');
  perform app.verify_pickup(p_order, v_code);
  perform tests.as_superuser();
end;
$$;

insert into t_ids values
  ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":2}]', 'rf-o1-key')),
  ('o2', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'rf-o2-key')),
  ('o3', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'rf-o3-key')),
  ('o4', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'rf-o4-key')),
  ('o5', tests.order_as('10000000-0000-4000-a000-000000000006', '40000000-0000-4000-e000-000000000001',
     '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'rf-o5-key'));
select tests.pay(id) from t_ids;

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.request_refund((select id from t_ids where name = 'o1'), 'Food was cold') $$,
  'CC409', null, 'a refund cannot be requested before pickup (cancel instead)');
select tests.as_superuser();

select tests.kitchen_ready(id) from t_ids;
select pg_temp.collect(id) from t_ids where name in ('o1', 'o2', 'o3', 'o4');

-- Requests ---------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.request_refund((select id from t_ids where name = 'o1'), 'Not my order but hey') $$,
  'CC404', null, 'a student cannot ask for a refund on someone else''s order');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.request_refund((select id from t_ids where name = 'o1'), 'bad') $$,
  'CC422', null, 'a reason is required');
insert into t_ids values ('r1', app.request_refund((select id from t_ids where name = 'o1'), 'Sandwich was cold and soggy'));
select results_eq(
  $$ select status::text, amount_paise, reason from public.refund_requests where id = (select id from t_ids where name = 'r1') $$,
  $$ values ('pending', 14000, 'Sandwich was cold and soggy') $$,
  'the request is pending for the full amount paid'
);
select throws_ok($$ select app.request_refund((select id from t_ids where name = 'o1'), 'Asking again please') $$,
  'CC409', null, 'one request per order');
select throws_ok($$ insert into public.refund_requests (order_id, outlet_id, user_id, amount_paise, reason)
  values ((select id from t_ids where name = 'o3'), '20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000005', 999999, 'direct insert') $$,
  '42501', null, 'students cannot write refund requests directly');
select ok((select count(*) = 1 from public.order_events where order_id = (select id from t_ids where name = 'o1') and event_type = 'refund_requested'),
  'the order history records the request');

-- Visibility -------------------------------------------------------------------------------------
select is((select count(*)::int from public.refund_requests), 1, 'the student sees their own request');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select is_empty($$ select 1 from public.refund_requests $$, 'other students see nothing');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is_empty($$ select 1 from public.refund_requests $$, 'kitchen staff do not see the refunds desk');
select throws_ok($$ select app.decide_refund_request((select id from t_ids where name = 'r1'), true) $$,
  'CC404', null, 'kitchen staff cannot decide refunds');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select is_empty($$ select 1 from public.refund_requests $$, 'a manager of another outlet sees nothing');
select throws_ok($$ select app.decide_refund_request((select id from t_ids where name = 'r1'), true) $$,
  'CC404', null, 'and cannot decide it');

-- Decisions --------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is((select count(*)::int from public.refund_requests), 1, 'the outlet''s manager sees the request');
select throws_ok($$ select app.decide_refund_request((select id from t_ids where name = 'r1'), false, '  ') $$,
  'CC422', null, 'declining needs a note for the student');
select lives_ok($$ select app.decide_refund_request((select id from t_ids where name = 'r1'), false, 'Photo shows it was eaten') $$,
  'the manager declines with a note');
select tests.as_superuser();
select results_eq(
  $$ select r.status::text, r.decided_by, o.refund_status::text from public.refund_requests r join public.orders o on o.id = r.order_id
     where r.id = (select id from t_ids where name = 'r1') $$,
  $$ values ('declined', '10000000-0000-4000-a000-000000000002'::uuid, 'none') $$,
  'a declined request owes nothing'
);
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ select app.decide_refund_request((select id from t_ids where name = 'r1'), true) $$,
  'CC409', null, 'a decided request cannot be decided again');

-- Bulk approval ----------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select app.request_refund((select id from t_ids where name = 'o2'), 'Wrong item in the bag');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select app.request_refund((select id from t_ids where name = 'o3'), 'Missing the chutney');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.approve_pending_refunds('20000000-0000-4000-b000-00000000000a') $$,
  'CC403', null, 'kitchen staff cannot bulk-approve');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is(app.approve_pending_refunds('20000000-0000-4000-b000-00000000000a'), 2, 'approve-all approves every pending request');
select tests.as_superuser();
select results_eq(
  $$ select o.refund_status::text, r.status::text from public.orders o join public.refund_requests r on r.order_id = o.id
     where o.id in ((select id from t_ids where name = 'o2'), (select id from t_ids where name = 'o3')) $$,
  $$ values ('required', 'approved'), ('required', 'approved') $$,
  'approved refunds are owed on the orders (paid out in Phase 5)'
);
select ok((select count(*) = 3 from public.audit_logs where table_name = 'refund_requests' and action = 'UPDATE'
    and outlet_id = '20000000-0000-4000-b000-00000000000a'),
  'every decision is in the audit log');

-- Limits -----------------------------------------------------------------------------------------
update public.orders set completed_at = now() - interval '25 hours' where id = (select id from t_ids where name = 'o4');
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.request_refund((select id from t_ids where name = 'o4'), 'Remembered late') $$,
  'CC409', 'Refunds can be requested up to 24 hours after pickup', 'requests close 24 hours after pickup');
select tests.as_superuser();
select tests.make_overdue((select id from t_ids where name = 'o5'));
select app.process_no_shows();
select tests.authenticate_as('10000000-0000-4000-a000-000000000006');
select throws_ok($$ select app.request_refund((select id from t_ids where name = 'o5'), 'I was late to pick up') $$,
  'CC409', 'Orders that were not collected in time are not refunded (outlet policy)', 'no-shows are not refundable');

select * from finish();
rollback;
