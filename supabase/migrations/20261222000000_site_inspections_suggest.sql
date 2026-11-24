-- Item 112 part B: site inspections that suggest instead of block (owner, 24 Nov 2026).
--
-- Before: every checklist item was required, a photo item took one photo, and Mark complete
-- stayed grey until all were done. All 7 inspections on production were unfinished.
--
-- After:
--  * A checklist belongs to one or more proposal types (inspection_checklist_templates.proposal_types),
--    so booking an inspection from a quote picks it without asking. 'off_grid' is the extra list
--    that joins a Solar inspection on an off-grid quote; a Solar quote with batteries takes the
--    battery list as well (site_inspections.extra_template_ids).
--  * Items gain two kinds (choice, text), the task an answer suggests (task_when, task_text) and
--    the pre-quote answer it fills (fills_answer, a key of projects.template_answers).
--  * site_inspection_photos: any number of labelled photos, on a checklist item or on their own.
--  * site_inspections.notes and .tasks (jsonb list of { text, ticked, item_id, created }).
--  * submit_site_inspection(): marks it done and lands it on the quote or job in one step.
--  * An inspection on a lead lands when a quote is made from that lead (trigger on projects.lead_id).
--
-- No existing row is deleted. The two old site inspection checklists are switched off (their
-- open inspections keep working) and the photos already taken are copied into the new table.

-- ---------------------------------------------------------------- columns
alter table public.inspection_checklist_templates add column if not exists proposal_types text[] not null default '{}';

alter table public.inspection_checklist_items add column if not exists options jsonb;
alter table public.inspection_checklist_items add column if not exists task_when text;
alter table public.inspection_checklist_items add column if not exists task_text text;
alter table public.inspection_checklist_items add column if not exists fills_answer text;

-- Two more kinds of item. Done inside a block so the constraint swap is one statement.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'inspection_checklist_items_item_type_check') then
    execute 'alter table public.inspection_checklist_items drop constraint inspection_checklist_items_item_type_check';
  end if;
  execute 'alter table public.inspection_checklist_items add constraint inspection_checklist_items_item_type_check check (item_type in (''photo'', ''yes_no'', ''choice'', ''text''))';
end $$;

alter table public.site_inspection_answers add column if not exists answer_text text;
alter table public.site_inspection_answers add column if not exists note text;

alter table public.site_inspections add column if not exists extra_template_ids uuid[] not null default '{}';
-- Who booked it was never recorded (the column was always blank): it is whoever makes the row.
alter table public.site_inspections alter column created_by set default auth.uid();
alter table public.site_inspections add column if not exists notes text;
alter table public.site_inspections add column if not exists tasks jsonb not null default '[]'::jsonb;
-- Who submitted it and where it landed are plain ids, not foreign keys: site_inspections already
-- links to profiles (created_by) and projects (project_id), and a second link to either would
-- break every page that reads an inspection with its project or person.
alter table public.site_inspections add column if not exists submitted_by uuid;
alter table public.site_inspections add column if not exists landed_project_id uuid;
alter table public.site_inspections add column if not exists notes_landed_at timestamptz;

-- ---------------------------------------------------------------- the photos
create table if not exists public.site_inspection_photos (
  id uuid primary key default gen_random_uuid(),
  inspection_id uuid not null references public.site_inspections(id) on delete cascade,
  item_id uuid references public.inspection_checklist_items(id) on delete set null,
  label text not null,
  url text not null,
  project_photo_id uuid references public.project_photos(id) on delete set null,
  -- when it went to the job's Photos. Kept apart from project_photo_id on purpose: a photo deleted
  -- from the Photos tab afterwards must not be sent again.
  landed_at timestamptz,
  taken_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists site_inspection_photos_inspection on public.site_inspection_photos (inspection_id);
create index if not exists site_inspection_photos_item on public.site_inspection_photos (item_id);
create index if not exists site_inspection_photos_project_photo on public.site_inspection_photos (project_photo_id);
create index if not exists site_inspection_photos_taken_by on public.site_inspection_photos (taken_by);

alter table public.site_inspection_photos enable row level security;
revoke all on public.site_inspection_photos from public, anon, authenticated;
-- a photo can be relabelled, nothing else about it changed
grant select, insert, delete on public.site_inspection_photos to authenticated;
grant update (label) on public.site_inspection_photos to authenticated;

drop policy if exists "Staff read inspection photos" on public.site_inspection_photos;
create policy "Staff read inspection photos" on public.site_inspection_photos
  for select to authenticated using (true);
drop policy if exists "Staff add inspection photos" on public.site_inspection_photos;
create policy "Staff add inspection photos" on public.site_inspection_photos
  for insert to authenticated with check (taken_by = (select auth.uid()));
drop policy if exists "Staff relabel inspection photos" on public.site_inspection_photos;
create policy "Staff relabel inspection photos" on public.site_inspection_photos
  for update to authenticated using (true) with check (true);
drop policy if exists "Staff remove inspection photos" on public.site_inspection_photos;
create policy "Staff remove inspection photos" on public.site_inspection_photos
  for delete to authenticated using (landed_at is null);

-- ---------------------------------------------------------------- the project guard lets the landing through
-- guard_projects_writes stops a field role changing anything on a quote but a few site columns.
-- The same function as in 20261124150000, with one early return added (the first block).
create or replace function public.guard_projects_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_allowed text[] := array['pipeline_stage', 'ccew_file_path', 'ccew_not_required_reason', 'nmi', 'panel_serial_numbers',
                            'inverter_serial_numbers', 'notes', 'needs_site_visit'];
  v_key text;
begin
  -- land_site_inspection (item 112) fills blank pre-quote answers for whoever did the inspection,
  -- a field role included. It switches this on for its own transaction; the page cannot.
  if tg_op = 'UPDATE' and coalesce(current_setting('teops.inspection_landing', true), '') = 'on' then
    return new;
  end if;

  -- the server (service role) and migrations have no user: nothing to guard
  if v_uid is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if not is_pricing_role() then
      raise exception 'Only Admin, Finance or Sales can delete a job or quote.';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if not is_pricing_role() then
      -- a job with no quote (My Day "+ New job") is the only kind a field role can add
      if new.proposal_template is distinct from 'direct_job' or new.pipeline_stage is distinct from 'ready_to_book'
         or new.quote_number is not null or coalesce(new.stc_total, 0) <> 0 or coalesce(new.bstc_total, 0) <> 0
         or new.deposit_percent is not null or new.roi_inputs is not null or new.bill_reading is not null
         or new.approved_at is not null or new.send_gate_override_at is not null then
        raise exception 'Only Admin, Finance or Sales can create a quote. You can add a job with no quote.';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if is_pricing_role() then
    if not is_finance_role()
       and (new.send_gate_override_reason is distinct from old.send_gate_override_reason
            or new.send_gate_override_at is distinct from old.send_gate_override_at) then
      raise exception 'Only Admin or Finance can override the ready-to-send check.';
    end if;
    return new;
  end if;

  -- a field role: only the site columns may change
  for v_key in select key from jsonb_each(to_jsonb(new)) loop
    if not (v_key = any (v_allowed)) and (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
      raise exception 'Only Admin, Finance or Sales can change % on a job or quote.', v_key;
    end if;
  end loop;
  -- job_booked: only ever set by sync_project_booked (a clock-in or booking), and projects_job_booked_gate
  -- refuses it without one
  if new.pipeline_stage is distinct from old.pipeline_stage
     and new.pipeline_stage not in ('client_handover', 'job_not_complete', 'ready_to_invoice', 'awaiting_action', 'ready_to_book', 'quote_sent', 'job_booked') then
    raise exception 'That stage move needs Admin, Finance or Sales.';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_projects_writes() from public, anon, authenticated;

-- ---------------------------------------------------------------- landing an inspection on a quote or job
-- Puts what an inspection holds onto a project: photos into project_photos named by their label,
-- ticked tasks into job_tasks for whoever booked the inspection (whoever submitted it when that is not known), the notes onto the project's
-- notes, and answers into blank pre-quote answers. Safe to run again: each photo, task and the
-- notes land once, and an answer never overwrites one already given.
-- Server side only (submit_site_inspection and the projects trigger call it): nobody is granted it.
create or replace function public.land_site_inspection(p_inspection_id uuid, p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_insp site_inspections%rowtype;
  v_project projects%rowtype;
  v_photo record;
  v_new_photo uuid;
  v_task jsonb;
  v_tasks jsonb := '[]'::jsonb;
  v_fill record;
  v_answers jsonb;
  v_photos int := 0;
  v_tasks_made int := 0;
  v_filled int := 0;
begin
  select * into v_insp from site_inspections where id = p_inspection_id for update;
  if not found then raise exception 'Inspection not found'; end if;
  select * into v_project from projects where id = p_project_id for update;
  if not found then raise exception 'Quote or job not found'; end if;

  for v_photo in
    select id, label, url, taken_by from site_inspection_photos
    where inspection_id = p_inspection_id and landed_at is null order by created_at
  loop
    insert into project_photos (project_id, staff_id, url, caption)
    values (p_project_id, v_photo.taken_by, v_photo.url, left('Inspection: ' || v_photo.label, 200))
    returning id into v_new_photo;
    update site_inspection_photos set project_photo_id = v_new_photo, landed_at = now() where id = v_photo.id;
    v_photos := v_photos + 1;
  end loop;

  for v_task in select * from jsonb_array_elements(coalesce(v_insp.tasks, '[]'::jsonb))
  loop
    if coalesce((v_task->>'ticked')::boolean, false) and not coalesce((v_task->>'created')::boolean, false)
       and btrim(coalesce(v_task->>'text', '')) <> '' then
      insert into job_tasks (project_id, description, assigned_to_user_id, created_by, task_type)
      values (p_project_id, left(btrim(v_task->>'text'), 500), coalesce(v_insp.created_by, v_insp.submitted_by),
              coalesce(v_insp.submitted_by, v_insp.created_by),
              case when v_project.job_number is null then 'quote' else 'prejob' end);
      v_task := v_task || jsonb_build_object('created', true);
      v_tasks_made := v_tasks_made + 1;
    end if;
    v_tasks := v_tasks || jsonb_build_array(v_task);
  end loop;

  v_answers := coalesce(v_project.template_answers, '{}'::jsonb);
  for v_fill in
    select i.fills_answer as key,
           case when i.item_type = 'yes_no' then case a.answer_yes_no when true then 'Yes' when false then 'No' end
                else nullif(btrim(a.answer_text), '') end as value
    from site_inspection_answers a
    join inspection_checklist_items i on i.id = a.item_id
    where a.inspection_id = p_inspection_id and i.fills_answer is not null
    order by i.sort_order
  loop
    if v_fill.value is not null and btrim(coalesce(v_answers->>v_fill.key, '')) = '' then
      v_answers := v_answers || jsonb_build_object(v_fill.key, v_fill.value);
      v_filled := v_filled + 1;
    end if;
  end loop;

  perform set_config('teops.inspection_landing', 'on', true);
  update projects set
    template_answers = v_answers,
    notes = case when v_insp.notes_landed_at is null and btrim(coalesce(v_insp.notes, '')) <> ''
                 then concat_ws(E'\n\n', nullif(btrim(coalesce(notes, '')), ''),
                        'Site inspection ' || to_char((now() at time zone 'Australia/Sydney')::date, 'FMDD Mon YYYY') || ': ' || btrim(v_insp.notes))
                 else notes end
  where id = p_project_id;
  perform set_config('teops.inspection_landing', '', true);

  update site_inspections set
    tasks = v_tasks,
    landed_project_id = p_project_id,
    notes_landed_at = case when notes_landed_at is null and btrim(coalesce(notes, '')) <> '' then now() else notes_landed_at end
  where id = p_inspection_id;

  return jsonb_build_object('photos', v_photos, 'tasks', v_tasks_made, 'answers', v_filled);
end $$;

revoke execute on function public.land_site_inspection(uuid, uuid) from public, anon, authenticated;

-- Submit: any active staff member. Marks the inspection done and, when it is on a quote or job,
-- lands it there. An inspection on a lead waits for the quote (the trigger below). Pressing
-- Submit again after adding more sends only what is new.
create or replace function public.submit_site_inspection(p_inspection_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_insp site_inspections%rowtype;
  v_project uuid;
  v_out jsonb := jsonb_build_object('photos', 0, 'tasks', 0, 'answers', 0);
begin
  if v_uid is null or not exists (select 1 from profiles where id = v_uid and active) then
    raise exception 'Not authorised';
  end if;
  select * into v_insp from site_inspections where id = p_inspection_id for update;
  if not found then raise exception 'Inspection not found'; end if;

  update site_inspections set
    status = 'completed',
    completed_at = coalesce(completed_at, now()),
    submitted_by = v_uid
  where id = p_inspection_id;
  v_insp.submitted_by := v_uid;

  v_project := coalesce(v_insp.project_id, v_insp.landed_project_id);
  if v_project is null and v_insp.lead_id is not null then
    select id into v_project from projects where lead_id = v_insp.lead_id order by created_at limit 1;
  end if;
  if v_project is not null then
    v_out := land_site_inspection(p_inspection_id, v_project);
  end if;
  return v_out || jsonb_build_object('landed', v_project is not null);
end $$;

revoke execute on function public.submit_site_inspection(uuid) from public, anon;
grant execute on function public.submit_site_inspection(uuid) to authenticated;

-- A quote made from a lead takes that lead's submitted inspections. A failure here must never
-- stop the quote being made, so each inspection lands in its own block and a failure is a warning.
create or replace function public.projects_land_lead_inspections()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  -- only what has not landed yet: a second quote from the same lead takes nothing from the first
  for v_id in select id from site_inspections where lead_id = new.lead_id and status = 'completed' and landed_project_id is null
  loop
    begin
      perform land_site_inspection(v_id, new.id);
    exception when others then
      raise warning 'Site inspection % did not land on project %: %', v_id, new.id, sqlerrm;
    end;
  end loop;
  return null;
end $$;

revoke execute on function public.projects_land_lead_inspections() from public, anon, authenticated;

drop trigger if exists projects_land_lead_inspections on public.projects;
create trigger projects_land_lead_inspections
  after insert or update of lead_id on public.projects
  for each row when (new.lead_id is not null)
  execute function public.projects_land_lead_inspections();

-- ---------------------------------------------------------------- data
-- Photos already taken on the old one-photo items, copied across with the item's label.
insert into public.site_inspection_photos (inspection_id, item_id, label, url, taken_by, created_at)
select a.inspection_id, a.item_id, i.label, a.photo_path, a.answered_by, a.answered_at
from public.site_inspection_answers a
join public.inspection_checklist_items i on i.id = a.item_id
where a.photo_path is not null
  and not exists (select 1 from public.site_inspection_photos p where p.inspection_id = a.inspection_id and p.url = a.photo_path);

-- The new lists, one per proposal type, seeded once. Every item is a suggestion (required false).
-- They are edited afterwards in Settings > Inspection Checklists.
do $$
declare
  v_t uuid;
begin
  if not exists (select 1 from inspection_checklist_templates where checklist_type = 'site_inspection' and proposal_types <> '{}') then
    update inspection_checklist_templates set active = false where checklist_type = 'site_inspection';
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types) values ('Solar', 'site_inspection', true, 101, array['solar']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'Property front', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'Meter box, door open', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'Meter and NMI', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'Main switchboard, cover off', null, false, 4, null, null, null, null),
      (v_t, 'photo', 'Sub board', null, false, 5, null, null, null, null),
      (v_t, 'photo', 'Each roof face the panels go on', null, false, 6, null, null, null, null),
      (v_t, 'photo', 'Roof sheet or tile, close up', null, false, 7, null, null, null, null),
      (v_t, 'photo', 'Where the ladder goes', null, false, 8, null, null, null, null),
      (v_t, 'photo', 'Inverter spot', null, false, 9, null, null, null, null),
      (v_t, 'photo', 'Cable route, roof to inverter to board', null, false, 10, null, null, null, null),
      (v_t, 'photo', 'Existing system (panels, inverter nameplate)', null, false, 11, null, null, null, null),
      (v_t, 'photo', 'Shading (trees, neighbours)', null, false, 12, null, null, null, null),
      (v_t, 'photo', 'Power bill', null, false, 13, null, null, null, null),
      (v_t, 'choice', 'Roof type', null, false, 14, '["Tin (Colorbond)", "Tile", "Klip-lok", "Flat or membrane", "Ground mount", "Other"]'::jsonb, null, null, 'roof_type'),
      (v_t, 'yes_no', 'Roof safe to work on?', null, false, 15, null, null, null, null),
      (v_t, 'choice', 'Storeys', null, false, 16, '["One", "Two", "Three or more"]'::jsonb, null, null, null),
      (v_t, 'choice', 'Supply', null, false, 17, '["Single phase", "Three phase", "Not sure"]'::jsonb, null, null, 'phases'),
      (v_t, 'text', 'Main switch or service fuse size', null, false, 18, null, null, null, null),
      (v_t, 'yes_no', 'Room in the board for the solar breaker?', null, false, 19, null, null, null, null),
      (v_t, 'yes_no', 'Switchboard upgrade needed?', null, false, 20, null, 'Yes', 'Quote the switchboard upgrade found at the site inspection', null),
      (v_t, 'yes_no', 'Meter upgrade needed?', null, false, 21, null, 'Yes', 'Apply for the meter upgrade', null),
      (v_t, 'yes_no', 'Service fuses needed?', null, false, 22, null, 'Yes', 'Arrange the service fuses (Level 2)', null),
      (v_t, 'yes_no', 'Asbestos in the board or eaves?', null, false, 23, null, 'Yes', 'Asbestos found at the inspection: plan the safe work method before booking', null),
      (v_t, 'yes_no', 'On a shed or carport?', null, false, 24, null, null, null, null),
      (v_t, 'yes_no', 'Tilt frames needed?', null, false, 25, null, null, null, null),
      (v_t, 'yes_no', 'Edge protection or scaffold needed?', null, false, 26, null, 'Yes', 'Book edge protection or scaffold', null),
      (v_t, 'text', 'Cable run, inverter to board (metres)', null, false, 27, null, null, null, null),
      (v_t, 'yes_no', 'Phone or Wi-Fi signal at the inverter spot?', null, false, 28, null, null, null, null);
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types) values ('Battery', 'site_inspection', true, 102, array['battery']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'Battery spot, wide', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'The wall and floor at the spot', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'What is within a metre (windows, doors, gas, hot water, aircon)', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'Inverter spot', null, false, 4, null, null, null, null),
      (v_t, 'photo', 'Gateway spot', null, false, 5, null, null, null, null),
      (v_t, 'photo', 'Main switchboard, cover off', null, false, 6, null, null, null, null),
      (v_t, 'photo', 'Meter box, door open', null, false, 7, null, null, null, null),
      (v_t, 'photo', 'Existing solar inverter nameplate', null, false, 8, null, null, null, null),
      (v_t, 'photo', 'Cable route, battery to board', null, false, 9, null, null, null, null),
      (v_t, 'photo', 'Power bill', null, false, 10, null, null, null, null),
      (v_t, 'choice', 'Where the battery goes', null, false, 11, '["Garage", "External wall", "Under cover outside", "Dedicated room", "Other"]'::jsonb, null, null, 'battery_location'),
      (v_t, 'choice', 'Wall type at the spot', null, false, 12, '["Brick or block", "Fibro", "Timber or cladding", "Steel", "Other"]'::jsonb, null, null, null),
      (v_t, 'yes_no', 'Clear of habitable rooms, exits and heat, with AS/NZS 5139 clearances?', null, false, 13, null, null, null, 'location_clear'),
      (v_t, 'yes_no', 'Bollard needed (a car can reach it)?', null, false, 14, null, 'Yes', 'Add a bollard to the battery quote', null),
      (v_t, 'yes_no', 'All in one unit (battery and inverter together)?', null, false, 15, null, null, null, null),
      (v_t, 'yes_no', 'Gateway needed?', null, false, 16, null, null, null, null),
      (v_t, 'text', 'What must stay on in a blackout', null, false, 17, null, null, null, 'backup_needs'),
      (v_t, 'choice', 'Backup', null, false, 18, '["Whole home", "Chosen circuits", "None"]'::jsonb, null, null, null),
      (v_t, 'yes_no', 'Switchboard upgrade needed for the backup circuits?', null, false, 19, null, 'Yes', 'Quote the switchboard upgrade found at the site inspection', null),
      (v_t, 'text', 'Cable run, battery to board (metres)', null, false, 20, null, null, null, null),
      (v_t, 'yes_no', 'In full sun or weather (needs a cover)?', null, false, 21, null, null, null, null),
      (v_t, 'yes_no', 'Internet at the spot for monitoring?', null, false, 22, null, null, null, 'internet'),
      (v_t, 'text', 'Existing solar (size, inverter, year)', null, false, 23, null, null, null, 'existing_pv');
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types) values ('Off-grid', 'site_inspection', true, 103, array['off_grid']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'Generator and its nameplate', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'Shed or plant room, wide', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'Spot for the batteries and inverters', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'The run from the array to the shed', null, false, 4, null, null, null, null),
      (v_t, 'photo', 'Truck access to the site', null, false, 5, null, null, null, null),
      (v_t, 'text', 'The big loads (pumps, welders, aircon, anything three phase)', null, false, 6, null, null, null, null),
      (v_t, 'text', 'Generator size (kVA)', null, false, 7, null, null, null, null),
      (v_t, 'yes_no', 'Generator has auto start?', null, false, 8, null, null, null, null),
      (v_t, 'text', 'Array to shed (metres)', null, false, 9, null, null, null, null),
      (v_t, 'yes_no', 'Phone signal on site?', null, false, 10, null, null, null, null),
      (v_t, 'yes_no', 'Truck or trailer can reach the shed?', null, false, 11, null, null, null, null);
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types) values ('Renovation', 'site_inspection', true, 104, array['renovation']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'Property front', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'Switchboard, cover off', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'Meter box, door open', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'Each room being worked on', null, false, 4, null, null, null, null),
      (v_t, 'photo', 'Roof space and manhole', null, false, 5, null, null, null, null),
      (v_t, 'photo', 'Under the floor', null, false, 6, null, null, null, null),
      (v_t, 'photo', 'Existing wiring', null, false, 7, null, null, null, null),
      (v_t, 'photo', 'The plans or a marked-up drawing', null, false, 8, null, null, null, null),
      (v_t, 'photo', 'Smoke alarms', null, false, 9, null, null, null, null),
      (v_t, 'photo', 'Anything to make good', null, false, 10, null, null, null, null),
      (v_t, 'yes_no', 'Built before 1990?', null, false, 11, null, null, null, 'built_pre_1990'),
      (v_t, 'yes_no', 'Asbestos suspected?', null, false, 12, null, 'Yes', 'Asbestos suspected at the inspection: plan the safe work method before booking', null),
      (v_t, 'choice', 'Wiring type', null, false, 13, '["TPS (modern)", "Rubber (VIR)", "Cloth", "Mixed", "Not sure"]'::jsonb, null, null, null),
      (v_t, 'yes_no', 'Switchboard upgrade needed?', null, false, 14, null, 'Yes', 'Quote the switchboard upgrade found at the site inspection', 'switchboard_upgrade'),
      (v_t, 'yes_no', 'Safety switches on every circuit?', null, false, 15, null, null, null, null),
      (v_t, 'yes_no', 'Roof space access OK?', null, false, 16, null, null, null, null),
      (v_t, 'yes_no', 'Under floor access OK?', null, false, 17, null, null, null, null),
      (v_t, 'yes_no', 'Occupied during the works?', null, false, 18, null, null, null, 'occupied'),
      (v_t, 'yes_no', 'Builder or other trades on site?', null, false, 19, null, null, null, 'other_trades'),
      (v_t, 'yes_no', 'Smoke alarm upgrade required?', null, false, 20, null, null, null, 'smoke_alarms'),
      (v_t, 'yes_no', 'Mains or three phase upgrade needed?', null, false, 21, null, 'Yes', 'Quote the mains upgrade and check with the network', null),
      (v_t, 'text', 'Points agreed with the client', null, false, 22, null, null, null, null);
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types) values ('New Build', 'site_inspection', true, 105, array['new_build']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'The block or slab', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'Builder''s temporary supply', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'Where the meter goes', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'The plans', null, false, 4, null, null, null, null),
      (v_t, 'yes_no', 'Plans supplied?', null, false, 5, null, null, null, null),
      (v_t, 'yes_no', 'New connection or Level 2 work needed?', null, false, 6, null, 'Yes', 'Arrange the new connection (Level 2)', null),
      (v_t, 'text', 'Mains run (metres)', null, false, 7, null, null, null, null),
      (v_t, 'choice', 'Mains', null, false, 8, '["Overhead", "Underground", "Not decided"]'::jsonb, null, null, null),
      (v_t, 'choice', 'Who digs the trench', null, false, 9, '["Us", "The builder", "The client", "No trench"]'::jsonb, null, null, null),
      (v_t, 'choice', 'Stage of the build', null, false, 10, '["Not started", "Slab", "Frame", "Lock-up", "Fit off"]'::jsonb, null, null, null),
      (v_t, 'yes_no', 'Solar or EV charger provision wanted?', null, false, 11, null, null, null, null),
      (v_t, 'yes_no', 'Data or NBN lead-in needed?', null, false, 12, null, null, null, null);
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types) values ('Electrical work', 'site_inspection', true, 106, array['service_work', 'quick_estimate']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'Property front', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'The work area, wide', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'The work area, close up', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'Switchboard, cover off', null, false, 4, null, null, null, null),
      (v_t, 'photo', 'Meter box, door open', null, false, 5, null, null, null, null),
      (v_t, 'photo', 'The equipment or its nameplate (what is there now, or being replaced)', null, false, 6, null, null, null, null),
      (v_t, 'photo', 'Cable route', null, false, 7, null, null, null, null),
      (v_t, 'photo', 'Access (roof space, under floor, height)', null, false, 8, null, null, null, null),
      (v_t, 'photo', 'The fault or damage (a repair)', null, false, 9, null, null, null, null),
      (v_t, 'text', 'What we found on site', null, false, 10, null, null, null, null),
      (v_t, 'yes_no', 'Switchboard upgrade needed for it?', null, false, 11, null, 'Yes', 'Quote the switchboard upgrade found at the site inspection', null),
      (v_t, 'yes_no', 'Safety switches on the circuits being worked on?', null, false, 12, null, null, null, null),
      (v_t, 'text', 'Cable run (metres)', null, false, 13, null, null, null, null),
      (v_t, 'yes_no', 'Roof space or under floor access OK?', null, false, 14, null, null, null, null),
      (v_t, 'yes_no', 'Ladder, lift or roof access needed?', null, false, 15, null, null, null, null),
      (v_t, 'yes_no', 'OK to switch the power off during the works?', null, false, 16, null, null, null, 'power_off_ok'),
      (v_t, 'text', 'Parts or equipment to order', null, false, 17, null, 'answered', 'Order the parts found at the site inspection', null),
      (v_t, 'yes_no', 'Two people needed?', null, false, 18, null, null, null, null),
      (v_t, 'text', 'Hours it should take', null, false, 19, null, null, null, null),
      (v_t, 'yes_no', 'Asbestos suspected?', null, false, 20, null, 'Yes', 'Asbestos suspected at the inspection: plan the safe work method before booking', null),
      (v_t, 'yes_no', 'Site induction or work permit required?', null, false, 21, null, null, null, 'induction_needed'),
      (v_t, 'text', 'Anything to make good after (patching, painting)', null, false, 22, null, null, null, null);
  end if;
end $$;
