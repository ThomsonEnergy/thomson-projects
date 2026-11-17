-- Merging jobs (project_merge, 20261128080000) moves a fixed list of tables. The tables added on
-- 18 Nov 2026 were not on it: the client's messages (job_client_messages), their open date ask
-- (portal_booking_requests) and the variation bars on the plan (job_windows rows of the merged job's
-- cost centres, which the merge moves to the kept job). Rather than rewrite the merge (it moves money
-- rows, all or nothing), this trigger carries them across the moment a job is marked merged, inside
-- the same transaction, so a merge that fails moves nothing. The merged job's own plan row stays with
-- it (the job is archived, so the plan never shows it). Found by the sweep of 18 Nov 2026.

create or replace function public.merge_carries_plan_and_portal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.merged_into_project_id is null or old.merged_into_project_id is not null then return new; end if;
  update job_client_messages set project_id = new.merged_into_project_id where project_id = new.id;
  -- one open ask per job: the kept job's own ask wins, the merged job's is closed as withdrawn
  if exists (select 1 from portal_booking_requests where project_id = new.merged_into_project_id and answered_at is null and withdrawn_at is null) then
    update portal_booking_requests set withdrawn_at = now() where project_id = new.id and answered_at is null and withdrawn_at is null;
  end if;
  update portal_booking_requests set project_id = new.merged_into_project_id where project_id = new.id;
  update job_windows set project_id = new.merged_into_project_id where project_id = new.id and cost_centre_id is not null;
  return new;
end;
$$;
revoke all on function public.merge_carries_plan_and_portal() from public, anon, authenticated;

drop trigger if exists projects_merge_carries_plan_and_portal on public.projects;
create trigger projects_merge_carries_plan_and_portal
  after update of merged_into_project_id on public.projects
  for each row execute function public.merge_carries_plan_and_portal();
