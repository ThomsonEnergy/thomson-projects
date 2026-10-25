-- AI suggested prebuilds on cost centres (docs/IDEAS_BACKLOG.md item 25): a line the AI added
-- stays flagged until a person confirms it; the ready-to-send gate lists unconfirmed lines.
alter table public.cost_centre_line_items add column if not exists ai_suggested boolean default false not null;
comment on column public.cost_centre_line_items.ai_suggested is 'Added by Suggest prebuilds with AI and not yet confirmed by a person.';
