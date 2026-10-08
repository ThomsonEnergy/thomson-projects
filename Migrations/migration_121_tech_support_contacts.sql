-- A shared list of tech support phone numbers (inverter makers, battery /
-- monitoring support, switchgear, software, etc.) so whoever's stuck on site
-- can find the right number fast. Free for any signed-in staff member to read
-- and maintain, same as the knowledge library.
create table if not exists tech_support_contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  phone text,
  phone_alt text,
  hours text,
  email text,
  website text,
  notes text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table tech_support_contacts enable row level security;
drop policy if exists "staff full access on tech_support_contacts" on tech_support_contacts;
create policy "staff full access on tech_support_contacts" on tech_support_contacts
  for all to authenticated using (true) with check (true);
