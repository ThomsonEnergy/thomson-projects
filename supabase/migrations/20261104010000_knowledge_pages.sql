-- Knowledge Base background reader (netlify/functions/read-knowledge-background.js, docs/PROJECT_SPEC.md A26).
--
--   knowledge_pages: one row per page of every entry. Sparky searches these with Postgres full text search
--     and gets page numbers back, instead of scanning the one big knowledge_entries.content column.
--     read_as says how the page was read:
--       text   the PDF's own text layer, or pasted / website text (split into parts of about 5,000 characters)
--       ocr    Claude read the page as a picture, word for word
--       notes  the word for word read was blocked by the copyright output filter, so Claude wrote the page up
--              as reference notes (clause numbers, requirements, table values), not the exact wording
--       failed the page could not be read, see error
--   knowledge_read_jobs: the queue. Anyone logged in can queue a read of a PDF entry; the server works through
--     it a page at a time (read-knowledge-background.js, restarted by read-knowledge-sweep.js if it stalls) and
--     the Knowledge page shows the progress. Cancel = status 'cancelled' by the person who queued it.
--   knowledge_entries.content stays the stitched text of the pages, so everything that reads it keeps working.
--     A hand edit of content (Edit button, pasted text, website text) rewrites the pages from it (trigger).

create table if not exists public.knowledge_pages (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.knowledge_entries(id) on delete cascade,
  page_no integer not null,
  text text,
  read_as text not null default 'text' check (read_as in ('text', 'ocr', 'notes', 'failed')),
  error text,
  updated_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored,
  unique (entry_id, page_no)
);
create index if not exists knowledge_pages_search_idx on public.knowledge_pages using gin (search);

create table if not exists public.knowledge_read_jobs (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.knowledge_entries(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  mode text not null default 'auto' check (mode in ('auto', 'ocr', 'failed')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  pdf_pages integer,
  total_pages integer,
  pages_done integer not null default 0,
  pages_failed integer not null default 0,
  next_page integer not null default 1,
  error text,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists knowledge_read_jobs_entry_idx on public.knowledge_read_jobs (entry_id, created_at desc);
create index if not exists knowledge_read_jobs_requested_by_idx on public.knowledge_read_jobs (requested_by);
create index if not exists knowledge_read_jobs_status_idx on public.knowledge_read_jobs (status, created_at);

alter table public.knowledge_pages enable row level security;
alter table public.knowledge_read_jobs enable row level security;

-- Pages are written by the server (service role) and the content trigger only.
drop policy if exists "staff read knowledge_pages" on public.knowledge_pages;
create policy "staff read knowledge_pages" on public.knowledge_pages for select to authenticated using (true);

drop policy if exists "staff read knowledge_read_jobs" on public.knowledge_read_jobs;
create policy "staff read knowledge_read_jobs" on public.knowledge_read_jobs for select to authenticated using (true);
drop policy if exists "staff queue knowledge_read_jobs" on public.knowledge_read_jobs;
create policy "staff queue knowledge_read_jobs" on public.knowledge_read_jobs for insert to authenticated
  with check (requested_by = (select auth.uid()) and status = 'queued');
drop policy if exists "staff cancel own knowledge_read_jobs" on public.knowledge_read_jobs;
create policy "staff cancel own knowledge_read_jobs" on public.knowledge_read_jobs for update to authenticated
  using (requested_by = (select auth.uid()))
  with check (requested_by = (select auth.uid()) and status = 'cancelled');

-- Rewrites an entry's pages from its content. Text read page by page carries "--- Page N ---" markers (one per
-- page; the old browser OCR wrote the same, plus "--- Pages A-B ---" blocks for batches that failed). A page whose
-- text starts with the reader's own note lines keeps its read_as (notes, failed) so content and pages round trip.
-- Anything without page markers (pasted text, a website, a spreadsheet) is split into parts of about 5,000
-- characters at a blank line, so search excerpts stay focused. Only called by the trigger below (security
-- definer, so it runs as the owner and the pages table needs no write policy) and by the migration backfill.
create or replace function public.kb_sync_pages_from_content(p_entry_id uuid, p_content text)
returns void
language plpgsql
set search_path = public
as $$
declare
  chunk text;
  body text;
  n integer;
  m text[];
  rest text;
  piece text;
  cut integer;
  kind text;
  err text;
begin
  delete from knowledge_pages where entry_id = p_entry_id;
  if p_content is null or btrim(p_content) = '' then return; end if;

  if p_content ~ '--- Page \d+ ---' then
    for chunk in select s from regexp_split_to_table(p_content, '(?=--- Pages? \d+)') as s loop
      m := regexp_match(chunk, '^--- Page (\d+) ---');
      if m is not null then
        n := m[1]::integer;
        body := btrim(regexp_replace(chunk, '^--- Page \d+ ---[ \t]*\n?', ''), E' \n\r\t');
        kind := 'text';
        err := null;
        m := regexp_match(body, '^\[This page could not be read: ([^\]]*)\]');
        if m is not null then
          kind := 'failed'; err := left(m[1], 500); body := null;
        elsif body like '[Reference notes, not the exact wording]%' then
          kind := 'notes';
          body := btrim(regexp_replace(body, '^\[Reference notes, not the exact wording\][ \t]*\n?', ''), E' \n\r\t');
        elsif body like '[Read as a picture]%' then
          kind := 'ocr';
          body := btrim(regexp_replace(body, '^\[Read as a picture\][ \t]*\n?', ''), E' \n\r\t');
        end if;
        insert into knowledge_pages (entry_id, page_no, text, read_as, error)
          values (p_entry_id, n, body, kind, err)
          on conflict (entry_id, page_no) do update set text = excluded.text, read_as = excluded.read_as, error = excluded.error, updated_at = now();
        continue;
      end if;
      m := regexp_match(chunk, '^--- Pages (\d+)-(\d+) ---\s*\[These pages could not be read: ([^\]]*)\]');
      if m is not null then
        for n in m[1]::integer .. m[2]::integer loop
          insert into knowledge_pages (entry_id, page_no, text, read_as, error)
            values (p_entry_id, n, null, 'failed', left(m[3], 500))
            on conflict (entry_id, page_no) do update set text = null, read_as = 'failed', error = excluded.error, updated_at = now();
        end loop;
      end if;
      -- anything else (text before the first marker) is dropped: it is never more than a heading
    end loop;
    return;
  end if;

  rest := p_content;
  n := 0;
  while length(rest) > 0 loop
    n := n + 1;
    if length(rest) <= 6000 then
      piece := rest;
      rest := '';
    else
      cut := length(substring(left(rest, 5000) from '^(.*\n\s*\n)'));
      if cut is null or cut < 1500 then cut := 5000; end if;
      piece := left(rest, cut);
      rest := substr(rest, cut + 1);
    end if;
    piece := btrim(piece, E' \n\r\t');
    if piece <> '' then
      insert into knowledge_pages (entry_id, page_no, text, read_as) values (p_entry_id, n, piece, 'text');
    end if;
  end loop;
end;
$$;
revoke execute on function public.kb_sync_pages_from_content(uuid, text) from public, anon, authenticated;
grant execute on function public.kb_sync_pages_from_content(uuid, text) to service_role;

-- Keeps the pages in step with a content change made by hand. Security definer so the pages table needs no
-- write policy for staff; it only ever touches the pages of the row being changed, which RLS on
-- knowledge_entries already allowed. The reader skips it (teops.skip_kb_pages) when it stitches content itself.
create or replace function public.trg_kb_sync_pages()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('teops.skip_kb_pages', true) = '1' then return new; end if;
  if tg_op = 'UPDATE' and new.content is not distinct from old.content then return new; end if;
  perform kb_sync_pages_from_content(new.id, new.content);
  return new;
end;
$$;
revoke execute on function public.trg_kb_sync_pages() from public, anon, authenticated;
grant execute on function public.trg_kb_sync_pages() to service_role;

create or replace trigger kb_sync_pages
  after insert or update of content on public.knowledge_entries
  for each row execute function public.trg_kb_sync_pages();

-- Called by the reader once a job's pages are in: stitches the pages back into knowledge_entries.content,
-- writes the "N pages could not be read" note, and closes the job. Server only.
create or replace function public.kb_finish_read(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  j knowledge_read_jobs;
  stitched text;
  failed_list text;
  failed_count integer;
  total integer;
begin
  select * into j from knowledge_read_jobs where id = p_job_id for update;
  if j.id is null then return; end if;

  select count(*) filter (where read_as = 'failed'), count(*),
         string_agg(page_no::text, ', ' order by page_no) filter (where read_as = 'failed')
    into failed_count, total, failed_list
    from knowledge_pages where entry_id = j.entry_id;

  select string_agg(
           '--- Page ' || page_no || ' ---' || E'\n' ||
           case
             when read_as = 'failed' then '[This page could not be read: ' || coalesce(error, 'unknown error') || ']'
             when read_as = 'notes' then '[Reference notes, not the exact wording]' || E'\n' || coalesce(text, '')
             when read_as = 'ocr' then '[Read as a picture]' || E'\n' || coalesce(text, '')
             else coalesce(text, '')
           end,
           E'\n\n' order by page_no)
    into stitched
    from knowledge_pages where entry_id = j.entry_id;

  perform set_config('teops.skip_kb_pages', '1', true);
  update knowledge_entries
     set content = stitched,
         extraction_error = case when failed_count > 0
           then failed_count || ' of ' || total || ' pages could not be read (' || left(failed_list, 300) || '). Read again > Only the failed pages retries them.'
           else null end,
         updated_at = now()
   where id = j.entry_id;
  perform set_config('teops.skip_kb_pages', '0', true);

  update knowledge_read_jobs
     set status = case when status = 'cancelled' then 'cancelled' else 'done' end,
         finished_at = now(), locked_until = null, pages_failed = failed_count
   where id = p_job_id;
end;
$$;
revoke execute on function public.kb_finish_read(uuid) from public, anon, authenticated;
grant execute on function public.kb_finish_read(uuid) to service_role;

-- Sparky's search: full text search over the pages, best pages first, with a short excerpt around the matches.
-- Runs as the caller (RLS on knowledge_pages applies).
create or replace function public.search_knowledge_pages(p_query text, p_entry_id uuid default null, p_limit integer default 8)
returns table (entry_id uuid, title text, category text, entry_type text, file_name text, page_no integer, read_as text, snippet text, rank real)
language sql
stable
set search_path = public
as $$
  select p.entry_id, e.title, e.category, e.entry_type, e.file_name, p.page_no, p.read_as,
         ts_headline('english', coalesce(p.text, ''), websearch_to_tsquery('english', p_query),
                     'MaxFragments=3, MaxWords=70, MinWords=30, StartSel=[, StopSel=]') as snippet,
         ts_rank_cd(p.search, websearch_to_tsquery('english', p_query)) as rank
    from knowledge_pages p
    join knowledge_entries e on e.id = p.entry_id
   where p.read_as <> 'failed'
     and p.search @@ websearch_to_tsquery('english', p_query)
     and (p_entry_id is null or p.entry_id = p_entry_id)
   order by rank desc, p.entry_id, p.page_no
   limit least(greatest(coalesce(p_limit, 8), 1), 20);
$$;
revoke execute on function public.search_knowledge_pages(text, uuid, integer) from public, anon;
grant execute on function public.search_knowledge_pages(text, uuid, integer) to authenticated;

-- Backfill: every entry's existing text becomes pages (AS 3000's old OCR text splits on its page markers, with
-- its failed batches recorded as failed pages so "Read again > Only the failed pages" picks them up).
do $$
declare r record;
begin
  for r in select id, content from public.knowledge_entries where content is not null loop
    perform public.kb_sync_pages_from_content(r.id, r.content);
  end loop;
end;
$$;

-- The old browser OCR's holding table is no longer used.
drop table if exists public.knowledge_ocr_parts;
