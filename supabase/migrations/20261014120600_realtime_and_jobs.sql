-- Phase 2 · Realtime publication and scheduled jobs.

-- Realtime postgres_changes applies each table's RLS per subscriber, so students receive only
-- their own orders and staff only their outlet's. Deliberately NOT published:
--   carts / cart_items      — DELETE events bypass RLS and would leak other users' keys
--   order_pickup_codes      — secret
--   inventory_movements     — staff-only ledger; dashboards query it
alter publication supabase_realtime add table
  public.outlets,
  public.menu_items,
  public.inventory,
  public.pickup_slots,
  public.orders,
  public.order_events;

create extension if not exists pg_cron;

-- Release stock and slots held by unpaid orders whose reservation expired.
select cron.schedule('campuscart-expire-pending-orders', '* * * * *',
  $$select app.expire_pending_orders()$$);

-- Reopen outlets whose break has ended (also emits the Realtime change students see).
select cron.schedule('campuscart-end-expired-breaks', '* * * * *',
  $$select app.end_expired_breaks()$$);

-- Keep two days of pickup slots ahead for every active outlet (00:05 UTC daily).
select cron.schedule('campuscart-generate-upcoming-slots', '5 0 * * *',
  $$select app.generate_upcoming_slots(2)$$);
