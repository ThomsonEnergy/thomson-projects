-- Holding area for "Read with OCR" on a Knowledge Base PDF. Some PDFs (found
-- for real with the AS/NZS 3008 cable-selection standard: 148 pages, but the
-- stored text stops at page 6) have pages whose text can't be extracted -
-- fonts with no text mapping - so the normal text-layer read only gets the
-- readable pages and the tables the AI chat needs are simply missing. The OCR
-- re-read renders pages in the browser and has Claude transcribe them in
-- batches that run in parallel; each batch lands here, and the browser stitches
-- them in page order onto knowledge_entries.content when all are in.

create table if not exists knowledge_ocr_parts (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references knowledge_entries(id) on delete cascade,
  start_page int not null,
  end_page int not null,
  text text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_ocr_parts_entry_idx on knowledge_ocr_parts (entry_id, start_page);

alter table knowledge_ocr_parts enable row level security;
drop policy if exists "staff full access on knowledge_ocr_parts" on knowledge_ocr_parts;
create policy "staff full access on knowledge_ocr_parts"
  on knowledge_ocr_parts for all to authenticated using (true) with check (true);
