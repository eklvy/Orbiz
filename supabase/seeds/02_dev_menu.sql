-- DEVELOPMENT SEED — local and automated-test databases only. Fictional outlets, prices and
-- stock levels for exercising the ordering flow. Not real NCU menus (REQUIREMENTS.md D-14).

update public.outlets set
  status = 'open', token_prefix = 'N', slot_minutes = 15, default_slot_capacity = 8,
  reservation_ttl_minutes = 10, concurrent_orders = 3
where slug = 'cafe-1';

update public.outlets set
  status = 'open', token_prefix = 'S', slot_minutes = 15, default_slot_capacity = 12,
  reservation_ttl_minutes = 10, concurrent_orders = 2
where slug = 'cafe-10';

-- Open every day: North 07:30–21:00, South 11:00–15:00 and 18:00–21:30 (two services).
insert into public.outlet_hours (outlet_id, day_of_week, opens_at, closes_at)
select '00000000-0000-4000-b000-000000000001'::uuid, d, '07:30'::time, '21:00'::time from generate_series(0, 6) d
union all
select '00000000-0000-4000-b000-000000000002', d, '11:00', '15:00' from generate_series(0, 6) d
union all
select '00000000-0000-4000-b000-000000000002', d, '18:00', '21:30' from generate_series(0, 6) d;

insert into public.menu_categories (id, outlet_id, name, sort_order) values
  ('00000000-0000-4000-c000-000000000001', '00000000-0000-4000-b000-000000000001', 'Beverages', 1),
  ('00000000-0000-4000-c000-000000000002', '00000000-0000-4000-b000-000000000001', 'Snacks', 2),
  ('00000000-0000-4000-c000-000000000003', '00000000-0000-4000-b000-000000000002', 'Meals', 1),
  ('00000000-0000-4000-c000-000000000004', '00000000-0000-4000-b000-000000000002', 'Street Food', 2);

insert into public.menu_items
  (id, outlet_id, category_id, name, description, price_paise, diet, calories_kcal, protein_g, prep_minutes, track_quantity, sort_order)
values
  ('00000000-0000-4000-d000-000000000001', '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-c000-000000000001',
   'Masala Chai', 'Dev sample item', 2000, 'veg', 90, 2, 2, false, 1),
  ('00000000-0000-4000-d000-000000000002', '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-c000-000000000001',
   'Cold Coffee', 'Dev sample item', 6000, 'veg', 210, 6, 3, true, 2),
  ('00000000-0000-4000-d000-000000000003', '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-c000-000000000002',
   'Paneer Sandwich', 'Dev sample item', 7000, 'veg', 380, 16, 6, true, 1),
  ('00000000-0000-4000-d000-000000000004', '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-c000-000000000002',
   'Egg Roll', 'Dev sample item', 5500, 'egg', 340, 14, 5, false, 2),
  ('00000000-0000-4000-d000-000000000005', '00000000-0000-4000-b000-000000000002', '00000000-0000-4000-c000-000000000003',
   'Rajma Chawal', 'Dev sample item', 8000, 'veg', 520, 18, 4, true, 1),
  ('00000000-0000-4000-d000-000000000006', '00000000-0000-4000-b000-000000000002', '00000000-0000-4000-c000-000000000003',
   'Veg Thali', 'Dev sample item', 12000, 'veg', 780, 24, 8, false, 2),
  ('00000000-0000-4000-d000-000000000007', '00000000-0000-4000-b000-000000000002', '00000000-0000-4000-c000-000000000004',
   'Chicken Kathi Roll', 'Dev sample item', 9000, 'non_veg', 450, 26, 7, true, 1);

insert into public.inventory (menu_item_id, quantity_available, low_stock_threshold) values
  ('00000000-0000-4000-d000-000000000002', 25, 5),
  ('00000000-0000-4000-d000-000000000003', 12, 3),
  ('00000000-0000-4000-d000-000000000005', 40, 8),
  ('00000000-0000-4000-d000-000000000007', 4, 5);  -- starts "low" to show the derived status

-- Bottled cold coffee is sealed stock: if an order isn't collected it goes back on the shelf,
-- while prepared food becomes a discounted deal (REQUIREMENTS.md D-19).
update public.menu_items set is_packaged = true where id = '00000000-0000-4000-d000-000000000002';

-- Today plus the next two days of slots for both dev outlets.
select app.generate_upcoming_slots(2);
