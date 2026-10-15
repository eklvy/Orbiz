-- Phase 5 · Loyalty (D-15, decided 2026-10-15), vouchers, and the monthly budget planner.
--
-- D-15: 1 point per ₹10 paid for an order (on payment; reversed when the order is refunded, never
-- below zero); +50 for one wallet top-up of ₹999 or more; +15 per review (reviews migration).
-- Tiers by lifetime points: Silver 0, Gold 1,000, Platinum 3,000. 100 points = a ₹10 voucher.

create type public.loyalty_reason as enum (
  'order_paid', 'order_refunded', 'topup_bonus', 'review', 'voucher_redeemed'
);
create type public.voucher_status as enum ('available', 'applied', 'used', 'expired');

create table public.loyalty_accounts (
  user_id uuid primary key references auth.users (id) on delete restrict,
  balance_points integer not null default 0 constraint loyalty_balance_non_negative check (balance_points >= 0),
  -- Points ever earned, minus reversals; redemptions don't lower it. Decides the tier.
  lifetime_points integer not null default 0 constraint loyalty_lifetime_non_negative check (lifetime_points >= 0),
  updated_at timestamptz not null default now()
);

create table public.loyalty_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete restrict,
  points integer not null constraint loyalty_ledger_points_non_zero check (points <> 0),
  reason public.loyalty_reason not null,
  order_id uuid references public.orders (id) on delete restrict,
  wallet_entry_id bigint references public.wallet_ledger (id) on delete restrict,
  voucher_id uuid,
  review_id uuid,
  created_at timestamptz not null default now()
);
create index loyalty_ledger_user_idx on public.loyalty_ledger (user_id, id desc);
create index loyalty_ledger_order_idx on public.loyalty_ledger (order_id);
create index loyalty_ledger_wallet_idx on public.loyalty_ledger (wallet_entry_id);
-- Each order earns once and is reversed at most once; each top-up earns its bonus once.
create unique index loyalty_ledger_once_per_order on public.loyalty_ledger (order_id, reason)
  where reason in ('order_paid', 'order_refunded');
create unique index loyalty_ledger_once_per_topup on public.loyalty_ledger (wallet_entry_id)
  where reason = 'topup_bonus';

create trigger loyalty_ledger_append_only
  before update or delete on public.loyalty_ledger
  for each row execute function private.forbid_ledger_changes();

create table public.vouchers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  code text not null unique constraint vouchers_code_format check (code ~ '^CC-[A-HJ-NP-Z2-9]{8}$'),
  value_paise integer not null constraint vouchers_value_positive check (value_paise > 0),
  status public.voucher_status not null default 'available',
  order_id uuid references public.orders (id) on delete restrict,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vouchers_order_when_applied check ((status in ('applied', 'used')) = (order_id is not null))
);
create index vouchers_user_idx on public.vouchers (user_id, created_at desc);
create index vouchers_order_idx on public.vouchers (order_id);
create trigger vouchers_set_updated_at
  before update on public.vouchers
  for each row execute function private.set_updated_at();

alter table public.loyalty_ledger
  add constraint loyalty_ledger_voucher_fk foreign key (voucher_id) references public.vouchers (id) on delete restrict;
create index loyalty_ledger_voucher_idx on public.loyalty_ledger (voucher_id);

-- Orders can carry a voucher discount. total = subtotal − discount, always.
alter table public.orders
  add column discount_paise integer not null default 0
    constraint orders_discount_non_negative check (discount_paise >= 0),
  add column voucher_id uuid references public.vouchers (id) on delete restrict,
  add constraint orders_total_is_subtotal_less_discount check (total_paise = subtotal_paise - discount_paise);
create index orders_voucher_idx on public.orders (voucher_id);

create table public.budgets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  monthly_limit_paise integer not null constraint budgets_monthly_range check (monthly_limit_paise between 10000 and 10000000),
  daily_limit_paise integer constraint budgets_daily_range check (daily_limit_paise between 1000 and 10000000),
  warn_at_percent smallint not null default 80 constraint budgets_warn_range check (warn_at_percent between 50 and 100),
  updated_at timestamptz not null default now()
);
create trigger budgets_set_updated_at
  before update on public.budgets
  for each row execute function private.set_updated_at();

-- Privileges and RLS: owners read their own rows; writes go through functions.
revoke all on public.loyalty_accounts, public.loyalty_ledger, public.vouchers, public.budgets from anon, authenticated;
grant select on public.loyalty_accounts, public.loyalty_ledger, public.vouchers, public.budgets to authenticated;
alter table public.loyalty_accounts enable row level security;
alter table public.loyalty_ledger enable row level security;
alter table public.vouchers enable row level security;
alter table public.budgets enable row level security;
create policy loyalty_accounts_select_own on public.loyalty_accounts
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy loyalty_ledger_select_own on public.loyalty_ledger
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy vouchers_select_own on public.vouchers
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_admin()));
create policy budgets_select_own on public.budgets
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Points
-- ---------------------------------------------------------------------------
create function private.loyalty_tier(p_lifetime integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_lifetime >= 3000 then 'platinum' when p_lifetime >= 1000 then 'gold' else 'silver' end;
$$;
grant execute on function private.loyalty_tier(integer) to anon, authenticated, service_role;

-- Posts points. Earning raises lifetime; reversals lower it; redemptions only lower the balance.
create function private.loyalty_post(
  p_user uuid, p_points integer, p_reason public.loyalty_reason,
  p_order uuid default null, p_wallet_entry bigint default null, p_voucher uuid default null,
  p_review uuid default null
)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_points = 0 then
    return;
  end if;
  insert into public.loyalty_accounts (user_id) values (p_user) on conflict do nothing;
  update public.loyalty_accounts set
    balance_points = balance_points + p_points,
    lifetime_points = greatest(0, lifetime_points + case when p_reason = 'voucher_redeemed' then 0 else p_points end),
    updated_at = now()
  where user_id = p_user and balance_points + p_points >= 0;
  if not found then
    perform private.fail(409, 'not_enough_points', 'Not enough loyalty points');
  end if;
  insert into public.loyalty_ledger (user_id, points, reason, order_id, wallet_entry_id, voucher_id, review_id)
  values (p_user, p_points, p_reason, p_order, p_wallet_entry, p_voucher, p_review);
end;
$$;
revoke all on function private.loyalty_post(uuid, integer, public.loyalty_reason, uuid, bigint, uuid, uuid) from public;

-- Order paid → points (1 per ₹10 actually paid); order refunded → those points back, as far as the
-- balance allows (points already spent on vouchers are not clawed back below zero).
-- Vouchers follow the order: used when it is paid, released if it ends unpaid.
create function private.on_order_money_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_earned integer;
  v_balance integer;
begin
  if new.payment_status = 'paid' and old.payment_status <> 'paid' then
    if new.voucher_id is not null then
      update public.vouchers set status = 'used' where id = new.voucher_id;
    end if;
    perform private.loyalty_post(new.user_id, new.total_paise / 1000, 'order_paid', new.id);
  end if;
  if new.status = 'cancelled' and old.status <> 'cancelled' and new.payment_status = 'unpaid'
     and new.voucher_id is not null then
    update public.vouchers set status = 'available', order_id = null where id = new.voucher_id and status = 'applied';
  end if;
  if new.refund_status = 'refunded' and old.refund_status <> 'refunded' then
    for v_earned, v_balance in
      select l.points, coalesce(a.balance_points, 0)
      from public.loyalty_ledger l
      left join public.loyalty_accounts a on a.user_id = l.user_id
      where l.order_id = new.id and l.reason = 'order_paid' and l.user_id = new.user_id
    loop
      perform private.loyalty_post(new.user_id, -least(v_earned, v_balance), 'order_refunded', new.id);
    end loop;
  end if;
  return null;
end;
$$;
revoke all on function private.on_order_money_change() from public;

create trigger orders_money_change
  after update of payment_status, status, refund_status on public.orders
  for each row execute function private.on_order_money_change();

-- A single top-up of ₹999 or more earns 50 points (report §9).
create function private.on_wallet_topup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind = 'topup' and new.amount_paise >= 99900 then
    perform private.loyalty_post(new.user_id, 50, 'topup_bonus', null, new.id);
  end if;
  return null;
end;
$$;
revoke all on function private.on_wallet_topup() from public;

create trigger wallet_ledger_topup_bonus
  after insert on public.wallet_ledger
  for each row execute function private.on_wallet_topup();

-- ---------------------------------------------------------------------------
-- Vouchers
-- ---------------------------------------------------------------------------
create function app.redeem_points_for_voucher()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_id uuid := gen_random_uuid();
  v_code text := 'CC-';
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea := extensions.gen_random_bytes(8);
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  for i in 0..7 loop
    v_code := v_code || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1);
  end loop;
  insert into public.vouchers (id, user_id, code, value_paise, expires_at)
  values (v_id, v_user, v_code, 1000, now() + interval '90 days');
  perform private.loyalty_post(v_user, -100, 'voucher_redeemed', null, null, v_id);
  return v_id;
end;
$$;

-- Apply a voucher to one's own unpaid order: total = subtotal − voucher value. The order must
-- cost more than the voucher (a voucher is never partly wasted or turned into money).
create function app.apply_voucher(p_order_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_order public.orders;
  v_voucher public.vouchers;
begin
  if v_user is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  select * into v_order from public.orders where id = p_order_id for update;
  if not found or v_order.user_id <> v_user then
    perform private.fail(404, 'order_not_found', 'Order not found');
  end if;
  if v_order.status <> 'payment_pending' then
    perform private.fail(409, 'order_not_pending', 'Vouchers can only be added before paying');
  end if;
  if v_order.voucher_id is not null then
    perform private.fail(409, 'voucher_already_applied', 'This order already has a voucher');
  end if;
  select * into v_voucher from public.vouchers
  where code = upper(btrim(coalesce(p_code, ''))) and user_id = v_user for update;
  if not found then
    perform private.fail(404, 'voucher_not_found', 'Voucher not found');
  end if;
  if v_voucher.status <> 'available' or v_voucher.expires_at <= now() then
    perform private.fail(409, 'voucher_unavailable', 'This voucher has been used or has expired');
  end if;
  if v_order.subtotal_paise <= v_voucher.value_paise then
    perform private.fail(409, 'order_too_small', 'The order must cost more than the voucher');
  end if;
  update public.vouchers set status = 'applied', order_id = p_order_id where id = v_voucher.id;
  update public.orders set
    voucher_id = v_voucher.id, discount_paise = v_voucher.value_paise,
    total_paise = subtotal_paise - v_voucher.value_paise, version = version + 1
  where id = p_order_id;
end;
$$;

-- A captured card payment must match the order's current total (a voucher added after checkout
-- started changes it); otherwise the money is kept in the wallet instead of over-charging.
create or replace function app.capture_payment(p_provider_order_id text, p_provider_payment_id text, p_amount integer)
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
  if v_payment.order_id is not null then
    perform 1 from public.orders where id = v_payment.order_id for update;
  end if;
  select * into v_payment from public.payments where id = v_payment.id for update;

  if v_payment.status = 'captured' then
    if v_payment.provider_payment_id = p_provider_payment_id then
      return v_payment.outcome;
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
  elsif (select total_paise from public.orders where id = v_payment.order_id) <> v_payment.amount_paise then
    perform private.wallet_post(v_payment.user_id, 'refund', v_payment.amount_paise, v_payment.order_id,
                                v_payment.id, null, 'Order total changed after checkout; money kept in wallet');
    v_outcome := 'credited_to_wallet';
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

-- ---------------------------------------------------------------------------
-- Budget
-- ---------------------------------------------------------------------------
create function app.set_budget(p_monthly_limit integer, p_daily_limit integer default null, p_warn_at integer default 80)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  insert into public.budgets (user_id, monthly_limit_paise, daily_limit_paise, warn_at_percent)
  values (auth.uid(), p_monthly_limit, p_daily_limit, p_warn_at)
  on conflict (user_id) do update set
    monthly_limit_paise = excluded.monthly_limit_paise,
    daily_limit_paise = excluded.daily_limit_paise,
    warn_at_percent = excluded.warn_at_percent;
exception when check_violation then
  perform private.fail(422, 'invalid_budget', 'Monthly ₹100–₹1,00,000; daily ₹10 or more; warning at 50–100%');
end;
$$;

create function app.clear_budget()
returns void
language sql
security definer
set search_path = ''
as $$ delete from public.budgets where user_id = auth.uid(); $$;

revoke all on function
  app.redeem_points_for_voucher(), app.apply_voucher(uuid, text),
  app.set_budget(integer, integer, integer), app.clear_budget()
from public;
grant execute on function
  app.redeem_points_for_voucher(), app.apply_voucher(uuid, text),
  app.set_budget(integer, integer, integer), app.clear_budget()
to authenticated, service_role;

alter publication supabase_realtime add table public.loyalty_accounts;
