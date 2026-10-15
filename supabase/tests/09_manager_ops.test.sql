-- Phase 4 manager operations: categories, items, hours, settings, slots, staff, customer names,
-- audit. Admin …0001; manager A …0002; kitchen A …0003; manager B …0004; students …0005/…0006.
begin;
\ir _helpers.psql
select plan(39);

select tests.seed_ordering_fixture();
create temporary table t_ids (name text primary key, id uuid);
grant all on t_ids to authenticated;

-- Categories ------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
insert into t_ids values ('cat', app.save_menu_category('20000000-0000-4000-b000-00000000000a', null, ' Drinks ', 1, true));
select is((select name from public.menu_categories where id = (select id from t_ids where name = 'cat')), 'Drinks',
  'a manager creates a category (name trimmed)');
select throws_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000a', null, 'Drinks', 2, true) $$,
  'CC409', null, 'category names are unique per outlet');
select throws_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000a', null, '  ', 2, true) $$,
  'CC422', null, 'a blank category name is rejected');
select lives_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000a', (select id from t_ids where name = 'cat'), 'Beverages', 3, true) $$,
  'a manager renames their category');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000a', null, 'Kitchen cat', 1, true) $$,
  'CC403', null, 'kitchen staff cannot edit the menu');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000a', (select id from t_ids where name = 'cat'), 'Hijack', 1, true) $$,
  'CC403', null, 'a manager of another outlet cannot edit it');
select throws_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000b', (select id from t_ids where name = 'cat'), 'Hijack', 1, true) $$,
  'CC404', null, 'nor move another outlet''s category under their own outlet id');
select tests.as_anon();
select throws_ok($$ select app.save_menu_category('20000000-0000-4000-b000-00000000000a', null, 'Anon', 1, true) $$,
  '42501', null, 'signed-out visitors cannot call manager functions');

-- Items -----------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
insert into t_ids values ('item', app.save_menu_item('20000000-0000-4000-b000-00000000000a', null,
  (select id from t_ids where name = 'cat'), 'Bottled Water', 'Sealed 500 ml', 2000, 'veg', 0, 0, 0, true, true, 5));
select results_eq(
  $$ select name, price_paise, is_packaged, stock_status::text, category_id from public.menu_items where id = (select id from t_ids where name = 'item') $$,
  $$ select 'Bottled Water', 2000, true, 'available', (select id from t_ids where name = 'cat') $$,
  'a manager adds a packaged item'
);
select lives_ok($$ select app.save_menu_item('20000000-0000-4000-b000-00000000000a', (select id from t_ids where name = 'item'),
  null, 'Bottled Water', null, 2500, 'veg', null, null, 0, true, true, 5) $$, 'and changes its price and category');
select is((select price_paise from public.menu_items where id = (select id from t_ids where name = 'item')), 2500, 'the new price is stored');
select throws_ok($$ select app.save_menu_item('20000000-0000-4000-b000-00000000000a', null, null, 'Free Lunch', null, 0, null, null, null, 0, false, true, 0) $$,
  'CC422', 'Price must be between ₹0.01 and ₹1,00,000', 'a zero price is rejected');
select throws_ok($$ select app.save_menu_item('20000000-0000-4000-b000-00000000000a', null, null, 'Fixture Chai', null, 100, null, null, null, 0, false, true, 0) $$,
  'CC409', null, 'item names are unique per outlet');
select throws_ok($$ select app.save_menu_item('20000000-0000-4000-b000-00000000000a', '30000000-0000-4000-d000-000000000004',
  null, 'Stolen Coffee', null, 100, null, null, null, 0, false, true, 0) $$,
  'CC404', null, 'another outlet''s item cannot be edited through this outlet');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.save_menu_item('20000000-0000-4000-b000-00000000000b', null, (select id from t_ids where name = 'cat'),
  'Wrong Category', null, 100, null, null, null, 0, false, true, 0) $$,
  'CC422', null, 'an item cannot use another outlet''s category');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select lives_ok($$ select app.delete_menu_category((select id from t_ids where name = 'cat')) $$, 'a manager deletes a category');
select is((select category_id from public.menu_items where id = (select id from t_ids where name = 'item')), null,
  'its items become uncategorised, not deleted');

-- Hours -----------------------------------------------------------------------------------------
select lives_ok($$ select app.set_outlet_hours('20000000-0000-4000-b000-00000000000a',
  '[{"day_of_week":1,"opens_at":"08:00","closes_at":"11:00"},{"day_of_week":1,"opens_at":"12:00","closes_at":"16:00"}]') $$,
  'a manager sets split opening hours');
select is((select count(*)::int from public.outlet_hours where outlet_id = '20000000-0000-4000-b000-00000000000a'), 2,
  'the schedule is replaced');
select throws_ok($$ select app.set_outlet_hours('20000000-0000-4000-b000-00000000000a',
  '[{"day_of_week":1,"opens_at":"08:00","closes_at":"12:00"},{"day_of_week":1,"opens_at":"11:00","closes_at":"16:00"}]') $$,
  'CC422', 'Opening hours on the same day must not overlap', 'overlapping ranges are rejected');
select throws_ok($$ select app.set_outlet_hours('20000000-0000-4000-b000-00000000000a', '[{"day_of_week":8,"opens_at":"08:00","closes_at":"12:00"}]') $$,
  'CC422', null, 'an invalid day is rejected');
select is((select count(*)::int from public.outlet_hours where outlet_id = '20000000-0000-4000-b000-00000000000a'), 2,
  'a rejected update leaves the previous schedule intact');

-- Settings ---------------------------------------------------------------------------------------
select lives_ok($$ select app.update_outlet_settings('20000000-0000-4000-b000-00000000000a',
  p_no_show_grace_minutes => 20, p_default_slot_capacity => 12) $$, 'a manager changes outlet settings');
select results_eq(
  $$ select no_show_grace_minutes::int, default_slot_capacity::int, no_show_deal_discount_percent::int, deal_ttl_minutes::int
     from public.outlets where id = '20000000-0000-4000-b000-00000000000a' $$,
  $$ values (20, 12, 50, 30) $$,
  'only the given settings change; the D-19 defaults stay (50% off, 30 min)'
);
select throws_ok($$ select app.update_outlet_settings('20000000-0000-4000-b000-00000000000a', p_no_show_deal_discount_percent => 100) $$,
  'CC422', null, 'out-of-range settings are rejected');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.update_outlet_settings('20000000-0000-4000-b000-00000000000a', p_no_show_grace_minutes => 60) $$,
  'CC403', null, 'kitchen staff cannot change settings');

-- Slots -------------------------------------------------------------------------------------------
select tests.as_superuser();
insert into t_ids values ('o1', tests.order_as('10000000-0000-4000-a000-000000000005', '40000000-0000-4000-e000-000000000001',
  '[{"menu_item_id":"30000000-0000-4000-d000-000000000002","quantity":1}]', 'mgr-o1-key'));
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ select app.update_pickup_slot('40000000-0000-4000-e000-000000000001', 0, null) $$,
  'CC409', 'This slot already has 1 booking(s)', 'capacity cannot drop below what is booked');
select is(app.update_pickup_slot('40000000-0000-4000-e000-000000000001', null, false), 1,
  'deactivating reports the orders that keep their slot');
select tests.as_superuser();
select results_eq($$ select is_active, reserved_count from public.pickup_slots where id = '40000000-0000-4000-e000-000000000001' $$,
  $$ values (false, 1) $$, 'the slot stops taking bookings; the existing order keeps its place');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.update_pickup_slot('40000000-0000-4000-e000-000000000001', 50, true) $$,
  'CC403', null, 'a manager of another outlet cannot edit the slot');

-- Staff -------------------------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is(app.add_outlet_staff('20000000-0000-4000-b000-00000000000a', ' STU.2@fixture.test ', 'kitchen_staff'),
  '10000000-0000-4000-a000-000000000006'::uuid, 'a manager adds kitchen staff by email (case-insensitive)');
select throws_ok($$ select app.add_outlet_staff('20000000-0000-4000-b000-00000000000a', 'stu.2@fixture.test', 'kitchen_staff') $$,
  'CC409', null, 'adding someone twice is rejected');
select throws_ok($$ select app.add_outlet_staff('20000000-0000-4000-b000-00000000000a', 'stu.1@fixture.test', 'manager') $$,
  'CC403', null, 'managers cannot appoint managers');
select throws_ok($$ select app.add_outlet_staff('20000000-0000-4000-b000-00000000000a', 'nobody@fixture.test', 'kitchen_staff') $$,
  'CC404', null, 'an unknown email gives a clear not-found');
select results_eq($$ select email, role::text from app.list_outlet_staff('20000000-0000-4000-b000-00000000000a') order by email $$,
  $$ values ('kitchen.a@fixture.test', 'kitchen_staff'), ('mgr.a@fixture.test', 'manager'), ('stu.2@fixture.test', 'kitchen_staff') $$,
  'the manager sees their staff list');
select throws_ok($$ select app.remove_outlet_staff('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000002') $$,
  'CC403', null, 'managers cannot remove managers');
select lives_ok($$ select app.remove_outlet_staff('20000000-0000-4000-b000-00000000000a', '10000000-0000-4000-a000-000000000006') $$,
  'a manager removes kitchen staff');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select * from app.list_outlet_staff('20000000-0000-4000-b000-00000000000a') $$,
  'CC403', null, 'kitchen staff cannot list staff emails');

-- Audit ------------------------------------------------------------------------------------------
select tests.as_superuser();
select ok(exists (select 1 from public.audit_logs where table_name = 'menu_items' and action = 'UPDATE'
  and outlet_id = '20000000-0000-4000-b000-00000000000a' and actor_id = '10000000-0000-4000-a000-000000000002'
  and (new_data ->> 'price_paise')::int = 2500), 'menu edits are audited with the outlet and the manager');

select * from finish();
rollback;
