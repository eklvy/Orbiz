-- Phase 4 · Manager operations: menu and category editing, the packaged flag (D-19), opening
-- hours, outlet settings, pickup-slot edits, staff management by email, and the customer name
-- shown to counter staff. Every write is an app.* function that authorises explicitly.

-- ---------------------------------------------------------------------------
-- Packaged items (D-19): sealed, shelf-stable items (bottled drinks, chips) go back into stock
-- when an order is not collected; freshly prepared food is offered as a discounted deal instead.
-- ---------------------------------------------------------------------------
alter table public.menu_items
  add column is_packaged boolean not null default false;

-- Snapshot on the order line, so a later change to the menu item doesn't rewrite history.
alter table public.order_items
  add column is_packaged boolean not null default false;

create function private.snapshot_order_item_packaging()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.is_packaged := coalesce(
    (select m.is_packaged from public.menu_items m where m.id = new.menu_item_id), false);
  return new;
end;
$$;

revoke all on function private.snapshot_order_item_packaging() from public;

create trigger order_items_snapshot_packaging
  before insert on public.order_items
  for each row execute function private.snapshot_order_item_packaging();

-- ---------------------------------------------------------------------------
-- Outlet settings for the no-show policy (D-19, decided 2026-10-14):
--   * an order counts as not collected `no_show_grace_minutes` after the later of
--     "food ready" and "end of the student's pickup slot" (default 15);
--   * no refund; packaged items return to stock;
--   * prepared items are offered to other students at `no_show_deal_discount_percent` off
--     (default 50) for `deal_ttl_minutes` (default 30), then recorded as unsold.
-- ---------------------------------------------------------------------------
alter table public.outlets
  add column no_show_grace_minutes smallint not null default 15
    constraint outlets_no_show_grace_range check (no_show_grace_minutes between 5 and 120),
  add column no_show_deal_discount_percent smallint not null default 50
    constraint outlets_deal_discount_range check (no_show_deal_discount_percent between 10 and 90),
  add column deal_ttl_minutes smallint not null default 30
    constraint outlets_deal_ttl_range check (deal_ttl_minutes between 5 and 240);

-- When a ready order stops waiting for its owner. One definition, used by the no-show job and
-- by the API (which shows staff and the student the deadline).
create function private.pickup_deadline(
  p_ready_at timestamptz, p_slot_ends_at timestamptz, p_grace_minutes integer
)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select greatest(p_ready_at, coalesce(p_slot_ends_at, p_ready_at)) + make_interval(mins => p_grace_minutes);
$$;

revoke all on function private.pickup_deadline(timestamptz, timestamptz, integer) from public;
grant execute on function private.pickup_deadline(timestamptz, timestamptz, integer)
  to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Menu categories
-- ---------------------------------------------------------------------------
create function app.save_menu_category(
  p_outlet_id uuid, p_category_id uuid, p_name text, p_sort_order integer, p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  perform private.require_outlet_manager(p_outlet_id);
  if char_length(v_name) not between 1 and 60 then
    perform private.fail(422, 'invalid_name', 'Category name must be 1–60 characters');
  end if;
  if p_sort_order is null or p_sort_order not between -1000 and 1000 then
    perform private.fail(422, 'invalid_sort_order', 'Sort order must be between -1000 and 1000');
  end if;

  begin
    if p_category_id is null then
      insert into public.menu_categories (outlet_id, name, sort_order, is_active)
      values (p_outlet_id, v_name, p_sort_order, coalesce(p_is_active, true))
      returning id into v_id;
    else
      update public.menu_categories
      set name = v_name, sort_order = p_sort_order, is_active = coalesce(p_is_active, is_active)
      where id = p_category_id and outlet_id = p_outlet_id
      returning id into v_id;
      if v_id is null then
        perform private.fail(404, 'category_not_found', 'Category not found');
      end if;
    end if;
  exception when unique_violation then
    perform private.fail(409, 'duplicate_name', 'This outlet already has a category with that name');
  end;
  return v_id;
end;
$$;

-- Items in a deleted category become uncategorised (FK ON DELETE SET NULL); none are lost.
create function app.delete_menu_category(p_category_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outlet uuid;
begin
  select outlet_id into v_outlet from public.menu_categories where id = p_category_id;
  if v_outlet is null then
    perform private.fail(404, 'category_not_found', 'Category not found');
  end if;
  perform private.require_outlet_manager(v_outlet);
  delete from public.menu_categories where id = p_category_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Menu items: create (p_item_id null) or replace the editable fields. Items are archived
-- (is_active = false), never deleted, so order history keeps its links.
-- Price changes never affect existing orders (order lines snapshot the price).
-- ---------------------------------------------------------------------------
create function app.save_menu_item(
  p_outlet_id uuid,
  p_item_id uuid,
  p_category_id uuid,
  p_name text,
  p_description text,
  p_price_paise integer,
  p_diet public.diet_type,
  p_calories_kcal integer,
  p_protein_g integer,
  p_prep_minutes integer,
  p_is_packaged boolean,
  p_is_active boolean,
  p_sort_order integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_description text := nullif(btrim(p_description), '');
  v_id uuid;
begin
  perform private.require_outlet_manager(p_outlet_id);
  if char_length(v_name) not between 1 and 120 then
    perform private.fail(422, 'invalid_name', 'Item name must be 1–120 characters');
  end if;
  if char_length(v_description) > 500 then
    perform private.fail(422, 'invalid_description', 'Description must be at most 500 characters');
  end if;
  if p_price_paise is null or p_price_paise not between 1 and 10000000 then
    perform private.fail(422, 'invalid_price', 'Price must be between ₹0.01 and ₹1,00,000');
  end if;
  if p_prep_minutes is null or p_prep_minutes not between 0 and 180 then
    perform private.fail(422, 'invalid_prep_minutes', 'Preparation time must be 0–180 minutes');
  end if;
  if p_calories_kcal is not null and p_calories_kcal not between 0 and 5000 then
    perform private.fail(422, 'invalid_calories', 'Calories must be 0–5000 kcal');
  end if;
  if p_protein_g is not null and p_protein_g not between 0 and 500 then
    perform private.fail(422, 'invalid_protein', 'Protein must be 0–500 g');
  end if;
  if p_sort_order is null or p_sort_order not between -1000 and 1000 then
    perform private.fail(422, 'invalid_sort_order', 'Sort order must be between -1000 and 1000');
  end if;
  if p_category_id is not null and not exists (
    select 1 from public.menu_categories where id = p_category_id and outlet_id = p_outlet_id
  ) then
    perform private.fail(422, 'category_not_found', 'That category is not on this outlet''s menu');
  end if;

  begin
    if p_item_id is null then
      insert into public.menu_items (
        outlet_id, category_id, name, description, price_paise, diet, calories_kcal, protein_g,
        prep_minutes, is_packaged, is_active, sort_order
      ) values (
        p_outlet_id, p_category_id, v_name, v_description, p_price_paise, p_diet, p_calories_kcal,
        p_protein_g, p_prep_minutes, coalesce(p_is_packaged, false), coalesce(p_is_active, true), p_sort_order
      )
      returning id into v_id;
    else
      update public.menu_items set
        category_id = p_category_id,
        name = v_name,
        description = v_description,
        price_paise = p_price_paise,
        diet = p_diet,
        calories_kcal = p_calories_kcal,
        protein_g = p_protein_g,
        prep_minutes = p_prep_minutes,
        is_packaged = coalesce(p_is_packaged, is_packaged),
        is_active = coalesce(p_is_active, is_active),
        sort_order = p_sort_order
      where id = p_item_id and outlet_id = p_outlet_id
      returning id into v_id;
      if v_id is null then
        perform private.fail(404, 'item_not_found', 'Menu item not found');
      end if;
    end if;
  exception when unique_violation then
    perform private.fail(409, 'duplicate_name', 'This outlet already has an item with that name');
  end;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Opening hours: replaces the outlet's whole weekly schedule.
-- p_hours: [{"day_of_week": 0-6, "opens_at": "HH:MM", "closes_at": "HH:MM"}, …]
-- Existing pickup slots are not changed; new hours apply to slots generated afterwards.
-- ---------------------------------------------------------------------------
create function app.set_outlet_hours(p_outlet_id uuid, p_hours jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry jsonb;
  v_day integer;
  v_open time;
  v_close time;
begin
  perform private.require_outlet_manager(p_outlet_id);
  if jsonb_typeof(p_hours) is distinct from 'array' or jsonb_array_length(p_hours) > 28 then
    perform private.fail(422, 'invalid_hours', 'Hours must be a list of at most 28 ranges');
  end if;
  perform 1 from public.outlets where id = p_outlet_id for update;

  delete from public.outlet_hours where outlet_id = p_outlet_id;
  for v_entry in select e from jsonb_array_elements(p_hours) e loop
    begin
      v_day := (v_entry ->> 'day_of_week')::integer;
      v_open := (v_entry ->> 'opens_at')::time;
      v_close := (v_entry ->> 'closes_at')::time;
    exception when others then
      perform private.fail(422, 'invalid_hours', 'Each range needs day_of_week, opens_at and closes_at');
    end;
    if v_day is null or v_day not between 0 and 6 or v_open is null or v_close is null then
      perform private.fail(422, 'invalid_hours', 'Each range needs day_of_week (0–6), opens_at and closes_at');
    end if;
    if v_close <= v_open then
      perform private.fail(422, 'invalid_hours', 'Closing time must be after opening time');
    end if;
    if exists (
      select 1 from public.outlet_hours
      where outlet_id = p_outlet_id and day_of_week = v_day and opens_at < v_close and closes_at > v_open
    ) then
      perform private.fail(422, 'overlapping_hours', 'Opening hours on the same day must not overlap');
    end if;
    insert into public.outlet_hours (outlet_id, day_of_week, opens_at, closes_at)
    values (p_outlet_id, v_day, v_open, v_close);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Outlet settings. NULL leaves a value unchanged. Ranges are enforced by table CHECKs too.
-- ---------------------------------------------------------------------------
create function app.update_outlet_settings(
  p_outlet_id uuid,
  p_name text default null,
  p_description text default null,
  p_location text default null,
  p_slot_minutes integer default null,
  p_default_slot_capacity integer default null,
  p_reservation_ttl_minutes integer default null,
  p_concurrent_orders integer default null,
  p_no_show_grace_minutes integer default null,
  p_no_show_deal_discount_percent integer default null,
  p_deal_ttl_minutes integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_outlet_manager(p_outlet_id);
  if p_name is not null and char_length(btrim(p_name)) not between 1 and 120 then
    perform private.fail(422, 'invalid_name', 'Outlet name must be 1–120 characters');
  end if;
  update public.outlets set
    name = coalesce(nullif(btrim(p_name), ''), name),
    description = case when p_description is null then description else nullif(btrim(p_description), '') end,
    location = case when p_location is null then location else nullif(btrim(p_location), '') end,
    slot_minutes = coalesce(p_slot_minutes, slot_minutes),
    default_slot_capacity = coalesce(p_default_slot_capacity, default_slot_capacity),
    reservation_ttl_minutes = coalesce(p_reservation_ttl_minutes, reservation_ttl_minutes),
    concurrent_orders = coalesce(p_concurrent_orders, concurrent_orders),
    no_show_grace_minutes = coalesce(p_no_show_grace_minutes, no_show_grace_minutes),
    no_show_deal_discount_percent = coalesce(p_no_show_deal_discount_percent, no_show_deal_discount_percent),
    deal_ttl_minutes = coalesce(p_deal_ttl_minutes, deal_ttl_minutes)
  where id = p_outlet_id;
  if not found then
    perform private.fail(404, 'outlet_not_found', 'Outlet not found');
  end if;
exception when check_violation then
  perform private.fail(422, 'invalid_setting', 'A setting is outside its allowed range');
end;
$$;

-- ---------------------------------------------------------------------------
-- Pickup slots: change capacity or (de)activate. Capacity can't drop below places already
-- reserved. Deactivating stops new bookings only: orders that already hold the slot keep it
-- (the function returns how many there are, so the UI can say so).
-- ---------------------------------------------------------------------------
create function app.update_pickup_slot(p_slot_id uuid, p_capacity integer, p_is_active boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_slot public.pickup_slots;
begin
  select * into v_slot from public.pickup_slots where id = p_slot_id;
  if not found then
    perform private.fail(404, 'slot_not_found', 'Pickup slot not found');
  end if;
  perform private.require_outlet_manager(v_slot.outlet_id);
  select * into v_slot from public.pickup_slots where id = p_slot_id for update;

  if p_capacity is not null then
    if p_capacity not between 0 and 1000 then
      perform private.fail(422, 'invalid_capacity', 'Capacity must be between 0 and 1000');
    end if;
    if p_capacity < v_slot.reserved_count then
      perform private.fail(409, 'capacity_below_reserved',
        format('This slot already has %s booking(s)', v_slot.reserved_count));
    end if;
  end if;

  update public.pickup_slots set
    capacity = coalesce(p_capacity, capacity),
    is_active = coalesce(p_is_active, is_active)
  where id = p_slot_id;
  return v_slot.reserved_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Staff management. Managers add/remove kitchen staff at their own outlet; admins manage any
-- role. Looking up an account by email is limited to these callers (enumeration is confined
-- to managers, and every change is written to audit_logs by trigger).
-- ---------------------------------------------------------------------------
create function app.list_outlet_staff(p_outlet_id uuid)
returns table (user_id uuid, full_name text, email text, role public.outlet_role, added_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_outlet_manager(p_outlet_id);
  return query
    select s.user_id, p.full_name, u.email::text, s.role, s.created_at
    from public.outlet_staff s
    join auth.users u on u.id = s.user_id
    left join public.profiles p on p.id = s.user_id
    where s.outlet_id = p_outlet_id
    order by s.role, p.full_name;
end;
$$;

create function app.add_outlet_staff(p_outlet_id uuid, p_email text, p_role public.outlet_role)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_user uuid;
begin
  perform private.require_outlet_manager(p_outlet_id);
  if p_role <> 'kitchen_staff' and not private.is_admin() then
    perform private.fail(403, 'forbidden', 'Only administrators can add managers');
  end if;
  if not exists (select 1 from public.outlets where id = p_outlet_id) then
    perform private.fail(404, 'outlet_not_found', 'Outlet not found');
  end if;

  select id into v_user from auth.users where lower(email) = lower(btrim(p_email));
  if v_user is null then
    perform private.fail(404, 'user_not_found',
      'No CampusCart account uses that email. Ask them to register first.');
  end if;
  if exists (select 1 from public.outlet_staff where outlet_id = p_outlet_id and user_id = v_user) then
    perform private.fail(409, 'already_staff', 'That person is already on this outlet''s staff');
  end if;

  insert into public.outlet_staff (outlet_id, user_id, role, granted_by)
  values (p_outlet_id, v_user, p_role, v_actor);
  return v_user;
end;
$$;

create function app.remove_outlet_staff(p_outlet_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role public.outlet_role;
begin
  perform private.require_outlet_manager(p_outlet_id);
  select role into v_role from public.outlet_staff where outlet_id = p_outlet_id and user_id = p_user_id;
  if v_role is null then
    perform private.fail(404, 'staff_not_found', 'That person is not on this outlet''s staff');
  end if;
  if v_role <> 'kitchen_staff' and not private.is_admin() then
    perform private.fail(403, 'forbidden', 'Only administrators can remove managers');
  end if;
  delete from public.outlet_staff where outlet_id = p_outlet_id and user_id = p_user_id;
end;
$$;

-- The customer's name for the counter ("A-24 · Riya S."). Only for orders at outlets where
-- the caller is staff (or an admin). Nothing else from the profile is exposed.
create function app.order_customer_names(p_order_ids uuid[])
returns table (order_id uuid, customer_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, p.full_name
  from public.orders o
  join public.profiles p on p.id = o.user_id
  where o.id = any(p_order_ids)
    and (private.is_outlet_staff(o.outlet_id) or private.is_admin());
$$;

-- ---------------------------------------------------------------------------
-- Audit: menu, category and hours changes are recorded too (outlet taken from the row).
-- Derived stock-status updates are excluded by listing the audited columns.
-- ---------------------------------------------------------------------------
create or replace function private.write_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_row jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  new_row jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  any_row jsonb := coalesce(new_row, old_row);
  key jsonb;
  outlet uuid;
begin
  if tg_op = 'UPDATE' and old_row = new_row then
    return null;
  end if;

  key := case tg_table_name
    when 'outlets' then jsonb_build_object('id', any_row -> 'id')
    when 'outlet_staff' then jsonb_build_object('outlet_id', any_row -> 'outlet_id', 'user_id', any_row -> 'user_id')
    when 'user_roles' then jsonb_build_object('user_id', any_row -> 'user_id', 'role', any_row -> 'role')
    else jsonb_build_object('id', any_row -> 'id')
  end;

  outlet := case tg_table_name
    when 'outlets' then (any_row ->> 'id')::uuid
    when 'user_roles' then null
    else (any_row ->> 'outlet_id')::uuid
  end;

  -- When an outlet is deleted (directly, or rows cascading from it) the FK target is
  -- gone; the id stays available in record_key / old_data.
  if outlet is not null and not exists (select 1 from public.outlets where id = outlet) then
    outlet := null;
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_key, outlet_id, old_data, new_data)
  values ((select auth.uid()), tg_op, tg_table_name, key, outlet, old_row, new_row);
  return null;
end;
$$;

create trigger menu_categories_audit
  after insert or update or delete on public.menu_categories
  for each row execute function private.write_audit_log();

create trigger menu_items_audit
  after insert or delete or update of category_id, name, description, price_paise, diet, calories_kcal,
    protein_g, prep_minutes, manual_status, track_quantity, is_packaged, is_active, sort_order
  on public.menu_items
  for each row execute function private.write_audit_log();

create trigger outlet_hours_audit
  after insert or update or delete on public.outlet_hours
  for each row execute function private.write_audit_log();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function
  app.save_menu_category(uuid, uuid, text, integer, boolean),
  app.delete_menu_category(uuid),
  app.save_menu_item(uuid, uuid, uuid, text, text, integer, public.diet_type, integer, integer, integer, boolean, boolean, integer),
  app.set_outlet_hours(uuid, jsonb),
  app.update_outlet_settings(uuid, text, text, text, integer, integer, integer, integer, integer, integer, integer),
  app.update_pickup_slot(uuid, integer, boolean),
  app.list_outlet_staff(uuid),
  app.add_outlet_staff(uuid, text, public.outlet_role),
  app.remove_outlet_staff(uuid, uuid),
  app.order_customer_names(uuid[])
from public;

grant execute on function
  app.save_menu_category(uuid, uuid, text, integer, boolean),
  app.delete_menu_category(uuid),
  app.save_menu_item(uuid, uuid, uuid, text, text, integer, public.diet_type, integer, integer, integer, boolean, boolean, integer),
  app.set_outlet_hours(uuid, jsonb),
  app.update_outlet_settings(uuid, text, text, text, integer, integer, integer, integer, integer, integer, integer),
  app.update_pickup_slot(uuid, integer, boolean),
  app.list_outlet_staff(uuid),
  app.add_outlet_staff(uuid, text, public.outlet_role),
  app.remove_outlet_staff(uuid, uuid),
  app.order_customer_names(uuid[])
to authenticated, service_role;
