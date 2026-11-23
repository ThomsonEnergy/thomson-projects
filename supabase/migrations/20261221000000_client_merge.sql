-- Merge two clients into one, a duplicate scan and the background ABN search (backlog item 110,
-- owner 24 Nov 2026).
--
--  * client_merge(p_into, p_from): Admin only, all or nothing, one client at a time. Every row
--    naming the old client is re-pointed to the kept one (jobs, quotes, invoices and their bill-to,
--    sites, contacts, equipment, email threads, leads referred, lead rewards, portal events, the
--    activity log). A site with the same address becomes the kept client's site and a
--    contact with the same email becomes the kept client's contact (jobs follow both). Open jobs and
--    quotes with no invoice take the kept client's name; anything invoiced keeps the name it was
--    invoiced under. The kept client's own details win; blanks are filled from the old one, notes
--    are joined, and the old client's email becomes a contact with a portal login.
--  * The old client row is then removed and client_merges keeps the record: the whole old row, what
--    moved, who and when, and the old statement link, referral link and ServiceM8 id, which keep
--    working by following client_merges (client_now, get_client_statement_by_token, and
--    _shared/referrals.js and _shared/sm8-import.js in the app). No undo button: the record is enough
--    to unwind one by hand.
--  * client_merge_preview(p_into, p_from): the counts and the differences the confirm screen shows.
--  * Refused: the same client twice, a client that no longer exists, and an old client holding a
--    lead reward whose Xero credit note is not yet on an invoice (it is in Xero under the old contact).
--  * New work that still names the old client (a page left open before the merge) lands on the kept
--    client (trigger _follow_merged_client on projects and invoices).
--  * client_merge_suggestions: pairs the duplicate scan thinks are one customer, with which to keep
--    and why; "Not the same" is remembered. client_abn_suggestions: what the background ABN search
--    found for a client, waiting for a person to apply. Both written by the server only.
-- No existing row is changed by this migration.

-- ---------------------------------------------------------------- the record of every merge
create table if not exists public.client_merges (
  id uuid primary key default gen_random_uuid(),
  into_client_id uuid not null references public.clients(id) on delete cascade,
  from_client_id uuid not null,                 -- the old client's id (the row is gone: no foreign key)
  from_name text,
  from_row jsonb not null default '{}'::jsonb,  -- the old client as it was
  from_statement_token uuid,
  from_referral_token text,
  from_sm8_company_uuid text,
  moved jsonb not null default '{}'::jsonb,
  merged_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists client_merges_into_client on public.client_merges (into_client_id);
create unique index if not exists client_merges_from_client on public.client_merges (from_client_id);
create index if not exists client_merges_from_statement_token on public.client_merges (from_statement_token) where from_statement_token is not null;
create index if not exists client_merges_from_referral_token on public.client_merges (from_referral_token) where from_referral_token is not null;
create index if not exists client_merges_merged_by on public.client_merges (merged_by);

alter table public.client_merges enable row level security;
revoke all on public.client_merges from public, anon, authenticated;
grant select on public.client_merges to authenticated;

drop policy if exists "Pricing roles read client merges" on public.client_merges;
create policy "Pricing roles read client merges" on public.client_merges
  for select to authenticated using ((select is_pricing_role()));

-- ---------------------------------------------------------------- what the two scans found
create table if not exists public.client_merge_suggestions (
  id uuid primary key default gen_random_uuid(),
  client_a uuid not null references public.clients(id) on delete cascade,
  client_b uuid not null references public.clients(id) on delete cascade,
  why_paired text,                              -- the rule that put them together (same email, same ABN...)
  verdict text not null default 'unsure' check (verdict in ('same', 'apart', 'unsure')),
  keep_client_id uuid references public.clients(id) on delete set null,
  reason text,
  confidence numeric not null default 0 check (confidence between 0 and 1),
  status text not null default 'open' check (status in ('open', 'dismissed')),
  scanned_at timestamptz not null default now(),
  dismissed_by uuid references public.profiles(id) on delete set null,
  check (client_a < client_b),
  unique (client_a, client_b)
);
create index if not exists client_merge_suggestions_b on public.client_merge_suggestions (client_b);
create index if not exists client_merge_suggestions_keep on public.client_merge_suggestions (keep_client_id);
create index if not exists client_merge_suggestions_dismissed_by on public.client_merge_suggestions (dismissed_by);

alter table public.client_merge_suggestions enable row level security;
revoke all on public.client_merge_suggestions from public, anon, authenticated;
grant select on public.client_merge_suggestions to authenticated;

drop policy if exists "Admin reads client merge suggestions" on public.client_merge_suggestions;
create policy "Admin reads client merge suggestions" on public.client_merge_suggestions
  for select to authenticated using ((select is_admin()));

create table if not exists public.client_abn_suggestions (
  client_id uuid primary key references public.clients(id) on delete cascade,
  searched_name text not null,
  results jsonb not null default '[]'::jsonb,   -- the register's matches, best first
  exact boolean not null default false,          -- one active ABN whose name matches exactly: shown green
  status text not null default 'open' check (status in ('open', 'applied', 'none')),
  searched_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete set null
);
create index if not exists client_abn_suggestions_decided_by on public.client_abn_suggestions (decided_by);

alter table public.client_abn_suggestions enable row level security;
revoke all on public.client_abn_suggestions from public, anon, authenticated;
grant select on public.client_abn_suggestions to authenticated;

drop policy if exists "Pricing roles read client ABN suggestions" on public.client_abn_suggestions;
create policy "Pricing roles read client ABN suggestions" on public.client_abn_suggestions
  for select to authenticated using ((select is_pricing_role()));

-- ---------------------------------------------------------------- following an old client id
-- The client an id means today: itself, or the client it was merged into (and on, if that one was
-- merged later).
create or replace function public.client_now(p_client_id uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid := p_client_id;
  v_next uuid;
  i integer := 0;
begin
  while v_id is not null and i < 10 loop
    select into_client_id into v_next from client_merges where from_client_id = v_id;
    exit when v_next is null;
    v_id := v_next;
    i := i + 1;
  end loop;
  return v_id;
end;
$$;
revoke execute on function public.client_now(uuid) from public, anon;
grant execute on function public.client_now(uuid) to authenticated;

-- New work naming a merged client lands on the client it was merged into.
create or replace function public._follow_merged_client()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_id is not null and exists (select 1 from client_merges where from_client_id = new.client_id) then
    new.client_id := client_now(new.client_id);
  end if;
  return new;
end;
$$;
revoke execute on function public._follow_merged_client() from public, anon, authenticated;

drop trigger if exists trg_projects_follow_merged_client on public.projects;
create trigger trg_projects_follow_merged_client before insert on public.projects
  for each row execute function public._follow_merged_client();
drop trigger if exists trg_invoices_follow_merged_client on public.invoices;
create trigger trg_invoices_follow_merged_client before insert on public.invoices
  for each row execute function public._follow_merged_client();

-- ---------------------------------------------------------------- the preview
create or replace function public._client_counts(p_client_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'jobs', (select count(*) from projects where client_id = p_client_id and job_number is not null),
    'quotes', (select count(*) from projects where client_id = p_client_id and job_number is null),
    'invoices', (select count(*) from invoices i left join cost_centres cc on cc.id = i.cost_centre_id left join projects p on p.id = coalesce(i.project_id, cc.project_id)
                 where coalesce(i.bill_to_client_id, i.client_id, p.client_id) = p_client_id),
    'unpaid_invoices', (select count(*) from invoices i left join cost_centres cc on cc.id = i.cost_centre_id left join projects p on p.id = coalesce(i.project_id, cc.project_id)
                 where coalesce(i.bill_to_client_id, i.client_id, p.client_id) = p_client_id and i.paid_at is null),
    'sites', (select count(*) from client_sites where client_id = p_client_id),
    'contacts', (select count(*) from client_contacts where client_id = p_client_id),
    'equipment', (select count(*) from customer_assets where client_id = p_client_id),
    'emails', (select count(*) from email_threads where client_id = p_client_id),
    'leads_referred', (select count(*) from leads where referrer_client_id = p_client_id),
    'lead_rewards', (select count(*) from lead_rewards where referrer_client_id = p_client_id),
    'last_job', (select max(created_at) from projects where client_id = p_client_id)
  );
$$;
revoke execute on function public._client_counts(uuid) from public, anon, authenticated;

create or replace function public.client_merge_preview(p_into uuid, p_from uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  a clients; b clients;
  one_client jsonb;
begin
  if not is_admin() then raise exception 'Only Admin can merge clients.'; end if;
  select * into a from clients where id = p_into;
  select * into b from clients where id = p_from;
  if a.id is null or b.id is null then raise exception 'One of those clients no longer exists.'; end if;
  return jsonb_build_object(
    'keep', jsonb_build_object('id', a.id, 'name', a.name, 'email', a.email, 'phone', a.phone, 'address', a.address, 'abn', a.abn, 'client_type', a.client_type,
      'payment_terms', a.payment_terms, 'rate_card', (select name from rate_cards where id = a.rate_card_id),
      'agreement', a.agreement_sent_at is not null and a.agreement_withdrawn_at is null, 'lead_reward_kind', a.lead_reward_kind, 'counts', _client_counts(a.id)),
    'old', jsonb_build_object('id', b.id, 'name', b.name, 'email', b.email, 'phone', b.phone, 'address', b.address, 'abn', b.abn, 'client_type', b.client_type,
      'payment_terms', b.payment_terms, 'rate_card', (select name from rate_cards where id = b.rate_card_id),
      'agreement', b.agreement_sent_at is not null and b.agreement_withdrawn_at is null, 'lead_reward_kind', b.lead_reward_kind, 'counts', _client_counts(b.id)),
    'renamed', (select count(*) from projects p where p.client_id = b.id and p.client_name is distinct from a.name
                and not exists (select 1 from invoices i where i.project_id = p.id)),
    'blocked', (select count(*) from lead_rewards where referrer_client_id = b.id and xero_credit_note_id is not null and applied_invoice_id is null and status <> 'cancelled')
  );
end;
$$;
revoke execute on function public.client_merge_preview(uuid, uuid) from public, anon;
grant execute on function public.client_merge_preview(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- the merge
create or replace function public.client_merge(p_into uuid, p_from uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a clients; b clients;
  v_counts jsonb;
  v_renamed integer;
  v_sites_joined integer := 0;
  v_contacts_joined integer := 0;
  v_id uuid;
  r record;
  norm_email text;
begin
  if not is_admin() then raise exception 'Only Admin can merge clients.'; end if;
  if p_into is null or p_from is null or p_into = p_from then raise exception 'Pick two different clients.'; end if;
  -- always locked in the same order, so two merges at once cannot wait on each other
  perform 1 from clients where id in (p_into, p_from) order by id for update;
  select * into a from clients where id = p_into;
  select * into b from clients where id = p_from;
  if a.id is null or b.id is null then raise exception 'One of those clients no longer exists.'; end if;
  if exists (select 1 from lead_rewards where referrer_client_id = b.id and xero_credit_note_id is not null and applied_invoice_id is null and status <> 'cancelled') then
    raise exception '% has a lead reward credit in Xero that is not on an invoice yet. Let it land on an invoice, or cancel it, then merge.', b.name;
  end if;
  v_counts := _client_counts(b.id);

  -- open jobs and quotes with no invoice take the kept client's name; invoiced ones keep theirs
  update projects p set client_name = a.name
  where p.client_id = b.id and p.client_name is distinct from a.name
    and not exists (select 1 from invoices i where i.project_id = p.id);
  get diagnostics v_renamed = row_count;

  -- sites: the same address is one site
  for r in select s.id, s.address from client_sites s where s.client_id = b.id loop
    select id into v_id from client_sites where client_id = a.id and lower(btrim(address)) = lower(btrim(r.address)) limit 1;
    if v_id is not null then
      update projects set client_site_id = v_id where client_site_id = r.id;
      delete from client_sites where id = r.id;
      v_sites_joined := v_sites_joined + 1;
    else
      update client_sites set client_id = a.id where id = r.id;
    end if;
  end loop;

  -- contacts: the same email is one contact (a portal login either had is kept)
  for r in select c.id, c.email, c.portal_access from client_contacts c where c.client_id = b.id loop
    norm_email := lower(btrim(coalesce(r.email, '')));
    v_id := null;
    if norm_email <> '' then
      select id into v_id from client_contacts where client_id = a.id and lower(btrim(coalesce(email, ''))) = norm_email order by sort_order limit 1;
    end if;
    if v_id is not null then
      update projects set project_manager_contact_id = v_id where project_manager_contact_id = r.id;
      update projects set site_contact_id = v_id where site_contact_id = r.id;
      update projects set job_contact_id = v_id where job_contact_id = r.id;
      update projects set sales_contact_id = v_id where sales_contact_id = r.id;
      update projects set accounts_contact_id = v_id where accounts_contact_id = r.id;
      update job_contacts set client_contact_id = v_id where client_contact_id = r.id;
      if r.portal_access then update client_contacts set portal_access = true where id = v_id; end if;
      delete from client_contacts where id = r.id;
      v_contacts_joined := v_contacts_joined + 1;
    else
      update client_contacts set client_id = a.id where id = r.id;
    end if;
  end loop;

  -- the old client's own email stays a way in: a contact with a portal login, unless it is already there
  norm_email := lower(btrim(coalesce(b.email, '')));
  if norm_email <> '' and norm_email <> lower(btrim(coalesce(a.email, '')))
     and not exists (select 1 from client_contacts where client_id = a.id and lower(btrim(coalesce(email, ''))) = norm_email) then
    insert into client_contacts (client_id, contact_type, name, phone, email, portal_access, sort_order)
    values (a.id, 'job', b.name, b.phone, btrim(b.email), b.portal_off_at is null,
      coalesce((select max(sort_order) + 1 from client_contacts where client_id = a.id), 0));
  end if;

  -- everything else that names the old client
  update projects set client_id = a.id where client_id = b.id;
  update projects set referrer_client_id = a.id where referrer_client_id = b.id;
  update invoices set client_id = a.id where client_id = b.id;
  update invoices set bill_to_client_id = a.id where bill_to_client_id = b.id;
  update customer_assets set client_id = a.id where client_id = b.id;
  update asset_reminder_log set client_id = a.id where client_id = b.id;
  update email_threads set client_id = a.id where client_id = b.id;
  update leads set referrer_client_id = a.id where referrer_client_id = b.id;
  update lead_rewards set referrer_client_id = a.id where referrer_client_id = b.id;
  update portal_events set client_id = a.id where client_id = b.id;
  update activity_log set entity_id = a.id where entity_type = 'client' and entity_id = b.id;
  update client_merges set into_client_id = a.id where into_client_id = b.id;

  insert into client_merges (into_client_id, from_client_id, from_name, from_row, from_statement_token, from_referral_token, from_sm8_company_uuid, moved, merged_by)
  values (a.id, b.id, b.name, to_jsonb(b), b.statement_token, b.referral_token, b.sm8_company_uuid,
    v_counts || jsonb_build_object('renamed', v_renamed, 'sites_joined', v_sites_joined, 'contacts_joined', v_contacts_joined), auth.uid());

  -- the old row goes (its ServiceM8 id is free for the kept client to take), then the kept client's blanks are filled
  delete from clients where id = b.id;
  update clients set
    email = coalesce(nullif(btrim(email), ''), b.email),
    phone = coalesce(nullif(btrim(phone), ''), b.phone),
    abn = coalesce(nullif(btrim(abn), ''), b.abn),
    xero_contact_id = coalesce(xero_contact_id, b.xero_contact_id),
    sm8_company_uuid = coalesce(sm8_company_uuid, b.sm8_company_uuid),
    address = coalesce(nullif(btrim(address), ''), b.address),
    address_parts = case when nullif(btrim(coalesce(address, '')), '') is null then b.address_parts else address_parts end,
    lat = case when nullif(btrim(coalesce(address, '')), '') is null then b.lat else lat end,
    lng = case when nullif(btrim(coalesce(address, '')), '') is null then b.lng else lng end,
    notes = nullif(concat_ws(E'\n\n', nullif(btrim(coalesce(notes, '')), ''),
      case when nullif(btrim(coalesce(b.notes, '')), '') is not null then format('From %s (merged %s): %s', b.name, to_char(sydney_today(), 'DD Mon YYYY'), btrim(b.notes)) end), '')
  where id = a.id;

  insert into activity_log (entity_type, entity_id, action, description, changed_by)
  values ('client', a.id, 'client_merged', format('%s merged into this client: %s jobs, %s quotes, %s invoices, %s sites, %s contacts, %s equipment%s',
    b.name, v_counts->>'jobs', v_counts->>'quotes', v_counts->>'invoices', v_counts->>'sites', v_counts->>'contacts', v_counts->>'equipment',
    case when v_renamed > 0 then format('. %s open jobs and quotes now carry this client''s name', v_renamed) else '' end), auth.uid());

  return jsonb_build_object('into_client_id', a.id, 'merged', b.name, 'moved', v_counts, 'renamed', v_renamed);
end;
$$;
revoke execute on function public.client_merge(uuid, uuid) from public, anon;
grant execute on function public.client_merge(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- the client's statement link
-- get_client_statement_by_token as in 20261217000000, except that a merged client's old link opens
-- the statement of the client it was merged into.
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
    select c.* into v_client from client_merges m join clients c on c.id = client_now(m.from_client_id) where m.from_statement_token = p_token limit 1;
    if not found then
      return null;
    end if;
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
