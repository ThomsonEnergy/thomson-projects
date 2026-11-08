-- Invoice history (docs/IDEAS_BACKLOG.md item 61, spec A28): one row per thing that happens to an
-- invoice, so the Invoices page and the job's Invoices tab can say where each invoice is and who did
-- what, when. Read by pricing roles. Written by the server where the server does the work
-- (netlify/functions/_shared/invoice-events.js: created, emailed, reminder, pushed to Xero, paid,
-- credit notes) and by the browser for the edit panel, the notes and "Sent another way"
-- (js/invoice-actions.js; the actor is always the signed in person). Never updated or deleted:
-- history is not rewritten. Backfilled below from invoices (created, paid) and the job activity log
-- (emailed, edited, credit notes), so invoices from before today have a history too.

create table if not exists public.invoice_events (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  kind text not null check (kind in ('created', 'edited', 'emailed', 'reminder', 'sent_elsewhere', 'pushed_to_xero', 'paid', 'credit_note', 'credit_note_pushed', 'notes')),
  detail text,
  email_thread_id uuid references public.email_threads(id) on delete set null,
  actor_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_events_invoice_idx on public.invoice_events (invoice_id, created_at);
create index if not exists invoice_events_email_thread_idx on public.invoice_events (email_thread_id);
create index if not exists invoice_events_actor_idx on public.invoice_events (actor_id);

alter table public.invoice_events enable row level security;
drop policy if exists "Pricing roles read invoice events" on public.invoice_events;
create policy "Pricing roles read invoice events" on public.invoice_events
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add their own invoice events" on public.invoice_events;
create policy "Pricing roles add their own invoice events" on public.invoice_events
  for insert to authenticated with check ((select is_pricing_role()) and actor_id = (select auth.uid()));
-- no update or delete policy: the server (service role) is the only other writer

-- Backfill. Created: every invoice, at its created_at, by created_by (a deposit invoice is made by the
-- approval, nobody in particular).
insert into public.invoice_events (invoice_id, kind, detail, actor_id, created_at)
select i.id, 'created',
  case when i.is_deposit then 'Deposit invoice made when the quote was approved' else 'Invoice created' end,
  i.created_by, i.created_at
from public.invoices i
where not exists (select 1 from public.invoice_events e where e.invoice_id = i.id and e.kind = 'created');

-- Emailed, edited and credit notes: from the job's activity log lines, matched on the invoice
-- number in the line and the job. The emailed line keeps who it went to.
insert into public.invoice_events (invoice_id, kind, detail, actor_id, created_at)
select i.id,
  case a.action when 'invoice_emailed' then 'emailed' when 'invoice_edited' then 'edited' else 'credit_note' end,
  case a.action
    when 'invoice_emailed' then regexp_replace(a.description, '^Invoice \S+ emailed to ', 'To ')
    when 'invoice_edited' then 'Amounts or dates changed (before today the old and new totals were not kept)'
    else 'Credit note issued'
  end,
  a.changed_by, a.created_at
from public.activity_log a
join public.invoices i
  on i.invoice_number = (regexp_match(a.description, 'invoice (\S+)', 'i'))[1]
 and coalesce(i.project_id, (select cc.project_id from public.cost_centres cc where cc.id = i.cost_centre_id)) = a.entity_id
where a.entity_type = 'project'
  and a.action in ('invoice_emailed', 'invoice_edited', 'credit_note_created')
  and not exists (select 1 from public.invoice_events e where e.invoice_id = i.id and e.kind <> 'created');

-- Paid: at paid_at. Which way (Xero or the pay online link) was not recorded before today.
insert into public.invoice_events (invoice_id, kind, detail, actor_id, created_at)
select i.id, 'paid', 'Payment recorded', null, i.paid_at
from public.invoices i
where i.paid_at is not null
  and not exists (select 1 from public.invoice_events e where e.invoice_id = i.id and e.kind = 'paid');
