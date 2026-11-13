-- Only needed if you already ran schema.sql before this update. Safe to run
-- even if you haven't, it will just do nothing.

-- Caches one AI-generated greeting per calendar day (shared across every
-- user, personalised client-side by swapping in {name}) so the homepage
-- doesn't trigger a fresh AI call on every single page load.
create table if not exists daily_greetings (
  greeting_date date primary key,
  message text not null,
  created_at timestamptz not null default now()
);

alter table daily_greetings enable row level security;
drop policy if exists "staff can read daily greetings" on daily_greetings;
create policy "staff can read daily greetings"
  on daily_greetings for select to authenticated using (true);

-- No insert/update policy: rows are only ever written by the
-- get-daily-greeting Netlify function using the service role key, which
-- bypasses RLS entirely.
