-- Price list jobs: disconnect and reconnect at fixed prices (backlog item 109, owner 23 Nov 2026).
-- A roofer (first Ocean Blue Metal Roofing) books a job with no quote; the crew fills a sheet on site
-- (quantities and photos); the job is billed like do and charge but from one company price list of
-- prebuilds, not from time. Inside the app the job has two cost centres (Disconnection,
-- Reconnection); the client's bill shows them as one block.
--
--  * service_price_items: the price list. One row per prebuild in the "Disconnect and reconnect"
--    group: shown or not, a fixed price each (ex GST), an optional minimum quantity charged, and the
--    share of the price that belongs to the disconnect visit.
--  * job_service_lines: what the crew counted on a job, with the price copied at that moment so a
--    later price change never moves a job already done. Written by the server only.
--  * job_sheet_answers: the sheet's photos and yes or no answers. Written by the server only.
--  * projects: service_price_job (the job is billed from the price list), service_booking (the
--    roofer's answers), service_booking_token (their link to the questions), service_state (which
--    sheets are finished, whether the price was sent).
--  * cost_centres.bill_group: cost centres with the same group print as one block on the bill.
--  * company_settings: the booking questions, the price list link's token (the price list page reads
--    through a server function that checks it), and whether the price email goes by itself (off: the
--    office checks it first).
--  * get_invoice_by_token_v3: each claim also carries its bill_group. Otherwise unchanged from
--    20261217000000.
--  * Seeded so it works on day one: the four solar prebuilds with the agreed prices, and the sheet's
--    photo list. Both only when none exist yet.
-- No existing row is changed.

-- ---------------------------------------------------------------- the price list
create table if not exists public.service_price_items (
  prebuild_id uuid primary key references public.prebuilds(id) on delete cascade,
  shown boolean not null default false,
  unit_price numeric not null default 0 check (unit_price >= 0),          -- ex GST, per unit
  unit_label text not null default 'each',
  min_quantity numeric check (min_quantity is null or min_quantity > 0),  -- charged at least this many
  disconnect_share numeric not null default 0 check (disconnect_share between 0 and 100), -- % of the price that is the disconnect visit
  fills_from text check (fills_from in ('panel_count', 'roof_change')),   -- starts at the roofer's booking answer
  sort_order integer not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
create index if not exists service_price_items_updated_by on public.service_price_items (updated_by);

alter table public.service_price_items enable row level security;
revoke all on public.service_price_items from public, anon, authenticated;
grant select, insert, update, delete on public.service_price_items to authenticated;

drop policy if exists "Pricing roles read service prices" on public.service_price_items;
create policy "Pricing roles read service prices" on public.service_price_items
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add service prices" on public.service_price_items;
create policy "Pricing roles add service prices" on public.service_price_items
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change service prices" on public.service_price_items;
create policy "Pricing roles change service prices" on public.service_price_items
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove service prices" on public.service_price_items;
create policy "Pricing roles remove service prices" on public.service_price_items
  for delete to authenticated using ((select is_pricing_role()));

-- ---------------------------------------------------------------- what a job is charged
create table if not exists public.job_service_lines (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  prebuild_id uuid references public.prebuilds(id) on delete set null,
  description text not null,
  unit_label text not null default 'each',
  quantity numeric not null default 0 check (quantity >= 0),
  unit_price numeric not null default 0 check (unit_price >= 0),
  min_quantity numeric,
  disconnect_share numeric not null default 0 check (disconnect_share between 0 and 100),
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, prebuild_id)
);
create index if not exists job_service_lines_prebuild on public.job_service_lines (prebuild_id);
create index if not exists job_service_lines_created_by on public.job_service_lines (created_by);

alter table public.job_service_lines enable row level security;
revoke all on public.job_service_lines from public, anon, authenticated;
grant select on public.job_service_lines to authenticated;

drop policy if exists "Pricing roles read job service lines" on public.job_service_lines;
create policy "Pricing roles read job service lines" on public.job_service_lines
  for select to authenticated using ((select is_pricing_role()));

-- ---------------------------------------------------------------- the sheet's photos and answers
create table if not exists public.job_sheet_answers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  item_id uuid not null references public.inspection_checklist_items(id) on delete cascade,
  answer_yes_no boolean,
  photo_path text,
  answered_by uuid references public.profiles(id) on delete set null,
  answered_at timestamptz not null default now(),
  unique (project_id, item_id)
);
create index if not exists job_sheet_answers_item on public.job_sheet_answers (item_id);
create index if not exists job_sheet_answers_answered_by on public.job_sheet_answers (answered_by);

alter table public.job_sheet_answers enable row level security;
revoke all on public.job_sheet_answers from public, anon, authenticated;
grant select on public.job_sheet_answers to authenticated;

drop policy if exists "Staff read job sheet answers" on public.job_sheet_answers;
create policy "Staff read job sheet answers" on public.job_sheet_answers
  for select to authenticated using (true);

-- ---------------------------------------------------------------- columns on what is already there
alter table public.projects add column if not exists service_price_job boolean not null default false;
alter table public.projects add column if not exists service_booking jsonb;
alter table public.projects add column if not exists service_booking_token uuid;
alter table public.projects add column if not exists service_state jsonb not null default '{}'::jsonb;
create unique index if not exists projects_service_booking_token on public.projects (service_booking_token) where service_booking_token is not null;

alter table public.cost_centres add column if not exists bill_group text;

alter table public.company_settings add column if not exists service_prices_token uuid not null default gen_random_uuid();
alter table public.company_settings add column if not exists service_price_email_auto boolean not null default false;
alter table public.company_settings add column if not exists service_booking_questions jsonb not null default '[
  {"key": "panel_count", "label": "How many solar panels are on the roof?", "type": "number"},
  {"key": "old_roof", "label": "What is the roof now?", "type": "choice", "options": ["Tile", "Corrugated metal", "Trimdek or Klip-Lok", "Other"]},
  {"key": "new_roof", "label": "What is the new roof?", "type": "choice", "options": ["Tile", "Corrugated metal", "Trimdek or Klip-Lok", "Other"]},
  {"key": "homeowner_name", "label": "Homeowner''s name", "type": "text"},
  {"key": "homeowner_phone", "label": "Homeowner''s phone", "type": "text"},
  {"key": "roof_off_date", "label": "Day the panels need to come off", "type": "date"},
  {"key": "roof_on_date", "label": "Day the roof is ready for the panels to go back", "type": "date"},
  {"key": "notes", "label": "Anything else we should know (air conditioning on the roof, access, pets)", "type": "longtext"}
]'::jsonb;

-- A sheet is a third kind of checklist. Done inside a block so the constraint swap is one statement.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'inspection_checklist_templates_checklist_type_check') then
    execute 'alter table public.inspection_checklist_templates drop constraint inspection_checklist_templates_checklist_type_check';
  end if;
  execute 'alter table public.inspection_checklist_templates add constraint inspection_checklist_templates_checklist_type_check check (checklist_type in (''site_inspection'', ''quote_compliance'', ''job_sheet''))';
end $$;

-- ---------------------------------------------------------------- seeds (only when there are none)
do $$
declare
  v_template uuid;
  v_id uuid;
begin
  if not exists (select 1 from inspection_checklist_templates where checklist_type = 'job_sheet') then
    insert into inspection_checklist_templates (name, checklist_type, active) values ('Disconnect and reconnect sheet', 'job_sheet', true) returning id into v_template;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order) values
      (v_template, 'photo', 'Back of a panel: the nameplate', 'Brand, model and watts must be readable', true, 1),
      (v_template, 'photo', 'Inverter nameplate', 'Brand, model and serial number', true, 2),
      (v_template, 'photo', 'Cabling on the roof', 'How the panels are wired and where the cable enters the roof', true, 3),
      (v_template, 'photo', 'Rail profile', 'End on, so the rail type can be matched', true, 4),
      (v_template, 'photo', 'Roof type', 'A wide photo of the roof and the fixings', true, 5),
      (v_template, 'photo', 'Array layout', 'The whole array before any panel comes off', true, 6),
      (v_template, 'photo', 'Isolators', 'Roof top and inverter isolators', true, 7),
      (v_template, 'photo', 'Switchboard', 'Door open, solar breaker in view', true, 8);
  end if;

  if not exists (select 1 from prebuilds where category = 'Disconnect and reconnect') then
    insert into prebuilds (name, client_description, category, subcategory)
      values ('Remove and refit solar panels', 'Remove the panels and rail before the roof work, store on site, refit and test after. Per panel, 10 panel minimum.', 'Disconnect and reconnect', 'Solar') returning id into v_id;
    insert into prebuild_components (prebuild_id, item_type, description, quantity, unit_cost, sort_order) values (v_id, 'labour', 'Remove and refit, per panel', 1, 80, 0);
    insert into service_price_items (prebuild_id, shown, unit_price, unit_label, min_quantity, disconnect_share, fills_from, sort_order) values (v_id, true, 80, 'panel', 10, 20, 'panel_count', 1);

    insert into prebuilds (name, client_description, category, subcategory)
      values ('New rail and clamps', 'Supply and fit new rail and clamps in place of the old. Per panel.', 'Disconnect and reconnect', 'Solar') returning id into v_id;
    insert into prebuild_components (prebuild_id, item_type, description, quantity, unit_cost, sort_order) values (v_id, 'labour', 'New rail and clamps, per panel', 1, 30, 0);
    insert into service_price_items (prebuild_id, shown, unit_price, unit_label, disconnect_share, sort_order) values (v_id, true, 30, 'panel', 0, 2);

    insert into prebuilds (name, client_description, category, subcategory)
      values ('New clamps only', 'Supply and fit new clamps on the existing rail. Per panel.', 'Disconnect and reconnect', 'Solar') returning id into v_id;
    insert into prebuild_components (prebuild_id, item_type, description, quantity, unit_cost, sort_order) values (v_id, 'labour', 'New clamps, per panel', 1, 15, 0);
    insert into service_price_items (prebuild_id, shown, unit_price, unit_label, disconnect_share, sort_order) values (v_id, true, 15, 'panel', 0, 3);

    insert into prebuilds (name, client_description, category, subcategory)
      values ('Roof type change', 'New roof fixings where the new roof is a different type from the old. Per panel.', 'Disconnect and reconnect', 'Solar') returning id into v_id;
    insert into prebuild_components (prebuild_id, item_type, description, quantity, unit_cost, sort_order) values (v_id, 'labour', 'Roof type change, per panel', 1, 15, 0);
    insert into service_price_items (prebuild_id, shown, unit_price, unit_label, disconnect_share, fills_from, sort_order) values (v_id, true, 15, 'panel', 0, 'roof_change', 4);
  end if;
end $$;

-- ---------------------------------------------------------------- the client's invoice page
-- get_invoice_by_token_v3 as in 20261217000000, with one more key on each claim: bill_group.
create or replace function public.get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_company jsonb;
  v_project jsonb;
  v_claims jsonb := '[]'::jsonb;
  v_previous jsonb := '[]'::jsonb;
  v_balance numeric;
  v_is_standalone boolean;
  v_project_id uuid;
  v_client_type text;
begin
  select * into v_invoice from invoices where invoice_token = p_token;
  if not found then
    return null;
  end if;

  select get_invoice_balance_due(v_invoice.id) into v_balance;
  v_client_type := invoice_client_type(v_invoice.id);
  select jsonb_build_object(
    'company_name', cs.company_name, 'abn', cs.abn, 'address', cs.address, 'phone', cs.phone, 'website', cs.website,
    'licenses', cs.licenses, 'logo_url', cs.logo_url, 'bank_name', cs.bank_name, 'bank_account_name', cs.bank_account_name,
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text,
    'invoice_terms_text', cs.invoice_terms_text)
  into v_company from company_settings cs where cs.id = 1;

  v_is_standalone := v_invoice.project_id is null and v_invoice.cost_centre_id is null;
  v_project_id := coalesce(v_invoice.project_id, (select cc.project_id from cost_centres cc where cc.id = v_invoice.cost_centre_id));

  if not v_is_standalone then
    select jsonb_build_object(
      'job_number', p.job_number,
      'quote_number', p.quote_number,
      'name', p.name,
      'client_name', p.client_name,
      'client_address', p.client_address,
      'client_office_address', (select c.address from clients c where c.id = p.client_id)
    ) into v_project
    from projects p where p.id = v_project_id;
  else
    select jsonb_build_object('client_name', c.name, 'client_address', c.address, 'client_office_address', c.address)
    into v_project
    from clients c where c.id = v_invoice.client_id;
  end if;

  -- Billed to another client (a warranty job billed to the manufacturer, or Edit details > Bill to):
  -- the Bill to block shows that client and their office address; the job's site stays as it is.
  if v_invoice.bill_to_client_id is not null then
    select coalesce(v_project, '{}'::jsonb) || jsonb_build_object('client_name', c.name, 'client_office_address', c.address)
    into v_project
    from clients c where c.id = v_invoice.bill_to_client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_name', cc.name,
      'bill_group', cc.bill_group,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'quote_lines', case when v_invoice.show_quote_lines then cost_centre_quote_lines(cc.id) else '[]'::jsonb end,
      'claimed_before', coalesce((
        select sum(x.amt) from (
          select ic2.labour_amount + ic2.material_amount as amt
          from invoice_claims ic2 join invoices i2 on i2.id = ic2.invoice_id
          where ic2.cost_centre_id = cc.id and i2.id <> v_invoice.id and i2.created_at < v_invoice.created_at
          union all
          select i3.labour_amount + i3.material_amount
          from invoices i3
          where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
            and not exists (select 1 from invoice_claims ic3 where ic3.invoice_id = i3.id)
          union all
          select -(cnc.labour_amount + cnc.material_amount)
          from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
          where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
          union all
          select (ic4.value ->> 'amount')::numeric
          from jsonb_array_elements(coalesce(cc.imported_claims, '[]'::jsonb)) ic4
        ) x
      ), 0),
      'invoice_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'description', ili.description, 'quantity', ili.quantity,
          'unit_price', ili.unit_price, 'labour_amount', ili.labour_amount, 'material_amount', ili.material_amount
        ) order by ili.sort_order, ili.created_at)
        from invoice_line_items ili where ili.invoice_claim_id = ic.id
      ), '[]'::jsonb)
    ) order by cc.sort_order)
    into v_claims
    from invoice_claims ic join cost_centres cc on cc.id = ic.cost_centre_id
    where ic.invoice_id = v_invoice.id;
  elsif v_invoice.cost_centre_id is not null then
    select jsonb_build_array(jsonb_build_object(
      'cost_centre_name', cc.name,
      'bill_group', cc.bill_group,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'quote_lines', case when v_invoice.show_quote_lines then cost_centre_quote_lines(cc.id) else '[]'::jsonb end,
      'claimed_before', coalesce((
        select sum(i3.labour_amount + i3.material_amount)
        from invoices i3
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
      ), 0) - coalesce((
        select sum(cnc.labour_amount + cnc.material_amount)
        from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
        where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
      ), 0) + coalesce((
        select sum((ic4.value ->> 'amount')::numeric)
        from jsonb_array_elements(coalesce(cc.imported_claims, '[]'::jsonb)) ic4
      ), 0),
      'invoice_items', '[]'::jsonb
    ))
    into v_claims
    from cost_centres cc where cc.id = v_invoice.cost_centre_id;
  end if;

  if not v_is_standalone then
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', i.invoice_number,
      'sent_at', i.sent_at,
      'amount', i.labour_amount + i.material_amount
    ) order by i.sent_at), '[]'::jsonb)
    into v_previous
    from invoices i
    where i.id <> v_invoice.id
      and i.interest_of_invoice_id is null -- an interest invoice (item 66) is not a claim on the job
      and coalesce(i.project_id, (select cc.project_id from cost_centres cc where cc.id = i.cost_centre_id)) = v_project_id
      and i.created_at < v_invoice.created_at;
    -- Claims invoiced before the job came across from ServiceM8 (cost_centres.imported_claims) come first.
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', ic.value ->> 'number',
      'sent_at', ic.value ->> 'date',
      'amount', (ic.value ->> 'amount')::numeric,
      'source', ic.value ->> 'source'
    ) order by ic.ordinality), '[]'::jsonb) || v_previous
    into v_previous
    from cost_centres cc, jsonb_array_elements(coalesce(cc.imported_claims, '[]'::jsonb)) with ordinality ic
    where cc.project_id = v_project_id;
  end if;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'invoice_number', v_invoice.invoice_number,
      'description', v_invoice.description,
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'stc_amount', v_invoice.stc_amount,
      'bstc_amount', v_invoice.bstc_amount,
      'is_deposit', v_invoice.is_deposit,
      'sent_at', v_invoice.sent_at,
      'due_date', v_invoice.due_date,
      'paid_at', v_invoice.paid_at,
      'balance_due', v_balance,
      'client_type', v_client_type,
      'commercial_agreement', v_invoice.commercial_agreement,
      'notes', v_invoice.notes,
      -- quoted lines on a claim invoice (item 67): the client page lists each stage's quoted lines when this is on
      'show_quote_lines', v_invoice.show_quote_lines,
      -- late payment interest (item 66): accruing on this invoice, or the charge an interest invoice carries
      'interest_enabled', v_invoice.interest_enabled,
      'interest_accrued', interest_accrued(v_invoice),
      'interest_days', interest_days(v_invoice),
      'interest_daily', interest_daily(v_invoice),
      'interest_rate_pct', (select late_interest_rate_pct from company_settings where id = 1),
      'interest_amount', v_invoice.interest_amount,
      'interest_of_invoice_number', (select i2.invoice_number from invoices i2 where i2.id = v_invoice.interest_of_invoice_id),
      'stc_credit_inc_gst', stc_credit_inc_gst(v_invoice.stc_amount, v_client_type),
      'bstc_credit_inc_gst', stc_credit_inc_gst(v_invoice.bstc_amount, v_client_type),
      -- lead reward credits taken off this invoice (item 74b part 2): one named line each on the client's page
      'lead_reward_credits', (select coalesce(jsonb_agg(jsonb_build_object('job_number', rp.job_number, 'amount', lr.amount) order by lr.due_at, lr.id), '[]'::jsonb)
                              from lead_rewards lr left join projects rp on rp.id = lr.project_id where lr.applied_invoice_id = v_invoice.id)
    ),
    'project', v_project,
    'company', v_company,
    'is_standalone', v_is_standalone,
    'claims', v_claims,
    'previous_invoices', v_previous
  );
end;
$$;
revoke execute on function public.get_invoice_by_token_v3(uuid) from public;
grant execute on function public.get_invoice_by_token_v3(uuid) to anon, authenticated;
