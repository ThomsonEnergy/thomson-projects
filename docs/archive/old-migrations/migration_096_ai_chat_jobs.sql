-- Migration 096: async job table for the "Ask AI" chatbox. A question
-- that needs the model to search the knowledge base, then dig into a
-- specific large document, then maybe check live data too, is several
-- Claude API calls chained together - routinely longer than a normal
-- Netlify function's ~10s synchronous budget, which was coming back as a
-- raw 504 HTML page in the chat widget. Now the browser starts a job,
-- polls this table for its result, and the actual work runs in a
-- background function (up to 15 minutes) instead.
--
-- Already applied directly via Supabase MCP - this file is kept for the
-- record, not meant to be re-run.

create table if not exists ai_chat_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references profiles(id),
  messages jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  answer text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists ai_chat_jobs_user_id_idx on ai_chat_jobs (user_id, created_at desc);

alter table ai_chat_jobs enable row level security;
drop policy if exists "staff can manage their own chat jobs" on ai_chat_jobs;
create policy "staff can manage their own chat jobs"
  on ai_chat_jobs for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
