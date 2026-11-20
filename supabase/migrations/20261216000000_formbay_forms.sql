-- Item 101, Formbay both ways: one row per Formbay form linked to a job.
--
-- The server (netlify/functions/_shared/formbay-sync.js, service role) keeps each row in step with
-- Formbay: the stage, what the form is waiting on, the form's own details (NMI, serial numbers,
-- install date) and its documents. The job's STCs tab reads it. Nobody writes it from the browser.
--
-- Additions only. No money, stock or payroll. RLS: pricing roles read (the same people as job_stcs).

create table if not exists public.formbay_forms (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  job_stc_id uuid references public.job_stcs(id) on delete set null,
  ftype text not null default 'bstc' check (ftype in ('pv', 'bstc', 'swh')),
  formbay_job_id text not null,
  -- Formbay's own status word (new, in_progress, installed, submitted, uploaded, approved, rejected), or sold.
  job_status text,
  form jsonb not null default '{}'::jsonb,     -- the form's details as Formbay sent them
  docs jsonb not null default '[]'::jsonb,     -- the form's documents as Formbay listed them
  filed jsonb not null default '{}'::jsonb,    -- Formbay file id -> where it was filed on the job
  synced_at timestamptz,
  sync_error text,
  equipment_made_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (ftype, formbay_job_id)
);

create index if not exists formbay_forms_project on public.formbay_forms (project_id);
create index if not exists formbay_forms_job_stc on public.formbay_forms (job_stc_id);
create index if not exists formbay_forms_created_by on public.formbay_forms (created_by);

alter table public.formbay_forms enable row level security;
revoke all on public.formbay_forms from public, anon, authenticated;
grant select on public.formbay_forms to authenticated;

drop policy if exists "Pricing roles read formbay forms" on public.formbay_forms;
create policy "Pricing roles read formbay forms" on public.formbay_forms
  for select to authenticated using ((select is_pricing_role()));

-- Equipment made from a Formbay form remembers the form, so a later read updates it and never doubles it.
alter table public.customer_assets add column if not exists formbay_form_id uuid references public.formbay_forms(id) on delete set null;
create index if not exists customer_assets_formbay_form on public.customer_assets (formbay_form_id);

-- One STC line per Formbay form on a job, so two reads landing together cannot add it twice.
create unique index if not exists job_stcs_one_per_formbay_form on public.job_stcs (project_id, formbay_job_id) where formbay_job_id is not null;
