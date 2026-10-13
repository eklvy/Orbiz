-- Phase 1 · Append-only audit log for security-sensitive changes.
-- Rows are written only by the trigger below; no role (including service_role) may
-- update or delete them through normal privileges.

create table public.audit_logs (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  -- auth.uid() of the end user, or NULL for system/server-side changes.
  actor_id uuid references auth.users (id) on delete set null,
  action text not null constraint audit_logs_action check (action in ('INSERT', 'UPDATE', 'DELETE')),
  table_name text not null,
  record_key jsonb not null,
  -- Set when the change belongs to an outlet, so that outlet's managers can review it.
  outlet_id uuid references public.outlets (id) on delete set null,
  old_data jsonb,
  new_data jsonb
);

create index audit_logs_outlet_idx on public.audit_logs (outlet_id, occurred_at desc);
create index audit_logs_actor_idx on public.audit_logs (actor_id, occurred_at desc);
create index audit_logs_table_idx on public.audit_logs (table_name, occurred_at desc);

create function private.write_audit_log()
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
    when 'outlet_staff' then (any_row ->> 'outlet_id')::uuid
  end;

  -- When an outlet is deleted (directly, or staff rows cascading from it) the FK target is
  -- gone; the id stays available in record_key / old_data.
  if outlet is not null and not exists (select 1 from public.outlets where id = outlet) then
    outlet := null;
  end if;

  insert into public.audit_logs (actor_id, action, table_name, record_key, outlet_id, old_data, new_data)
  values ((select auth.uid()), tg_op, tg_table_name, key, outlet, old_row, new_row);
  return null;
end;
$$;

revoke all on function private.write_audit_log() from public, anon, authenticated;

create trigger outlets_audit
  after insert or update or delete on public.outlets
  for each row execute function private.write_audit_log();

create trigger outlet_staff_audit
  after insert or update or delete on public.outlet_staff
  for each row execute function private.write_audit_log();

create trigger user_roles_audit
  after insert or update or delete on public.user_roles
  for each row execute function private.write_audit_log();

-- Privileges: readable under RLS, never writable directly.
revoke all on public.audit_logs from anon, authenticated, service_role;
grant select on public.audit_logs to authenticated, service_role;

alter table public.audit_logs enable row level security;

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    (select private.is_admin())
    or (outlet_id is not null and (select private.is_outlet_manager(outlet_id)))
  );
