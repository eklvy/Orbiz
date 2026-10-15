-- Phase 4 · Refunds & cancellations desk (report §3.2, F11).
--
-- A student can ask for a refund on a collected order (e.g. wrong or poor food) within 24 hours.
-- The outlet's manager approves or declines it (or approves every pending one at once). Approval
-- marks the order's refund as owed (orders.refund_status = 'required'); the money moves in
-- Phase 5 (payments), which sets 'refunded'. Refunds the system already owes (paid orders the
-- kitchen cancelled or rejected) need no request and appear on the desk as owed.
-- Orders that were not collected (no_show) are not refundable, by outlet policy (D-19).

create type public.refund_request_status as enum ('pending', 'approved', 'declined');

create table public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  -- One request per order.
  order_id uuid not null unique references public.orders (id) on delete restrict,
  outlet_id uuid not null references public.outlets (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  -- The full amount paid for the order (partial refunds are not supported).
  amount_paise integer not null constraint refund_requests_amount_positive check (amount_paise > 0),
  reason text not null
    constraint refund_requests_reason_length check (char_length(btrim(reason)) between 5 and 500),
  status public.refund_request_status not null default 'pending',
  decision_note text constraint refund_requests_note_length check (char_length(decision_note) <= 300),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint refund_requests_decided_consistent check ((status = 'pending') = (decided_at is null)),
  constraint refund_requests_decline_has_note check (status <> 'declined' or decision_note is not null)
);

create index refund_requests_outlet_idx on public.refund_requests (outlet_id, status, created_at);
create index refund_requests_user_idx on public.refund_requests (user_id, created_at desc);
create index refund_requests_decided_by_idx on public.refund_requests (decided_by);

create trigger refund_requests_set_updated_at
  before update on public.refund_requests
  for each row execute function private.set_updated_at();

-- Every request and decision is also written to the append-only audit log.
create trigger refund_requests_audit
  after insert or update or delete on public.refund_requests
  for each row execute function private.write_audit_log();

revoke all on public.refund_requests from anon, authenticated;
grant select on public.refund_requests to authenticated;
alter table public.refund_requests enable row level security;

-- The student who asked, and the outlet's managers (not kitchen staff), and admins.
create policy refund_requests_select on public.refund_requests
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.is_outlet_manager(outlet_id))
    or (select private.is_admin())
  );

-- Order history records refund activity and no-shows too.
alter table public.order_events drop constraint order_events_type;
alter table public.order_events add constraint order_events_type check (
  event_type in ('created', 'payment_confirmed', 'status_changed', 'expired', 'pickup_verified',
                 'no_show', 'refund_requested', 'refund_approved', 'refund_declined'));

-- ---------------------------------------------------------------------------
-- Student: ask for a refund on their own collected order.
-- ---------------------------------------------------------------------------
create function app.request_refund(p_order_id uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_order public.orders;
  v_id uuid;
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id <> v_user then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if char_length(v_reason) not between 5 and 500 then
    perform private.fail(422, 'invalid_reason', 'Tell the outlet what went wrong (5–500 characters)');
  end if;
  if v_order.status = 'no_show' then
    perform private.fail(409, 'no_show_not_refundable',
      'Orders that were not collected in time are not refunded (outlet policy)');
  end if;
  if v_order.status <> 'completed' or v_order.payment_status <> 'paid' then
    perform private.fail(409, 'refund_not_allowed',
      'You can ask for a refund after collecting your order. Cancel it instead if it is not accepted yet.');
  end if;
  if v_order.refund_status <> 'none' then
    perform private.fail(409, 'refund_already_owed', 'A refund is already owed for this order');
  end if;
  if v_order.completed_at < now() - interval '24 hours' then
    perform private.fail(409, 'refund_window_closed', 'Refunds can be requested up to 24 hours after pickup');
  end if;
  if exists (select 1 from public.refund_requests where order_id = p_order_id) then
    perform private.fail(409, 'refund_already_requested', 'You already asked for a refund on this order');
  end if;

  insert into public.refund_requests (order_id, outlet_id, user_id, amount_paise, reason)
  values (p_order_id, v_order.outlet_id, v_user, v_order.total_paise, v_reason)
  returning id into v_id;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id, reason)
  values (p_order_id, 'refund_requested', v_order.status, v_order.status, 'student', v_user, v_reason);
  update public.orders set version = version + 1 where id = p_order_id;
  return v_id;
end;
$$;

-- Applies one decision. Caller has authorised and holds the order lock (order → request).
create function private.apply_refund_decision(p_request_id uuid, p_approve boolean, p_note text, p_actor uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_request public.refund_requests;
  v_note text := nullif(btrim(p_note), '');
begin
  select * into v_request from public.refund_requests where id = p_request_id for update;
  if v_request.status <> 'pending' then
    perform private.fail(409, 'already_decided', 'This request has already been decided');
  end if;
  if not p_approve and v_note is null then
    perform private.fail(422, 'reason_required', 'Tell the student why the refund was declined');
  end if;
  if char_length(v_note) > 300 then
    perform private.fail(422, 'reason_too_long', 'Note must be at most 300 characters');
  end if;

  update public.refund_requests set
    status = case when p_approve then 'approved'::public.refund_request_status else 'declined' end,
    decision_note = v_note,
    decided_by = p_actor,
    decided_at = now()
  where id = p_request_id;

  update public.orders set
    refund_status = case when p_approve then 'required'::public.refund_status else refund_status end,
    version = version + 1
  where id = v_request.order_id;

  insert into public.order_events (order_id, event_type, from_status, to_status, actor, actor_id, reason)
  select o.id, case when p_approve then 'refund_approved' else 'refund_declined' end,
         o.status, o.status, 'staff', p_actor, v_note
  from public.orders o where o.id = v_request.order_id;
end;
$$;

revoke all on function private.apply_refund_decision(uuid, boolean, text, uuid) from public;

create function app.decide_refund_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_id uuid;
  v_outlet uuid;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select order_id, outlet_id into v_order_id, v_outlet from public.refund_requests where id = p_request_id;
  if v_order_id is null or not (private.is_admin() or private.is_outlet_manager(v_outlet)) then
    perform private.fail(404, 'refund_request_not_found', 'Refund request not found');
  end if;
  perform 1 from public.orders where id = v_order_id for update;
  perform private.apply_refund_decision(p_request_id, p_approve, p_note, auth.uid());
end;
$$;

-- "1-click approve all pending" for one outlet. Returns how many were approved.
create function app.approve_pending_refunds(p_outlet_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request record;
  v_count integer := 0;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  perform private.require_outlet_manager(p_outlet_id);
  for v_request in
    select r.id, r.order_id from public.refund_requests r
    where r.outlet_id = p_outlet_id and r.status = 'pending'
    order by r.created_at
  loop
    perform 1 from public.orders where id = v_request.order_id for update;
    -- Re-check under the lock: a concurrent single decision may have got there first.
    if (select status from public.refund_requests where id = v_request.id) = 'pending' then
      perform private.apply_refund_decision(v_request.id, true, null, auth.uid());
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function
  app.request_refund(uuid, text),
  app.decide_refund_request(uuid, boolean, text),
  app.approve_pending_refunds(uuid)
from public;
grant execute on function
  app.request_refund(uuid, text),
  app.decide_refund_request(uuid, boolean, text),
  app.approve_pending_refunds(uuid)
to authenticated, service_role;

-- Live desk for managers; students see their own request change (RLS filters per subscriber).
alter publication supabase_realtime add table public.refund_requests;
