-- Migration 042 — Universal activity log
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- One shared table rather than a separate log per entity type - every
-- job, quote, PO, supplier, and anything else editable logs into this
-- same table, tagged by entity_type + entity_id. A "Log" tab on any
-- detail page just filters this table down to that one record.

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  description text not null,
  changed_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists activity_log_entity_idx on activity_log (entity_type, entity_id, created_at desc);

alter table activity_log enable row level security;
drop policy if exists "Everyone can view activity log" on activity_log;
create policy "Everyone can view activity log" on activity_log for select using (true);
drop policy if exists "Everyone can write activity log" on activity_log;
create policy "Everyone can write activity log" on activity_log
  for insert with check (auth.uid() is not null);
