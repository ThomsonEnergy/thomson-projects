-- invoice@ supplier bill intake (backlog item 8).
--
-- Suppliers email bills to invoice@thomsonenergy.com.au, a Google Group that
-- delivers to sales@; a Gmail filter keeps them out of the sales@ inbox under
-- the "Supplier Bills" label. process-supplier-bills-background.js puts one
-- row here per PDF or photo, reads it, matches the supplier and the PO, and
-- either leaves it to be checked or (when auto-save is on) saves the bill.
-- Rows are only ever inserted by the server (service role).

create table if not exists public.supplier_bill_inbox (
  id uuid primary key default gen_random_uuid(),
  email_id uuid references public.emails(id) on delete set null,
  gmail_message_id text not null,
  attachment_part_id text not null,
  file_name text,
  mime_type text,
  file_path text,
  email_from text,
  email_subject text,
  received_at timestamptz,
  status text not null default 'pending',
  extracted jsonb,
  supplier_id uuid references public.suppliers(id) on delete set null,
  po_id uuid references public.purchase_orders(id) on delete set null,
  match_confidence text,
  match_reason text,
  po_candidates jsonb not null default '[]'::jsonb,
  bill_id uuid references public.supplier_bills(id) on delete set null,
  duplicate_of_bill_id uuid references public.supplier_bills(id) on delete set null,
  error text,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete set null,
  resolved_at timestamptz,
  constraint supplier_bill_inbox_status_check check (status in ('pending', 'processing', 'to_check', 'saved', 'duplicate', 'not_a_bill', 'failed')),
  constraint supplier_bill_inbox_confidence_check check (match_confidence is null or match_confidence in ('confident', 'guess', 'none')),
  constraint supplier_bill_inbox_attachment_key unique (gmail_message_id, attachment_part_id)
);

create index if not exists supplier_bill_inbox_email_id_idx on public.supplier_bill_inbox (email_id);
create index if not exists supplier_bill_inbox_supplier_id_idx on public.supplier_bill_inbox (supplier_id);
create index if not exists supplier_bill_inbox_po_id_idx on public.supplier_bill_inbox (po_id);
create index if not exists supplier_bill_inbox_bill_id_idx on public.supplier_bill_inbox (bill_id);
create index if not exists supplier_bill_inbox_duplicate_of_bill_id_idx on public.supplier_bill_inbox (duplicate_of_bill_id);
create index if not exists supplier_bill_inbox_resolved_by_idx on public.supplier_bill_inbox (resolved_by);
create index if not exists supplier_bill_inbox_status_idx on public.supplier_bill_inbox (status, created_at desc);

alter table public.supplier_bill_inbox enable row level security;

-- Same people who can see and save supplier bills (admin, finance, sales).
-- No insert or delete policy: only the server adds rows.
drop policy if exists "Pricing roles read supplier bill inbox" on public.supplier_bill_inbox;
create policy "Pricing roles read supplier bill inbox" on public.supplier_bill_inbox for select to authenticated
  using ((select is_pricing_role()));
drop policy if exists "Pricing roles update supplier bill inbox" on public.supplier_bill_inbox;
create policy "Pricing roles update supplier bill inbox" on public.supplier_bill_inbox for update to authenticated
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));

grant select, update on public.supplier_bill_inbox to authenticated;
grant select, insert, update, delete on public.supplier_bill_inbox to service_role;

-- invoice@ conversations are hidden from the Sales inbox and send no
-- "New email" notification.
alter table public.email_threads
  add column if not exists is_supplier_bill boolean not null default false;

CREATE OR REPLACE FUNCTION public.trg_notify_email()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record;
begin
  if new.direction <> 'inbound' then return new; end if;
  if new.sent_at is not null and new.sent_at < now() - interval '1 day' then return new; end if;
  if exists (select 1 from email_threads where id = new.thread_id and is_supplier_bill) then return new; end if;
  for r in select id from profiles where active and role in ('admin', 'sales') loop
    perform create_notification(r.id, 'email', 'New email: ' || coalesce(nullif(new.subject, ''), '(no subject)'), 'From ' || coalesce(new.from_address, 'unknown'), '/inbox.html', null, 'email:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $function$
;
