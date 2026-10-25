-- Approve by phone, email or in person (with the client's email linked as proof) and Decline,
-- for quotes (projects) and fixed-price variations (job_variation_entries).
-- approval_method: 'online' (signed on the page), 'email', 'phone', 'in_person'.
-- declined_by empty with declined_at set = the client declined on their page.

alter table public.projects
  add column if not exists approval_method text,
  add column if not exists approval_email_thread_id uuid references public.email_threads(id) on delete set null,
  add column if not exists declined_at timestamptz,
  add column if not exists declined_by uuid references public.profiles(id) on delete set null,
  add column if not exists decline_reason text;

alter table public.job_variation_entries
  add column if not exists approval_method text,
  add column if not exists approval_note text,
  add column if not exists approved_by uuid references public.profiles(id) on delete set null,
  add column if not exists approval_email_thread_id uuid references public.email_threads(id) on delete set null,
  add column if not exists declined_at timestamptz,
  add column if not exists declined_by uuid references public.profiles(id) on delete set null,
  add column if not exists decline_reason text;

create index if not exists projects_approval_email_thread_idx on public.projects (approval_email_thread_id);
create index if not exists projects_declined_by_idx on public.projects (declined_by);
create index if not exists job_variation_entries_approved_by_idx on public.job_variation_entries (approved_by);
create index if not exists job_variation_entries_approval_email_thread_idx on public.job_variation_entries (approval_email_thread_id);
create index if not exists job_variation_entries_declined_by_idx on public.job_variation_entries (declined_by);

-- The variation page also shows how it was approved or why it was declined.
create or replace function public.get_variation_by_token(p_token uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  ve job_variation_entries%rowtype;
  p projects%rowtype;
  src_token text;
begin
  select * into ve from job_variation_entries
  where variation_token = p_token and variation_type = 'fixed' and coalesce(approval_status, 'draft') in ('draft', 'sent', 'approved', 'declined');
  if not found then
    return null;
  end if;
  select * into p from projects where id = ve.project_id;
  select coalesce((select s.quote_token from projects s where s.id = p.source_quote_id), p.quote_token) into src_token;

  return jsonb_build_object(
    'variation', jsonb_build_object(
      'id', ve.id, 'number', ve.variation_number, 'description', ve.description, 'reason', ve.reason,
      'lines', ve.fixed_lines, 'approval_status', ve.approval_status, 'sent_at', ve.sent_at,
      'approved_at', ve.approved_at, 'signed_by_name', ve.signed_by_name,
      'signature_data_url', case when ve.approval_status = 'approved' then ve.signature_data_url else null end,
      'approval_method', ve.approval_method, 'approval_note', ve.approval_note,
      'declined_at', ve.declined_at, 'decline_reason', ve.decline_reason,
      'job_number', p.job_number, 'job_name', p.name, 'client_name', p.client_name
    ),
    'quote', get_quote_by_token(src_token)::jsonb,
    'other_variations', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'number', o.variation_number, 'description', o.description, 'reason', o.reason,
        'lines', o.fixed_lines, 'approved_at', o.approved_at
      ) order by o.variation_number), '[]'::jsonb)
      from job_variation_entries o
      where o.project_id = ve.project_id and o.variation_type = 'fixed' and o.approval_status = 'approved' and o.id <> ve.id
    )
  );
end;
$function$;
