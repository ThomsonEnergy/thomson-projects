-- Backlog item 39 (30 Oct 2026): every new website lead and call request notifies Admin, Finance
-- and Sales (kind 'lead', bell channel, pushed to the phone by send-notifications). Each person can
-- turn it off with the "New leads and call requests" tick box. The 7am nudge for leads still
-- waiting is remind-leads.js. Triggers only: no table or policy changes.

create or replace function public.trg_notify_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_who text; v_where text;
begin
  if coalesce(new.status, 'new') <> 'new' then return new; end if;
  if coalesce(new.email, '') = '' and coalesce(new.phone, '') = '' then return new; end if; -- no way to reach them
  v_who := coalesce(nullif(trim(new.name), ''), nullif(trim(new.ai_title), ''), new.email, new.phone);
  v_where := coalesce(nullif(trim(new.suburb), ''), '');
  for r in select id from profiles where active and role in ('admin', 'finance', 'sales') loop
    perform create_notification(r.id, 'lead',
      'New lead: ' || v_who || case when v_where <> '' then ', ' || v_where else '' end,
      coalesce('From ' || nullif(new.source, ''), 'New lead') || case when new.needs_site_visit then '. Needs a site visit.' else '.' end,
      '/leads.html?id=' || new.id, (select auth.uid()), 'lead:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
revoke execute on function public.trg_notify_lead() from public, anon, authenticated;
grant execute on function public.trg_notify_lead() to service_role;

create or replace function public.trg_notify_callback_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r record; v_who text;
begin
  if new.status not in ('pending', 'scheduled') then return new; end if;
  v_who := coalesce(nullif(trim(new.name), ''), new.phone);
  for r in select id from profiles where active and role in ('admin', 'finance', 'sales') loop
    perform create_notification(r.id, 'lead',
      'Call request: ' || v_who || ', ' || to_char(new.requested_date, 'Dy FMDD Mon') || ' ' || lower(to_char(new.requested_time, 'FMHH12:MIam')),
      coalesce(nullif(left(trim(new.message), 200), ''), 'Call ' || new.phone),
      '/leads.html', (select auth.uid()), 'callback:' || new.id);
  end loop;
  return new;
exception when others then
  raise warning 'notification trigger % failed: %', tg_name, sqlerrm;
  return new;
end $$;
revoke execute on function public.trg_notify_callback_request() from public, anon, authenticated;
grant execute on function public.trg_notify_callback_request() to service_role;

drop trigger if exists notify_lead on public.leads;
create trigger notify_lead after insert on public.leads for each row execute function public.trg_notify_lead();

drop trigger if exists notify_callback_request on public.callback_requests;
create trigger notify_callback_request after insert on public.callback_requests for each row execute function public.trg_notify_callback_request();
