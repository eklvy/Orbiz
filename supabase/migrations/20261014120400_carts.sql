-- Phase 2 · Server-side cart: the same cart on app and website (report "One Account").
-- One cart per user, tied to one outlet (an order is for a single outlet). Composite FKs
-- guarantee every cart item belongs to the cart's outlet. The cart is NOT a reservation:
-- prices and availability are re-validated when the order is created.
--
-- Not published to Realtime: Realtime does not apply RLS to DELETE events, which would leak
-- other users' cart keys to subscribers. Clients refetch the cart instead.

create table public.carts (
  user_id uuid primary key references auth.users (id) on delete cascade,
  outlet_id uuid not null references public.outlets (id) on delete cascade,
  updated_at timestamptz not null default now(),
  unique (user_id, outlet_id)
);

create table public.cart_items (
  user_id uuid not null,
  outlet_id uuid not null,
  menu_item_id uuid not null,
  quantity smallint not null constraint cart_items_quantity_range check (quantity between 1 and 20),
  added_at timestamptz not null default now(),
  primary key (user_id, menu_item_id),
  foreign key (user_id, outlet_id) references public.carts (user_id, outlet_id)
    on delete cascade on update cascade,
  foreign key (menu_item_id, outlet_id) references public.menu_items (id, outlet_id)
    on delete cascade
);

create index cart_items_menu_item_idx on public.cart_items (menu_item_id, outlet_id);
create index cart_items_cart_idx on public.cart_items (user_id, outlet_id);

create trigger carts_set_updated_at
  before update on public.carts
  for each row execute function private.set_updated_at();

revoke all on public.carts, public.cart_items from anon, authenticated;
grant select, insert, update, delete on public.carts, public.cart_items to authenticated;

alter table public.carts enable row level security;
alter table public.cart_items enable row level security;

create policy carts_own on public.carts
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy cart_items_own on public.cart_items
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
