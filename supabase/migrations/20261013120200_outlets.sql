-- Phase 1 · Outlets and outlet-scoped staff roles.
-- Operational outlet fields (open/break/closed status, hours, pickup slots) arrive in Phase 2.

create table public.outlets (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique
    constraint outlets_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  name text not null
    constraint outlets_name_length check (char_length(btrim(name)) between 1 and 120),
  description text
    constraint outlets_description_length check (char_length(description) <= 1000),
  location text
    constraint outlets_location_length check (char_length(location) <= 200),
  -- Inactive outlets are hidden from the public (decommissioned or not yet launched).
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index outlets_active_idx on public.outlets (is_active) where is_active;

create trigger outlets_set_updated_at
  before update on public.outlets
  for each row execute function private.set_updated_at();

create table public.outlet_staff (
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.outlet_role not null,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- One role per person per outlet; a person may hold roles at several outlets.
  primary key (outlet_id, user_id)
);

create index outlet_staff_user_idx on public.outlet_staff (user_id);
create index outlet_staff_granted_by_idx on public.outlet_staff (granted_by);

-- ---------------------------------------------------------------------------
-- Authorization helpers (SECURITY DEFINER: bypass outlet_staff RLS, avoid recursion).
-- ---------------------------------------------------------------------------
create function private.is_outlet_staff(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.outlet_staff
    where outlet_id = p_outlet_id and user_id = (select auth.uid())
  );
$$;

create function private.is_outlet_manager(p_outlet_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.outlet_staff
    where outlet_id = p_outlet_id and user_id = (select auth.uid()) and role = 'manager'
  );
$$;

revoke all on function private.is_outlet_staff(uuid) from public;
revoke all on function private.is_outlet_manager(uuid) from public;
grant execute on function private.is_outlet_staff(uuid) to anon, authenticated, service_role;
grant execute on function private.is_outlet_manager(uuid) to anon, authenticated, service_role;

-- Managers may edit descriptive fields of their outlet, but only admins may rename the slug
-- or (de)activate an outlet. Column grants can't vary by policy, so a trigger enforces it.
-- Only applies to end-user sessions; trusted server roles (postgres, service_role) are not
-- subject to it — the API enforces its own authorization for those paths.
create function private.guard_outlet_admin_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user = 'authenticated'
     and (new.slug is distinct from old.slug or new.is_active is distinct from old.is_active)
     and not private.is_admin() then
    raise exception 'Only administrators can change an outlet''s slug or active status'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_outlet_admin_fields() from public;

create trigger outlets_guard_admin_fields
  before update on public.outlets
  for each row execute function private.guard_outlet_admin_fields();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.outlets from anon, authenticated;
grant select on public.outlets to anon, authenticated;
grant insert, delete on public.outlets to authenticated;
grant update (slug, name, description, location, is_active) on public.outlets to authenticated;

revoke all on public.outlet_staff from anon, authenticated;
grant select, insert, delete on public.outlet_staff to authenticated;
grant update (role) on public.outlet_staff to authenticated;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.outlets enable row level security;
alter table public.outlet_staff enable row level security;

-- Public (including signed-out visitors) sees active outlets; staff also see their own
-- inactive outlet; admins see everything.
create policy outlets_select_public on public.outlets
  for select to anon, authenticated
  using (
    is_active
    or (select private.is_admin())
    or (select private.is_outlet_staff(id))
  );

create policy outlets_insert_admin on public.outlets
  for insert to authenticated
  with check ((select private.is_admin()));

create policy outlets_update_manager_or_admin on public.outlets
  for update to authenticated
  using ((select private.is_admin()) or (select private.is_outlet_manager(id)))
  with check ((select private.is_admin()) or (select private.is_outlet_manager(id)));

create policy outlets_delete_admin on public.outlets
  for delete to authenticated
  using ((select private.is_admin()));

create policy outlet_staff_select on public.outlet_staff
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.is_outlet_manager(outlet_id))
    or (select private.is_admin())
  );

-- Admins assign any role. Managers may add/remove kitchen staff at their own outlet only.
create policy outlet_staff_insert on public.outlet_staff
  for insert to authenticated
  with check (
    granted_by = (select auth.uid())
    and (
      (select private.is_admin())
      or (role = 'kitchen_staff' and (select private.is_outlet_manager(outlet_id)))
    )
  );

create policy outlet_staff_delete on public.outlet_staff
  for delete to authenticated
  using (
    (select private.is_admin())
    or (role = 'kitchen_staff' and (select private.is_outlet_manager(outlet_id)))
  );

create policy outlet_staff_update_admin on public.outlet_staff
  for update to authenticated
  using ((select private.is_admin()))
  with check ((select private.is_admin()));
