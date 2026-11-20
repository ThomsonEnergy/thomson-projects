-- Quote save points (backlog item 99, owner 18 Nov 2026): Undo on the quote steps.
--
-- The quote steps now save themselves as they are typed (public/js/quote-autosave.js), so there
-- is no Save press to mark a point to go back to. Instead a save point is a snapshot of every
-- step's boxes, made by the page when the quote is opened and then changed, just before the AI
-- writes the scope of works, and just before an Undo (so an Undo can be undone). Undo on a step
-- puts that step's boxes back from the save point picked. The page keeps the newest 10 per quote
-- and removes the rest.
--
-- snapshot is { client, answers, visit, pricing, scope }: the same values the step saves to
-- projects (and payment_milestones). No stage table rows, no line items: those still save with
-- Save pricing and are not part of Undo yet.
--
-- Pricing roles only (the quote steps only show for them). No money, stock or payroll moves here:
-- an Undo saves through the same step save as typing does. taken_by carries no foreign key on
-- purpose (the same reason as job_windows: a second link to profiles makes joins ambiguous).

create table if not exists public.quote_save_points (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  taken_at timestamptz not null default now(),
  taken_by uuid default auth.uid(),
  reason text not null,
  snapshot jsonb not null
);

create index if not exists quote_save_points_project_idx on public.quote_save_points (project_id, taken_at desc);

alter table public.quote_save_points enable row level security;

drop policy if exists "Pricing roles read quote save points" on public.quote_save_points;
create policy "Pricing roles read quote save points" on public.quote_save_points
  for select to authenticated using ((select is_pricing_role()));
drop policy if exists "Pricing roles add quote save points" on public.quote_save_points;
create policy "Pricing roles add quote save points" on public.quote_save_points
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove quote save points" on public.quote_save_points;
create policy "Pricing roles remove quote save points" on public.quote_save_points
  for delete to authenticated using ((select is_pricing_role()));
