-- Fake data for the staging branch and per-PR preview branches.
-- Runs after supabase/migrations on a new branch. NEVER real customers.
--
-- Test logins (staging and preview branches only, all share one password):
--   admin@staging.test, finance@staging.test, sales@staging.test, staff@staging.test
--   password: StagingOnly-TEops-2026
-- Change them freely; they do not exist in production.

-- Company settings (singleton row)
insert into public.company_settings (id, company_name, abn, address, phone)
values (1, 'Thomson Energy (STAGING)', '00 000 000 000', '1 Test Street, Testville NSW 2000', '02 0000 0000')
on conflict (id) do nothing;

-- Test users, one per role
do $$
declare
  u record;
begin
  for u in
    select * from (values
      ('00000000-0000-4000-a000-000000000001'::uuid, 'admin@staging.test',   'Test Admin',   'admin'),
      ('00000000-0000-4000-a000-000000000002'::uuid, 'finance@staging.test', 'Test Finance', 'finance'),
      ('00000000-0000-4000-a000-000000000003'::uuid, 'sales@staging.test',   'Test Sales',   'sales'),
      ('00000000-0000-4000-a000-000000000004'::uuid, 'staff@staging.test',   'Test Sparky',  'staff')
    ) as t(id, email, full_name, role)
  loop
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
            extensions.crypt('StagingOnly-TEops-2026', extensions.gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.full_name),
            now(), now(), '', '', '', '')
    on conflict (id) do nothing;

    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
            'email', now(), now(), now())
    on conflict do nothing;

    -- Marked as onboarded, so test logins go straight into the app.
    insert into public.profiles (id, full_name, role, active, onboarding_completed_at)
    values (u.id, u.full_name, u.role, true, now())
    on conflict (id) do nothing;
  end loop;
end $$;

-- Clients
insert into public.clients (id, name, email, phone, address, client_type) values
  ('00000000-0000-4000-b000-000000000001', 'Jane Testperson', 'jane@example.test', '0400 000 001', '12 Sample Road, Testville NSW 2000', 'individual'),
  ('00000000-0000-4000-b000-000000000002', 'Acme Builders Pty Ltd (TEST)', 'accounts@acme.example.test', '0400 000 002', '3 Fake Avenue, Mocktown NSW 2001', 'company'),
  ('00000000-0000-4000-b000-000000000003', 'Bob Example', 'bob@example.test', '0400 000 003', '45 Demo Street, Testville NSW 2000', 'individual')
on conflict (id) do nothing;

-- Jobs and quotes at different pipeline stages
insert into public.projects (id, name, client_name, client_id, status, pipeline_stage, quote_number, job_number, created_by) values
  ('00000000-0000-4000-c000-000000000001', 'Switchboard upgrade (TEST)', 'Jane Testperson', '00000000-0000-4000-b000-000000000001', 'draft', 'draft_quote', 9001, null, '00000000-0000-4000-a000-000000000003'),
  ('00000000-0000-4000-c000-000000000002', '10kW solar + battery (TEST)', 'Acme Builders Pty Ltd (TEST)', '00000000-0000-4000-b000-000000000002', 'draft', 'quote_approved', 9002, 9002, '00000000-0000-4000-a000-000000000003'),
  ('00000000-0000-4000-c000-000000000003', 'Downlights and RCDs (TEST)', 'Bob Example', '00000000-0000-4000-b000-000000000003', 'draft', 'job_booked', 9003, 9003, '00000000-0000-4000-a000-000000000001')
on conflict (id) do nothing;
