-- Money and data fixes from the site review (docs/BUG_REVIEW.md, M items).

-- M4: one job per quote, one stage per approved variation, even if two approvals land at once.
create unique index if not exists projects_source_quote_unique on public.projects (source_quote_id) where source_quote_id is not null;
create unique index if not exists cost_centres_variation_entry_unique on public.cost_centres (variation_entry_id) where variation_entry_id is not null;

-- M9: add to a stage's invoiced amount in one step (two invoices at once can't lose one).
-- Server only (create-invoice.js runs as the service role).
create or replace function public.add_invoiced_amount(p_centre_id uuid, p_amount numeric)
returns void
language sql
security definer
set search_path = public
as $$
  update cost_centres set invoiced_amount = coalesce(invoiced_amount, 0) + coalesce(p_amount, 0) where id = p_centre_id;
$$;
revoke execute on function public.add_invoiced_amount(uuid, numeric) from public, anon, authenticated;

-- M11: the amount an Airwallex pay link was made for, so a changed balance gets a new link.
alter table public.invoices add column if not exists airwallex_link_amount numeric;

-- M14: the STC credit GST follows the client the invoice is billed to (bill_to_client_id),
-- the same client the Xero push uses.
create or replace function public.invoice_client_type(p_invoice_id uuid)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce(
    (select cl.client_type
       from invoices i
       left join cost_centres cc on cc.id = i.cost_centre_id
       left join projects p on p.id = coalesce(i.project_id, cc.project_id)
       left join clients cl on cl.id = coalesce(i.bill_to_client_id, i.client_id, p.client_id)
      where i.id = p_invoice_id),
    'individual');
$function$;

-- F8 (done here as it is a data rule): a job moved to Complete by hand gets its completed date,
-- so archive-completed-jobs.js archives it after 2 days like the others.
create or replace function public.stamp_completed_at() returns trigger
language plpgsql set search_path to 'public'
as $$
begin
  if new.pipeline_stage = 'complete' and new.completed_at is null then
    new.completed_at := now();
  end if;
  return new;
end $$;
drop trigger if exists stamp_completed_at on public.projects;
create trigger stamp_completed_at before insert or update of pipeline_stage on public.projects
  for each row execute function public.stamp_completed_at();
update public.projects set completed_at = now() where pipeline_stage = 'complete' and completed_at is null;
