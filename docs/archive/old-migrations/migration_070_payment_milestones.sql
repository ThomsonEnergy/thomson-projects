-- Migration 070 — Custom payment milestones on a quote
-- Run this in Supabase: SQL Editor > New query > paste > Run.
--
-- Lets a quote show its own named payment schedule (e.g. "10% deposit,
-- 40% on ordering materials, 20% on booking install day, 30% on
-- commissioning") instead of the fixed "deposit % now, remainder per
-- stage on completion" schedule. When a project has milestones, the
-- quote shows those; otherwise it falls back to the existing deposit-
-- percent schedule exactly as before.
--
-- This is DISPLAY ONLY on the quote for now - the deposit_percent field
-- still drives the actual automatic deposit invoice raised when a quote
-- is approved (see create-job-from-quote.js). The two aren't unified yet
-- since that would mean auto-detecting which milestone the "deposit" is
-- from free-text labels, which is worth doing properly later, not guessed.

create table if not exists payment_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  label text not null,
  percent numeric not null,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table payment_milestones enable row level security;
drop policy if exists "staff manage payment milestones" on payment_milestones;
create policy "staff manage payment milestones" on payment_milestones
  for all to authenticated using (true) with check (true);

-- The client-facing quote page reads via this token-based function
-- (no login), same as cost_centres already does - add milestones to its
-- output alongside them.
create or replace function get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result json;
begin
  select json_build_object(
    'project', row_to_json(p),
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
          )
        ) order by c.sort_order
      ), '[]'::json)
      from cost_centres c where c.project_id = p.id
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
$$;

grant execute on function get_quote_by_token(text) to anon, authenticated;
