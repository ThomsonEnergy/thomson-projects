-- Lead rewards, step 3b part 1 (backlog item 74b; owner's "go ahead with 3b" and "Two steps",
-- 18 Nov 2026). No invoice is changed here: the reward is worked out, earned, owed and settled by
-- hand. Part 2 (later) takes a credit off the referrer's next invoice by itself and posts a paid
-- reward to Xero.
--
--  * No hidden line on the quote (owner, 18 Nov 2026): the quote shows "Referred by ABC: $200 if won"
--    and the quoter prices it in. lead_reward_amount() is that figure, from Settings > Lead rewards:
--    a full referral by the tier of what the client pays (stages inc GST, less the STC and BSTC
--    credits, the proposal's figure), a quick one at the flat amount, nothing under the minimum job.
--  * lead_rewards: one row per job. lead_reward_earn(job) makes it when a referred quote is approved
--    (create-job-from-quote.js), the amount fixed then. A trigger on invoices makes it due when the
--    job's deposit invoice is paid (or its first invoice, when it has no deposit), and tells the office.
--  * lead_reward_settle(): Paid (a reference and date), Credited (the invoice it went on), or Cancel
--    (a reason), by Admin, Finance or Sales from the Clients page.
-- Money is recorded here, never moved: all or nothing per call, limits checked in the function.

create table if not exists public.lead_rewards (
  id uuid primary key default gen_random_uuid(),
  referrer_client_id uuid not null references public.clients(id) on delete cascade,
  lead_id uuid references public.leads(id) on delete set null,
  project_id uuid not null references public.projects(id) on delete cascade,
  quote_id uuid,
  referral_kind text not null check (referral_kind in ('quick', 'full')),
  kind text not null check (kind in ('pay', 'credit')),
  quote_total numeric(12,2) not null,
  amount numeric(10,2) not null check (amount > 0),
  status text not null default 'earned' check (status in ('earned', 'due', 'settled', 'cancelled')),
  earned_at timestamptz not null default now(),
  due_at timestamptz,
  settled_at timestamptz,
  settled_how text check (settled_how in ('paid', 'credited')),
  settled_reference text,
  settled_by uuid,
  cancelled_reason text,
  created_at timestamptz not null default now()
);
create unique index if not exists lead_rewards_one_per_job on public.lead_rewards (project_id);
create index if not exists lead_rewards_referrer on public.lead_rewards (referrer_client_id, status);
create index if not exists lead_rewards_lead on public.lead_rewards (lead_id);

alter table public.lead_rewards enable row level security;
revoke all on public.lead_rewards from public, anon, authenticated;
grant select on public.lead_rewards to authenticated;
drop policy if exists "Pricing roles read lead rewards" on public.lead_rewards;
create policy "Pricing roles read lead rewards" on public.lead_rewards
  for select to authenticated using ((select is_pricing_role()));

-- What a referral earns on a job the client pays p_total for (inc GST, after credits).
create or replace function public.lead_reward_amount(p_total numeric, p_referral_kind text)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(p_total, 0) < s.lead_reward_min_job then 0
    when p_referral_kind = 'quick' then s.lead_reward_quick_amount
    else coalesce((select (t ->> 'amount')::numeric from jsonb_array_elements(s.lead_reward_tiers) t
                   where (t ->> 'from')::numeric <= p_total order by (t ->> 'from')::numeric desc limit 1), 0)
  end
  from company_settings s where s.id = 1;
$$;
revoke execute on function public.lead_reward_amount(numeric, text) from public, anon;
grant execute on function public.lead_reward_amount(numeric, text) to authenticated;

-- What the client pays on a quote: the stages inc GST, less the STC and BSTC credits (a company
-- client's credits carry GST), the same figure the proposal shows.
create or replace function public.quote_client_total(p_quote uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select round(coalesce((select sum(c.quoted_amount) from cost_centres c where c.project_id = p.id and c.variation_entry_id is null), 0) * 1.1
    - (case when cl.client_type = 'company' then 1.1 else 1 end)
      * (case when coalesce(p.stc_total, 0) > 0 then p.stc_total
              else coalesce((select sum(c.stc_total) from cost_centres c where c.project_id = p.id), 0) end
         + coalesce(p.bstc_total, 0)), 2)
  from projects p left join clients cl on cl.id = p.client_id
  where p.id = p_quote;
$$;
revoke execute on function public.quote_client_total(uuid) from public, anon;
grant execute on function public.quote_client_total(uuid) to authenticated;

-- A referred quote was approved: the reward is earned, its amount fixed now. Safe to call twice.
-- Nothing when the quote was not referred, the referrer's reward is off, the lead was already a
-- client, or the job is under the minimum. Called by the server only (create-job-from-quote.js).
create or replace function public.lead_reward_earn(p_job uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job projects; v_quote projects; v_client clients; v_lead leads;
  v_total numeric; v_amount numeric; v_id uuid;
begin
  select * into v_job from projects where id = p_job;
  if not found or v_job.source_quote_id is null then return null; end if;
  select id into v_id from lead_rewards where project_id = p_job;
  if v_id is not null then return v_id; end if;
  select * into v_quote from projects where id = v_job.source_quote_id;
  if v_quote.referrer_client_id is null then return null; end if;
  select * into v_client from clients where id = v_quote.referrer_client_id;
  if not found or v_client.lead_reward_kind not in ('pay', 'credit') then return null; end if;
  if v_quote.lead_id is not null then select * into v_lead from leads where id = v_quote.lead_id; end if;
  if v_lead.id is not null and v_lead.already_client then return null; end if;
  v_total := quote_client_total(v_quote.id);
  v_amount := lead_reward_amount(v_total, coalesce(v_lead.referral_kind, 'full'));
  if coalesce(v_amount, 0) <= 0 then return null; end if;
  insert into lead_rewards (referrer_client_id, lead_id, project_id, quote_id, referral_kind, kind, quote_total, amount)
  values (v_client.id, v_lead.id, p_job, v_quote.id, coalesce(v_lead.referral_kind, 'full'), v_client.lead_reward_kind, v_total, v_amount)
  on conflict (project_id) do nothing
  returning id into v_id;
  if v_id is not null then
    insert into activity_log (entity_type, entity_id, action, description)
    values ('client', v_client.id, 'lead_reward_earned', format('Lead reward earned: $%s for J%s (%s referral, the client pays $%s). Owed once the deposit is paid.', v_amount, v_job.job_number, coalesce(v_lead.referral_kind, 'full'), v_total));
  end if;
  return v_id;
end;
$$;
revoke execute on function public.lead_reward_earn(uuid) from public, anon, authenticated;

-- The job's deposit invoice was paid (or its first invoice, when it has no deposit): the reward is
-- owed. The office hears about it.
create or replace function public.lead_reward_due_on_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r lead_rewards; v_client text; v_job integer; p record;
begin
  if new.paid_at is null or (tg_op = 'UPDATE' and old.paid_at is not null) or new.project_id is null then return new; end if;
  select * into r from lead_rewards where project_id = new.project_id and status = 'earned';
  if r.id is null then return new; end if;
  if not new.is_deposit and exists (select 1 from invoices i where i.project_id = new.project_id and i.is_deposit and i.id <> new.id) then return new; end if;
  update lead_rewards set status = 'due', due_at = now() where id = r.id and status = 'earned';
  select name into v_client from clients where id = r.referrer_client_id;
  select job_number into v_job from projects where id = r.project_id;
  insert into activity_log (entity_type, entity_id, action, description)
  values ('client', r.referrer_client_id, 'lead_reward_due', format('Lead reward now owed: $%s for J%s (%s)', r.amount, v_job, case when r.kind = 'credit' then 'a credit on their next invoice' else 'to pay' end));
  for p in select id from profiles where active and role in ('admin', 'finance') loop
    perform create_notification(p.id, 'lead', format('Lead reward owed: %s, $%s', v_client, r.amount),
      format('J%s deposit paid. %s from the Clients page.', v_job, case when r.kind = 'credit' then 'Take it off their next invoice and mark it Credited' else 'Pay it and mark it Paid' end),
      '/clients.html', null, 'lead-reward-due:' || r.id);
  end loop;
  return new;
exception when others then
  -- never stop an invoice being marked paid: the reward can be marked owed by hand from the log
  raise warning 'lead_reward_due_on_paid: %', sqlerrm;
  return new;
end;
$$;
revoke execute on function public.lead_reward_due_on_paid() from public, anon, authenticated;
drop trigger if exists invoices_lead_reward_due on public.invoices;
create trigger invoices_lead_reward_due
  after insert or update of paid_at on public.invoices
  for each row execute function public.lead_reward_due_on_paid();

-- Settle or cancel a reward, by Admin, Finance or Sales. p_action: 'paid' (p_reference: the bank
-- reference and date), 'credited' (p_reference: the invoice it went on), 'cancel' (p_reference: why).
create or replace function public.lead_reward_settle(p_id uuid, p_action text, p_reference text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r lead_rewards; v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance and Sales can settle a lead reward.'; end if;
  select * into r from lead_rewards where id = p_id for update;
  if not found then raise exception 'Lead reward not found.'; end if;
  if p_action = 'cancel' then
    if r.status in ('settled', 'cancelled') then raise exception 'This reward is already %.', r.status; end if;
    if v_ref is null then raise exception 'Say why it is cancelled.'; end if;
    update lead_rewards set status = 'cancelled', cancelled_reason = left(v_ref, 300), settled_by = auth.uid(), settled_at = now() where id = p_id;
  elsif p_action in ('paid', 'credited') then
    if r.status <> 'due' then raise exception 'Only a reward that is owed (the deposit paid) can be settled. This one is %.', r.status; end if;
    if v_ref is null then raise exception '%', case when p_action = 'paid' then 'Add the payment reference.' else 'Add the invoice number it was credited on.' end; end if;
    update lead_rewards set status = 'settled', settled_how = p_action, settled_reference = left(v_ref, 200), settled_by = auth.uid(), settled_at = now() where id = p_id;
  else
    raise exception 'Unknown action.';
  end if;
  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values ('client', r.referrer_client_id, 'lead_reward_' || p_action, format('Lead reward $%s %s: %s', r.amount, case p_action when 'paid' then 'paid' when 'credited' then 'credited' else 'cancelled' end, v_ref), auth.uid());
end;
$$;
revoke execute on function public.lead_reward_settle(uuid, text, text) from public, anon;
grant execute on function public.lead_reward_settle(uuid, text, text) to authenticated;
