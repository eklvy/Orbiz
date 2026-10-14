-- Menu visibility, derived stock status, stock adjustments, outlet status, slot generation.
-- IDs: manager A …0002, kitchen A …0003, manager B …0004, student …0005; outlet A …000a.
begin;
\ir _helpers.psql
select plan(31);

select tests.seed_ordering_fixture();

-- Derived stock status ------------------------------------------------------------------
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-000000000001'),
  'available', 'tracked item above threshold is available');
update public.inventory set quantity_available = 2 where menu_item_id = '30000000-0000-4000-d000-000000000001';
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-000000000001'),
  'low', 'tracked item at threshold becomes low');
update public.inventory set quantity_available = 0 where menu_item_id = '30000000-0000-4000-d000-000000000001';
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-000000000001'),
  'sold_out', 'tracked item at zero becomes sold out');
update public.inventory set quantity_available = 5 where menu_item_id = '30000000-0000-4000-d000-000000000001';
update public.menu_items set manual_status = 'sold_out' where id = '30000000-0000-4000-d000-000000000001';
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-000000000001'),
  'sold_out', 'manual sold-out wins over available quantity');
update public.menu_items set manual_status = 'available' where id = '30000000-0000-4000-d000-000000000001';
update public.menu_items set manual_status = 'low' where id = '30000000-0000-4000-d000-000000000002';
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-000000000002'),
  'low', 'untracked item follows its manual status');
update public.menu_items set manual_status = 'available' where id = '30000000-0000-4000-d000-000000000002';
insert into public.menu_items (id, outlet_id, name, price_paise, track_quantity)
  values ('30000000-0000-4000-d000-0000000000ff', '20000000-0000-4000-b000-00000000000a', 'No Inventory Row', 100, true);
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-0000000000ff'),
  'sold_out', 'tracked item without an inventory row is sold out');

-- Visibility ----------------------------------------------------------------------------
update public.menu_items set is_active = false where id = '30000000-0000-4000-d000-0000000000ff';
select tests.as_anon();
select set_eq(
  $$ select name from public.menu_items where outlet_id = '20000000-0000-4000-b000-00000000000a' $$,
  array['Fixture Chai', 'Fixture Sandwich', 'Fixture Samosa'],
  'signed-out visitors see active items only'
);
select is((select quantity_available from public.inventory where menu_item_id = '30000000-0000-4000-d000-000000000001'),
  5, 'stock quantities are publicly readable for visible items');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select is((select count(*)::int from public.menu_items where outlet_id = '20000000-0000-4000-b000-00000000000a'),
  4, 'outlet staff also see archived items');

select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ update public.menu_items set price_paise = 1 where id = '30000000-0000-4000-d000-000000000001' $$,
  '42501', null, 'students cannot edit menu items directly');
select throws_ok($$ update public.inventory set quantity_available = 999 $$,
  '42501', null, 'students cannot edit stock directly');
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select throws_ok($$ update public.inventory set quantity_available = 999 $$,
  '42501', null, 'managers cannot edit stock directly either (must use app.adjust_stock)');

-- Stock adjustments -----------------------------------------------------------------------
select is(app.adjust_stock('30000000-0000-4000-d000-000000000001', 10, 'restock', 'delivery'), 15,
  'manager restocks their outlet''s item and gets the new quantity');
select throws_ok($$ select app.adjust_stock('30000000-0000-4000-d000-000000000001', -16, 'manual_adjustment') $$,
  'CC409', 'Stock cannot go below zero', 'stock cannot go negative');
select throws_ok($$ select app.adjust_stock('30000000-0000-4000-d000-000000000002', 5, 'restock') $$,
  'CC409', 'This item does not track quantity', 'untracked items cannot be restocked');
select throws_ok($$ select app.adjust_stock('30000000-0000-4000-d000-000000000001', -1, 'restock') $$,
  'CC422', 'A restock must add stock', 'a restock must be positive');
select throws_ok($$ select app.adjust_stock('30000000-0000-4000-d000-000000000001', 1, 'order_reserved') $$,
  'CC422', 'Use restock or manual_adjustment', 'order reasons are reserved for the ordering system');

select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.adjust_stock('30000000-0000-4000-d000-000000000001', 1, 'restock') $$,
  'CC403', null, 'a manager of another outlet cannot adjust stock');
select tests.authenticate_as('10000000-0000-4000-a000-000000000003');
select throws_ok($$ select app.adjust_stock('30000000-0000-4000-d000-000000000001', 1, 'restock') $$,
  'CC403', null, 'kitchen staff cannot adjust stock');

select tests.as_superuser();
select results_eq(
  $$ select delta, quantity_after, reason::text, actor_id, note from public.inventory_movements
     where menu_item_id = '30000000-0000-4000-d000-000000000001' $$,
  $$ values (10, 15, 'restock', '10000000-0000-4000-a000-000000000002'::uuid, 'delivery') $$,
  'the restock is recorded in the movement ledger with its actor'
);
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select is_empty($$ select 1 from public.inventory_movements $$, 'students cannot read the stock ledger');

-- Manual status ---------------------------------------------------------------------------
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select lives_ok($$ select app.set_item_manual_status('30000000-0000-4000-d000-000000000002', 'sold_out') $$,
  'manager marks an item sold out');
select is((select stock_status::text from public.menu_items where id = '30000000-0000-4000-d000-000000000002'),
  'sold_out', 'the derived status follows immediately');

-- Outlet status ---------------------------------------------------------------------------
select lives_ok($$ select app.set_outlet_status('20000000-0000-4000-b000-00000000000a', 'on_break', 'Restocking', 15) $$,
  'manager puts their outlet on a break');
select results_eq(
  $$ select status::text, status_reason, break_until between now() + interval '14 minutes' and now() + interval '16 minutes'
     from public.outlets where id = '20000000-0000-4000-b000-00000000000a' $$,
  $$ values ('on_break', 'Restocking', true) $$,
  'break status, public reason and end time are stored'
);
select throws_ok($$ select app.set_outlet_status('20000000-0000-4000-b000-00000000000a', 'on_break', null, null) $$,
  'CC422', null, 'a break needs a duration');
select lives_ok($$ select app.set_outlet_status('20000000-0000-4000-b000-00000000000a', 'open') $$,
  'manager reopens the outlet');
select tests.authenticate_as('10000000-0000-4000-a000-000000000004');
select throws_ok($$ select app.set_outlet_status('20000000-0000-4000-b000-00000000000a', 'closed', 'x') $$,
  'CC403', null, 'a manager of another outlet cannot change its status');

-- Slot generation -------------------------------------------------------------------------
select tests.as_superuser();
insert into public.outlet_hours (outlet_id, day_of_week, opens_at, closes_at)
  values ('20000000-0000-4000-b000-00000000000a', extract(dow from date '2030-01-07'), '12:00', '13:00');
update public.outlets set slot_minutes = 15 where id = '20000000-0000-4000-b000-00000000000a';
select tests.authenticate_as('10000000-0000-4000-a000-000000000002');
select is(app.generate_pickup_slots('20000000-0000-4000-b000-00000000000a', '2030-01-07'), 4,
  'one hour of opening hours yields four 15-minute slots');
select is(app.generate_pickup_slots('20000000-0000-4000-b000-00000000000a', '2030-01-07'), 0,
  'slot generation is idempotent');
select tests.authenticate_as('10000000-0000-4000-a000-000000000005');
select throws_ok($$ select app.generate_pickup_slots('20000000-0000-4000-b000-00000000000a', '2030-01-08') $$,
  'CC403', null, 'students cannot generate slots');

select * from finish();
rollback;
