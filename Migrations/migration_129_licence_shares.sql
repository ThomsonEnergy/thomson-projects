-- Shareable licence / insurance packs. An admin ticks which company
-- insurance/licences and which employee licences to include, then either
-- downloads them as a zip, or makes a live link (share-licences.html?token=)
-- that anyone with the link can open without logging in. The link always shows
-- the CURRENT files and expiry dates (a renewed certificate replaces the old
-- one automatically), can have an expiry date, and can be switched off.
-- The public page reads through the get-licence-share function (service role),
-- so this table itself is admin-only.
create table if not exists licence_shares (
  id uuid primary key default gen_random_uuid(),
  token uuid not null unique default gen_random_uuid(),
  label text,
  company_credential_ids uuid[] not null default '{}',
  employee_licence_ids uuid[] not null default '{}',
  expires_at timestamptz,
  revoked boolean not null default false,
  view_count integer not null default 0,
  last_viewed_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table licence_shares enable row level security;
drop policy if exists "Admin manages licence shares" on licence_shares;
create policy "Admin manages licence shares" on licence_shares
  for all using (is_admin()) with check (is_admin());
