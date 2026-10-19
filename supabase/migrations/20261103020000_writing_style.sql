-- Email drafts in the mailbox owner's own tone (docs/IDEAS_BACKLOG.md item 19, docs/PROJECT_SPEC.md A18).
--
-- Postie learns a short writing style guide from the replies already sent from a
-- mailbox (the outbound emails TEops holds), keeps a few real replies as examples,
-- and puts both into the drafting prompt. The guide is editable in Settings > Email
-- Agent. "Learn" sets writing_style_requested_at and the mailbox worker does the
-- reading; it is refreshed by itself every 30 days once learned.

alter table public.mailboxes
  add column if not exists writing_style text,
  add column if not exists writing_style_examples jsonb not null default '[]'::jsonb,
  add column if not exists writing_style_learned_at timestamptz,
  add column if not exists writing_style_edited_at timestamptz,
  add column if not exists writing_style_requested_at timestamptz,
  add column if not exists writing_style_error text;
