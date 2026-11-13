-- Review requests: when staff email a client from a job they can tick "ask for a review".
-- The email carries a link to /review.html?t=<token>. That page works without any
-- account: the client picks stars and writes a comment (saved here), then is offered
-- a button to post the same on Google if they use it.
--
-- The page is public, so it never touches this table directly: the get-review-request and
-- submit-review Netlify functions (service role) look rows up by the unguessable token.
-- Staff read and create rows through RLS like everything else.
--
-- company_settings.google_review_url: the "write a review" link for the business's
-- Google profile (Settings > Company).

create table if not exists review_requests (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  project_id uuid references projects(id) on delete set null,
  client_name text,
  client_email text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  rating int check (rating between 1 and 5),
  comment text,
  submitted_at timestamptz,
  google_clicked_at timestamptz
);
create index if not exists review_requests_project_idx on review_requests (project_id);

alter table review_requests enable row level security;
drop policy if exists "staff full access on review_requests" on review_requests;
create policy "staff full access on review_requests" on review_requests for all to authenticated using (true) with check (true);

alter table company_settings add column if not exists google_review_url text;
