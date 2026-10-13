-- Phase 1 · Identity: profiles, platform roles, email-domain allow-list, signup trigger.

-- ---------------------------------------------------------------------------
-- profiles — one row per auth user, created by trigger at signup.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null
    constraint profiles_full_name_length check (char_length(btrim(full_name)) between 1 and 120),
  customer_type public.customer_type not null default 'student',
  -- College roll number / student ID (REQUIREMENTS.md D-10). Optional: faculty and staff
  -- accounts have none. Unique case-insensitively (index below).
  roll_number text
    constraint profiles_roll_number_format check (roll_number ~ '^[A-Za-z0-9/-]{3,32}$'),
  department text
    constraint profiles_department_length check (char_length(department) <= 120),
  year_of_study smallint
    constraint profiles_year_of_study_range check (year_of_study between 1 and 8),
  hostel_room text
    constraint profiles_hostel_room_length check (char_length(hostel_room) <= 40),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Customer-facing profile for every auth user. Created by private.handle_new_user().';

create unique index profiles_roll_number_key
  on public.profiles (upper(roll_number))
  where roll_number is not null;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_roles — platform-wide roles (currently only admin).
-- ---------------------------------------------------------------------------
create table public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.platform_role not null,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create index user_roles_granted_by_idx on public.user_roles (granted_by);

-- ---------------------------------------------------------------------------
-- Email-domain allow-list for signups (REQUIREMENTS.md D-11).
-- Empty table = any domain allowed (local development default).
-- Managed by database administrators only; not reachable through the Data API.
-- ---------------------------------------------------------------------------
create table private.allowed_email_domains (
  domain text primary key
    constraint allowed_email_domains_lowercase check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$'),
  created_at timestamptz not null default now()
);

revoke all on private.allowed_email_domains from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Authorization helpers used by RLS policies (here and in later migrations).
-- SECURITY DEFINER so policies on user_roles / outlet_staff don't recurse into RLS.
-- ---------------------------------------------------------------------------
create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = (select auth.uid()) and role = 'admin'
  );
$$;

-- ---------------------------------------------------------------------------
-- Signup trigger: enforce the domain allow-list and create the profile.
-- Profile fields come from the signUp() `options.data` metadata. Invalid values make the
-- signup fail (constraint violation) rather than being silently dropped; clients validate
-- with the same rules before submitting.
-- ---------------------------------------------------------------------------
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  email_domain text := lower(split_part(coalesce(new.email, ''), '@', 2));
  requested_type text := meta ->> 'customer_type';
  year_text text := meta ->> 'year_of_study';
begin
  if exists (select 1 from private.allowed_email_domains)
     and not exists (select 1 from private.allowed_email_domains where domain = email_domain) then
    raise exception 'Signups are restricted to approved campus email domains'
      using errcode = 'check_violation';
  end if;

  insert into public.profiles (id, full_name, customer_type, roll_number, department, year_of_study)
  values (
    new.id,
    coalesce(nullif(btrim(meta ->> 'full_name'), ''), split_part(coalesce(new.email, 'user'), '@', 1)),
    case when requested_type in ('student', 'faculty')
         then requested_type::public.customer_type
         else 'student'::public.customer_type end,
    nullif(btrim(meta ->> 'roll_number'), ''),
    nullif(btrim(meta ->> 'department'), ''),
    case when year_text ~ '^[0-9]{1,2}$' then year_text::smallint end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------------------
-- Privileges. Supabase grants ALL on new public tables to anon/authenticated by default;
-- replace that with the minimum each role needs, then let RLS filter rows.
-- ---------------------------------------------------------------------------
revoke all on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
-- Users may edit only these columns. customer_type and roll_number are set at signup and
-- changed only by administrators through the API.
grant update (full_name, department, year_of_study, hostel_room) on public.profiles to authenticated;

revoke all on public.user_roles from anon, authenticated;
grant select, insert, delete on public.user_roles to authenticated;

revoke all on function private.set_updated_at() from public;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.is_admin() from public;
grant execute on function private.is_admin() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;

create policy profiles_select_own_or_admin on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select private.is_admin()));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy user_roles_select_own_or_admin on public.user_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_admin()));

create policy user_roles_insert_admin on public.user_roles
  for insert to authenticated
  with check ((select private.is_admin()) and granted_by = (select auth.uid()));

create policy user_roles_delete_admin on public.user_roles
  for delete to authenticated
  using ((select private.is_admin()));
