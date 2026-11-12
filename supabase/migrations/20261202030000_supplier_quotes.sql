-- Item 81: ask suppliers for prices from a quote (a request for quote, RFQ), the quotes they send
-- back on a Supplier quotes tab, Approve issues the PO.
--
-- supplier_quote_requests: one row per supplier asked on a quote or job. The request number is not
--   stored: it is RFQ plus the project's Q number (or J number), the same for every supplier asked.
--   lines is the list sent, as a snapshot: [{ material_id, description, quantity, unit }].
--   request_token opens the request on po.html (?rfq=) for the PDF the email carries.
-- supplier_quotes: one row per quote a supplier sends back (one per file). The file is a
--   project_documents row in the Supplier quotes folder (document_id, with its path kept here too).
--   Tally reads it (reading, supplier_quote_number, quoted_on, total ex GST) onto supplier_quote_lines.
--   status: reading (Tally is on it) > quoted > approved (po_id) or denied.
-- supplier_quote_approve: the one step that makes the PO. The same supplier's PO made by an approval
--   today on the same job takes the lines (several quotes from one supplier approved the same day go
--   on one PO); otherwise a new PO (lines known, the quoted prices, the quote attached, "From RFQ1017").
--
-- Pricing roles only (the quotes side of the business), fast RLS, an index on every FK.

-- ---------- tables ----------

create table if not exists public.supplier_quote_requests (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  supplier_name text not null default '',
  status text not null default 'draft',
  lines jsonb not null default '[]'::jsonb,
  note text,
  request_token uuid not null default gen_random_uuid(),
  pdf_path text,
  email_thread_id uuid references public.email_threads(id) on delete set null,
  sent_to text,
  sent_at timestamptz,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint supplier_quote_requests_status_check check (status in ('draft', 'sent'))
);
create index if not exists supplier_quote_requests_project_idx on public.supplier_quote_requests (project_id);
create index if not exists supplier_quote_requests_supplier_idx on public.supplier_quote_requests (supplier_id);
create index if not exists supplier_quote_requests_thread_idx on public.supplier_quote_requests (email_thread_id);
create index if not exists supplier_quote_requests_created_by_idx on public.supplier_quote_requests (created_by);
create unique index if not exists supplier_quote_requests_token_idx on public.supplier_quote_requests (request_token);

create table if not exists public.supplier_quotes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  request_id uuid references public.supplier_quote_requests(id) on delete set null,
  document_id uuid references public.project_documents(id) on delete set null,
  file_path text,
  file_name text,
  mime_type text,
  email_id uuid references public.emails(id) on delete set null,
  attachment_part_id text,
  supplier_quote_number text,
  quoted_on date,
  total numeric(12,2),
  status text not null default 'reading',
  read_error text,
  reading jsonb,
  approved_at timestamptz,
  approved_by uuid references public.profiles(id) on delete set null,
  denied_at timestamptz,
  denied_by uuid references public.profiles(id) on delete set null,
  po_id uuid references public.purchase_orders(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint supplier_quotes_status_check check (status in ('reading', 'quoted', 'approved', 'denied'))
);
create index if not exists supplier_quotes_project_idx on public.supplier_quotes (project_id);
create index if not exists supplier_quotes_supplier_idx on public.supplier_quotes (supplier_id);
create index if not exists supplier_quotes_request_idx on public.supplier_quotes (request_id);
create index if not exists supplier_quotes_document_idx on public.supplier_quotes (document_id);
create index if not exists supplier_quotes_email_idx on public.supplier_quotes (email_id);
create index if not exists supplier_quotes_po_idx on public.supplier_quotes (po_id);
create index if not exists supplier_quotes_approved_by_idx on public.supplier_quotes (approved_by);
create index if not exists supplier_quotes_denied_by_idx on public.supplier_quotes (denied_by);
create index if not exists supplier_quotes_created_by_idx on public.supplier_quotes (created_by);
-- one row per file of an email: the intake sweep never files the same attachment twice
create unique index if not exists supplier_quotes_email_part_idx on public.supplier_quotes (email_id, attachment_part_id) where email_id is not null;

create table if not exists public.supplier_quote_lines (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.supplier_quotes(id) on delete cascade,
  material_id uuid references public.materials(id) on delete set null,
  description text not null default '',
  part_number text,
  quantity numeric not null default 0,
  unit text,
  unit_cost numeric,
  sort_order integer not null default 0
);
create index if not exists supplier_quote_lines_quote_idx on public.supplier_quote_lines (quote_id);
create index if not exists supplier_quote_lines_material_idx on public.supplier_quote_lines (material_id);

-- ---------- RLS: pricing roles only ----------

alter table public.supplier_quote_requests enable row level security;
alter table public.supplier_quotes enable row level security;
alter table public.supplier_quote_lines enable row level security;

drop policy if exists "Pricing roles read supplier quote requests" on public.supplier_quote_requests;
create policy "Pricing roles read supplier quote requests" on public.supplier_quote_requests
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add supplier quote requests" on public.supplier_quote_requests;
create policy "Pricing roles add supplier quote requests" on public.supplier_quote_requests
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change supplier quote requests" on public.supplier_quote_requests;
create policy "Pricing roles change supplier quote requests" on public.supplier_quote_requests
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove supplier quote requests" on public.supplier_quote_requests;
create policy "Pricing roles remove supplier quote requests" on public.supplier_quote_requests
  for delete to authenticated using ((select is_pricing_role()));

drop policy if exists "Pricing roles read supplier quotes" on public.supplier_quotes;
create policy "Pricing roles read supplier quotes" on public.supplier_quotes
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add supplier quotes" on public.supplier_quotes;
create policy "Pricing roles add supplier quotes" on public.supplier_quotes
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change supplier quotes" on public.supplier_quotes;
create policy "Pricing roles change supplier quotes" on public.supplier_quotes
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove supplier quotes" on public.supplier_quotes;
create policy "Pricing roles remove supplier quotes" on public.supplier_quotes
  for delete to authenticated using ((select is_pricing_role()));

drop policy if exists "Pricing roles read supplier quote lines" on public.supplier_quote_lines;
create policy "Pricing roles read supplier quote lines" on public.supplier_quote_lines
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add supplier quote lines" on public.supplier_quote_lines;
create policy "Pricing roles add supplier quote lines" on public.supplier_quote_lines
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change supplier quote lines" on public.supplier_quote_lines;
create policy "Pricing roles change supplier quote lines" on public.supplier_quote_lines
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove supplier quote lines" on public.supplier_quote_lines;
create policy "Pricing roles remove supplier quote lines" on public.supplier_quote_lines
  for delete to authenticated using ((select is_pricing_role()));

-- An approved quote stays approved (its PO exists); the browser's Deny is a plain update on a quoted one.
create or replace function public.supplier_quotes_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'approved' and (new.status is distinct from 'approved' or new.po_id is distinct from old.po_id) then
    raise exception 'This quote is already approved: its PO % stands.', (select po_number from purchase_orders where id = old.po_id);
  end if;
  if new.status = 'approved' and old.status is distinct from 'approved' and coalesce(current_setting('teops.po_step', true), '') <> 'on' then
    raise exception 'Approve a supplier quote with the Approve button (supplier_quote_approve).';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_supplier_quotes_guard on public.supplier_quotes;
create trigger trg_supplier_quotes_guard before update on public.supplier_quotes
  for each row execute function public.supplier_quotes_guard();
revoke all on function public.supplier_quotes_guard() from public, anon, authenticated;

-- ---------- the request number ----------

-- RFQ plus the quote number: RFQ1017 for Q1017, also on the job it became (J7068 from Q1017 is still
-- RFQ1017); a job with no quote uses its J number.
create or replace function public.supplier_quote_rfq_number(p_project_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select 'RFQ' || coalesce(p.quote_number::text, sq.quote_number::text, p.job_number::text, '')
  from projects p
  left join projects sq on sq.id = p.source_quote_id
  where p.id = p_project_id;
$$;
revoke execute on function public.supplier_quote_rfq_number(uuid) from public, anon;
grant execute on function public.supplier_quote_rfq_number(uuid) to authenticated;

-- ---------- the request on po.html, by token (the PDF the email carries) ----------

-- The same shape as get_po_by_token, with request true: po.html prints it as a request for quote
-- (no prices, no PO number, "a request for pricing, not an order").
create or replace function public.get_supplier_quote_request_by_token(p_token uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'request', true,
    'po', jsonb_build_object('po_number', supplier_quote_rfq_number(r.project_id), 'order_date', coalesce(r.sent_at, r.created_at)::date,
      'description', 'Items to price', 'supplier_name', coalesce(s.name, r.supplier_name), 'closed', false,
      'supplier_notes', r.note, 'show_prices', false),
    'deliver', jsonb_build_object('job_number', p.job_number, 'quote_number', coalesce(p.quote_number, sq.quote_number), 'job_name', p.name, 'address', p.client_address),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l->>'description', 'quantity', (l->>'quantity')::numeric, 'unit', l->>'unit') order by ord)
                       from jsonb_array_elements(r.lines) with ordinality as t(l, ord)), '[]'::jsonb),
    'company', (select jsonb_build_object('company_name', company_name, 'abn', abn, 'address', address, 'phone', phone,
                       'website', website, 'licenses', licenses, 'logo_url', logo_url) from company_settings where id = 1))
  from supplier_quote_requests r
  left join suppliers s on s.id = r.supplier_id
  left join projects p on p.id = r.project_id
  left join projects sq on sq.id = p.source_quote_id
  where r.request_token = p_token;
$$;
revoke execute on function public.get_supplier_quote_request_by_token(uuid) from public;
grant execute on function public.get_supplier_quote_request_by_token(uuid) to anon, authenticated;

-- ---------- Approve: the PO in one step ----------

create or replace function public.supplier_quote_approve(p_quote_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  q supplier_quotes;
  v_po purchase_orders;
  v_rfq text;
  v_their text;
  v_lines integer;
  v_added boolean := false;
  v_supplier_name text;
begin
  if auth.uid() is null or not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can approve a supplier quote.'; end if;
  select * into q from supplier_quotes where id = p_quote_id for update;
  if not found then raise exception 'Supplier quote not found.'; end if;
  if q.status = 'approved' then raise exception 'This quote is already approved.'; end if;
  if q.status = 'denied' then raise exception 'This quote was denied. Deny cannot be undone; ask the supplier for a fresh quote.'; end if;
  if q.status <> 'quoted' then raise exception 'Wait for the quote to be read first.'; end if;

  v_rfq := supplier_quote_rfq_number(q.project_id);
  select name into v_supplier_name from suppliers where id = q.supplier_id;
  v_their := coalesce(nullif(trim(q.supplier_quote_number), ''), 'quote');
  select count(*) into v_lines from supplier_quote_lines where quote_id = q.id and quantity > 0;

  perform set_config('teops.po_step', 'on', true);

  -- the same supplier's PO made by an approval today on this job takes the lines
  select po.* into v_po
  from supplier_quotes q2
  join purchase_orders po on po.id = q2.po_id
  where q2.project_id = q.project_id and q2.supplier_id = q.supplier_id and q2.status = 'approved' and q2.id <> q.id
    and (q2.approved_at at time zone 'Australia/Sydney')::date = sydney_today()
    and po.closed_at is null and po.stock_source is null
  order by q2.approved_at desc limit 1;

  if found then
    v_added := true;
    update purchase_orders
      set description = left(coalesce(nullif(description, ''), 'From ' || v_rfq) || ', their quote ' || v_their
                             || case when q.quoted_on is not null then ' dated ' || to_char(q.quoted_on, 'DD Mon YYYY') else '' end, 500),
          po_type = case when v_lines = 0 and (select count(*) from purchase_order_line_items where po_id = v_po.id) = 0 then 'open' else po_type end
      where id = v_po.id;
  else
    insert into purchase_orders (project_id, cost_centre_id, supplier_id, supplier_name, description, po_type, locked, status, amount,
        file_path, file_name)
    values (q.project_id, null, q.supplier_id, coalesce(v_supplier_name, ''),
        left('From ' || v_rfq || ', their quote ' || v_their || case when q.quoted_on is not null then ' dated ' || to_char(q.quoted_on, 'DD Mon YYYY') else '' end, 500),
        case when v_lines = 0 then 'open' else 'fixed' end, false, 'ordered', 0,
        q.file_path, q.file_name)
    returning * into v_po;
    insert into job_tasks (project_id, description, created_by)
    values (q.project_id, format('Follow up PO %s with %s', v_po.po_number, coalesce(v_supplier_name, 'the supplier')), auth.uid());
  end if;

  insert into purchase_order_line_items (po_id, material_id, description, quantity, unit_cost, added_by)
  select v_po.id, l.material_id, left(coalesce(nullif(l.description, ''), 'Item'), 500), l.quantity, coalesce(l.unit_cost, 0), auth.uid()
  from supplier_quote_lines l where l.quote_id = q.id and l.quantity > 0
  order by l.sort_order, l.id;

  update supplier_quotes set status = 'approved', approved_at = now(), approved_by = auth.uid(), po_id = v_po.id where id = q.id;

  perform _po_log('purchase_order', v_po.id, case when v_added then 'po_item_added' else 'created' end,
    format('%s: %s quote %s approved (%s %s lines)%s', v_rfq, coalesce(v_supplier_name, 'Supplier'), v_their, v_lines,
           case when v_added then 'more' else '' end, case when v_added then ' added to PO ' || v_po.po_number else ', PO ' || v_po.po_number || ' created' end));
  perform _po_log('project', q.project_id, 'po_created',
    format('%s: %s quote %s approved, %s', v_rfq, coalesce(v_supplier_name, 'Supplier'), v_their,
           case when v_added then 'added to PO ' || v_po.po_number else 'PO ' || v_po.po_number || ' created' end));

  return jsonb_build_object('po_id', v_po.id, 'po_number', v_po.po_number, 'added_to_existing', v_added,
    'supplier_id', q.supplier_id, 'project_id', q.project_id, 'supplier_name', v_supplier_name, 'lines', v_lines);
end;
$$;
revoke execute on function public.supplier_quote_approve(uuid) from public, anon;
grant execute on function public.supplier_quote_approve(uuid) to authenticated;
