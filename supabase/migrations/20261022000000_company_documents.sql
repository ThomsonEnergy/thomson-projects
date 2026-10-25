-- Company documents: the docs Thomson Energy sends out on any job (Documents page, documents.html).
-- One built-in doc, the Schedule of Rates (rates.html, drawn from billable_rate_tiers), plus any
-- uploaded file. On a job, "Add from Documents" copies one into the job's "Company docs" folder,
-- where the job email already offers it as an attachment.
-- Everyone can add and rename; only admins can delete, and the Schedule of Rates cannot be deleted.
-- Uploaded files live in the project-documents bucket under company-documents/, so the existing
-- bucket rules apply and adding one to a job is a copy inside the same bucket.

create table if not exists public.company_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  kind text not null default 'file',
  file_path text,
  file_name text,
  mime_type text,
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint company_documents_kind_check check (kind in ('file', 'schedule_of_rates')),
  constraint company_documents_file_check check (kind <> 'file' or file_path is not null)
);

create index if not exists company_documents_created_by_idx on public.company_documents (created_by);
create unique index if not exists company_documents_one_sor_idx on public.company_documents (kind) where kind = 'schedule_of_rates';

alter table public.company_documents enable row level security;

drop policy if exists "Staff read company documents" on public.company_documents;
create policy "Staff read company documents" on public.company_documents for select to authenticated
  using (true);
drop policy if exists "Staff add company documents" on public.company_documents;
create policy "Staff add company documents" on public.company_documents for insert to authenticated
  with check (kind = 'file' and created_by = (select auth.uid()));
drop policy if exists "Staff rename company documents" on public.company_documents;
create policy "Staff rename company documents" on public.company_documents for update to authenticated
  using (true)
  with check (true);
drop policy if exists "Admins delete company documents" on public.company_documents;
create policy "Admins delete company documents" on public.company_documents for delete to authenticated
  using ((select is_admin()) and kind = 'file');

insert into public.company_documents (title, kind, sort_order)
select 'Schedule of Rates', 'schedule_of_rates', 0
where not exists (select 1 from public.company_documents where kind = 'schedule_of_rates');

-- The date the rates were last checked: printed as "current as at" on the Schedule of Rates (the
-- standalone doc and the estimate page). The ops manager opens a "Needs me" reminder 6 months on.
alter table public.company_settings add column if not exists rates_reviewed_on date;
update public.company_settings set rates_reviewed_on = date '2026-10-18' where id = 1 and rates_reviewed_on is null;

-- The public Schedule of Rates page (rates.html) and its PDF read the rates through this: anonymous
-- visitors cannot read billable_rate_tiers, and the rates are already on every estimate.
create or replace function public.get_schedule_of_rates()
 returns json
 language sql
 stable security definer
 set search_path = public
as $function$
  select json_build_object(
    'rates', (
      select coalesce(json_agg(json_build_object('name', t.name, 'sell_rate', t.sell_rate) order by t.sort_order), '[]'::json)
      from billable_rate_tiers t
    ),
    'reviewed_on', (select s.rates_reviewed_on from company_settings s where s.id = 1)
  );
$function$;

grant execute on function public.get_schedule_of_rates() to anon, authenticated;
