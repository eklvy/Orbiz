-- DEVELOPMENT SEED — local and automated-test databases only. NEVER run against staging or
-- production. The outlet names "Cafe 1" and "Cafe 10" are the university's real cafe names
-- (given by the product owner, 2026-10-16); their locations, menus, prices and all people here
-- are fictional sample data (REQUIREMENTS.md D-14).
--
-- Test accounts (all share the password below; local-only throwaway credential):
--   password: DevOnly-CampusCart-2026
--
--   admin@campuscart.test        platform admin
--   manager.north@campuscart.test  manager, Cafe 1
--   kitchen.north@campuscart.test  kitchen staff, Cafe 1
--   manager.south@campuscart.test  manager, Cafe 10
--   student.one@campuscart.test    student (roll DEV-0001)
--   student.two@campuscart.test    student (roll DEV-0002)
--   faculty.one@campuscart.test    faculty

-- Fixed UUIDs keep tests and docs stable across resets.
create temporary table dev_users (id uuid, email text, meta jsonb) on commit drop;
insert into dev_users (id, email, meta) values
  ('00000000-0000-4000-a000-000000000001', 'admin@campuscart.test',
   '{"full_name": "Dev Admin"}'),
  ('00000000-0000-4000-a000-000000000002', 'manager.north@campuscart.test',
   '{"full_name": "Dev Manager North"}'),
  ('00000000-0000-4000-a000-000000000003', 'kitchen.north@campuscart.test',
   '{"full_name": "Dev Kitchen North"}'),
  ('00000000-0000-4000-a000-000000000004', 'manager.south@campuscart.test',
   '{"full_name": "Dev Manager South"}'),
  ('00000000-0000-4000-a000-000000000005', 'student.one@campuscart.test',
   '{"full_name": "Dev Student One", "roll_number": "DEV-0001", "department": "Computer Science", "year_of_study": "2"}'),
  ('00000000-0000-4000-a000-000000000006', 'student.two@campuscart.test',
   '{"full_name": "Dev Student Two", "roll_number": "DEV-0002", "department": "Mechanical", "year_of_study": "3"}'),
  ('00000000-0000-4000-a000-000000000007', 'faculty.one@campuscart.test',
   '{"full_name": "Dev Faculty One", "customer_type": "faculty", "department": "Computer Science"}');

-- auth.users rows as GoTrue would create them for confirmed email/password users.
-- The on_auth_user_created trigger creates the matching profiles.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new
)
select
  '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
  extensions.crypt('DevOnly-CampusCart-2026', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}', meta, now(), now(),
  '', '', '', ''
from dev_users;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select
  gen_random_uuid(), id, id::text, 'email',
  jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
  now(), now(), now()
from dev_users;

insert into public.outlets (id, slug, name, description, location) values
  ('00000000-0000-4000-b000-000000000001', 'cafe-1', 'Cafe 1',
   'Sample menu for local development (real menu to come).', 'Dev Block A, Ground Floor'),
  ('00000000-0000-4000-b000-000000000002', 'cafe-10', 'Cafe 10',
   'Sample menu for local development (real menu to come).', 'Dev Block C, First Floor'),
  ('00000000-0000-4000-b000-000000000003', 'dev-closed-kiosk', 'Dev Inactive Kiosk',
   'Fictional inactive outlet — should be hidden from the public.', 'Dev Block D');
update public.outlets set is_active = false where slug = 'dev-closed-kiosk';

insert into public.user_roles (user_id, role) values
  ('00000000-0000-4000-a000-000000000001', 'admin');

insert into public.outlet_staff (outlet_id, user_id, role) values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000002', 'manager'),
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-000000000003', 'kitchen_staff'),
  ('00000000-0000-4000-b000-000000000002', '00000000-0000-4000-a000-000000000004', 'manager');
