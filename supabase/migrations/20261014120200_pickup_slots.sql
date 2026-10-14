-- Phase 2 · Pickup slots with enforced capacity.
-- The CHECK (reserved_count <= capacity) is the last line of defence against overbooking:
-- even a buggy caller cannot commit more reservations than capacity, and capacity can never
-- be lowered below what is already reserved.

create table public.pickup_slots (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  capacity integer not null
    constraint pickup_slots_capacity_range check (capacity between 0 and 1000),
  reserved_count integer not null default 0
    constraint pickup_slots_reserved_non_negative check (reserved_count >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pickup_slots_time_range check (ends_at > starts_at),
  constraint pickup_slots_capacity_respected check (reserved_count <= capacity),
  unique (outlet_id, starts_at),
  unique (id, outlet_id)
);

create index pickup_slots_upcoming_idx on public.pickup_slots (outlet_id, starts_at) where is_active;

create trigger pickup_slots_set_updated_at
  before update on public.pickup_slots
  for each row execute function private.set_updated_at();

revoke all on public.pickup_slots from anon, authenticated;
grant select on public.pickup_slots to anon, authenticated;

alter table public.pickup_slots enable row level security;

create policy pickup_slots_select on public.pickup_slots
  for select to anon, authenticated
  using (
    (is_active and exists (select 1 from public.outlets o where o.id = outlet_id and o.is_active))
    or (select private.is_outlet_staff(outlet_id))
    or (select private.is_admin())
  );
