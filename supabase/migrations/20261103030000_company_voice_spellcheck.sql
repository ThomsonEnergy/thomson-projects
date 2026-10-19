-- Company voice, spell check and Polish (docs/IDEAS_BACKLOG.md item 20, docs/PROJECT_SPEC.md A18 and A33).
--
-- company_settings.writing_style_mailbox_id: the mailbox whose learned writing style is the
-- company voice (jasper@ to start). Every mailbox drafts in it unless its writing_style_source
-- is 'own' and it has a learned style of its own. Polish uses the same voice.
-- profiles.spellcheck_mode: auto (fix spelling on a pause or on leaving a text box), button
-- (only when Fix spelling is pressed) or off. Each person sets their own (own profile policy).

alter table public.mailboxes
  add column if not exists writing_style_source text not null default 'company'
    check (writing_style_source in ('company', 'own'));

alter table public.company_settings
  add column if not exists writing_style_mailbox_id uuid references public.mailboxes(id) on delete set null;

create index if not exists company_settings_writing_style_mailbox_idx on public.company_settings (writing_style_mailbox_id);

alter table public.profiles
  add column if not exists spellcheck_mode text not null default 'auto'
    check (spellcheck_mode in ('auto', 'button', 'off'));

update public.company_settings
set writing_style_mailbox_id = (select id from public.mailboxes where address = 'jasper@thomsonenergy.com.au')
where id = 1 and writing_style_mailbox_id is null;
