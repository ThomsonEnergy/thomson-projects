-- A running log, per job, of out-of-scope work (a variation) as it happens:
-- what was done, how long it took, what materials went in. Anyone on the job
-- can add to it from site; pricing roles then mark each entry billed or no
-- charge, and the invoicing screen warns about anything still "to bill" so a
-- variation doesn't get missed. No dollar amounts are stored here on purpose -
-- staff see this tab, and pricing stays with the pricing roles.
create table if not exists job_variation_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  description text not null,
  hours numeric,
  materials text,
  work_date date not null default current_date,
  status text not null default 'to_bill' check (status in ('to_bill', 'billed', 'no_charge')),
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  status_changed_by uuid references profiles(id) on delete set null,
  status_changed_at timestamptz
);
create index if not exists job_variation_entries_project_idx on job_variation_entries (project_id);

alter table job_variation_entries enable row level security;
drop policy if exists "variation entries readable" on job_variation_entries;
create policy "variation entries readable" on job_variation_entries for select to authenticated using (true);
drop policy if exists "variation entries insertable" on job_variation_entries;
create policy "variation entries insertable" on job_variation_entries for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "variation entries editable" on job_variation_entries;
create policy "variation entries editable" on job_variation_entries for update to authenticated
  using ((created_by = auth.uid() and status = 'to_bill') or is_pricing_role())
  with check ((created_by = auth.uid() and status = 'to_bill') or is_pricing_role());
drop policy if exists "variation entries deletable" on job_variation_entries;
create policy "variation entries deletable" on job_variation_entries for delete to authenticated
  using ((created_by = auth.uid() and status = 'to_bill') or is_pricing_role());
