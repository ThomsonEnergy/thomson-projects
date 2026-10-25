-- Quotes and fixed-price variations expire. Each gets a valid_until date when it is sent
-- (sent date + company_settings.quote_valid_days, default 30). sweep-quote-expiry.js runs
-- just after midnight Sydney: a reminder 3 days before, and anything still sent past its
-- date is declined as expired (unless auto decline is off company wide or on that one).
-- Sales, Admin and Finance can extend the date (approval-actions.js), even after expiry.

alter table public.company_settings
  add column if not exists quote_valid_days integer not null default 30,
  add column if not exists auto_decline_expired boolean not null default true;

alter table public.projects
  add column if not exists valid_until date,
  add column if not exists no_auto_decline boolean not null default false,
  add column if not exists expired boolean not null default false;

alter table public.job_variation_entries
  add column if not exists valid_until date,
  add column if not exists no_auto_decline boolean not null default false,
  add column if not exists expired boolean not null default false;

create or replace function public.sydney_today() returns date
language sql stable set search_path to 'public'
as $$ select (now() at time zone 'Australia/Sydney')::date $$;

create or replace function public.quote_valid_days() returns integer
language sql stable security definer set search_path to 'public'
as $$ select coalesce((select quote_valid_days from company_settings where id = 1), 30) $$;

-- A quote is "sent" once it moves to Quote Sent (emailed from the app, or moved on the
-- pipeline). Its status follows, and it gets a valid until date if it has none (or an old one).
create or replace function public.quote_sent_valid_until() returns trigger
language plpgsql set search_path to 'public'
as $$
begin
  if new.job_number is null and new.pipeline_stage = 'quote_sent'
     and (tg_op = 'INSERT' or old.pipeline_stage is distinct from 'quote_sent') then
    if new.status = 'draft' then new.status := 'sent'; end if;
    if new.valid_until is null or new.valid_until < sydney_today() then
      new.valid_until := sydney_today() + quote_valid_days();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists quote_sent_valid_until on public.projects;
create trigger quote_sent_valid_until before insert or update of pipeline_stage on public.projects
  for each row execute function public.quote_sent_valid_until();

create or replace function public.variation_sent_valid_until() returns trigger
language plpgsql set search_path to 'public'
as $$
begin
  if new.variation_type = 'fixed' and new.approval_status = 'sent'
     and (tg_op = 'INSERT' or old.approval_status is distinct from 'sent')
     and (new.valid_until is null or new.valid_until < sydney_today()) then
    new.valid_until := sydney_today() + quote_valid_days();
  end if;
  return new;
end $$;

drop trigger if exists variation_sent_valid_until on public.job_variation_entries;
create trigger variation_sent_valid_until before insert or update of approval_status on public.job_variation_entries
  for each row execute function public.variation_sent_valid_until();

-- What is already out with clients gets today + the valid days, so nothing expires the first night.
update public.projects set status = 'sent'
  where job_number is null and status = 'draft' and pipeline_stage = 'quote_sent';
update public.projects set valid_until = sydney_today() + quote_valid_days()
  where job_number is null and status = 'sent' and valid_until is null;
update public.job_variation_entries set valid_until = sydney_today() + quote_valid_days()
  where variation_type = 'fixed' and approval_status = 'sent' and valid_until is null;

-- The variation page shows its valid until date and whether it expired.
create or replace function public.get_variation_by_token(p_token uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  ve job_variation_entries%rowtype;
  p projects%rowtype;
  src_token text;
begin
  select * into ve from job_variation_entries
  where variation_token = p_token and variation_type = 'fixed' and coalesce(approval_status, 'draft') in ('draft', 'sent', 'approved', 'declined');
  if not found then
    return null;
  end if;
  select * into p from projects where id = ve.project_id;
  select coalesce((select s.quote_token from projects s where s.id = p.source_quote_id), p.quote_token) into src_token;

  return jsonb_build_object(
    'variation', jsonb_build_object(
      'id', ve.id, 'number', ve.variation_number, 'description', ve.description, 'reason', ve.reason,
      'lines', ve.fixed_lines, 'approval_status', ve.approval_status, 'sent_at', ve.sent_at,
      'approved_at', ve.approved_at, 'signed_by_name', ve.signed_by_name,
      'signature_data_url', case when ve.approval_status = 'approved' then ve.signature_data_url else null end,
      'approval_method', ve.approval_method, 'approval_note', ve.approval_note,
      'declined_at', ve.declined_at, 'decline_reason', ve.decline_reason,
      'valid_until', ve.valid_until, 'expired', ve.expired,
      'job_number', p.job_number, 'job_name', p.name, 'client_name', p.client_name
    ),
    'quote', get_quote_by_token(src_token)::jsonb,
    'other_variations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'number', o.variation_number, 'description', o.description, 'reason', o.reason,
        'lines', o.fixed_lines, 'approved_at', o.approved_at
      ) order by o.variation_number), '[]'::jsonb)
      from job_variation_entries o
      where o.project_id = ve.project_id and o.variation_type = 'fixed' and o.approval_status = 'approved' and o.id <> ve.id
    )
  );
end;
$function$;
