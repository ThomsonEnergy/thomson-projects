-- Field staff report incidents and near misses from My Day (UX review item 5).
-- One function does the whole write; staff still cannot read incident rows or files
-- (the admin/finance select policies on incident_* and staff-files are untouched).

create or replace function public.report_incident(
  p_id uuid,
  p_nature text,
  p_title text,
  p_location text default null,
  p_project_id uuid default null,
  p_date date default null,
  p_time time without time zone default null,
  p_injured boolean default false,
  p_photos jsonb default '[]'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me record;
  co text;
  job_no bigint;
  ph jsonb;
  r record;
  n bigint;
  nature_label text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select id, full_name, job_title, mobile_number into me from profiles where id = auth.uid() and active;
  if me.id is null then raise exception 'Only active staff can report an incident'; end if;
  if p_id is null then raise exception 'Missing incident id'; end if;
  if p_nature not in ('near_miss', 'first_aid', 'medical_treatment', 'lost_time', 'dangerous_incident', 'property_damage') then
    raise exception 'Unknown incident type';
  end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Say what happened'; end if;
  if p_project_id is not null then
    select job_number into job_no from projects where id = p_project_id;
    if not found then raise exception 'Job not found'; end if;
  end if;
  if jsonb_typeof(p_photos) <> 'array' then raise exception 'Photos must be a list'; end if;
  for ph in select * from jsonb_array_elements(p_photos) loop
    if coalesce(ph->>'path', '') not like 'incidents/' || p_id::text || '/%' then
      raise exception 'Photo path does not belong to this incident';
    end if;
  end loop;

  select company_name into co from company_settings where id = 1;
  nature_label := case p_nature
    when 'near_miss' then 'near miss' when 'first_aid' then 'first aid injury'
    when 'medical_treatment' then 'medical treatment injury' when 'lost_time' then 'lost time injury'
    when 'dangerous_incident' then 'dangerous incident' else 'property or plant damage' end;

  insert into incident_reports (
    id, nature, incident_date, incident_time, title, description, project_id, site_location,
    injured_profile_id, injured_name, injured_occupation, injured_phone, injured_employer,
    completed_by_name, completed_by_position, completed_date, created_by, status
  ) values (
    p_id, p_nature, coalesce(p_date, sydney_today()), p_time, left(trim(p_title), 200), trim(p_title),
    p_project_id, nullif(trim(coalesce(p_location, '')), ''),
    case when p_injured then me.id end, case when p_injured then me.full_name end,
    case when p_injured then me.job_title end, case when p_injured then me.mobile_number end,
    case when p_injured then co end,
    me.full_name, me.job_title, sydney_today(), me.id, 'open'
  ) returning incident_number into n;

  insert into incident_people (incident_id, profile_id, name, contact, role)
  values (p_id, me.id, coalesce(me.full_name, 'Staff member'), me.mobile_number, case when p_injured then 'injured' else 'reported' end);

  insert into incident_files (incident_id, kind, category, title, file_path, file_name, uploaded_by)
  select p_id, 'photo', 'Photo', ph->>'name', ph->>'path', ph->>'name', me.id
  from jsonb_array_elements(p_photos) ph;

  for r in select id from profiles where active and role in ('admin', 'finance') loop
    perform create_notification(
      r.id, 'incident',
      'Incident #' || n || ': ' || left(trim(p_title), 120),
      coalesce(me.full_name, 'A staff member') || ' reported a ' || nature_label
        || case when job_no is not null then ' on J' || job_no else '' end || '.',
      '/incident.html?id=' || p_id,
      me.id,
      'incident:' || p_id
    );
  end loop;
  return n;
end $$;

revoke execute on function public.report_incident(uuid, text, text, text, uuid, time without time zone, boolean, jsonb) from public, anon;
grant execute on function public.report_incident(uuid, text, text, text, uuid, time without time zone, boolean, jsonb) to authenticated;

-- Staff can put photos into staff-files/incidents/<incident id>/ only. Read and delete stay admin/finance.
drop policy if exists "staff upload incident photos" on storage.objects;
create policy "staff upload incident photos" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'staff-files'
    and (storage.foldername(name))[1] = 'incidents'
    and exists (select 1 from public.profiles where id = (select auth.uid()) and active)
  );
