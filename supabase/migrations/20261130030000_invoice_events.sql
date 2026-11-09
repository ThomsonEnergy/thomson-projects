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
  actor_label text, -- what did it when nobody did: the quote approval, Xero, the pay online link
  created_at timestamptz not null default now()
);
alter table public.invoice_events add column if not exists actor_label text;
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
insert into public.invoice_events (invoice_id, kind, detail, actor_id, actor_label, created_at)
select i.id, 'created',
  case when i.is_deposit then 'Deposit invoice made when the quote was approved' else 'Invoice created' end,
  i.created_by, case when i.is_deposit and i.created_by is null then 'the quote approval' end, i.created_at
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

-- A deposit the client approved online was shown to them straight after accepting (quote.html sends
-- them to the invoice page), so it counts as sent. A deposit raised by a staff approval does not.
insert into public.invoice_events (invoice_id, kind, detail, actor_id, actor_label, created_at)
select i.id, 'sent_elsewhere', 'Shown to the client on the quote approval page', null, 'the quote approval', i.created_at
from public.invoices i
join public.projects j on j.id = i.project_id
left join public.projects q on q.id = j.source_quote_id
where i.is_deposit and q.approved_by is null
  and not exists (select 1 from public.invoice_events e where e.invoice_id = i.id and e.kind in ('emailed', 'sent_elsewhere'));

-- In Xero already: the push happened before today's history, so its date is not known (listed at the
-- invoice's own date and says so).
insert into public.invoice_events (invoice_id, kind, detail, actor_id, created_at)
select i.id, 'pushed_to_xero', 'In Xero (pushed before today''s history, date not recorded)', null, i.created_at
from public.invoices i
where i.xero_invoice_id is not null
  and not exists (select 1 from public.invoice_events e where e.invoice_id = i.id and e.kind = 'pushed_to_xero');

-- Paid: at paid_at. Which way (Xero or the pay online link) was not recorded before today.
insert into public.invoice_events (invoice_id, kind, detail, actor_id, actor_label, created_at)
select i.id, 'paid', 'Payment recorded', null, 'the payment', i.paid_at
from public.invoices i
where i.paid_at is not null
  and not exists (select 1 from public.invoice_events e where e.invoice_id = i.id and e.kind = 'paid');

-- Rows backfilled before actor_label existed (staging and production ran the first version by hand).
update public.invoice_events set actor_label = 'the quote approval'
  where actor_label is null and actor_id is null and ((kind = 'created' and detail like 'Deposit invoice%') or kind = 'sent_elsewhere');
update public.invoice_events set actor_label = 'the payment' where actor_label is null and actor_id is null and kind = 'paid' and detail = 'Payment recorded';

-- balance_due as a column on invoices (a PostgREST computed field): the one balance rule (inc GST, less
-- STC credits and credit notes, get_invoice_balance_due) for the Invoices page, the job tab and the panel,
-- selected like any column instead of one RPC per invoice.
create or replace function public.balance_due(i public.invoices)
returns numeric language sql stable security invoker set search_path = public as $$
  select public.get_invoice_balance_due(i.id);
$$;
revoke execute on function public.balance_due(public.invoices) from public, anon;
grant execute on function public.balance_due(public.invoices) to authenticated;

-- One writer per fact: every history line is copied to the job's Activity tab by this trigger, so
-- neither the browser nor the functions write activity_log for an invoice any more. Runs as the table
-- owner so the copy always lands; nobody calls it directly.
create or replace function public.invoice_events_to_activity_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_inv invoices%rowtype;
  v_project uuid;
  v_label text;
begin
  select * into v_inv from invoices where id = new.invoice_id;
  if not found then return new; end if;
  v_project := coalesce(v_inv.project_id, (select cc.project_id from cost_centres cc where cc.id = v_inv.cost_centre_id));
  if v_project is null then return new; end if;
  v_label := case new.kind
    when 'created' then 'created' when 'edited' then 'edited' when 'emailed' then 'emailed to the client'
    when 'reminder' then 'reminder sent' when 'sent_elsewhere' then 'sent another way' when 'pushed_to_xero' then 'pushed to Xero'
    when 'paid' then 'paid' when 'credit_note' then 'credit note issued' when 'credit_note_pushed' then 'credit note pushed to Xero'
    when 'notes' then 'notes changed' else new.kind end;
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values ('project', v_project, 'invoice_' || new.kind,
    'Invoice ' || v_inv.invoice_number || ' ' || v_label || coalesce(': ' || new.detail, '')
      || case when new.actor_id is null and new.actor_label is not null then ' (by ' || new.actor_label || ')' else '' end,
    new.actor_id);
  return new;
end;
$$;
revoke execute on function public.invoice_events_to_activity_log() from public, anon, authenticated;
drop trigger if exists trg_invoice_events_activity on public.invoice_events;
create trigger trg_invoice_events_activity after insert on public.invoice_events
  for each row execute function public.invoice_events_to_activity_log();
