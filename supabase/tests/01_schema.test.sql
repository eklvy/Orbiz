-- Schema-level invariants that must hold for every migration from Phase 1 onward.
begin;
\ir _helpers.psql
select plan(9);

select is(
  (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0,
  'RLS is enabled on every table in the public schema'
);

select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid)),
  null,
  'every public table has at least one RLS policy'
);

select has_table('public', 'profiles', 'profiles exists');
select has_table('public', 'user_roles', 'user_roles exists');
select has_table('public', 'outlets', 'outlets exists');
select has_table('public', 'outlet_staff', 'outlet_staff exists');
select has_table('public', 'audit_logs', 'audit_logs exists');

select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'private' and grantee in ('anon', 'authenticated')),
  0,
  'anon/authenticated hold no table privileges in the private schema'
);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.prosecdef
      and not coalesce(array_to_string(p.proconfig, ',') like '%search_path=%', false)),
  0,
  'every SECURITY DEFINER function pins search_path'
);

select * from finish();
rollback;
