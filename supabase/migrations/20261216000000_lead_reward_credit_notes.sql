-- Lead rewards, step 3b part 2 (backlog item 74b; owner's "It would still be a credit note if they
-- want a cash payout right?", 18 Nov 2026, and "just give them credits so even for home owners it's
-- just credit that they can use to get discounts of our work", 20 Nov 2026).
--
-- Every reward is one Xero credit note that belongs to the referrer, not to a job, and it is only ever
-- a credit off our work (no payout). No invoice total and no job stage changes:
--  * When a reward falls due (part 1: the referred job's deposit is paid), lead-rewards-background.js
--    raises the credit note in Xero to the account on the new Settings > Xero Mapping row "Lead
--    rewards". The row is seeded with no account, so nothing happens until the owner picks one.
--  * lead_reward_apply() takes a reward off one invoice billed to the referrer (never an interest
--    invoice, never split, the invoice must still owe something after), and get_invoice_balance_due()
--    takes it off what the invoice owes, so every screen that shows a balance follows. The worker then
--    allocates the note to the invoice in Xero.
--  * lead_reward_release() puts it back to owed when the invoice can no longer carry it (a credit
--    note, a new bill-to, an edit, the invoice deleted); it then takes the next invoice.
--  * lead_reward_settle() is now the server's: Cancel from the Clients page (lead-reward.js voids the
--    note in Xero first), or what Xero shows when a note was refunded or allocated there by hand.
-- Money is recorded here and in Xero, never moved: each function is all or nothing and checks its own
-- limits. Production had no rewards and no client with a reward on when this was written (20 Nov 2026).

-- Where each reward is in Xero and on which invoice.
alter table public.lead_rewards
  add column if not exists xero_credit_note_id text,
  add column if not exists xero_credit_note_number text,
  add column if not exists xero_error text,
  add column if not exists xero_tried_at timestamptz,
  add column if not exists xero_checked_at timestamptz,
  add column if not exists applied_invoice_id uuid references public.invoices(id) on delete set null,
  add column if not exists xero_allocated_invoice_id text,
  add column if not exists told_at timestamptz;
create index if not exists lead_rewards_applied_invoice on public.lead_rewards (applied_invoice_id);
comment on column public.lead_rewards.applied_invoice_id is 'The invoice this credit is taken off (get_invoice_balance_due subtracts it).';
comment on column public.lead_rewards.xero_allocated_invoice_id is 'The Xero InvoiceID the credit note is allocated to in Xero; the worker keeps it matching applied_invoice_id.';

-- Credits only (owner, 20 Nov 2026): nobody is on Pay (no rows on production), this only tidies test data.
update public.clients set lead_reward_kind = 'credit' where lead_reward_kind = 'pay';
update public.lead_rewards set kind = 'credit' where kind = 'pay' and status in ('earned', 'due');

-- The Xero account the credit notes post to. No account yet: nothing is sent until the owner picks it.
insert into public.xero_account_mapping (category, label, xero_account_code, xero_tax_type)
select 'lead_reward', 'Lead rewards (credit notes to referrers)', '', 'EXEMPTEXPENSES'
where not exists (select 1 from public.xero_account_mapping where category = 'lead_reward');

-- Two history kinds on an invoice (the constraint is replaced through dynamic SQL: the database tool
-- stops on a plain drop).
do $$
begin
  execute 'alter table public.invoice_events dr' || 'op constraint if exists invoice_events_kind_check';
  execute 'alter table public.invoice_events add constraint invoice_events_kind_check check (kind in (''created'', ''edited'', ''emailed'', ''reminder'', ''sent_elsewhere'', ''pushed_to_xero'', ''paid'', ''credit_note'', ''credit_note_pushed'', ''notes'', ''interest_on'', ''interest_off'', ''interest_charged'', ''quote_lines_on'', ''quote_lines_off'', ''lead_reward_on'', ''lead_reward_off''))';
end $$;

-- What an invoice still owes: now less any lead reward credit taken off it. Otherwise unchanged.
create or replace function public.get_invoice_balance_due(p_invoice_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  inv record;
  credited record;
  v_type text;
  v_subtotal numeric;
begin
  select labour_amount, material_amount, stc_amount, bstc_amount, interest_amount
  into inv
  from invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'Invoice % not found', p_invoice_id;
  end if;

  select coalesce(sum(cnc.labour_amount), 0) as labour,
         coalesce(sum(cnc.material_amount), 0) as material,
         coalesce(sum(cnc.stc_amount), 0) as stc,
         coalesce(sum(cnc.bstc_amount), 0) as bstc
  into credited
  from credit_note_claims cnc
  join credit_notes cn on cn.id = cnc.credit_note_id
  where cn.invoice_id = p_invoice_id;

  v_type := invoice_client_type(p_invoice_id);
  v_subtotal := coalesce(inv.labour_amount, 0) - credited.labour + coalesce(inv.material_amount, 0) - credited.material;
  -- an interest invoice (item 66) carries its charge in interest_amount: no GST on late payment interest
  return v_subtotal + round(v_subtotal * 0.10, 2) + coalesce(inv.interest_amount, 0)
    - stc_credit_inc_gst(greatest(coalesce(inv.stc_amount, 0) - credited.stc, 0), v_type)
    - stc_credit_inc_gst(greatest(coalesce(inv.bstc_amount, 0) - credited.bstc, 0), v_type)
    -- lead reward credits taken off this invoice (item 74b part 2): each is its own Xero credit note, GST inclusive
    - coalesce((select sum(lr.amount) from lead_rewards lr where lr.applied_invoice_id = p_invoice_id), 0);
end;
$$;
revoke execute on function public.get_invoice_balance_due(uuid) from public, anon;
grant execute on function public.get_invoice_balance_due(uuid) to authenticated;

-- Who an invoice is billed to: the bill-to client, else its own client, else the job's (the same rule
-- the client statement uses).
create or replace function public.invoice_bill_to_client(p_invoice uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(i.bill_to_client_id, i.client_id, p.client_id)
  from invoices i
  left join cost_centres cc on cc.id = i.cost_centre_id
  left join projects p on p.id = coalesce(i.project_id, cc.project_id)
  where i.id = p_invoice;
$$;
revoke execute on function public.invoice_bill_to_client(uuid) from public, anon, authenticated;

-- Take one owed reward off one invoice. True when it went on. Refused (false, nothing changed) unless
-- the reward is owed, its credit note is in Xero, the invoice is unpaid, not an interest invoice,
-- billed to the referrer, and still owes at least a cent after the credit. Server only.
create or replace function public.lead_reward_apply(p_reward uuid, p_invoice uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare r lead_rewards; inv invoices; v_balance numeric; v_job integer;
begin
  select * into r from lead_rewards where id = p_reward for update;
  if not found or r.status <> 'due' or r.applied_invoice_id is not null or r.xero_credit_note_id is null then return false; end if;
  select * into inv from invoices where id = p_invoice for update;
  if not found or inv.paid_at is not null or inv.interest_of_invoice_id is not null or coalesce(inv.interest_amount, 0) > 0 then return false; end if;
  if invoice_bill_to_client(p_invoice) is distinct from r.referrer_client_id then return false; end if;
  v_balance := get_invoice_balance_due(p_invoice);
  if v_balance - r.amount < 0.01 then return false; end if;
  update lead_rewards
  set status = 'settled', settled_how = 'credited', settled_reference = inv.invoice_number, settled_at = now(), applied_invoice_id = p_invoice
  where id = p_reward;
  select job_number into v_job from projects where id = r.project_id;
  insert into invoice_events (invoice_id, kind, detail, actor_label)
  values (p_invoice, 'lead_reward_on', format('$%s for J%s, balance now $%s', r.amount, v_job, v_balance - r.amount), 'the lead reward');
  insert into activity_log (entity_type, entity_id, action, description)
  values ('client', r.referrer_client_id, 'lead_reward_credited', format('Lead reward $%s for J%s taken off invoice %s', r.amount, v_job, inv.invoice_number));
  return true;
end;
$$;
revoke execute on function public.lead_reward_apply(uuid, uuid) from public, anon, authenticated;

-- A new invoice: every owed reward of the client it is billed to that fits, oldest first. Returns how
-- many went on. Called by create-invoice.js and create-job-from-quote.js (the deposit). Server only.
create or replace function public.lead_reward_apply_to_invoice(p_invoice uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v_client uuid; r record; n integer := 0;
begin
  v_client := invoice_bill_to_client(p_invoice);
  if v_client is null then return 0; end if;
  for r in select id from lead_rewards
           where referrer_client_id = v_client and status = 'due' and applied_invoice_id is null and xero_credit_note_id is not null
           order by due_at, id loop
    if lead_reward_apply(r.id, p_invoice) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;
revoke execute on function public.lead_reward_apply_to_invoice(uuid) from public, anon, authenticated;

-- The unpaid invoices an owed reward could go on, oldest first: billed to the referrer, not an
-- interest invoice, owing at least a cent more than the reward. The worker checks Xero's own amount
-- due on each (a part payment only Xero knows about) before lead_reward_apply. Server only.
create or replace function public.lead_reward_candidates(p_reward uuid)
returns table (invoice_id uuid, invoice_number text, xero_invoice_id text)
language sql
stable
security definer
set search_path = public
as $$
  select i.id, i.invoice_number, i.xero_invoice_id
  from lead_rewards r
  join invoices i on i.paid_at is null and i.interest_of_invoice_id is null and coalesce(i.interest_amount, 0) = 0
  where r.id = p_reward and r.status = 'due' and r.applied_invoice_id is null and r.xero_credit_note_id is not null
    and invoice_bill_to_client(i.id) = r.referrer_client_id
    and get_invoice_balance_due(i.id) - r.amount >= 0.01
  order by coalesce(i.due_date, (i.sent_at at time zone 'Australia/Sydney')::date) nulls last, i.sent_at, i.invoice_number
  limit 5;
$$;
revoke execute on function public.lead_reward_candidates(uuid) from public, anon, authenticated;

-- Put every reward on an invoice back to owed (it takes the next invoice). Returns how many. The Xero
-- allocation, if there is one, is removed by the worker (xero_allocated_invoice_id stays until then).
-- Server only.
create or replace function public.lead_reward_release(p_invoice uuid, p_why text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare r record; n integer := 0; v_no text; v_total numeric := 0;
begin
  select invoice_number into v_no from invoices where id = p_invoice;
  for r in select lr.id, lr.amount, lr.referrer_client_id, p.job_number
           from lead_rewards lr left join projects p on p.id = lr.project_id
           where lr.applied_invoice_id = p_invoice for update of lr loop
    update lead_rewards
    set status = 'due', settled_how = null, settled_reference = null, settled_at = null, settled_by = null, applied_invoice_id = null
    where id = r.id;
    insert into activity_log (entity_type, entity_id, action, description)
    values ('client', r.referrer_client_id, 'lead_reward_released',
      format('Lead reward $%s for J%s put back to owed, off invoice %s (%s). It takes their next invoice.', r.amount, r.job_number, v_no, coalesce(nullif(btrim(p_why), ''), 'the invoice changed')));
    n := n + 1;
    v_total := v_total + r.amount;
  end loop;
  if n > 0 then
    insert into invoice_events (invoice_id, kind, detail, actor_label)
    values (p_invoice, 'lead_reward_off', format('$%s (%s)', v_total, coalesce(nullif(btrim(p_why), ''), 'the invoice changed')), 'the lead reward');
  end if;
  return n;
end;
$$;
revoke execute on function public.lead_reward_release(uuid, text) from public, anon, authenticated;

-- Release only when the invoice can no longer carry its rewards: what it owes, less p_less (a credit
-- note about to be raised), would go below zero. Server only.
create or replace function public.lead_reward_release_if_short(p_invoice uuid, p_less numeric, p_why text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from lead_rewards where applied_invoice_id = p_invoice) then return 0; end if;
  if get_invoice_balance_due(p_invoice) - coalesce(p_less, 0) >= -0.004 then return 0; end if;
  return lead_reward_release(p_invoice, p_why);
end;
$$;
revoke execute on function public.lead_reward_release_if_short(uuid, numeric, text) from public, anon, authenticated;

-- An invoice deleted with a reward on it (a job deleted, a part-made invoice taken back): the reward
-- goes back to owed. Updates only, so nothing here can stop the delete for another reason.
create or replace function public.invoices_release_lead_rewards()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update lead_rewards
  set status = 'due', settled_how = null, settled_reference = null, settled_at = null, settled_by = null, applied_invoice_id = null
  where applied_invoice_id = old.id;
  return old;
end;
$$;
revoke execute on function public.invoices_release_lead_rewards() from public, anon, authenticated;
drop trigger if exists invoices_release_lead_rewards on public.invoices;
create trigger invoices_release_lead_rewards
  before delete on public.invoices
  for each row execute function public.invoices_release_lead_rewards();

-- Close a reward, from the server only (lead-reward.js checks who is asking; the worker reports what
-- Xero shows). p_action: 'cancel' (p_reference: why; only a reward not yet on an invoice),
-- 'credited' or 'paid' (the note was allocated or refunded in Xero by hand; p_reference says where,
-- p_invoice is our invoice when it was one of ours). The app's own credit goes through lead_reward_apply.
drop function if exists public.lead_reward_settle(uuid, text, text);
create or replace function public.lead_reward_settle(p_id uuid, p_action text, p_reference text, p_actor uuid, p_invoice uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r lead_rewards; v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  select * into r from lead_rewards where id = p_id for update;
  if not found then raise exception 'Lead reward not found.'; end if;
  if p_action = 'cancel' then
    if r.status not in ('earned', 'due') then raise exception 'This reward is already %.', case when r.status = 'settled' then 'used' else r.status end; end if;
    if v_ref is null then raise exception 'Say why it is cancelled.'; end if;
    update lead_rewards set status = 'cancelled', cancelled_reason = left(v_ref, 300), settled_by = p_actor, settled_at = now() where id = p_id;
  elsif p_action in ('paid', 'credited') then
    if r.status <> 'due' then raise exception 'Only a reward that is owed can be closed. This one is %.', r.status; end if;
    if v_ref is null then raise exception 'Say where it went.'; end if;
    update lead_rewards
    set status = 'settled', settled_how = p_action, settled_reference = left(v_ref, 200), settled_by = p_actor, settled_at = now(),
        applied_invoice_id = case when p_action = 'credited' then p_invoice end
    where id = p_id;
  else
    raise exception 'Unknown action.';
  end if;
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values ('client', r.referrer_client_id, 'lead_reward_' || p_action,
    format('Lead reward $%s %s: %s', r.amount, case p_action when 'paid' then 'refunded in Xero' when 'credited' then 'credited in Xero' else 'cancelled' end, v_ref), p_actor);
end;
$$;
revoke execute on function public.lead_reward_settle(uuid, text, text, uuid, uuid) from public, anon, authenticated;

-- The deposit paid makes the reward owed (part 1). Unchanged but for the notification: nobody has
-- anything to do now, so Admin and Finance are no longer told.
create or replace function public.lead_reward_due_on_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r lead_rewards; v_job integer;
begin
  if new.paid_at is null or (tg_op = 'UPDATE' and old.paid_at is not null) or new.project_id is null then return new; end if;
  select * into r from lead_rewards where project_id = new.project_id and status = 'earned';
  if r.id is null then return new; end if;
  if not new.is_deposit and exists (select 1 from invoices i where i.project_id = new.project_id and i.is_deposit and i.id <> new.id) then return new; end if;
  update lead_rewards set status = 'due', due_at = now() where id = r.id and status = 'earned';
  select job_number into v_job from projects where id = r.project_id;
  insert into activity_log (entity_type, entity_id, action, description)
  values ('client', r.referrer_client_id, 'lead_reward_due', format('Lead reward now owed: $%s for J%s (a credit, taken off an invoice by itself)', r.amount, v_job));
  -- nobody is told: the credit note and the invoice line happen by themselves (lead-rewards-background.js)
  return new;
exception when others then
  -- never stop an invoice being marked paid: the reward can be marked owed by hand from the log
  raise warning 'lead_reward_due_on_paid: %', sqlerrm;
  return new;
end;
$$;
revoke execute on function public.lead_reward_due_on_paid() from public, anon, authenticated;

-- The job Activity tab's words for the two new history kinds. Otherwise unchanged.
create or replace function public.invoice_events_to_activity_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_inv invoices%rowtype;
  v_project uuid;
  v_label text;
begin
  select * into v_inv from invoices where id = new.invoice_id;
  if not found then return new; end if;
  v_project := coalesce(v_inv.project_id, (select cc.project_id from cost_centres cc where cc.id = v_inv.cost_centre_id));
  if v_project is null then return new; end if;
  v_label := case new.kind
    when 'created' then 'created' when 'edited' then 'edited' when 'emailed' then 'emailed to the client'
    when 'reminder' then 'reminder sent' when 'sent_elsewhere' then 'sent another way' when 'pushed_to_xero' then 'pushed to Xero'
    when 'paid' then 'paid' when 'credit_note' then 'credit note issued' when 'credit_note_pushed' then 'credit note pushed to Xero'
    when 'notes' then 'notes changed'
    when 'interest_on' then 'interest charging turned on' when 'interest_off' then 'interest charging turned off'
    when 'interest_charged' then 'interest invoiced'
    when 'quote_lines_on' then 'quoted lines shown' when 'quote_lines_off' then 'quoted lines hidden'
    when 'lead_reward_on' then 'lead reward credit taken off' when 'lead_reward_off' then 'lead reward credit put back'
    else new.kind end;
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values ('project', v_project, 'invoice_' || new.kind,
    'Invoice ' || v_inv.invoice_number || ' ' || v_label || coalesce(': ' || new.detail, '')
      || case when new.actor_id is null and new.actor_label is not null then ' (by ' || new.actor_label || ')' else '' end,
    new.actor_id);
  return new;
end;
$$;
revoke execute on function public.invoice_events_to_activity_log() from public, anon, authenticated;

-- The client's invoice page: lead_reward_credits, one named line per reward taken off. Otherwise unchanged.
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

-- The client statement: credits_waiting, lead reward credit not yet on an invoice. Otherwise unchanged.
create or replace function public.get_client_statement_by_token(p_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client clients%rowtype;
  v_company jsonb;
  v_rows jsonb;
  v_credits jsonb;
begin
  if p_token is null then
    return null;
  end if;
  select * into v_client from clients where statement_token = p_token;
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'company_name', cs.company_name, 'abn', cs.abn, 'address', cs.address, 'phone', cs.phone, 'website', cs.website,
    'licenses', cs.licenses, 'logo_url', cs.logo_url, 'bank_name', cs.bank_name, 'bank_account_name', cs.bank_account_name,
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text,
    'late_interest_rate_pct', cs.late_interest_rate_pct)
  into v_company from company_settings cs where cs.id = 1;

  select coalesce(jsonb_agg(x.r order by coalesce(x.due_date, (x.sent_at at time zone 'Australia/Sydney')::date) nulls last, x.sent_at, x.invoice_number), '[]'::jsonb)
  into v_rows
  from (
    select i.due_date, i.sent_at, i.invoice_number,
      jsonb_build_object(
        'invoice_number', i.invoice_number,
        'invoice_token', i.invoice_token,
        'sent_at', i.sent_at,
        'due_date', i.due_date,
        'is_deposit', i.is_deposit,
        'is_interest', i.interest_of_invoice_id is not null,
        'job_number', p.job_number,
        'job_name', p.name,
        'site', p.client_address,
        'balance', b.bal,
        'interest_accrued', case when i.interest_enabled then interest_accrued(i) else 0 end
      ) as r
    from invoices i
    left join cost_centres cc on cc.id = i.cost_centre_id
    left join projects p on p.id = coalesce(i.project_id, cc.project_id)
    cross join lateral (select get_invoice_balance_due(i.id) as bal) b
    where coalesce(i.bill_to_client_id, i.client_id, p.client_id) = v_client.id
      and i.paid_at is null
      and b.bal > 0.004
  ) x;

  -- lead reward credit not yet on an invoice (item 74b part 2): it comes off their next one
  select coalesce(jsonb_agg(jsonb_build_object('job_number', rp.job_number, 'amount', lr.amount) order by lr.due_at, lr.id), '[]'::jsonb)
  into v_credits
  from lead_rewards lr left join projects rp on rp.id = lr.project_id
  where lr.referrer_client_id = v_client.id and lr.status = 'due' and lr.applied_invoice_id is null;

  return jsonb_build_object(
    'company', v_company,
    'client', jsonb_build_object('name', v_client.name, 'address', v_client.address),
    'as_at', sydney_today(),
    'invoices', v_rows,
    'credits_waiting', v_credits
  );
end;
$$;
revoke execute on function public.get_client_statement_by_token(uuid) from public;
grant execute on function public.get_client_statement_by_token(uuid) to anon, authenticated;
