-- Only needed if you already ran schema.sql before photos and terms and
-- conditions were added. Safe to run even if you haven't.

create table if not exists company_settings (
  id int primary key default 1 constraint singleton check (id = 1),
  default_terms text not null default '',
  portfolio_photos jsonb not null default '[]'
);
insert into company_settings (id) values (1) on conflict (id) do nothing;

alter table company_settings enable row level security;
drop policy if exists "staff full access on company_settings" on company_settings;
create policy "staff full access on company_settings"
  on company_settings for all to authenticated using (true) with check (true);
drop policy if exists "public can read company_settings" on company_settings;
create policy "public can read company_settings"
  on company_settings for select to anon using (true);

alter table projects add column if not exists terms_text text not null default '';
alter table projects add column if not exists cover_photos jsonb not null default '[]';
alter table projects add column if not exists reference_photos jsonb not null default '[]';

insert into storage.buckets (id, name, public)
values ('proposal-photos', 'proposal-photos', true)
on conflict (id) do nothing;

drop policy if exists "public can view proposal photos" on storage.objects;
create policy "public can view proposal photos"
  on storage.objects for select to public
  using (bucket_id = 'proposal-photos');

drop policy if exists "staff can upload proposal photos" on storage.objects;
create policy "staff can upload proposal photos"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'proposal-photos');

drop policy if exists "staff can delete proposal photos" on storage.objects;
create policy "staff can delete proposal photos"
  on storage.objects for delete to authenticated
  using (bucket_id = 'proposal-photos');
