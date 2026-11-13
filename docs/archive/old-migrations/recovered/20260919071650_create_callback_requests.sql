-- Recovered 17 Oct 2026 from the live migration history (applied 19 Sep 2026,
-- never saved to the repo). Historical record only: the baseline in
-- supabase/migrations already contains this.
create table public.callback_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  phone text not null,
  email text,
  requested_date date not null,
  requested_time time not null,
  message text,
  status text not null default 'pending' check (status in ('pending','scheduled','completed','cancelled'))
);

alter table public.callback_requests enable row level security;

create policy "Allow public insert only" on public.callback_requests
  for insert to anon with check (true);

create policy "Pricing roles can view callback requests" on public.callback_requests
  for select to public using (is_pricing_role());

create policy "Pricing roles can update callback requests" on public.callback_requests
  for update to public using (is_pricing_role());

comment on table public.callback_requests is 'Website "book a call" requests, kept separate from leads so the app can alert on / schedule them distinctly. Populated only via the book_callback_slot() function.';
