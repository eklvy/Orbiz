-- Phase 2 · Outlet operations: open/break/closed status, operating hours, per-outlet settings.

create type public.outlet_status as enum ('open', 'on_break', 'closed');

alter table public.outlets
  -- New outlets start closed: a manager must open them deliberately.
  add column status public.outlet_status not null default 'closed',
  -- Public reason shown to students when on a break or closed (report §3.1).
  add column status_reason text
    constraint outlets_status_reason_length check (char_length(status_reason) <= 200),
  add column break_until timestamptz,
  add column timezone text not null default 'Asia/Kolkata',
  -- Digital token prefix, e.g. 'A' gives tokens A-1, A-2, … (reset daily per outlet).
  add column token_prefix text not null default 'A'
    constraint outlets_token_prefix_format check (token_prefix ~ '^[A-Z]{1,2}$'),
  add column slot_minutes smallint not null default 15
    constraint outlets_slot_minutes_range check (slot_minutes between 5 and 120),
  add column default_slot_capacity smallint not null default 10
    constraint outlets_default_slot_capacity_range check (default_slot_capacity between 1 and 500),
  -- How long an unpaid order holds its stock and pickup slot.
  add column reservation_ttl_minutes smallint not null default 10
    constraint outlets_reservation_ttl_range check (reservation_ttl_minutes between 2 and 60),
  -- Orders the kitchen prepares in parallel; used for the transparent wait estimate (D-17).
  add column concurrent_orders smallint not null default 2
    constraint outlets_concurrent_orders_range check (concurrent_orders between 1 and 50),
  add constraint outlets_break_until_only_on_break
    check (break_until is null or status = 'on_break');

-- Reject unknown time zone names early (an invalid name would otherwise fail at use time).
create function private.validate_outlet_timezone()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform now() at time zone new.timezone;
  return new;
exception when invalid_parameter_value then
  raise exception 'Unknown time zone: %', new.timezone using errcode = 'check_violation';
end;
$$;

revoke all on function private.validate_outlet_timezone() from public;

create trigger outlets_validate_timezone
  before insert or update of timezone on public.outlets
  for each row execute function private.validate_outlet_timezone();

-- An outlet accepts new orders when it is active and open. A break whose end time has
-- passed counts as open even before the minute job flips the status back.
create function private.outlet_accepting_orders(p_outlet public.outlets)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_outlet.is_active
    and (
      p_outlet.status = 'open'
      or (p_outlet.status = 'on_break' and p_outlet.break_until is not null and p_outlet.break_until <= now())
    );
$$;

revoke all on function private.outlet_accepting_orders(public.outlets) from public;
grant execute on function private.outlet_accepting_orders(public.outlets) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Operating hours. day_of_week follows extract(dow): 0 = Sunday … 6 = Saturday.
-- Several ranges per day are allowed (e.g. lunch and evening service).
-- ---------------------------------------------------------------------------
create table public.outlet_hours (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  day_of_week smallint not null
    constraint outlet_hours_day_range check (day_of_week between 0 and 6),
  opens_at time not null,
  closes_at time not null,
  created_at timestamptz not null default now(),
  constraint outlet_hours_range_valid check (closes_at > opens_at),
  unique (outlet_id, day_of_week, opens_at)
);

create index outlet_hours_outlet_idx on public.outlet_hours (outlet_id, day_of_week);

revoke all on public.outlet_hours from anon, authenticated;
grant select on public.outlet_hours to anon, authenticated;

alter table public.outlet_hours enable row level security;

-- Visible whenever the outlet itself is visible (outlets RLS applies inside the subquery).
create policy outlet_hours_select on public.outlet_hours
  for select to anon, authenticated
  using (exists (select 1 from public.outlets o where o.id = outlet_id));
