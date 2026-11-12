-- Item 73c (backlog item 73): product pictures for the picture editor on a quote.
--
-- product_pictures: one row per picture of a model (an inverter, a battery), usually the maker's
-- own picture with a clear background, uploaded once in Settings > Company Details > Product
-- pictures. The picture editor on step 4 of a quote offers them to place on the client's wall
-- picture, the quote's own makes first. brand and model are what a person typed; url is the
-- picture in the proposal-photos bucket.
--
-- Staff can read them (the editor is on the quote page); only Admin adds, changes or removes them
-- (the Settings page).

create table if not exists public.product_pictures (
  id uuid primary key default gen_random_uuid(),
  brand text not null default '',
  model text not null default '',
  url text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists product_pictures_created_by_idx on public.product_pictures (created_by);

alter table public.product_pictures enable row level security;

drop policy if exists "Staff read product pictures" on public.product_pictures;
create policy "Staff read product pictures" on public.product_pictures
  for select to authenticated using (true);

drop policy if exists "Admin adds product pictures" on public.product_pictures;
create policy "Admin adds product pictures" on public.product_pictures
  for insert to authenticated with check ((select is_admin()));

drop policy if exists "Admin changes product pictures" on public.product_pictures;
create policy "Admin changes product pictures" on public.product_pictures
  for update to authenticated using ((select is_admin())) with check ((select is_admin()));

drop policy if exists "Admin removes product pictures" on public.product_pictures;
create policy "Admin removes product pictures" on public.product_pictures
  for delete to authenticated using ((select is_admin()));
