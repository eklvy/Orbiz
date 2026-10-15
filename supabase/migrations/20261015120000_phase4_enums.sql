-- Phase 4 · New enum values. Kept in their own migration because a value added with
-- ALTER TYPE … ADD VALUE cannot be used in the transaction that adds it.

-- D-19: a paid order that was ready but never collected within the outlet's grace period.
alter type public.order_status add value if not exists 'no_show' after 'ready_for_pickup';

-- D-19: packaged items from a no-show order go back into stock.
alter type public.inventory_movement_reason add value if not exists 'no_show_return';
