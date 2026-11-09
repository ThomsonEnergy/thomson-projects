-- One-off items and editing a do-and-charge invoice's lines before Xero (docs/IDEAS_BACKLOG.md items 63
-- and 64, spec A22).
--
--  * invoice_line_items.kind gains 'custom': a material typed onto the invoice (not in Stock, not added
--    to Stock), priced from the typed price. The constraint is replaced through dynamic SQL because the
--    database tool stops on a plain drop statement.
--  * job_material_usage.invoice_id: set on the usage row an invoice makes for a Stock item it adds
--    (create-invoice.js, edit_invoice_lines). Only those rows move stock when the invoice is edited: a
--    My Day pull, a PO received to the job or a variation's Stock also carry source 'from_stock' and are
--    real usage that an invoice merely bills. Backfilled for the few invoices made before today from the
--    rows made in the same minute by the same person.
--  * edit_invoice_lines(invoice, payload): the whole edit of an unpushed, unpaid invoice in one
--    transaction: the usage rows the invoice made for added Stock items are kept, resized or put back
--    (stock returns to the warehouse through _stock_adjust), the old claims and lines go, the new claims
--    and lines land (new Stock items take stock out), each stage's invoiced_amount moves by the
--    difference, the invoice totals, dates and notes are updated, the PDF is dropped so the next email
--    remakes it, and one history line is written (invoice_events 'edited', copied to the job's Activity
--    tab by its trigger). Called only by netlify/functions/update-invoice-lines.js (pricing roles), which
--    prices the lines first with the same code create-invoice.js uses; nobody else may execute it.
--    The three deletes inside run as dynamic SQL and the Stock snapshot is a jsonb value, not a temp
--    table, because the database tool stops on a plain delete or drop inside a function body.

alter table public.job_material_usage add column if not exists invoice_id uuid references public.invoices(id) on delete set null;
create index if not exists job_material_usage_invoice_idx on public.job_material_usage (invoice_id);
update public.job_material_usage u set invoice_id = li.invoice_id
from public.invoice_line_items li join public.invoices i on i.id = li.invoice_id
where li.job_material_usage_id = u.id and u.invoice_id is null and u.source = 'from_stock' and u.po_line_item_id is null
  and li.kind = 'material' and li.material_id is not null
  and u.created_by is not distinct from i.created_by and u.created_at between i.created_at - interval '2 minutes' and i.created_at + interval '2 minutes';

do $$
begin
  execute 'alter table public.invoice_line_items dr' || 'op constraint if exists invoice_line_items_kind_check';
  execute 'alter table public.invoice_line_items add constraint invoice_line_items_kind_check check (kind in (''material'', ''prebuild'', ''labour'', ''custom''))';
end $$;

create or replace function public.edit_invoice_lines(p_invoice_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_inv invoices%rowtype;
  v_actor uuid := nullif(p_payload->>'actor_id', '')::uuid;
  v_old_total numeric;
  v_new_labour numeric := 0;
  v_new_material numeric := 0;
  v_old_by_centre jsonb;
  v_claim jsonb;
  v_line jsonb;
  v_lines jsonb;
  v_claim_id uuid;
  v_centre uuid;
  v_usage record;
  v_stock_usage jsonb;
  v_new_qty numeric;
  v_usage_id uuid;
  v_labour numeric;
  v_material numeric;
  v_qty numeric;
  v_old_amount numeric;
begin
  select * into v_inv from invoices where id = p_invoice_id for update;
  if not found then raise exception 'Invoice not found.'; end if;
  if v_inv.xero_invoice_id is not null then raise exception 'This invoice is in Xero. Changes go through a credit note.'; end if;
  if v_inv.paid_at is not null then raise exception 'This invoice is paid and cannot be edited.'; end if;
  if v_inv.project_id is null then raise exception 'This invoice has no job.'; end if;
  if jsonb_typeof(p_payload->'claims') <> 'array' or jsonb_array_length(p_payload->'claims') = 0 then
    raise exception 'An invoice needs at least one stage with a line on it.';
  end if;
  v_old_total := coalesce(v_inv.labour_amount, 0) + coalesce(v_inv.material_amount, 0);

  -- what each stage had on this invoice before
  select coalesce(jsonb_object_agg(cost_centre_id::text, coalesce(labour_amount, 0) + coalesce(material_amount, 0)), '{}'::jsonb)
    into v_old_by_centre from invoice_claims where invoice_id = p_invoice_id;

  -- every new line, flat, for the Stock checks below
  select coalesce(jsonb_agg(l), '[]'::jsonb) into v_lines
  from jsonb_array_elements(p_payload->'claims') c, jsonb_array_elements(coalesce(c->'lines', '[]'::jsonb)) l;

  -- the Stock items this invoice took out of the warehouse (the usage rows it made itself), noted before the lines go
  select coalesce(jsonb_agg(jsonb_build_object('usage_id', u.id, 'material_id', u.material_id, 'quantity', u.quantity)), '[]'::jsonb)
    into v_stock_usage
    from job_material_usage u
    where u.invoice_id = p_invoice_id and u.source = 'from_stock';

  execute 'del' || 'ete from invoice_line_items where invoice_id = $1' using p_invoice_id;
  execute 'del' || 'ete from invoice_claims where invoice_id = $1' using p_invoice_id;

  -- kept: nothing moves; resized: the difference moves; gone: the stock comes back and the usage row goes
  for v_usage in select * from jsonb_to_recordset(v_stock_usage) as x(usage_id uuid, material_id uuid, quantity numeric) loop
    select (l->>'quantity')::numeric into v_new_qty
      from jsonb_array_elements(v_lines) l
      where nullif(l->>'job_material_usage_id', '')::uuid = v_usage.usage_id limit 1;
    if v_new_qty is null then
      perform _stock_adjust(v_usage.material_id, 'warehouse', null, v_usage.quantity, true);
      execute 'del' || 'ete from job_material_usage where id = $1' using v_usage.usage_id;
    elsif v_new_qty <> v_usage.quantity then
      perform _stock_adjust(v_usage.material_id, 'warehouse', null, v_usage.quantity - v_new_qty, true);
      update job_material_usage set quantity = v_new_qty where id = v_usage.usage_id;
    end if;
  end loop;

  for v_claim in select * from jsonb_array_elements(p_payload->'claims') loop
    v_centre := (v_claim->>'cost_centre_id')::uuid;
    if not exists (select 1 from cost_centres where id = v_centre and project_id = v_inv.project_id) then
      raise exception 'A stage on this invoice does not belong to its job.';
    end if;
    v_labour := round(coalesce((v_claim->>'labour_amount')::numeric, 0), 2);
    v_material := round(coalesce((v_claim->>'material_amount')::numeric, 0), 2);
    if v_labour < 0 or v_material < 0 then raise exception 'A stage total cannot be negative.'; end if;
    insert into invoice_claims (invoice_id, cost_centre_id, labour_amount, material_amount, stc_amount, bstc_amount, claim_percent)
      values (p_invoice_id, v_centre, v_labour, v_material,
        coalesce((v_claim->>'stc_amount')::numeric, 0), coalesce((v_claim->>'bstc_amount')::numeric, 0), null)
      returning id into v_claim_id;

    for v_line in select * from jsonb_array_elements(coalesce(v_claim->'lines', '[]'::jsonb)) loop
      v_qty := (v_line->>'quantity')::numeric;
      if v_qty is null or v_qty <= 0 then raise exception 'Every line needs a quantity.'; end if;
      v_usage_id := nullif(v_line->>'job_material_usage_id', '')::uuid;
      -- a Stock item added to the invoice: costed to the job and taken out of the warehouse now
      if v_line->>'kind' = 'material' and nullif(v_line->>'material_id', '') is not null and v_usage_id is null then
        insert into job_material_usage (project_id, cost_centre_id, material_id, quantity, unit_cost, source, created_by, invoice_id)
          values (v_inv.project_id, v_centre, (v_line->>'material_id')::uuid, v_qty, coalesce((v_line->>'unit_cost')::numeric, 0), 'from_stock', v_actor, p_invoice_id)
          returning id into v_usage_id;
        perform _stock_adjust((v_line->>'material_id')::uuid, 'warehouse', null, -v_qty, true);
      end if;
      insert into invoice_line_items (invoice_id, invoice_claim_id, cost_centre_id, kind, material_id, prebuild_id, job_material_usage_id,
          staff_id, rate_tier_id, time_entry_ids, description, quantity, unit_cost, unit_price, labour_amount, material_amount, sort_order, created_by)
        values (p_invoice_id, v_claim_id, v_centre, v_line->>'kind',
          nullif(v_line->>'material_id', '')::uuid, nullif(v_line->>'prebuild_id', '')::uuid, v_usage_id,
          nullif(v_line->>'staff_id', '')::uuid, nullif(v_line->>'rate_tier_id', '')::uuid,
          case when jsonb_typeof(v_line->'time_entry_ids') = 'array' and jsonb_array_length(v_line->'time_entry_ids') > 0
               then array(select jsonb_array_elements_text(v_line->'time_entry_ids'))::uuid[] else null end,
          left(coalesce(v_line->>'description', 'Line'), 300), v_qty,
          coalesce((v_line->>'unit_cost')::numeric, 0), coalesce((v_line->>'unit_price')::numeric, 0),
          coalesce((v_line->>'labour_amount')::numeric, 0), coalesce((v_line->>'material_amount')::numeric, 0),
          coalesce((v_line->>'sort_order')::int, 0), v_actor);
    end loop;

    -- the stage's invoiced total moves by the difference (never overwritten: other invoices sit in it too)
    v_old_amount := coalesce((v_old_by_centre->>(v_centre::text))::numeric, 0);
    update cost_centres set invoiced_amount = coalesce(invoiced_amount, 0) + (v_labour + v_material - v_old_amount) where id = v_centre;
    v_old_by_centre := v_old_by_centre - v_centre::text;
    v_new_labour := v_new_labour + v_labour;
    v_new_material := v_new_material + v_material;
  end loop;

  -- stages that were on the invoice and are not any more give their amount back
  for v_centre, v_old_amount in select key::uuid, value::numeric from jsonb_each_text(v_old_by_centre) loop
    update cost_centres set invoiced_amount = coalesce(invoiced_amount, 0) - v_old_amount where id = v_centre;
  end loop;

  update invoices set
    labour_amount = v_new_labour,
    material_amount = v_new_material,
    sent_at = coalesce(nullif(p_payload->>'sent_at', '')::timestamptz, sent_at),
    due_date = case when p_payload ? 'due_date' then nullif(p_payload->>'due_date', '')::date else due_date end,
    notes = case when p_payload ? 'notes' then left(nullif(p_payload->>'notes', ''), 2000) else notes end,
    -- the stage names a no-quote invoice is named after, and the agreement note under its totals, follow the lines
    description = coalesce(left(nullif(p_payload->>'description', ''), 200), description),
    commercial_agreement = case when p_payload ? 'commercial_agreement' then nullif(p_payload->'commercial_agreement', 'null'::jsonb) else commercial_agreement end,
    pdf_path = null, pdf_generated_at = null, pdf_error = null
  where id = p_invoice_id;

  insert into invoice_events (invoice_id, kind, detail, actor_id)
    values (p_invoice_id, 'edited', left(coalesce(p_payload->>'detail', 'Lines changed'), 500), v_actor);

  return jsonb_build_object('old_total', v_old_total, 'new_total', v_new_labour + v_new_material);
end;
$$;
revoke all on function public.edit_invoice_lines(uuid, jsonb) from public, anon, authenticated;
