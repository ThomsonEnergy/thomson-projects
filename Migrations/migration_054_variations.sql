-- Variations - a record of a change made to a job's cost centres after its
-- quote was approved. Two ways to record one, chosen at the moment the
-- change is saved:
--   quick_note - just the $ delta and a reason, logged instantly
--   full       - signed off (on-screen for now; a client-link remote-sign
--                entry point is a planned follow-up, not built yet)
-- `changes` captures every stage affected by that one save, since a single
-- edit can touch more than one cost centre at once - not worth a separate
-- variation row per stage when they all happened together for one reason.

create table if not exists variations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  changes jsonb not null default '[]', -- [{cost_centre_id, cost_centre_name, old_amount, new_amount}]
  total_delta numeric(12,2) not null default 0,
  variation_type text not null default 'quick_note' check (variation_type in ('quick_note', 'full')),
  status text not null default 'recorded' check (status in ('recorded', 'signed')),
  signature_data_url text,
  signed_by_name text,
  signed_at timestamptz,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists variations_project_id_idx on variations (project_id);

alter table variations enable row level security;
drop policy if exists "staff full access on variations" on variations;
create policy "staff full access on variations"
  on variations for all to authenticated using (true) with check (true);
