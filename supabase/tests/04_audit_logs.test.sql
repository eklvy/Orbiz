-- Audit log: written by triggers, readable by admins and the relevant outlet's managers,
-- and never writable by any client or server role.
begin;
\ir _helpers.psql
select plan(9);

select tests.seed_fixture();

select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
insert into public.outlet_staff (outlet_id, user_id, role, granted_by) values
  ('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000006', 'kitchen_staff',
   '10000000-0000-4000-a000-000000000002');

select tests.as_superuser();
select results_eq(
  $$ select actor_id, action, table_name, outlet_id from public.audit_logs
     where table_name = 'outlet_staff' and record_key ->> 'user_id' = '10000000-0000-4000-a000-000000000006' $$,
  $$ values ('10000000-0000-4000-a000-000000000002'::uuid, 'INSERT', 'outlet_staff',
             '20000000-0000-4000-b000-00000000000a'::uuid) $$,
  'staff assignment is audited with the acting user and outlet'
);

select is(
  (select count(*)::int from public.audit_logs
    where table_name = 'user_roles' and actor_id is null
      and record_key ->> 'user_id' = '10000000-0000-4000-a000-000000000001'),
  1,
  'system-side role grants are audited with a null actor'
);

-- Visibility
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is(
  (select count(*)::int from public.audit_logs
    where outlet_id is distinct from '20000000-0000-4000-b000-00000000000a'),
  0,
  'manager A sees only audit entries for outlet A'
);
select cmp_ok(
  (select count(*)::int from public.audit_logs), '>', 0,
  'manager A does see outlet A audit entries'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select is_empty($$ select 1 from public.audit_logs $$, 'students see no audit entries');

select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select throws_ok(
  $$ delete from public.audit_logs $$,
  '42501', null,
  'even admins cannot delete audit entries'
);
select throws_ok(
  $$ insert into public.audit_logs (action, table_name, record_key) values ('INSERT', 'x', '{}') $$,
  '42501', null,
  'clients cannot forge audit entries'
);

select tests.as_superuser();
set local role service_role;
select throws_ok(
  $$ update public.audit_logs set action = 'DELETE' $$,
  '42501', null,
  'service_role cannot rewrite audit entries'
);
reset role;

-- Deleting an outlet (cascading to its staff) must not fail on the audit FK.
select lives_ok(
  $$ delete from public.outlets where slug = 'fixture-a' $$,
  'outlet deletion with cascading staff rows is audited without FK errors'
);

select * from finish();
rollback;
