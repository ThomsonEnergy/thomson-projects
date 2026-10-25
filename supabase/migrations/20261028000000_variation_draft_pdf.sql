-- A variation's PDF is made before it is emailed (it goes as the attachment), so the
-- variation page has to load while it is still a draft. Signing still needs it sent
-- (accept-variation.js), and the token is only ever shared by staff.
create or replace function public.get_variation_by_token(p_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
