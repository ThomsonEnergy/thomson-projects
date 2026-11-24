-- Staff personal links and the link bonus (backlog item 74b step 3c, point 7a; owner's "Build it",
-- 24 Nov 2026).
--
--  * staff_referral_links: one private link per staff member, refer.html?s=<token>. Nobody reads the
--    table: my_staff_link() hands a person their own, the server (refer.js) looks a token up.
--  * leads.referrer_profile_id: whose link the lead came through ("From Nathan" on the Leads page).
--    leads.heard_from / heard_from_profile_id: the customer's answer to "How did you first hear about
--    Thomson Energy?". leads.already_reason: why a lead is "Already ours" (already_client, widened).
--  * staff_lead_check(lead): the server calls it once the lead is in. A lead is Already ours when the
--    person is already a client or a client's contact, already has a quote or a job, enquired, asked
--    for a call or emailed us in the last company_settings.already_ours_days (90), or answered
--    anything other than the link's owner. Already ours pays no bonus and still counts on the KPIs.
--  * staff_bonuses: the $50 (company_settings.staff_link_amount). staff_bonus_earn(job) makes the row
--    when a quote from an eligible link lead is approved, on a job of lead_reward_min_job or more; a
--    trigger on invoices makes it due when the deposit is paid (or the first invoice, with no
--    deposit). What is owed adds up on the person's Home page and stays owed until it is paid
--    (owner, 24 Nov 2026: bonuses accrue; paying them through a pay run is built later, so nothing
--    here marks one paid yet). Admin can cancel one with a reason, or clear a wrong Already ours
--    with a reason.
--  * staff_lead_stats(): leads sent, quoted, won and the won value for a person and a period.
--  * The minimum job for every reward is now $3,000 (owner, 24 Nov 2026).
--  * The staff policy joins the documents every person signs at their next login.
-- Money is recorded here, never moved: each function is all or nothing and checks its own limits.
-- Additions only.

-- 1. The link ------------------------------------------------------------------------------------
create table if not exists public.staff_referral_links (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  created_at timestamptz not null default now()
);
create unique index if not exists staff_referral_links_token on public.staff_referral_links (token);
alter table public.staff_referral_links enable row level security;
-- no policies and no grants: the server and the functions below only
revoke all on public.staff_referral_links from public, anon, authenticated;

-- A person's own link token, made the first time they ask. Active staff only.
create or replace function public.my_staff_link()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare v_token text;
begin
  if (select auth.uid()) is null then raise exception 'Not logged in'; end if;
  if not exists (select 1 from profiles where id = (select auth.uid()) and active) then raise exception 'Not an active user'; end if;
  insert into staff_referral_links (profile_id) values ((select auth.uid())) on conflict (profile_id) do nothing;
  select token into v_token from staff_referral_links where profile_id = (select auth.uid());
  return v_token;
end;
$$;
revoke execute on function public.my_staff_link() from public, anon;
grant execute on function public.my_staff_link() to authenticated;

-- 2. The lead ------------------------------------------------------------------------------------
alter table public.leads
  add column if not exists referrer_profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists heard_from text,
  add column if not exists heard_from_profile_id uuid references public.profiles(id) on delete set null,
  add column if not exists already_reason text;
create index if not exists leads_referrer_profile on public.leads (referrer_profile_id);
create index if not exists leads_heard_from_profile on public.leads (heard_from_profile_id);
comment on column public.leads.referrer_profile_id is 'The staff member whose personal link this lead came through (item 74b 7a).';
comment on column public.leads.already_reason is 'Why the lead is Already ours (already_client): what it matched, or what the customer answered.';

alter table public.company_settings
  add column if not exists staff_link_amount numeric(10,2) not null default 50,
  add column if not exists already_ours_days integer not null default 90,
  add column if not exists heard_from_options jsonb not null default '["Google", "Our website", "Facebook or Instagram", "Saw a vehicle or a sign", "Already a customer", "Someone recommended you", "Other"]'::jsonb;

-- Every reward starts at jobs of $3,000 (owner, 24 Nov 2026). Production and staging were changed by
-- hand the same day; this is for a database built fresh from the migrations.
alter table public.company_settings alter column lead_reward_min_job set default 3000;
alter table public.company_settings alter column lead_reward_tiers set default '[{"from": 3000, "amount": 80}, {"from": 5000, "amount": 200}, {"from": 15000, "amount": 500}]'::jsonb;
update public.company_settings
  set lead_reward_min_job = 3000,
      lead_reward_tiers = '[{"from": 3000, "amount": 80}, {"from": 5000, "amount": 200}, {"from": 15000, "amount": 500}]'::jsonb
  where lead_reward_min_job = 1000;

-- Who a lead came from and whether it is Already ours decide money, so only the server (the service
-- key, which the link's function uses) and an admin can set them. The website's enquiry form inserts
-- leads with the public key and Sales can edit a lead: neither can credit a lead to a staff member.
create or replace function public.leads_guard_referrer()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(auth.role(), 'service_role') not in ('anon', 'authenticated') then return new; end if;
  if tg_op = 'INSERT' then
    new.referrer_profile_id := null;
    new.heard_from_profile_id := null;
  elsif new.referrer_profile_id is distinct from old.referrer_profile_id
     or new.heard_from_profile_id is distinct from old.heard_from_profile_id
     or new.already_client is distinct from old.already_client
     or new.already_reason is distinct from old.already_reason then
    if not is_admin() then raise exception 'Only an admin can change who a lead came from.'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists leads_guard_referrer on public.leads;
create trigger leads_guard_referrer
  before insert or update on public.leads
  for each row execute function public.leads_guard_referrer();

-- Is this staff link lead someone we already had? Sets already_client and already_reason and returns
-- the reason (null: a new customer, brought in by the link's owner). Server only.
create or replace function public.staff_lead_check(p_lead uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  l leads;
  v_days integer;
  v_since timestamptz;
  v_email text;
  v_phone text;
  v_street text;
  v_reason text;
  v_name text;
begin
  select * into l from leads where id = p_lead;
  if not found or l.referrer_profile_id is null then return null; end if;
  select coalesce(already_ours_days, 90) into v_days from company_settings where id = 1;
  v_since := now() - make_interval(days => coalesce(v_days, 90));
  v_email := nullif(lower(btrim(coalesce(l.email, ''))), '');
  v_phone := right(regexp_replace(coalesce(l.phone, ''), '\D', '', 'g'), 8);
  if length(v_phone) < 8 then v_phone := null; end if;
  v_street := lower(btrim(split_part(coalesce(l.address_formatted, l.address_line, ''), ',', 1)));
  if length(v_street) < 8 then v_street := null; end if;

  -- an existing client, or a contact at one
  select c.name into v_name from clients c
    where (v_email is not null and lower(btrim(c.email)) = v_email)
       or (v_phone is not null and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 8) = v_phone)
    limit 1;
  if v_name is null then
    select c.name into v_name from client_contacts cc join clients c on c.id = cc.client_id
      where (v_email is not null and lower(btrim(cc.email)) = v_email)
         or (v_phone is not null and right(regexp_replace(coalesce(cc.phone, ''), '\D', '', 'g'), 8) = v_phone)
      limit 1;
  end if;
  if v_name is not null then v_reason := format('already a client (%s)', v_name); end if;

  -- a quote or a job in their name, or an open one at that address
  if v_reason is null then
    select case when p.job_number is not null then 'J' || p.job_number when p.quote_number is not null then 'Q' || p.quote_number else 'a quote' end
      into v_name from projects p
      where coalesce(p.lead_id, '00000000-0000-0000-0000-000000000000'::uuid) <> l.id
        and ((v_email is not null and lower(btrim(p.client_email)) = v_email)
          or (v_phone is not null and right(regexp_replace(coalesce(p.client_phone, ''), '\D', '', 'g'), 8) = v_phone)
          -- the same street line in the same suburb and postcode (when the lead has them), still open
          or (v_street is not null and p.pipeline_stage not in ('complete', 'archived')
              and lower(p.client_address) like replace(replace(replace(v_street, '\', '\\'), '%', '\%'), '_', '\_') || '%'
              and (nullif(btrim(l.postcode), '') is null or position(btrim(l.postcode) in p.client_address) > 0)
              and (nullif(btrim(l.suburb), '') is null or position(lower(btrim(l.suburb)) in lower(p.client_address)) > 0)))
      order by p.created_at desc limit 1;
    if v_name is not null then v_reason := format('already has %s with us', v_name); end if;
  end if;

  -- enquired, asked for a call or emailed us before this lead, in the last v_days
  if v_reason is null then
    select to_char(o.created_at at time zone 'Australia/Sydney', 'DD Mon') into v_name from leads o
      where o.id <> l.id and o.created_at >= v_since and o.created_at < l.created_at
        and ((v_email is not null and lower(btrim(o.email)) = v_email)
          or (v_phone is not null and right(regexp_replace(coalesce(o.phone, ''), '\D', '', 'g'), 8) = v_phone))
      order by o.created_at desc limit 1;
    if v_name is not null then v_reason := format('enquired before, on %s', v_name); end if;
  end if;
  if v_reason is null then
    select to_char(r.created_at at time zone 'Australia/Sydney', 'DD Mon') into v_name from callback_requests r
      where r.created_at >= v_since and r.created_at < l.created_at
        and ((v_email is not null and lower(btrim(r.email)) = v_email)
          or (v_phone is not null and right(regexp_replace(coalesce(r.phone, ''), '\D', '', 'g'), 8) = v_phone))
      order by r.created_at desc limit 1;
    if v_name is not null then v_reason := format('asked for a call on %s', v_name); end if;
  end if;
  if v_reason is null and v_email is not null then
    select to_char(e.sent_at at time zone 'Australia/Sydney', 'DD Mon') into v_name from emails e
      where e.direction = 'inbound' and e.sent_at >= v_since and e.sent_at < l.created_at
        and position(v_email in lower(e.from_address)) > 0
      order by e.sent_at desc limit 1;
    if v_name is not null then v_reason := format('emailed us on %s', v_name); end if;
  end if;

  -- what the customer said: anyone but the link's owner means the business brought them in
  if v_reason is null and l.heard_from_profile_id is distinct from l.referrer_profile_id then
    if l.heard_from_profile_id is not null then
      select full_name into v_name from profiles where id = l.heard_from_profile_id;
      v_reason := format('they said %s told them about us', coalesce(v_name, 'someone else here'));
    else
      v_reason := format('they heard of us from: %s', coalesce(nullif(l.heard_from, ''), 'no answer'));
    end if;
  end if;

  update leads set already_client = (v_reason is not null), already_reason = left(v_reason, 200) where id = p_lead;
  return v_reason;
end;
$$;
revoke execute on function public.staff_lead_check(uuid) from public, anon, authenticated;

-- 3. The bonus -----------------------------------------------------------------------------------
create table if not exists public.staff_bonuses (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null default 'link' check (kind in ('link')),
  lead_id uuid references public.leads(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  quote_id uuid,
  quote_total numeric(12,2) not null,
  amount numeric(10,2) not null check (amount > 0),
  status text not null default 'earned' check (status in ('earned', 'due', 'paid', 'cancelled')),
  earned_at timestamptz not null default now(),
  due_at timestamptz,
  paid_at timestamptz,
  paid_reference text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancelled_reason text,
  created_at timestamptz not null default now()
);
create unique index if not exists staff_bonuses_one_per_job on public.staff_bonuses (project_id, kind);
create unique index if not exists staff_bonuses_one_per_lead on public.staff_bonuses (lead_id, kind) where status <> 'cancelled';
create index if not exists staff_bonuses_profile on public.staff_bonuses (profile_id, status);
create index if not exists staff_bonuses_lead on public.staff_bonuses (lead_id);

alter table public.staff_bonuses enable row level security;
revoke all on public.staff_bonuses from public, anon, authenticated;
grant select on public.staff_bonuses to authenticated;
drop policy if exists "Own bonuses, or Admin and Finance" on public.staff_bonuses;
create policy "Own bonuses, or Admin and Finance" on public.staff_bonuses
  for select to authenticated using (profile_id = (select auth.uid()) or (select is_finance_role()));

-- A bonus is owed: the person and the admins are told, the job's log says so. Server only.
create or replace function public.staff_bonus_set_due(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b staff_bonuses; v_job integer; v_name text; v_amount text; p record;
begin
  update staff_bonuses set status = 'due', due_at = now() where id = p_id and status = 'earned' returning * into b;
  if b.id is null then return; end if;
  v_amount := to_char(b.amount, 'FM999,999,990');
  select job_number into v_job from projects where id = b.project_id;
  select full_name into v_name from profiles where id = b.profile_id;
  insert into activity_log (entity_type, entity_id, action, description)
  values ('project', b.project_id, 'staff_bonus_due', format('Link bonus now owed: $%s to %s (the deposit is paid).', v_amount, v_name));
  perform create_notification(b.profile_id, 'lead', format('Link bonus owed to you: $%s', v_amount),
    format('The deposit on J%s is paid. It is on your balance: Home, My link.', v_job), '/home.html', null, 'staff-bonus-due:' || b.id);
  for p in select id from profiles where active and role = 'admin' loop
    perform create_notification(p.id, 'lead', format('Link bonus owed: %s, $%s', v_name, v_amount),
      format('J%s deposit paid. It is on their balance: Leads, Link bonuses.', v_job), '/leads.html', null, 'staff-bonus-due-admin:' || b.id);
  end loop;
end;
$$;
revoke execute on function public.staff_bonus_set_due(uuid) from public, anon, authenticated;

-- A quote from a staff link lead was approved: the link bonus is earned, its amount fixed now. Safe
-- to call twice. Nothing when the lead is Already ours, the quote is for someone other than the
-- lead's person (any logged-in user can point a quote at a lead, so the phone or email must match),
-- the person has left, or the job is under the minimum; the job's log says which. Owed straight away
-- when the deposit is already paid (a match cleared late). Called by the server
-- (create-job-from-quote.js) and by lead_clear_already_ours().
create or replace function public.staff_bonus_earn(p_job uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job projects; v_quote projects; v_lead leads; v_who profiles;
  v_total numeric; v_amount numeric; v_min numeric; v_id uuid; v_first text; v_same boolean; v_why text;
begin
  select * into v_job from projects where id = p_job;
  if not found or v_job.source_quote_id is null then return null; end if;
  select id into v_id from staff_bonuses where project_id = p_job and kind = 'link';
  if v_id is not null then return v_id; end if;
  select * into v_quote from projects where id = v_job.source_quote_id;
  if v_quote.lead_id is null then return null; end if;
  select * into v_lead from leads where id = v_quote.lead_id;
  if v_lead.id is null or v_lead.referrer_profile_id is null then return null; end if;
  select * into v_who from profiles where id = v_lead.referrer_profile_id;
  v_first := split_part(coalesce(v_who.full_name, 'a staff member'), ' ', 1);
  select staff_link_amount, lead_reward_min_job into v_amount, v_min from company_settings where id = 1;
  v_total := quote_client_total(v_quote.id);
  v_same := (nullif(lower(btrim(coalesce(v_lead.email, ''))), '') is not null and lower(btrim(v_quote.client_email)) = lower(btrim(v_lead.email)))
    or (length(regexp_replace(coalesce(v_lead.phone, ''), '\D', '', 'g')) >= 8
        and right(regexp_replace(coalesce(v_quote.client_phone, ''), '\D', '', 'g'), 8) = right(regexp_replace(v_lead.phone, '\D', '', 'g'), 8));

  v_why := case
    when v_lead.already_client then 'already ours (' || coalesce(v_lead.already_reason, 'matched') || ')'
    when not coalesce(v_same, false) then 'the quote''s phone and email are not the lead''s'
    when not coalesce(v_who.active, false) then 'they no longer work here'
    when coalesce(v_total, 0) < coalesce(v_min, 0) then format('the job is under $%s', to_char(v_min, 'FM999,999,990'))
    when coalesce(v_amount, 0) <= 0 then 'the link bonus is set to $0'
    when exists (select 1 from staff_bonuses where lead_id = v_lead.id and kind = 'link' and status <> 'cancelled') then 'one was already earned on this lead'
  end;
  if v_why is not null then
    if not exists (select 1 from activity_log where entity_type = 'project' and entity_id = p_job and action = 'staff_link_no_bonus') then
      insert into activity_log (entity_type, entity_id, action, description)
      values ('project', p_job, 'staff_link_no_bonus', format('Lead from %s''s link, no link bonus: %s.', v_first, v_why));
    end if;
    return null;
  end if;

  insert into staff_bonuses (profile_id, kind, lead_id, project_id, quote_id, quote_total, amount)
  values (v_who.id, 'link', v_lead.id, p_job, v_quote.id, v_total, v_amount)
  on conflict do nothing
  returning id into v_id;
  if v_id is not null then
    insert into activity_log (entity_type, entity_id, action, description)
    values ('project', p_job, 'staff_bonus_earned', format('Link bonus earned: $%s for %s (the lead came through their link). Owed once the deposit is paid.', to_char(v_amount, 'FM999,999,990'), v_first));
    perform create_notification(v_who.id, 'lead', format('Link bonus earned: $%s', to_char(v_amount, 'FM999,999,990')),
      format('J%s was won from your link. It is owed once the deposit is paid.', v_job.job_number), '/home.html', null, 'staff-bonus-earned:' || v_id);
    if exists (select 1 from invoices i where i.project_id = p_job and i.paid_at is not null
               and (i.is_deposit or not exists (select 1 from invoices d where d.project_id = p_job and d.is_deposit))) then
      perform staff_bonus_set_due(v_id);
    end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.staff_bonus_earn(uuid) from public, anon, authenticated;

-- The job's deposit invoice was paid (or its first invoice, when it has no deposit): the bonus is owed.
create or replace function public.staff_bonus_due_on_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_id uuid;
begin
  if new.paid_at is null or (tg_op = 'UPDATE' and old.paid_at is not null) or new.project_id is null then return new; end if;
  select id into v_id from staff_bonuses where project_id = new.project_id and kind = 'link' and status = 'earned';
  if v_id is null then return new; end if;
  if not new.is_deposit and exists (select 1 from invoices i where i.project_id = new.project_id and i.is_deposit and i.id <> new.id) then return new; end if;
  perform staff_bonus_set_due(v_id);
  return new;
exception when others then
  -- never stop an invoice being marked paid
  raise warning 'staff_bonus_due_on_paid: %', sqlerrm;
  return new;
end;
$$;
revoke execute on function public.staff_bonus_due_on_paid() from public, anon, authenticated;
drop trigger if exists invoices_staff_bonus_due on public.invoices;
create trigger invoices_staff_bonus_due
  after insert or update of paid_at on public.invoices
  for each row execute function public.staff_bonus_due_on_paid();

-- Cancel a bonus that has not been paid, with a reason. Admin only.
create or replace function public.staff_bonus_cancel(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare b staff_bonuses; v_why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if not is_admin() then raise exception 'Only an admin can cancel a link bonus.'; end if;
  select * into b from staff_bonuses where id = p_id for update;
  if not found then raise exception 'Bonus not found.'; end if;
  if b.status in ('paid', 'cancelled') then raise exception 'This bonus is already %.', b.status; end if;
  if v_why is null then raise exception 'Say why it is cancelled.'; end if;
  update staff_bonuses set status = 'cancelled', cancelled_reason = left(v_why, 300), cancelled_by = auth.uid(), cancelled_at = now() where id = p_id;
  if b.project_id is not null then
    insert into activity_log (entity_type, entity_id, action, description, changed_by)
    values ('project', b.project_id, 'staff_bonus_cancelled', format('Link bonus $%s cancelled: %s', to_char(b.amount, 'FM999,999,990'), v_why), auth.uid());
  end if;
  perform create_notification(b.profile_id, 'lead', format('Link bonus cancelled: $%s', to_char(b.amount, 'FM999,999,990')), left(v_why, 200), '/home.html', auth.uid(), 'staff-bonus-cancelled:' || b.id);
end;
$$;
revoke execute on function public.staff_bonus_cancel(uuid, text) from public, anon;
grant execute on function public.staff_bonus_cancel(uuid, text) to authenticated;

-- A wrong Already ours, cleared by an admin with a reason. A job already won from the lead earns its
-- bonus now.
create or replace function public.lead_clear_already_ours(p_lead uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare l leads; v_why text := nullif(btrim(coalesce(p_reason, '')), ''); j record;
begin
  if not is_admin() then raise exception 'Only an admin can clear this.'; end if;
  select * into l from leads where id = p_lead for update;
  if not found then raise exception 'Lead not found.'; end if;
  if l.referrer_profile_id is null then raise exception 'This lead did not come through a staff link.'; end if;
  if not l.already_client then return; end if;
  if v_why is null then raise exception 'Say why it is not already ours.'; end if;
  update leads set already_client = false, already_reason = left('cleared: ' || v_why, 200) where id = p_lead;
  for j in select jb.id from projects q join projects jb on jb.source_quote_id = q.id where q.lead_id = p_lead loop
    perform staff_bonus_earn(j.id);
  end loop;
end;
$$;
revoke execute on function public.lead_clear_already_ours(uuid, text) from public, anon;
grant execute on function public.lead_clear_already_ours(uuid, text) to authenticated;

-- 4. KPIs ----------------------------------------------------------------------------------------
-- Leads from a person's link in a period (Sydney dates, either end open): sent, became a quote or a
-- job, won, and what the won quotes come to. Already ours leads count. Their own, or Admin and Finance.
create or replace function public.staff_lead_stats(p_profile uuid, p_from date default null, p_to date default null)
returns table (sent integer, quoted integer, won integer, won_value numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if (select auth.uid()) is distinct from p_profile and not is_finance_role() then raise exception 'Not allowed'; end if;
  return query
  with mine as (
    select l.id from leads l
    where l.referrer_profile_id = p_profile
      and (p_from is null or (l.created_at at time zone 'Australia/Sydney')::date >= p_from)
      and (p_to is null or (l.created_at at time zone 'Australia/Sydney')::date <= p_to)
  ), per as (
    select m.id,
      exists (select 1 from projects p where p.lead_id = m.id) as is_quoted,
      exists (select 1 from projects p where p.lead_id = m.id and (p.job_number is not null or exists (select 1 from projects j where j.source_quote_id = p.id))) as is_won,
      coalesce((select sum(quote_client_total(p.id)) from projects p where p.lead_id = m.id and exists (select 1 from projects j where j.source_quote_id = p.id)), 0) as val
    from mine m
  )
  select count(*)::integer, count(*) filter (where per.is_quoted)::integer, count(*) filter (where per.is_won)::integer, coalesce(sum(per.val), 0)::numeric from per;
end;
$$;
revoke execute on function public.staff_lead_stats(uuid, date, date) from public, anon;
grant execute on function public.staff_lead_stats(uuid, date, date) to authenticated;

-- 5. The policy every staff member signs (Settings > Onboarding Documents; signed at next login).
-- It covers what is live: the link and the link bonus. The amounts are the settings on the day; when
-- one changes, edit the document there and Publish new version so everyone signs again.
insert into public.onboarding_documents (title, body, is_required, is_contract, sort_order)
select 'Thomson Energy Lead Bonus Scheme (Staff)', $doc$Thomson Energy Lead Bonus Scheme (Staff)

Purpose
Thomson Energy pays a bonus to employees who bring in new work. This document explains what counts, what does not, how much it pays and how it is paid.

The short version
* You bring in a new customer yourself through your personal link (someone you know, someone you meet, someone walking past a job who you talk into a quote): $50 when we win a job of $3,000 or more.
* The customer found Thomson Energy themselves (Google, the website, a call to 0455 415 464, an email to sales@thomsonenergy.com.au, an ad, a sign on a ute), or is already a customer: nobody gets a bonus. That is the business's own work. It still counts on your KPIs if it came through your link.

1. Your link
* Every employee has a personal link in TEops (Home, My link). It opens a short form on any phone with no login.
* Give it to people you know or meet who are not already dealing with Thomson Energy and who ask about solar, a battery, a switchboard, a fault or any electrical work: family, a mate, a neighbour, someone at footy or the pub, or a passer-by who stops at a job and asks what we do. They fill it in themselves, or you fill it in with them.
* Every lead from your link shows your name in TEops on the lead and on the job, so the office always knows who brought the customer in.
* You can also send your link to an existing Thomson Energy customer, or to someone who has already contacted us, for example someone who rings 0455 415 464 and you answer. It is a quick way to get their details in, and it counts on your KPIs as your lead. It pays no bonus, because the customer came to the business, not through you.
* The form asks the customer how they first heard about Thomson Energy. Let them answer for themselves.

2. The link bonus
* $50 for every job we win from a new customer who came through your link, earned the day the customer approves the quote and payable once they have paid their deposit (or their first invoice, when the job has no deposit).
* Nothing is earned for a quote that is declined or expires, for a job that falls over before the deposit is paid, or for a job under $3,000 (the total the customer pays, including GST, after any solar or battery rebates).
* One bonus per job. You can refer your own family.
* No bonus, for anyone, when the customer came to Thomson Energy by themselves or through the business. That means:
  - they found us on Google, the website, social media, an ad, a directory, a vehicle or a sign;
  - they called 0455 415 464 or emailed sales@thomsonenergy.com.au (or any Thomson Energy number or address) before your lead arrived;
  - they are already a Thomson Energy customer, or already have an enquiry, a quote or a job with us;
  - they are the customer of the job you are on, or someone at that site;
  - they tell us on the form that they heard about us some other way, or from a different staff member.
* TEops checks every link lead against the customers, enquiries, emails and jobs we already have, and against the customer's own answer. A match is marked Already ours and pays no bonus. If you think a match is wrong, tell the owner and he will look at it.

3. How it is paid
* A bonus that is payable is added to your balance in TEops (Home, My link). The balance adds up and stays owed to you until it is paid.
* It is paid through payroll. It is taxed like any other pay, and superannuation applies as the law requires.
* TEops (Home, My link) shows the leads from your link, every bonus earned and whether it has been paid.

4. The rules
* Never promise a customer a price, a date or a rebate to get a lead. Say Thomson Energy will contact them.
* Never tell a customer what to answer on the form, never tell a customer who has already contacted Thomson Energy to say they came from you, and never pass one off as your own. A lead entered under someone else's name, or a referral of work that was already coming to Thomson Energy, is not paid and may be treated as misconduct under the Code of Conduct.
* The owner can cancel a bonus that was recorded by mistake, and will tell you why.
* This scheme is discretionary. It is not a term of your employment contract and it sits on top of your award and contract entitlements. Thomson Energy can change the amounts, change the rules or withdraw the scheme at any time, without notice, for any lead or job not yet won. A bonus already earned is still paid, at the amount that applied on the day it was earned.
* Thomson Energy pays bonuses to its own employees only. Your link stops working the day you leave.

5. Signing
* Signing means you have read this document and understand what earns a bonus and what does not. A signed copy is saved in TEops under Settings, My Profile.
* When an amount or a rule changes, TEops shows you the new version to sign at your next login.$doc$, true, false, 5
where not exists (select 1 from public.onboarding_documents where title = 'Thomson Energy Lead Bonus Scheme (Staff)');
