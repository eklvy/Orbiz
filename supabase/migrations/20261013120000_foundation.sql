-- Phase 1 · Foundation: private schema, shared trigger functions, core enums.
--
-- `private` holds helper functions used by RLS policies and triggers. It is NOT in the
-- PostgREST exposed schemas (see config.toml [api].schemas), so nothing here is callable
-- over the Data API. Roles still need USAGE so policies can invoke the helpers.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated, service_role;

-- Keeps updated_at honest on every row update.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Students and faculty are both customers with identical permissions (REQUIREMENTS.md D-5).
create type public.customer_type as enum ('student', 'faculty');

-- Platform-wide roles. Ordinary customers have no row; outlet roles live in outlet_staff.
create type public.platform_role as enum ('admin');

-- Outlet-scoped roles. A manager can do everything kitchen staff can at that outlet.
create type public.outlet_role as enum ('manager', 'kitchen_staff');
