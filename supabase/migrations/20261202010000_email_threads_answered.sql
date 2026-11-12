-- Item 80 (12 Nov 2026): a conversation in Priority counts as answered when we email that person
-- in any way (a booking, a quote, a reply in another thread), not only a reply in its own thread.
-- send-recorded-email.js sets these on the open Priority conversations from the recipient; the
-- Gmail sync clears them when the person writes back. Additions only, no policy change.
alter table public.email_threads
  add column if not exists answered_at timestamptz,
  add column if not exists answered_by uuid references public.profiles(id) on delete set null,
  add column if not exists answered_email_id uuid references public.emails(id) on delete set null;
create index if not exists email_threads_answered_by_idx on public.email_threads (answered_by);
create index if not exists email_threads_answered_email_id_idx on public.email_threads (answered_email_id);
