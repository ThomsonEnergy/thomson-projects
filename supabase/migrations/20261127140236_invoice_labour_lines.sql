-- Item 41: labour by the hour per person on no-quote (Direct Job) invoices.
-- invoice_line_items gets a 'labour' kind: hours as quantity, $/hr as unit_price, who it was
-- (staff_id) and which rate tier it was billed at (rate_tier_id), and the clocked shifts it
-- covers (time_entry_ids) so the next invoice on the job offers only shifts not yet billed.
-- The "Less" line under the hours is a labour line with a negative unit_price and quantity 1.
-- No RLS change: the existing pricing-role policy covers the new columns.

alter table public.invoice_line_items
  add column if not exists staff_id uuid references public.profiles(id) on delete set null,
  add column if not exists rate_tier_id uuid references public.billable_rate_tiers(id) on delete set null,
  add column if not exists time_entry_ids uuid[];

create index if not exists invoice_line_items_staff_idx on public.invoice_line_items (staff_id);
create index if not exists invoice_line_items_rate_tier_idx on public.invoice_line_items (rate_tier_id);
create index if not exists invoice_line_items_time_entries_idx on public.invoice_line_items using gin (time_entry_ids);

alter table public.invoice_line_items drop constraint if exists invoice_line_items_kind_check;
alter table public.invoice_line_items
  add constraint invoice_line_items_kind_check check (kind in ('material', 'prebuild', 'labour'));
