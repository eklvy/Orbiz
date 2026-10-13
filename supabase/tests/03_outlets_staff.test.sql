-- Outlets, outlet-scoped staff roles, and platform roles.
begin;
\ir _helpers.psql
select plan(22);

select tests.seed_fixture();

-- Outlet visibility ---------------------------------------------------------------------
select tests.as_anon();
select set_eq(
  $$ select slug from public.outlets where slug like 'fixture-%' $$,
  array['fixture-a', 'fixture-b'],
  'signed-out visitors see active outlets only'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select set_eq(
  $$ select slug from public.outlets where slug like 'fixture-%' $$,
  array['fixture-a', 'fixture-b'],
  'students see active outlets only'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select set_eq(
  $$ select slug from public.outlets where slug like 'fixture-%' $$,
  array['fixture-a', 'fixture-b', 'fixture-hidden'],
  'admins also see inactive outlets'
);

-- Outlet writes -------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ insert into public.outlets (slug, name, location) values ('student-made', 'Nope', null) $$,
  '42501', null,
  'a student cannot create an outlet'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok(
  $$ insert into public.outlets (slug, name) values ('mgr-made', 'Nope') $$,
  '42501', null,
  'a manager cannot create outlets'
);
select lives_ok(
  $$ update public.outlets set description = 'Updated by A' where slug = 'fixture-a' $$,
  'a manager can edit their own outlet'
);
update public.outlets set description = 'Tampered by A' where slug = 'fixture-b';
select throws_ok(
  $$ update public.outlets set is_active = false where slug = 'fixture-a' $$,
  '42501', null,
  'a manager cannot deactivate their outlet (admin-only field)'
);
select throws_ok(
  $$ update public.outlets set slug = 'renamed-a' where slug = 'fixture-a' $$,
  '42501', null,
  'a manager cannot change their outlet slug (admin-only field)'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
update public.outlets set description = 'Tampered by kitchen' where slug = 'fixture-a';

select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select lives_ok(
  $$ update public.outlets set is_active = false where slug = 'fixture-b' $$,
  'an admin can deactivate an outlet'
);
select lives_ok(
  $$ insert into public.outlets (slug, name) values ('admin-made', 'Admin Outlet') $$,
  'an admin can create an outlet'
);

select tests.as_superuser();
select results_eq(
  $$ select slug, description from public.outlets where slug in ('fixture-a', 'fixture-b') order by slug $$,
  $$ values ('fixture-a', 'Updated by A'), ('fixture-b', null) $$,
  'manager edits only landed on their own outlet; kitchen staff edits had no effect'
);

-- Staff visibility ----------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is(
  (select count(*)::int from public.outlet_staff),
  2,
  'manager A sees the staff of outlet A only'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select results_eq(
  $$ select outlet_id, role::text from public.outlet_staff $$,
  $$ values ('20000000-0000-4000-b000-00000000000a'::uuid, 'kitchen_staff') $$,
  'kitchen staff see only their own membership'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select is_empty(
  $$ select 1 from public.outlet_staff $$,
  'students see no staff assignments'
);

-- Staff management ----------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select lives_ok(
  $$ insert into public.outlet_staff (outlet_id, user_id, role, granted_by) values
     ('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000006', 'kitchen_staff',
      '10000000-0000-4000-a000-000000000002') $$,
  'a manager can add kitchen staff to their own outlet'
);
select throws_ok(
  $$ insert into public.outlet_staff (outlet_id, user_id, role, granted_by) values
     ('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000005', 'manager',
      '10000000-0000-4000-a000-000000000002') $$,
  '42501', null,
  'a manager cannot appoint another manager'
);
select throws_ok(
  $$ insert into public.outlet_staff (outlet_id, user_id, role, granted_by) values
     ('20000000-0000-4000-b000-00000000000b', '10000000-0000-4000-a000-000000000005', 'kitchen_staff',
      '10000000-0000-4000-a000-000000000002') $$,
  '42501', null,
  'a manager cannot add staff to another outlet'
);
select throws_ok(
  $$ insert into public.outlet_staff (outlet_id, user_id, role, granted_by) values
     ('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000005', 'kitchen_staff',
      '10000000-0000-4000-a000-000000000001') $$,
  '42501', null,
  'granted_by must be the acting user (no forged attribution)'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok(
  $$ insert into public.outlet_staff (outlet_id, user_id, role, granted_by) values
     ('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000005', 'kitchen_staff',
      '10000000-0000-4000-a000-000000000003') $$,
  '42501', null,
  'kitchen staff cannot add staff'
);

-- Platform roles ------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, granted_by) values
     ('10000000-0000-4000-a000-000000000005', 'admin', '10000000-0000-4000-a000-000000000005') $$,
  '42501', null,
  'a student cannot grant themselves admin'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok(
  $$ insert into public.user_roles (user_id, role, granted_by) values
     ('10000000-0000-4000-a000-000000000002', 'admin', '10000000-0000-4000-a000-000000000002') $$,
  '42501', null,
  'a manager cannot grant themselves admin'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select lives_ok(
  $$ insert into public.user_roles (user_id, role, granted_by) values
     ('10000000-0000-4000-a000-000000000004', 'admin', '10000000-0000-4000-a000-000000000001') $$,
  'an admin can grant admin'
);

select * from finish();
rollback;
