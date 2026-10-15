-- Phase 5 · Payments (Razorpay), the campus wallet, and refund payout.
--
-- Money rules (AGENTS.md): integer paise only; the server decides amounts; ledgers are
-- append-only; every multi-row money change is one transaction with explicit locks.
-- Lock order extends Phase 4: outlet → inventory → slot → order → deal → refund request →
-- payment → wallet accounts (by user id).
--
-- Decisions: D-18 online only (no pay at counter). D-20 (default): refunds owed are paid into the
-- student's wallet by a minute job; top-ups ₹50–₹5,000; balance cap ₹10,000 for top-ups.

create type public.payment_purpose as enum ('order', 'wallet_topup');
create type public.payment_state as enum ('created', 'captured', 'failed');
create type public.wallet_entry_kind as enum (
  'topup', 'order_payment', 'refund', 'transfer_out', 'transfer_in', 'adjustment'
);

-- ---------------------------------------------------------------------------
-- Provider payments (one row per Razorpay order we create)
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  purpose public.payment_purpose not null,
  order_id uuid references public.orders (id) on delete restrict,
  amount_paise integer not null constraint payments_amount_positive check (amount_paise > 0),
  currency text not null default 'INR' constraint payments_currency_inr check (currency = 'INR'),
  provider text not null default 'razorpay' constraint payments_provider check (provider in ('razorpay')),
  provider_order_id text not null unique
    constraint payments_provider_order_id_length check (char_length(provider_order_id) between 1 and 100),
  provider_payment_id text unique
    constraint payments_provider_payment_id_length check (char_length(provider_payment_id) <= 100),
  status public.payment_state not null default 'created',
  failure_reason text constraint payments_failure_reason_length check (char_length(failure_reason) <= 300),
  -- What the captured money was finally used for (an expired order's money goes to the wallet).
  outcome text constraint payments_outcome_length check (char_length(outcome) <= 300),
  captured_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_order_purpose check ((purpose = 'order') = (order_id is not null)),
  constraint payments_captured_consistent check ((status = 'captured') = (captured_at is not null)),
  constraint payments_captured_has_payment_id check (status <> 'captured' or provider_payment_id is not null)
);

create index payments_user_idx on public.payments (user_id, created_at desc);
create index payments_order_idx on public.payments (order_id);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function private.set_updated_at();

-- Webhook deliveries already processed (Razorpay retries; each event id is handled once).
create table private.payment_webhook_events (
  event_id text primary key,
  event_type text not null,
  received_at timestamptz not null default now()
);
revoke all on private.payment_webhook_events from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Wallet: one account per user, an append-only ledger of every change.
-- ---------------------------------------------------------------------------
create table public.wallet_accounts (
  user_id uuid primary key references auth.users (id) on delete restrict,
  balance_paise integer not null default 0
    constraint wallet_accounts_balance_non_negative check (balance_paise >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger wallet_accounts_set_updated_at
  before update on public.wallet_accounts
  for each row execute function private.set_updated_at();

create table public.wallet_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete restrict,
  kind public.wallet_entry_kind not null,
  amount_paise integer not null constraint wallet_ledger_amount_non_zero check (amount_paise <> 0),
  balance_after_paise integer not null constraint wallet_ledger_balance_non_negative check (balance_after_paise >= 0),
  order_id uuid references public.orders (id) on delete restrict,
  payment_id uuid references public.payments (id) on delete restrict,
  counterparty_user_id uuid references auth.users (id) on delete restrict,
  note text constraint wallet_ledger_note_length check (char_length(note) <= 300),
  created_at timestamptz not null default now(),
  constraint wallet_ledger_sign check (
    (kind in ('topup', 'refund', 'transfer_in') and amount_paise > 0)
    or (kind in ('order_payment', 'transfer_out') and amount_paise < 0)
    or kind = 'adjustment'
  )
);

create index wallet_ledger_user_idx on public.wallet_ledger (user_id, id desc);
create index wallet_ledger_order_idx on public.wallet_ledger (order_id);
create index wallet_ledger_payment_idx on public.wallet_ledger (payment_id);
create index wallet_ledger_counterparty_idx on public.wallet_ledger (counterparty_user_id);

-- The ledger is append-only for everyone, including the server's privileged roles.
create function private.forbid_ledger_changes()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end;
$$;
revoke all on function private.forbid_ledger_changes() from public;

create trigger wallet_ledger_append_only
  before update or delete on public.wallet_ledger
  for each row execute function private.forbid_ledger_changes();

-- ---------------------------------------------------------------------------
-- Privileges and RLS: owners read their own rows; all writes go through functions.
-- ---------------------------------------------------------------------------
revoke all on public.payments, public.wallet_accounts, public.wallet_ledger from anon, authenticated;
grant select on public.payments, public.wallet_accounts, public.wallet_ledger to authenticated;

alter table public.payments enable row level security;
alter table public.wallet_accounts enable row level security;
alter table public.wallet_ledger enable row level security;

create policy payments_select_own on public.payments
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy wallet_accounts_select_own on public.wallet_accounts
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy wallet_ledger_select_own on public.wallet_ledger
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));

-- ---------------------------------------------------------------------------
-- Internal money primitives
-- ---------------------------------------------------------------------------

-- Posts one ledger entry and moves the balance. Caller authorises. The account row is locked, so
-- concurrent posts for the same user serialise; a debit that would go negative fails.
create function private.wallet_post(
  p_user uuid, p_kind public.wallet_entry_kind, p_amount integer,
  p_order uuid default null, p_payment uuid default null, p_counterparty uuid default null,
  p_note text default null
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_after integer;
  v_id bigint;
begin
  insert into public.wallet_accounts (user_id) values (p_user) on conflict do nothing;
  update public.wallet_accounts set balance_paise = balance_paise + p_amount
  where user_id = p_user and balance_paise + p_amount >= 0
  returning balance_paise into v_after;
  if not found then
    perform private.fail(409, 'insufficient_wallet_balance', 'Not enough money in your CampusCart wallet');
  end if;
  insert into public.wallet_ledger
    (user_id, kind, amount_paise, balance_after_paise, order_id, payment_id, counterparty_user_id, note)
  values (p_user, p_kind, p_amount, v_after, p_order, p_payment, p_counterparty, p_note)
  returning id into v_id;
  return v_id;
end;
$$;

-- The one place an order becomes paid (Razorpay capture, wallet, group shares). Caller holds the
-- order lock and has checked who may pay. Idempotent for the same reference.
create function private.mark_order_paid(p_order_id uuid, p_reference text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_order public.orders;
  v_outlet public.outlets;
  v_deal public.surplus_deals;
  v_business_date date;
  v_token integer;
  v_code text;
  v_to public.order_status := 'placed';
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
begin
  if nullif(btrim(p_reference), '') is null then
    perform private.fail(422, 'payment_reference_required', 'A payment reference is required');
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.payment_status = 'paid' then
    if v_order.payment_reference = p_reference then
      return; -- idempotent replay
    end if;
    perform private.fail(409, 'already_paid', 'Order is already paid with a different reference');
  end if;
  if v_order.status <> 'payment_pending' then
    perform private.fail(409, 'order_not_pending', 'Order is no longer awaiting payment');
  end if;
  if v_order.reservation_expires_at <= now() then
    perform private.fail(409, 'reservation_expired', 'The reservation for this order has expired');
  end if;

  if v_order.source_deal_id is not null then
    select * into v_deal from public.surplus_deals where id = v_order.source_deal_id for update;
    if v_deal.status <> 'reserved' or v_deal.reserved_order_id is distinct from v_order.id then
      perform private.fail(409, 'deal_unavailable', 'This deal is no longer held for this order');
    end if;
    update public.surplus_deals set
      status = 'sold', sold_order_id = v_order.id, reserved_order_id = null, closed_at = now(),
      version = version + 1
    where id = v_deal.id;
    v_to := 'ready_for_pickup';
  end if;

  select * into v_outlet from public.outlets where id = v_order.outlet_id;
  v_business_date := (now() at time zone v_outlet.timezone)::date;

  insert into private.outlet_token_counters as c (outlet_id, business_date, last_number)
  values (v_order.outlet_id, v_business_date, 1)
  on conflict (outlet_id, business_date) do update set last_number = c.last_number + 1
  returning last_number into v_token;

  bytes := extensions.gen_random_bytes(6);
  v_code := '';
  for i in 0..5 loop
    v_code := v_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;

  update public.orders set
    status = v_to,
    payment_status = 'paid',
    payment_reference = p_reference,
    placed_at = now(),
    ready_at = case when v_to = 'ready_for_pickup' then now() else ready_at end,
    reservation_expires_at = null,
    business_date = v_business_date,
    token_number = v_token,
    token_label = v_outlet.token_prefix || '-' || v_token,
    version = version + 1
  where id = p_order_id;

  insert into public.order_pickup_codes (order_id, code) values (p_order_id, v_code);
  insert into public.order_events (order_id, event_type, from_status, to_status, actor)
  values (p_order_id, 'payment_confirmed', 'payment_pending', v_to, 'system');
end;
$$;

revoke all on function
  private.wallet_post(uuid, public.wallet_entry_kind, integer, uuid, uuid, uuid, text),
  private.mark_order_paid(uuid, text)
from public;

-- Trusted payment confirmation (unchanged contract): system callers only.
create or replace function app.confirm_order_payment(p_order_id uuid, p_payment_reference text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'Only the payment service can confirm payments');
  end if;
  perform private.mark_order_paid(p_order_id, p_payment_reference);
end;
$$;

-- ---------------------------------------------------------------------------
-- Student: pay an unpaid order from the wallet (one transaction: debit + paid).
-- ---------------------------------------------------------------------------
create function app.pay_order_with_wallet(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_order public.orders;
  v_entry bigint;
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id <> v_user then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.payment_status = 'paid' and v_order.payment_reference like 'wallet:%' then
    return; -- already paid from the wallet (retry)
  end if;
  if v_order.status <> 'payment_pending' then
    perform private.fail(409, 'order_not_pending', 'Order is no longer awaiting payment');
  end if;
  if v_order.reservation_expires_at <= now() then
    perform private.fail(409, 'reservation_expired', 'The hold on this order has expired');
  end if;
  v_entry := private.wallet_post(v_user, 'order_payment', -v_order.total_paise, p_order_id, null, null,
                                 'Order payment');
  perform private.mark_order_paid(p_order_id, 'wallet:' || v_entry);
end;
$$;

-- ---------------------------------------------------------------------------
-- Razorpay payments. The API creates the provider order (HTTP, outside a transaction), then
-- records it here; capture comes from the verified checkout callback or the signed webhook.
-- ---------------------------------------------------------------------------

-- Student: what an order payment would be for (validates ownership and state; no writes).
create function app.order_payment_amount(p_order_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
begin
  select * into v_order from public.orders where id = p_order_id;
  if not found or v_order.user_id is distinct from auth.uid() then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.status <> 'payment_pending' then
    perform private.fail(409, 'order_not_pending', 'Order is no longer awaiting payment');
  end if;
  if v_order.reservation_expires_at <= now() then
    perform private.fail(409, 'reservation_expired', 'The hold on this order has expired');
  end if;
  return v_order.total_paise;
end;
$$;

-- System: record a provider order created for a user.
create function app.register_payment(
  p_user uuid, p_purpose public.payment_purpose, p_order_id uuid, p_amount integer, p_provider_order_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  if p_purpose = 'wallet_topup' and p_amount not between 5000 and 500000 then
    perform private.fail(422, 'invalid_topup_amount', 'Top up between ₹50 and ₹5,000');
  end if;
  if p_purpose = 'wallet_topup' and coalesce(
       (select balance_paise from public.wallet_accounts where user_id = p_user), 0) + p_amount > 1000000 then
    perform private.fail(409, 'wallet_limit', 'Your wallet can hold at most ₹10,000');
  end if;
  insert into public.payments (user_id, purpose, order_id, amount_paise, provider_order_id)
  values (p_user, p_purpose, p_order_id, p_amount, p_provider_order_id)
  returning id into v_id;
  return v_id;
end;
$$;

-- System: a provider payment was captured (verified signature or webhook). Idempotent per
-- provider payment. Returns the outcome text. Money is never lost: if the order can no longer be
-- paid (expired, cancelled, paid another way), the amount goes to the student's wallet.
create function app.capture_payment(p_provider_order_id text, p_provider_payment_id text, p_amount integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_payment public.payments;
  v_outcome text;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  select * into v_payment from public.payments where provider_order_id = p_provider_order_id;
  if not found then
    perform private.fail(404, 'payment_not_found', 'Unknown payment');
  end if;
  -- Order lock first (lock order), then the payment row.
  if v_payment.order_id is not null then
    perform 1 from public.orders where id = v_payment.order_id for update;
  end if;
  select * into v_payment from public.payments where id = v_payment.id for update;

  if v_payment.status = 'captured' then
    if v_payment.provider_payment_id = p_provider_payment_id then
      return v_payment.outcome; -- replay
    end if;
    perform private.fail(409, 'already_captured', 'This payment order was already captured');
  end if;
  if p_amount is distinct from v_payment.amount_paise then
    update public.payments set status = 'failed', failure_reason = 'Amount mismatch' where id = v_payment.id;
    return 'amount_mismatch';
  end if;

  update public.payments set
    status = 'captured', provider_payment_id = p_provider_payment_id, captured_at = now()
  where id = v_payment.id;

  if v_payment.purpose = 'wallet_topup' then
    perform private.wallet_post(v_payment.user_id, 'topup', v_payment.amount_paise, null, v_payment.id, null,
                                'Wallet top-up');
    v_outcome := 'wallet_credited';
  else
    begin
      perform private.mark_order_paid(v_payment.order_id, 'razorpay:' || p_provider_payment_id);
      v_outcome := 'order_paid';
    exception when sqlstate 'CC409' then
      perform private.wallet_post(v_payment.user_id, 'refund', v_payment.amount_paise, v_payment.order_id,
                                  v_payment.id, null, 'Order could no longer be paid; money kept in wallet');
      v_outcome := 'credited_to_wallet';
    end;
  end if;
  update public.payments set outcome = v_outcome where id = v_payment.id;
  return v_outcome;
end;
$$;

create function app.fail_payment(p_provider_order_id text, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  update public.payments set status = 'failed', failure_reason = left(p_reason, 300)
  where provider_order_id = p_provider_order_id and status = 'created';
end;
$$;

-- System: record a webhook delivery once. Returns false if it was already handled.
create function app.claim_webhook_event(p_event_id text, p_event_type text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  insert into private.payment_webhook_events (event_id, event_type) values (p_event_id, p_event_type)
  on conflict do nothing;
  return found;
end;
$$;

-- ---------------------------------------------------------------------------
-- Refund payout (D-20 default): refunds owed are paid into the student's wallet (pg_cron).
-- ---------------------------------------------------------------------------
alter table public.order_events drop constraint order_events_type;
alter table public.order_events add constraint order_events_type check (
  event_type in ('created', 'payment_confirmed', 'status_changed', 'expired', 'pickup_verified',
                 'no_show', 'refund_requested', 'refund_approved', 'refund_declined', 'refund_paid'));

create function app.payout_refunds(p_limit integer default 200)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_count integer := 0;
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  for v_order in
    select * from public.orders where refund_status = 'required'
    order by updated_at limit p_limit
    for update skip locked
  loop
    perform private.wallet_post(v_order.user_id, 'refund', v_order.total_paise, v_order.id, null, null,
                                'Refund for order ' || coalesce(v_order.token_label, ''));
    update public.orders set refund_status = 'refunded', version = version + 1 where id = v_order.id;
    insert into public.order_events (order_id, event_type, from_status, to_status, actor, reason)
    values (v_order.id, 'refund_paid', v_order.status, v_order.status, 'system',
            'Refunded to your CampusCart wallet');
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function
  app.pay_order_with_wallet(uuid),
  app.order_payment_amount(uuid),
  app.register_payment(uuid, public.payment_purpose, uuid, integer, text),
  app.capture_payment(text, text, integer),
  app.fail_payment(text, text),
  app.claim_webhook_event(text, text),
  app.payout_refunds(integer)
from public;
grant execute on function app.pay_order_with_wallet(uuid), app.order_payment_amount(uuid)
  to authenticated, service_role;
grant execute on function
  app.register_payment(uuid, public.payment_purpose, uuid, integer, text),
  app.capture_payment(text, text, integer),
  app.fail_payment(text, text),
  app.claim_webhook_event(text, text),
  app.payout_refunds(integer)
to service_role;

alter publication supabase_realtime add table public.wallet_accounts;

select cron.schedule('campuscart-payout-refunds', '* * * * *', $$select app.payout_refunds()$$);
