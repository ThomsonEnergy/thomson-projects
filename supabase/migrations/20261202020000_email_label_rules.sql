-- Item 81 (12 Nov 2026): rules Postie learns from a person's label corrections, one per sender
-- and mailbox. label_id set: mail from that sender goes under that label, no AI. label_id null:
-- Postie never labels that sender (a person still can, which replaces the rule). Written by
-- email-actions.js (move_label, add_label, remove_label, delete_label, merge_label), read by
-- _shared/email-agent.js before the AI, listed in Settings > Email Agent. Same row rules as
-- email_sender_rules (the people who work in that mailbox).
create table if not exists public.email_label_rules (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.mailboxes(id) on delete cascade,
  sender text not null,
  label_id uuid references public.email_labels(id) on delete cascade,
  taught_by_thread_id uuid references public.email_threads(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index if not exists email_label_rules_mailbox_sender_idx on public.email_label_rules (mailbox_id, lower(sender));
create index if not exists email_label_rules_label_id_idx on public.email_label_rules (label_id);
create index if not exists email_label_rules_taught_by_thread_id_idx on public.email_label_rules (taught_by_thread_id);
create index if not exists email_label_rules_created_by_idx on public.email_label_rules (created_by);

alter table public.email_label_rules enable row level security;

drop policy if exists "email_label_rules select" on public.email_label_rules;
create policy "email_label_rules select" on public.email_label_rules for select to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_label_rules insert" on public.email_label_rules;
create policy "email_label_rules insert" on public.email_label_rules for insert to authenticated
  with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_label_rules update" on public.email_label_rules;
create policy "email_label_rules update" on public.email_label_rules for update to authenticated
  using (mailbox_id in (select public.my_mailbox_ids())) with check (mailbox_id in (select public.my_mailbox_ids()));
drop policy if exists "email_label_rules delete" on public.email_label_rules;
create policy "email_label_rules delete" on public.email_label_rules for delete to authenticated
  using (mailbox_id in (select public.my_mailbox_ids()));
