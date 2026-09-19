-- Migration 109 — Surface callback_requests in the app
--
-- callback_requests (the website's new "Book a call" feature) already
-- existed with clean RLS mirroring leads (public insert, pricing-role
-- select/update) - but nothing in this app read it yet. Jasper wants a
-- callback request to show as an "up for grabs" item on the Home page
-- (any staff member, not just pricing roles - same open pattern
-- job_tasks already uses for free tasks) and listed on the Leads page.
--
-- claimed_by tracks who picked one up from Home - once claimed it drops
-- off the "up for grabs" list there, but still shows on the Leads page
-- either way.

alter table callback_requests add column claimed_by uuid references profiles(id);

drop policy if exists "Pricing roles can view callback requests" on callback_requests;
create policy "Authenticated can view callback requests" on callback_requests
  for select using (auth.uid() is not null);

drop policy if exists "Pricing roles can update callback requests" on callback_requests;
create policy "Authenticated can update callback requests" on callback_requests
  for update using (auth.uid() is not null);
