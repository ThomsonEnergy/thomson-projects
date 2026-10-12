-- Variations (the per-job log of out-of-scope work, migration 122) can now
-- carry hours and materials, and be billed on an invoice.
--
--  * job_variation_hours      hours worked on a variation, per person and day
--  * job_variation_materials  materials / prebuilds taken from Stock for it
--  * job_variation_entries    gains cost_centre_id + invoice_id: when a variation
--                             is added to an invoice it becomes its own stage
--                             (cost centre) so it flows through the normal
--                             claim / invoice / Xero machinery unchanged
--  * cost_centres             gains variation_entry_id, which marks that stage
--                             as a variation so the client's quote page never
--                             shows it (it wasn't part of what they accepted)
--
-- No dollar amounts are stored on the hours / materials rows: staff log them
-- and see this tab, pricing stays with the pricing roles (prices are worked
-- out when the variation is billed - see bill-variations.js).

create table if not exists job_variation_hours (
  id uuid primary key default gen_random_uuid(),
  variation_id uuid not null references job_variation_entries(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  staff_id uuid references profiles(id) on delete set null,
  work_date date not null default current_date,
  hours numeric not null check (hours > 0),
  note text,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists job_variation_hours_variation_idx on job_variation_hours (variation_id);

create table if not exists job_variation_materials (
  id uuid primary key default gen_random_uuid(),
  variation_id uuid not null references job_variation_entries(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  kind text not null check (kind in ('material', 'prebuild', 'other')),
  material_id uuid references materials(id) on delete set null,
  prebuild_id uuid references prebuilds(id) on delete set null,
  description text not null,
  quantity numeric not null check (quantity > 0),
  -- 'other' lines (something not in Stock) carry a cost, entered by a pricing role
  other_unit_cost numeric,
  stock_deducted boolean not null default false,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists job_variation_materials_variation_idx on job_variation_materials (variation_id);

alter table job_variation_entries add column if not exists cost_centre_id uuid references cost_centres(id) on delete set null;
alter table job_variation_entries add column if not exists invoice_id uuid references invoices(id) on delete set null;
alter table cost_centres add column if not exists variation_entry_id uuid references job_variation_entries(id) on delete set null;

alter table job_variation_hours enable row level security;
drop policy if exists "variation hours readable" on job_variation_hours;
create policy "variation hours readable" on job_variation_hours for select to authenticated using (true);
drop policy if exists "variation hours insertable" on job_variation_hours;
create policy "variation hours insertable" on job_variation_hours for insert to authenticated
  with check (
    is_pricing_role()
    or (created_by = auth.uid() and staff_id = auth.uid()
        and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill'))
  );
drop policy if exists "variation hours editable" on job_variation_hours;
create policy "variation hours editable" on job_variation_hours for update to authenticated
  using (is_pricing_role() or (created_by = auth.uid() and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill')))
  with check (is_pricing_role() or (created_by = auth.uid() and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill')));
drop policy if exists "variation hours deletable" on job_variation_hours;
create policy "variation hours deletable" on job_variation_hours for delete to authenticated
  using (is_pricing_role() or (created_by = auth.uid() and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill')));

alter table job_variation_materials enable row level security;
drop policy if exists "variation materials readable" on job_variation_materials;
create policy "variation materials readable" on job_variation_materials for select to authenticated using (true);
drop policy if exists "variation materials insertable" on job_variation_materials;
create policy "variation materials insertable" on job_variation_materials for insert to authenticated
  with check (
    is_pricing_role()
    or (created_by = auth.uid() and kind <> 'other'
        and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill'))
  );
drop policy if exists "variation materials editable" on job_variation_materials;
create policy "variation materials editable" on job_variation_materials for update to authenticated
  using (is_pricing_role() or (created_by = auth.uid() and kind <> 'other' and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill')))
  with check (is_pricing_role() or (created_by = auth.uid() and kind <> 'other' and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill')));
drop policy if exists "variation materials deletable" on job_variation_materials;
create policy "variation materials deletable" on job_variation_materials for delete to authenticated
  using (is_pricing_role() or (created_by = auth.uid() and kind <> 'other' and exists (select 1 from job_variation_entries e where e.id = variation_id and e.status = 'to_bill')));

-- The client's quote link must not list variation stages. This is
-- get_quote_by_token exactly as it was (migration 140) plus
-- "and c.variation_entry_id is null" on the stages.
create or replace function public.get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
as $function$
declare
  result json;
begin
  select json_build_object(
    'project', row_to_json(p),
    'prepared_by', (select pr.full_name from profiles pr where pr.id = p.created_by),
    'cost_centres', (
      select coalesce(json_agg(
        json_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'stc_total', c.stc_total,
          'photo_groups', (
            select coalesce(json_agg(
              json_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::json)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          ),
          'line_items', (
            select coalesce(json_agg(
              json_build_object('description', li.description, 'amount', li.amount, 'quantity', li.quantity, 'item_type', li.item_type)
              order by li.sort_order
            ), '[]'::json)
            from (
              select cli.description as description,
                (case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                      else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                 end) as amount,
                cli.quantity as quantity,
                cli.item_type as item_type,
                cli.sort_order as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is null

              union all

              select max(cli.prebuild_client_description) as description,
                sum(case when cli.item_type = 'labour' then cli.quantity * cli.unit_cost
                         else cli.quantity * cli.unit_cost * (1 + coalesce(c.markup_percent, 45) / 100.0)
                    end) as amount,
                (array_agg(cli.quantity / nullif(cli.prebuild_base_quantity, 0) order by cli.sort_order))[1] as quantity,
                null::text as item_type,
                min(cli.sort_order) as sort_order
              from cost_centre_line_items cli
              where cli.cost_centre_id = c.id and cli.prebuild_group_id is not null
              group by cli.prebuild_group_id
            ) li
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c where c.project_id = p.id and c.variation_entry_id is null
    ),
    'payment_milestones', (
      select coalesce(json_agg(
        json_build_object('label', m.label, 'percent', m.percent)
        order by m.sort_order
      ), '[]'::json)
      from payment_milestones m where m.project_id = p.id
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result;
end;
$function$;
