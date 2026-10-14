-- Phase 2 · Menu, stock, and the stock-movement ledger (REQUIREMENTS.md D-12).
--
-- Stock model: each item either tracks a quantity (decremented transactionally by orders)
-- or not (manual status only). `stock_status` is derived and maintained by triggers so every
-- client reads one authoritative value:
--   sold_out  if manually sold out, or tracked with 0 left
--   low       if manually low, or tracked at/below its low-stock threshold
--   available otherwise

create type public.diet_type as enum ('veg', 'egg', 'non_veg');
create type public.stock_status as enum ('available', 'low', 'sold_out');
create type public.inventory_movement_reason as enum (
  'order_reserved', 'order_released', 'restock', 'manual_adjustment'
);

create table public.menu_categories (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  name text not null
    constraint menu_categories_name_length check (char_length(btrim(name)) between 1 and 60),
  sort_order smallint not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, name),
  unique (id, outlet_id)
);

create trigger menu_categories_set_updated_at
  before update on public.menu_categories
  for each row execute function private.set_updated_at();

create table public.menu_items (
  id uuid primary key default gen_random_uuid(),
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  category_id uuid,
  name text not null
    constraint menu_items_name_length check (char_length(btrim(name)) between 1 and 120),
  description text
    constraint menu_items_description_length check (char_length(description) <= 500),
  -- Integer paise. Authoritative price; orders snapshot it at creation.
  price_paise integer not null
    constraint menu_items_price_range check (price_paise between 1 and 10000000),
  diet public.diet_type,
  calories_kcal smallint
    constraint menu_items_calories_range check (calories_kcal between 0 and 5000),
  protein_g smallint
    constraint menu_items_protein_range check (protein_g between 0 and 500),
  prep_minutes smallint not null default 5
    constraint menu_items_prep_minutes_range check (prep_minutes between 0 and 180),
  manual_status public.stock_status not null default 'available',
  track_quantity boolean not null default false,
  -- Derived; never written directly (see private.sync_menu_item_stock_status).
  stock_status public.stock_status not null default 'available',
  -- Archived items are hidden from the menu but kept for order history.
  is_active boolean not null default true,
  sort_order smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (outlet_id, name),
  unique (id, outlet_id),
  -- Category must belong to the same outlet; deleting a category un-categorises its items.
  foreign key (category_id, outlet_id)
    references public.menu_categories (id, outlet_id) on delete set null (category_id)
);

create index menu_items_outlet_idx on public.menu_items (outlet_id, category_id, sort_order);
create index menu_items_category_idx on public.menu_items (category_id);

create table public.inventory (
  menu_item_id uuid primary key references public.menu_items (id) on delete cascade,
  quantity_available integer not null default 0
    constraint inventory_quantity_non_negative check (quantity_available >= 0),
  low_stock_threshold integer not null default 5
    constraint inventory_threshold_non_negative check (low_stock_threshold >= 0),
  updated_at timestamptz not null default now()
);

-- Append-only ledger of every stock change, written by app.* functions.
create table public.inventory_movements (
  id bigint generated always as identity primary key,
  menu_item_id uuid not null references public.menu_items (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  delta integer not null constraint inventory_movements_delta_non_zero check (delta <> 0),
  quantity_after integer not null
    constraint inventory_movements_quantity_after_non_negative check (quantity_after >= 0),
  reason public.inventory_movement_reason not null,
  order_id uuid, -- FK added with the orders table
  actor_id uuid references auth.users (id) on delete set null,
  note text constraint inventory_movements_note_length check (char_length(note) <= 200),
  created_at timestamptz not null default now()
);

create index inventory_movements_item_idx on public.inventory_movements (menu_item_id, created_at desc);
create index inventory_movements_outlet_idx on public.inventory_movements (outlet_id, created_at desc);
create index inventory_movements_order_idx on public.inventory_movements (order_id);
create index inventory_movements_actor_idx on public.inventory_movements (actor_id);

-- ---------------------------------------------------------------------------
-- Derived stock status
-- ---------------------------------------------------------------------------
create function private.compute_stock_status(
  p_manual public.stock_status, p_track boolean, p_quantity integer, p_threshold integer
)
returns public.stock_status
language sql
immutable
set search_path = ''
as $$
  select case
    when p_manual = 'sold_out' or (p_track and coalesce(p_quantity, 0) = 0) then 'sold_out'::public.stock_status
    when p_manual = 'low' or (p_track and p_quantity <= p_threshold) then 'low'::public.stock_status
    else 'available'::public.stock_status
  end;
$$;

create function private.sync_menu_item_stock_status()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  qty integer;
  threshold integer;
begin
  select quantity_available, low_stock_threshold into qty, threshold
  from public.inventory where menu_item_id = new.id;
  new.stock_status := private.compute_stock_status(new.manual_status, new.track_quantity, qty, threshold);
  return new;
end;
$$;

create trigger menu_items_sync_stock_status
  before insert or update of manual_status, track_quantity, stock_status on public.menu_items
  for each row execute function private.sync_menu_item_stock_status();

create trigger menu_items_set_updated_at
  before update on public.menu_items
  for each row execute function private.set_updated_at();

-- When quantities change, refresh the item's derived status (only if it actually changes,
-- so Realtime subscribers to menu_items aren't spammed on every sale).
create function private.propagate_inventory_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.menu_items m
  set stock_status = private.compute_stock_status(
    m.manual_status, m.track_quantity, new.quantity_available, new.low_stock_threshold)
  where m.id = new.menu_item_id
    and m.stock_status is distinct from private.compute_stock_status(
      m.manual_status, m.track_quantity, new.quantity_available, new.low_stock_threshold);
  return null;
end;
$$;

create trigger inventory_propagate_change
  after insert or update on public.inventory
  for each row execute function private.propagate_inventory_change();

create trigger inventory_set_updated_at
  before update on public.inventory
  for each row execute function private.set_updated_at();

revoke all on function private.compute_stock_status(public.stock_status, boolean, integer, integer) from public;
revoke all on function private.sync_menu_item_stock_status() from public;
revoke all on function private.propagate_inventory_change() from public;

-- ---------------------------------------------------------------------------
-- Privileges: read-only for clients. All writes go through app.* functions (API).
-- ---------------------------------------------------------------------------
revoke all on public.menu_categories, public.menu_items, public.inventory, public.inventory_movements
  from anon, authenticated;
grant select on public.menu_categories, public.menu_items, public.inventory to anon, authenticated;
grant select on public.inventory_movements to authenticated;

alter table public.menu_categories enable row level security;
alter table public.menu_items enable row level security;
alter table public.inventory enable row level security;
alter table public.inventory_movements enable row level security;

-- Public: active categories/items of visible active outlets. Staff/admins: everything for their outlet.
create policy menu_categories_select on public.menu_categories
  for select to anon, authenticated
  using (
    (is_active and exists (select 1 from public.outlets o where o.id = outlet_id and o.is_active))
    or (select private.is_outlet_staff(outlet_id))
    or (select private.is_admin())
  );

create policy menu_items_select on public.menu_items
  for select to anon, authenticated
  using (
    (is_active and exists (select 1 from public.outlets o where o.id = outlet_id and o.is_active))
    or (select private.is_outlet_staff(outlet_id))
    or (select private.is_admin())
  );

-- Quantities are public for visible items ("only 3 left" is genuine availability info).
create policy inventory_select on public.inventory
  for select to anon, authenticated
  using (exists (select 1 from public.menu_items m where m.id = menu_item_id));

create policy inventory_movements_select on public.inventory_movements
  for select to authenticated
  using ((select private.is_outlet_staff(outlet_id)) or (select private.is_admin()));
