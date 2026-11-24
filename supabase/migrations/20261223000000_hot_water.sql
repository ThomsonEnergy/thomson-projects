-- Item 113: the Hot Water quote type (owner, 24 Nov 2026).
--
--  * projects.proposal_template takes 'hot_water'.
--  * A hot water unit in the prebuild library carries what the quote needs to know about the
--    model: heat pump or electric, its litres, how many units of heat it makes per unit of power
--    (hw_cop, about 3.5 for a heat pump, 1 for an element) and its STC count.
--  * rebates: the other rebates Thomson can offer (the NSW energy savings and peak reduction
--    certificates, claimed through Formbay like STCs). A list in Settings, never typed into code:
--    the name the client sees, the state, the quote types it fits, and either a fixed amount or
--    certificates times a price.
--  * projects.rebates / rebates_total: the rebates ticked on this quote, kept as they were when
--    ticked. They come off the client's price with the STC credit: projects.stc_total holds the
--    STCs and the rebates together, so invoices, credit notes and Xero need no new path, and
--    rebates_total says how much of it is rebates so the proposal can print each on its own line.
--  * projects.hot_water: the unit picked, the figures typed off the bill and the saving worked
--    out from them, so the client's proposal prints exactly what the office saw.
--  * job_stcs takes 'esc' and 'prc' rows beside pv, bstc and swh, so each kind is tracked on the
--    job's STCs tab.
--  * get_quote_extras_by_token: what the client's proposal needs for the above. Public by design:
--    the quote's own random token is the check, and it returns only those three things.
--  * A Hot water site inspection list (item 112).
--
-- No existing row changes.

-- ---------------------------------------------------------------- the type
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'projects_proposal_template_check') then
    execute 'alter table public.projects drop constraint projects_proposal_template_check';
  end if;
  execute 'alter table public.projects add constraint projects_proposal_template_check check (proposal_template = any (array[''new_build'', ''solar'', ''battery'', ''quick_estimate'', ''time_and_materials'', ''direct_job'', ''renovation'', ''service_work'', ''hot_water'']))';
end $$;

-- ---------------------------------------------------------------- the unit, on its prebuild
alter table public.prebuilds add column if not exists hw_kind text;
alter table public.prebuilds add column if not exists hw_litres integer;
alter table public.prebuilds add column if not exists hw_cop numeric(4,2);
alter table public.prebuilds add column if not exists stc_count integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'prebuilds_hw_kind_check') then
    execute 'alter table public.prebuilds add constraint prebuilds_hw_kind_check check (hw_kind is null or hw_kind in (''heat_pump'', ''electric''))';
  end if;
end $$;

-- ---------------------------------------------------------------- the rebates list
create table if not exists public.rebates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client_label text not null,
  state text,
  proposal_types text[] not null default '{}',
  kind text not null default 'fixed' check (kind in ('fixed', 'certificates')),
  amount numeric(12,2) not null default 0,
  certificates numeric(10,2) not null default 0,
  certificate_price numeric(10,2) not null default 0,
  stc_type text check (stc_type is null or stc_type in ('esc', 'prc')),
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.rebates enable row level security;
revoke all on public.rebates from public, anon, authenticated;
grant select, insert, update, delete on public.rebates to authenticated;

drop policy if exists "Staff read rebates" on public.rebates;
create policy "Staff read rebates" on public.rebates
  for select to authenticated using (true);
drop policy if exists "Pricing roles add rebates" on public.rebates;
create policy "Pricing roles add rebates" on public.rebates
  for insert to authenticated with check ((select is_pricing_role()));
drop policy if exists "Pricing roles change rebates" on public.rebates;
create policy "Pricing roles change rebates" on public.rebates
  for update to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
drop policy if exists "Pricing roles remove rebates" on public.rebates;
create policy "Pricing roles remove rebates" on public.rebates
  for delete to authenticated using ((select is_pricing_role()));

-- The two NSW schemes, switched off until the owner types the certificate count and price
-- (Settings > Rebates): the figures are his, not something to guess.
insert into public.rebates (name, client_label, state, proposal_types, kind, stc_type, active, sort_order)
select v.name, v.client_label, 'NSW', array['hot_water'], 'certificates', v.stc_type, false, v.sort_order
from (values
  ('NSW Energy Savings Certificates (ESC)', 'NSW energy savings certificates', 'esc', 1),
  ('NSW Peak Reduction Certificates (PRC)', 'NSW peak reduction certificates', 'prc', 2)
) as v(name, client_label, stc_type, sort_order)
where not exists (select 1 from public.rebates);

-- ---------------------------------------------------------------- on the quote
alter table public.projects add column if not exists rebates jsonb not null default '[]'::jsonb;
alter table public.projects add column if not exists rebates_total numeric(12,2) not null default 0;
alter table public.projects add column if not exists hot_water jsonb;

-- ---------------------------------------------------------------- two more kinds of certificate on a job
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'job_stcs_stc_type_check') then
    execute 'alter table public.job_stcs drop constraint job_stcs_stc_type_check';
  end if;
  execute 'alter table public.job_stcs add constraint job_stcs_stc_type_check check (stc_type in (''pv'', ''bstc'', ''swh'', ''esc'', ''prc''))';
end $$;

-- ---------------------------------------------------------------- for the client's proposal
create or replace function public.get_quote_extras_by_token(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object('rebates', p.rebates, 'rebates_total', p.rebates_total, 'hot_water', p.hot_water)
  from projects p
  where p_token is not null and length(p_token) >= 16 and p.quote_token = p_token
  limit 1;
$$;

revoke execute on function public.get_quote_extras_by_token(text) from public;
grant execute on function public.get_quote_extras_by_token(text) to anon, authenticated;

-- ---------------------------------------------------------------- the site inspection list
do $$
declare
  v_t uuid;
begin
  if not exists (select 1 from inspection_checklist_templates where checklist_type = 'site_inspection' and 'hot_water' = any (proposal_types)) then
    insert into inspection_checklist_templates (name, checklist_type, active, sort_order, proposal_types)
    values ('Hot water', 'site_inspection', true, 107, array['hot_water']) returning id into v_t;
    insert into inspection_checklist_items (template_id, item_type, label, description, required, sort_order, options, task_when, task_text, fills_answer) values
      (v_t, 'photo', 'The heater there now', null, false, 1, null, null, null, null),
      (v_t, 'photo', 'Its nameplate', null, false, 2, null, null, null, null),
      (v_t, 'photo', 'The spot for the new unit', null, false, 3, null, null, null, null),
      (v_t, 'photo', 'Main switchboard, cover off', null, false, 4, null, null, null, null),
      (v_t, 'photo', 'The hot water circuit and its breaker', null, false, 5, null, null, null, null),
      (v_t, 'photo', 'Meter (controlled load or not)', null, false, 6, null, null, null, null),
      (v_t, 'photo', 'The pipe run', null, false, 7, null, null, null, null),
      (v_t, 'photo', 'Where the relief valve drains', null, false, 8, null, null, null, null),
      (v_t, 'photo', 'Access for the unit', null, false, 9, null, null, null, null),
      (v_t, 'photo', 'Power bill', null, false, 10, null, null, null, null),
      (v_t, 'choice', 'The heater there now', null, false, 11, '["Electric, full rate", "Electric, controlled load", "Gas, mains", "Gas, LPG bottles", "Solar hot water", "None"]'::jsonb, null, null, 'hw_old'),
      (v_t, 'text', 'People in the home', null, false, 12, null, null, null, 'hw_people'),
      (v_t, 'text', 'Hot water circuit size (amps) and cable', null, false, 13, null, null, null, null),
      (v_t, 'text', 'Distance to the switchboard (metres)', null, false, 14, null, null, null, null),
      (v_t, 'yes_no', 'New unit in the same spot?', null, false, 15, null, null, null, 'hw_same_spot'),
      (v_t, 'yes_no', 'Slab or base needed?', null, false, 16, null, 'Yes', 'Allow for a slab or base for the hot water unit', null),
      (v_t, 'yes_no', 'Tempering valve needed?', null, false, 17, null, null, null, 'hw_tempering'),
      (v_t, 'yes_no', 'Near a bedroom or a neighbour (heat pump noise)?', null, false, 18, null, null, null, null),
      (v_t, 'yes_no', 'Drain for the relief valve and condensate OK?', null, false, 19, null, null, null, null);
  end if;
end $$;
