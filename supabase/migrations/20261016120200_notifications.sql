-- Phase 5 · Notification Center (F23). Notifications are written only by database triggers on real
-- events (order progress, refunds, loyalty), never by clients. Students read and mark them read.
-- Push to phones is optional: the API sends pending ones via Expo when an access token is set.

create type public.notification_category as enum ('orders', 'refunds', 'loyalty', 'specials', 'social');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category public.notification_category not null,
  title text not null constraint notifications_title_length check (char_length(title) between 1 and 120),
  body text not null constraint notifications_body_length check (char_length(body) <= 500),
  -- Where the app should take the student (e.g. {"order_id": "…"}).
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  pushed_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id) where read_at is null;
create index notifications_push_idx on public.notifications (created_at) where pushed_at is null;

create table public.push_tokens (
  token text primary key constraint push_tokens_format check (token ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,100}\]$'),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null constraint push_tokens_platform check (platform in ('ios', 'android')),
  created_at timestamptz not null default now()
);
create index push_tokens_user_idx on public.push_tokens (user_id);

revoke all on public.notifications, public.push_tokens from anon, authenticated;
grant select on public.notifications, public.push_tokens to authenticated;
alter table public.notifications enable row level security;
alter table public.push_tokens enable row level security;
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = (select auth.uid()));
create policy push_tokens_select_own on public.push_tokens
  for select to authenticated using (user_id = (select auth.uid()));

create function private.notify(p_user uuid, p_category public.notification_category, p_title text, p_body text, p_data jsonb)
returns void
language sql
set search_path = ''
as $$
  insert into public.notifications (user_id, category, title, body, data)
  values (p_user, p_category, left(p_title, 120), left(p_body, 500), coalesce(p_data, '{}'::jsonb));
$$;
revoke all on function private.notify(uuid, public.notification_category, text, text, jsonb) from public;

-- Order progress and refunds → the order's owner.
create function private.notify_order_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.orders;
  v_outlet text;
  v_label text;
  v_data jsonb;
begin
  select * into v_order from public.orders where id = new.order_id;
  select name into v_outlet from public.outlets where id = v_order.outlet_id;
  v_label := coalesce(v_order.token_label, 'Your order');
  v_data := jsonb_build_object('order_id', v_order.id);

  if new.event_type = 'payment_confirmed' and new.to_status = 'ready_for_pickup' then
    perform private.notify(v_order.user_id, 'orders', v_label || ' is ready', 'Your deal is waiting at the ' || v_outlet || ' counter.', v_data);
  elsif new.event_type = 'payment_confirmed' then
    perform private.notify(v_order.user_id, 'orders', 'Order ' || v_label || ' placed', 'Paid. ' || v_outlet || ' will start on it soon.', v_data);
  elsif new.event_type = 'status_changed' and new.to_status = 'preparing' then
    perform private.notify(v_order.user_id, 'orders', v_label || ' is being prepared', 'Your turn is coming up at ' || v_outlet || '.', v_data);
  elsif new.event_type = 'status_changed' and new.to_status = 'ready_for_pickup' then
    perform private.notify(v_order.user_id, 'orders', v_label || ' is ready for pickup', 'Show your Food Pass at the ' || v_outlet || ' counter.', v_data);
  elsif new.event_type = 'status_changed' and new.to_status in ('cancelled', 'rejected') and new.actor = 'staff' then
    perform private.notify(v_order.user_id, 'orders', v_label || ' was ' || new.to_status::text,
      coalesce('Reason: ' || new.reason, v_outlet || ' couldn''t complete it.')
      || case when v_order.payment_status = 'paid' then ' You''ll be refunded to your wallet.' else '' end, v_data);
  elsif new.event_type = 'expired' then
    perform private.notify(v_order.user_id, 'orders', 'Order not paid in time', 'The hold on your items was released.', v_data);
  elsif new.event_type = 'no_show' then
    perform private.notify(v_order.user_id, 'orders', v_label || ' wasn''t collected', coalesce(new.reason, 'It was not collected in time.'), v_data);
  elsif new.event_type = 'refund_approved' then
    perform private.notify(v_order.user_id, 'refunds', 'Refund approved', 'Your refund for ' || v_label || ' is on its way to your wallet.', v_data);
  elsif new.event_type = 'refund_declined' then
    perform private.notify(v_order.user_id, 'refunds', 'Refund declined', coalesce('Note from ' || v_outlet || ': ' || new.reason, 'Your refund request was declined.'), v_data);
  elsif new.event_type = 'refund_paid' then
    perform private.notify(v_order.user_id, 'refunds', 'Refund paid', 'Your refund for ' || v_label || ' is in your CampusCart wallet.', v_data);
  end if;
  return null;
end;
$$;
revoke all on function private.notify_order_event() from public;

create trigger order_events_notify
  after insert on public.order_events
  for each row execute function private.notify_order_event();

-- Points earned → the student.
create function private.notify_loyalty()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.points > 0 then
    perform private.notify(new.user_id, 'loyalty', 'You earned ' || new.points || ' points',
      case new.reason
        when 'topup_bonus' then 'Bonus for topping up ₹999 or more.'
        when 'review' then 'Thanks for reviewing your order.'
        else 'For your order.' end,
      jsonb_build_object('order_id', new.order_id));
  end if;
  return null;
end;
$$;
revoke all on function private.notify_loyalty() from public;

create trigger loyalty_ledger_notify
  after insert on public.loyalty_ledger
  for each row execute function private.notify_loyalty();

-- ---------------------------------------------------------------------------
-- Student actions
-- ---------------------------------------------------------------------------
create function app.mark_notifications_read(p_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  update public.notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create function app.register_push_token(p_token text, p_platform text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    perform private.fail(401, 'unauthenticated', 'Sign in first');
  end if;
  -- A device token belongs to whoever signed in on that device most recently.
  insert into public.push_tokens (token, user_id, platform) values (p_token, auth.uid(), p_platform)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, created_at = now();
exception when check_violation then
  perform private.fail(422, 'invalid_push_token', 'Not an Expo push token');
end;
$$;

create function app.remove_push_token(p_token text)
returns void
language sql
security definer
set search_path = ''
as $$ delete from public.push_tokens where token = p_token and user_id = auth.uid(); $$;

-- System (API push sender): take a batch of unsent notifications with their device tokens.
-- Marks them pushed in the same transaction (at-most-once delivery; missed pushes still show in-app).
create function app.claim_pending_pushes(p_limit integer default 100)
returns table (notification_id uuid, token text, title text, body text, data jsonb)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_system_caller() then
    perform private.fail(403, 'forbidden', 'System operation');
  end if;
  return query
    with batch as (
      select n.id from public.notifications n
      where n.pushed_at is null and n.created_at > now() - interval '1 hour'
      order by n.created_at limit p_limit
      for update skip locked
    ), marked as (
      update public.notifications n set pushed_at = now() from batch where n.id = batch.id
      returning n.id, n.user_id, n.title, n.body, n.data
    )
    select m.id, t.token, m.title, m.body, m.data
    from marked m join public.push_tokens t on t.user_id = m.user_id;
end;
$$;

revoke all on function
  app.mark_notifications_read(uuid[]), app.register_push_token(text, text), app.remove_push_token(text),
  app.claim_pending_pushes(integer)
from public;
grant execute on function
  app.mark_notifications_read(uuid[]), app.register_push_token(text, text), app.remove_push_token(text)
to authenticated, service_role;
grant execute on function app.claim_pending_pushes(integer) to service_role;

alter publication supabase_realtime add table public.notifications;
