-- Profiles: signup trigger, ownership, column-level privileges, domain allow-list.
begin;
\ir _helpers.psql
select plan(16);

select tests.seed_fixture();

-- Signup trigger maps metadata ---------------------------------------------------------
select results_eq(
  $$ select full_name, customer_type::text, roll_number, department, year_of_study::int
     from public.profiles where id = '10000000-0000-4000-a000-000000000005' $$,
  $$ values ('Student One', 'student', 'FX-001', 'CSE', 2) $$,
  'signup trigger copies metadata into the profile'
);

select tests.create_user('10000000-0000-4000-a000-0000000000f1', 'prof.x@fixture.test',
  '{"customer_type":"faculty","year_of_study":"abc"}');
select results_eq(
  $$ select full_name, customer_type::text, year_of_study from public.profiles
     where id = '10000000-0000-4000-a000-0000000000f1' $$,
  $$ values ('prof.x', 'faculty', null::smallint) $$,
  'missing name falls back to email local part; non-numeric year is ignored'
);

select tests.create_user('10000000-0000-4000-a000-0000000000f2', 'odd@fixture.test',
  '{"customer_type":"admin"}');
select is(
  (select customer_type::text from public.profiles where id = '10000000-0000-4000-a000-0000000000f2'),
  'student',
  'unknown customer_type in metadata cannot escalate; defaults to student'
);

select throws_ok(
  $$ select tests.create_user('10000000-0000-4000-a000-0000000000f3', 'dup@fixture.test', '{"roll_number":"fx-001"}') $$,
  '23505', null,
  'roll numbers are unique case-insensitively'
);

select throws_ok(
  $$ select tests.create_user('10000000-0000-4000-a000-0000000000f4', 'bad@fixture.test', '{"roll_number":"x; drop"}') $$,
  '23514', null,
  'malformed roll number rejects the signup'
);

-- Email-domain allow-list ---------------------------------------------------------------
insert into private.allowed_email_domains (domain) values ('campus.test');
select throws_ok(
  $$ select tests.create_user('10000000-0000-4000-a000-0000000000f5', 'outsider@gmail.test') $$,
  '23514', 'Signups are restricted to approved campus email domains',
  'non-allow-listed domain is rejected once the allow-list is non-empty'
);
select lives_ok(
  $$ select tests.create_user('10000000-0000-4000-a000-0000000000f6', 'insider@Campus.Test') $$,
  'allow-listed domain is accepted (case-insensitive)'
);
delete from private.allowed_email_domains;

-- Visibility ----------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select results_eq(
  $$ select id from public.profiles $$,
  $$ values ('10000000-0000-4000-a000-000000000005'::uuid) $$,
  'a student sees only their own profile'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is(
  (select count(*)::int from public.profiles),
  1,
  'an outlet manager sees only their own profile (no platform-wide access)'
);

select tests.authenticate_as('10000000-0000-4000-a000-000000000001');
select cmp_ok(
  (select count(*)::int from public.profiles), '>=', 6,
  'an admin sees all profiles'
);

select tests.as_anon();
select throws_ok(
  $$ select count(*) from public.profiles $$,
  '42501', null,
  'signed-out visitors cannot read profiles at all'
);

-- Updates -------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select lives_ok(
  $$ update public.profiles set full_name = 'Renamed', hostel_room = 'H-12'
     where id = '10000000-0000-4000-a000-000000000005' $$,
  'a student can edit their own editable fields'
);

select throws_ok(
  $$ update public.profiles set roll_number = 'FX-999' where id = '10000000-0000-4000-a000-000000000005' $$,
  '42501', null,
  'a student cannot change their roll number'
);

select throws_ok(
  $$ update public.profiles set customer_type = 'faculty' where id = '10000000-0000-4000-a000-000000000005' $$,
  '42501', null,
  'a student cannot change their customer type'
);

-- RLS hides the other row, so this updates nothing (no error, no effect).
update public.profiles set full_name = 'Hijacked' where id = '10000000-0000-4000-a000-000000000006';

select throws_ok(
  $$ insert into public.profiles (id, full_name) values ('10000000-0000-4000-a000-000000000006', 'x') $$,
  '42501', null,
  'clients cannot insert profiles directly'
);

select tests.as_superuser();
select results_eq(
  $$ select full_name from public.profiles
     where id in ('10000000-0000-4000-a000-000000000005', '10000000-0000-4000-a000-000000000006')
     order by id $$,
  $$ values ('Renamed'), ('Student Two') $$,
  'own update persisted; the attempt on another student''s profile changed nothing'
);

select * from finish();
rollback;
