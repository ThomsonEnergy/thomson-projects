-- Merge a client's jobs into one job (docs/IDEAS_BACKLOG.md item 47, spec A13e).
--
--  * project_merge(p_into, p_from[]): Admin only, all or nothing. Every table with a job id is
--    re-pointed to the one job; each old job's cost centres come across as they are (their line
--    items, claims, invoice lines, shifts and PO lines point at the cost centre, so nothing is
--    re-costed and no invoice changes), renamed "J7010: <stage>" after the job they came from.
--    The old job row stays as a pointer (merged_into_project_id, merged_at, pipeline stage archived,
--    status merged) so its J number, its ServiceM8 id and any link already sent still land on the
--    merged job. Every merge is written to project_merges (what moved, with counts) and to both
--    jobs' activity logs. No undo button: the record is enough to unwind one by hand.
--  * project_merge_preview(p_from[]): the counts the confirm screen shows.
--  * Checks: same client, J numbers only (quotes stay separate), open jobs only on both sides (not
--    complete or archived), nothing already merged, nobody clocked in on a job being merged.
--  * Also moved: PO lines received to the old job (destination_job_id), payment milestones, warranty
--    jobs raised against it, chat and email job suggestions; its variations are renumbered after the
--    merged job's own. A row a unique rule keeps on the old job is listed in the log as left behind.
--  * New work that still names the old job (an offline clock-in, a booking, a PO, a task made from a
--    page opened before the merge) lands on the merged job (trigger _follow_merged_project).

alter table public.projects
  add column if not exists merged_into_project_id uuid references public.projects(id) on delete set null,
  add column if not exists merged_at timestamptz;
create index if not exists projects_merged_into_project_id_idx on public.projects (merged_into_project_id) where merged_into_project_id is not null;

create table if not exists public.project_merges (
  id uuid primary key default gen_random_uuid(),
  into_project_id uuid not null references public.projects(id) on delete cascade,
  from_project_id uuid not null references public.projects(id) on delete cascade,
  from_job_number integer,
  moved jsonb not null default '{}'::jsonb,
  merged_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists project_merges_into_project_id_idx on public.project_merges (into_project_id);
create index if not exists project_merges_from_project_id_idx on public.project_merges (from_project_id);
create index if not exists project_merges_merged_by_idx on public.project_merges (merged_by);
alter table public.project_merges enable row level security;
drop policy if exists "Pricing roles read project merges" on public.project_merges;
create policy "Pricing roles read project merges" on public.project_merges for select to authenticated using ((select is_pricing_role()));

-- What hangs off a job, by table (the confirm screen and the merge record).
create or replace function public._project_counts(p_project_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'stages', (select count(*) from cost_centres where project_id = p_project_id),
    'shifts', (select count(*) from time_entries where project_id = p_project_id),
    'purchase_orders', (select count(*) from purchase_orders where project_id = p_project_id),
    'bills', (select count(*) from supplier_bills where project_id = p_project_id),
    'invoices', (select count(*) from invoices where project_id = p_project_id),
    'variations', (select count(*) from job_variation_entries where project_id = p_project_id),
    'tasks', (select count(*) from job_tasks where project_id = p_project_id),
    'documents', (select count(*) from project_documents where project_id = p_project_id),
    'photos', (select count(*) from project_photos where project_id = p_project_id),
    'bookings', (select count(*) from schedule_assignments where project_id = p_project_id),
    'notes', (select count(*) from project_field_notes where project_id = p_project_id),
    'materials_used', (select count(*) from job_material_usage where project_id = p_project_id),
    'stcs', (select count(*) from job_stcs where project_id = p_project_id),
    'assets', (select count(*) from customer_assets where project_id = p_project_id),
    'inspections', (select count(*) from site_inspections where project_id = p_project_id),
    'emails', (select count(*) from email_job_links where project_id = p_project_id),
    'contacts', (select count(*) from job_contacts where project_id = p_project_id)
  );
$$;
revoke all on function public._project_counts(uuid) from public, anon, authenticated;

-- Re-points one table's rows from one job to the other. A row that would clash with one already on
-- the merged job (a unique rule on the table) stays on the old job, which keeps its pointer.
create or replace function public._project_merge_move(p_table text, p_from uuid, p_into uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  n integer := 0;
  r record;
begin
  begin
    execute format('update %I set project_id = $1 where project_id = $2', p_table) using p_into, p_from;
    get diagnostics n = row_count;
    return n;
  exception when unique_violation then
    for r in execute format('select id from %I where project_id = $1', p_table) using p_from loop
      begin
        execute format('update %I set project_id = $1 where id = $2', p_table) using p_into, r.id;
        n := n + 1;
      exception when unique_violation then null;
      end;
    end loop;
    return n;
  end;
end;
$$;
revoke all on function public._project_merge_move(text, uuid, uuid) from public, anon, authenticated;

create or replace function public.project_merge_preview(p_from uuid[])
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Only Admin can merge jobs.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'job_number', p.job_number, 'name', p.name, 'counts', _project_counts(p.id)) order by p.job_number)
                   from projects p where p.id = any (p_from)), '[]'::jsonb);
end;
$$;
revoke all on function public.project_merge_preview(uuid[]) from public, anon;
grant execute on function public.project_merge_preview(uuid[]) to authenticated;

create or replace function public.project_merge(p_into uuid, p_from uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  into_job projects;
  from_job projects;
  v_id uuid;
  v_counts jsonb;
  v_sort integer;
  v_table text;
  v_moved jsonb;
  v_left text[];
  v_n integer;
  v_var_base integer;
  v_summary text[] := '{}';
  v_tables text[] := array['invoices', 'purchase_orders', 'supplier_bills', 'time_entries', 'job_material_usage', 'job_variation_entries',
    'job_variation_hours', 'job_variation_materials', 'variations', 'job_tasks', 'project_documents', 'project_photos', 'project_field_notes',
    'schedule_assignments', 'job_stcs', 'customer_assets', 'dnsp_records', 'email_job_links', 'feed_posts', 'incident_reports', 'meetings',
    'quote_compliance_answers', 'review_requests', 'site_inspections', 'sm8_attachment_copies', 'chat_messages', 'schedule_time_offers',
    'schedule_emails', 'job_contacts'];
begin
  if not is_admin() then raise exception 'Only Admin can merge jobs.'; end if;
  select * into into_job from projects where id = p_into for update;
  if not found then raise exception 'Job not found.'; end if;
  if into_job.job_number is null then raise exception 'Jobs can only be merged into a job with a J number, not a quote.'; end if;
  if into_job.merged_into_project_id is not null then raise exception 'J% was itself merged into another job.', into_job.job_number; end if;
  if into_job.pipeline_stage in ('complete', 'archived') then raise exception 'J% is %: reopen it before merging jobs into it.', into_job.job_number, into_job.pipeline_stage; end if;
  if p_from is null or array_length(p_from, 1) is null then raise exception 'Pick at least one job to merge.'; end if;
  perform set_config('teops.po_step', 'on', true);

  foreach v_id in array p_from loop
    select * into from_job from projects where id = v_id for update;
    if not found then raise exception 'A job to merge was not found.'; end if;
    if from_job.id = into_job.id then raise exception 'A job cannot be merged into itself.'; end if;
    if from_job.job_number is null then raise exception 'Q% is a quote: approve it onto the job instead.', from_job.quote_number; end if;
    if from_job.merged_into_project_id is not null then raise exception 'J% was already merged into another job.', from_job.job_number; end if;
    if from_job.pipeline_stage in ('complete', 'archived') then raise exception 'J% is %: reopen it before merging it.', from_job.job_number, from_job.pipeline_stage; end if;
    if (into_job.client_id is not null and from_job.client_id is distinct from into_job.client_id)
       or (into_job.client_id is null and lower(trim(from_job.client_name)) is distinct from lower(trim(into_job.client_name))) then
      raise exception 'J% is for % and J% is for %: only one client''s jobs can be merged.', from_job.job_number, from_job.client_name, into_job.job_number, into_job.client_name;
    end if;
    if exists (select 1 from time_entries where project_id = from_job.id and clock_out is null) then
      raise exception 'Someone is still clocked in on J%. Wait for the clock-out, then merge.', from_job.job_number;
    end if;

    v_counts := _project_counts(from_job.id);
    v_moved := '{}'::jsonb;

    -- the stages come across as they are, named after the job they came from, after this job's own
    select coalesce(max(sort_order), 0) into v_sort from cost_centres where project_id = into_job.id;
    update cost_centres set project_id = into_job.id, name = format('J%s: %s', from_job.job_number, name), sort_order = v_sort + 1 + sort_order
      where project_id = from_job.id;
    -- variations numbered after the merged job's own (variation_number is per job)
    select coalesce(max(variation_number), 0) into v_var_base from job_variation_entries where project_id = into_job.id;
    update job_variation_entries set variation_number = v_var_base + variation_number where project_id = from_job.id and variation_number is not null;
    v_left := '{}';
    foreach v_table in array v_tables loop
      v_moved := v_moved || jsonb_build_object(v_table, _project_merge_move(v_table, from_job.id, into_job.id));
      execute format('select count(*) from %I where project_id = $1', v_table) into v_n using from_job.id;
      if v_n > 0 then v_left := v_left || format('%s %s', v_n, replace(v_table, '_', ' ')); end if;
    end loop;
    update meetings set project_ids = array_replace(project_ids, from_job.id, into_job.id) where from_job.id = any (project_ids);
    update sm8_deleted_activities set project_id = into_job.id where project_id = from_job.id;
    update activity_log set entity_id = into_job.id where entity_type = 'project' and entity_id = from_job.id;
    update purchase_order_line_items set destination_job_id = into_job.id where destination_job_id = from_job.id;
    update payment_milestones set project_id = into_job.id where project_id = from_job.id;
    update projects set warranty_of_project_id = into_job.id where warranty_of_project_id = from_job.id;
    update chat_messages set tag_suggested_project_id = into_job.id where tag_suggested_project_id = from_job.id;
    update email_threads set suggested_project_id = into_job.id where suggested_project_id = from_job.id;

    update projects set merged_into_project_id = into_job.id, merged_at = now(), pipeline_stage = 'archived', status = 'merged' where id = from_job.id;
    insert into project_merges (into_project_id, from_project_id, from_job_number, moved, merged_by)
      values (into_job.id, from_job.id, from_job.job_number, v_counts || jsonb_build_object('tables', v_moved), auth.uid());
    perform _po_log('project', into_job.id, 'merged', format('J%s (%s) merged into this job: %s stages, %s shifts, %s POs, %s bills, %s invoices, %s variations, %s tasks, %s documents, %s photos, %s bookings',
      from_job.job_number, from_job.name, v_counts->>'stages', v_counts->>'shifts', v_counts->>'purchase_orders', v_counts->>'bills', v_counts->>'invoices',
      v_counts->>'variations', v_counts->>'tasks', v_counts->>'documents', v_counts->>'photos', v_counts->>'bookings')
      || case when array_length(v_left, 1) > 0 then format('. Left on J%s because this job already has the same (open J%s''s record to see them): %s', from_job.job_number, from_job.job_number, array_to_string(v_left, ', ')) else '' end);
    perform _po_log('project', from_job.id, 'merged', format('Merged into J%s (%s); this J number now opens that job', into_job.job_number, into_job.name));
    v_summary := v_summary || format('J%s', from_job.job_number);
  end loop;

  return jsonb_build_object('into_project_id', into_job.id, 'into_job_number', into_job.job_number, 'merged', v_summary);
end;
$$;
revoke all on function public.project_merge(uuid, uuid[]) from public, anon;
grant execute on function public.project_merge(uuid, uuid[]) to authenticated;

-- New work that names a merged job lands on the job it was merged into (its stages are there now).
create or replace function public._follow_merged_project()
returns trigger language plpgsql set search_path = public as $$
declare
  v_into uuid;
begin
  if new.project_id is not null then
    select merged_into_project_id into v_into from projects where id = new.project_id;
    if v_into is not null then new.project_id := v_into; end if;
  end if;
  return new;
end;
$$;
revoke all on function public._follow_merged_project() from public, anon, authenticated;
drop trigger if exists trg_time_entries_follow_merged on public.time_entries;
create trigger trg_time_entries_follow_merged before insert on public.time_entries for each row execute function public._follow_merged_project();
drop trigger if exists trg_schedule_assignments_follow_merged on public.schedule_assignments;
create trigger trg_schedule_assignments_follow_merged before insert on public.schedule_assignments for each row execute function public._follow_merged_project();
drop trigger if exists trg_purchase_orders_follow_merged on public.purchase_orders;
create trigger trg_purchase_orders_follow_merged before insert on public.purchase_orders for each row execute function public._follow_merged_project();
drop trigger if exists trg_job_tasks_follow_merged on public.job_tasks;
create trigger trg_job_tasks_follow_merged before insert on public.job_tasks for each row execute function public._follow_merged_project();
drop trigger if exists trg_job_material_usage_follow_merged on public.job_material_usage;
create trigger trg_job_material_usage_follow_merged before insert on public.job_material_usage for each row execute function public._follow_merged_project();
