-- Auto replies that point senders to the right mailbox (Postie on sales@, Tally on invoice@):
--   sales_invoice:     a supplier emailed an invoice to sales@. "Please send invoices to
--                      invoice@ with our PO number"; the invoice is passed to invoice@ intake.
--   invoice_not_bill:  an email to invoice@ with no invoice, statement, credit note or price
--                      list. "This mailbox is for invoices only, please use sales@".
-- company_settings.routing_reply_mode: off, draft (Gmail draft in sales@ for a person to send)
-- or send. One reply per conversation, and one per sender every 14 days.
-- Written only by the server (service role); pricing roles can read the log.

alter table public.company_settings
  add column if not exists routing_reply_mode text not null default 'draft'
  check (routing_reply_mode in ('off', 'draft', 'send'));

create table if not exists public.routing_replies (
  id uuid primary key default gen_random_uuid(),
  gmail_thread_id text not null unique,
  source_message_id text,
  kind text not null check (kind in ('sales_invoice', 'invoice_not_bill')),
  sender text not null,
  subject text,
  mode text not null check (mode in ('draft', 'send')),
  gmail_draft_id text,
  gmail_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists routing_replies_sender_idx on public.routing_replies (sender, created_at desc);

alter table public.routing_replies enable row level security;

drop policy if exists "Pricing roles read routing replies" on public.routing_replies;
create policy "Pricing roles read routing replies" on public.routing_replies
  for select to authenticated using ((select public.is_pricing_role()));
