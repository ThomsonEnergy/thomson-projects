-- Client statements (owner, 15 Nov 2026): one page per client listing every unpaid invoice across
-- all their jobs, each one linking to its own invoice page (where Pay online pays that invoice), with
-- the total owing and our bank details. Invoices themselves are not changed.
--  * clients.statement_token: the random link to the client's statement (statement.html?token=),
--    always current; the PDF is the statement as at the day it was made.
--  * get_client_statement_by_token: what the page shows, read through the token (anon), the same way
--    the invoice page reads get_invoice_by_token_v3.
-- An invoice is owing while it is not paid and its balance (after credit notes) is above zero; oldest
-- due first (no due date means due on receipt, so its invoice date).

alter table public.clients add column if not exists statement_token uuid not null default gen_random_uuid();
create unique index if not exists clients_statement_token_idx on public.clients (statement_token);

create or replace function public.get_client_statement_by_token(p_token uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_client clients%rowtype;
  v_company jsonb;
  v_rows jsonb;
begin
  if p_token is null then
    return null;
  end if;
  select * into v_client from clients where statement_token = p_token;
  if not found then
    return null;
  end if;

  select jsonb_build_object(
    'company_name', cs.company_name, 'abn', cs.abn, 'address', cs.address, 'phone', cs.phone, 'website', cs.website,
    'licenses', cs.licenses, 'logo_url', cs.logo_url, 'bank_name', cs.bank_name, 'bank_account_name', cs.bank_account_name,
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text,
    'late_interest_rate_pct', cs.late_interest_rate_pct)
  into v_company from company_settings cs where cs.id = 1;

  select coalesce(jsonb_agg(x.r order by coalesce(x.due_date, (x.sent_at at time zone 'Australia/Sydney')::date) nulls last, x.sent_at, x.invoice_number), '[]'::jsonb)
  into v_rows
  from (
    select i.due_date, i.sent_at, i.invoice_number,
      jsonb_build_object(
        'invoice_number', i.invoice_number,
        'invoice_token', i.invoice_token,
        'sent_at', i.sent_at,
        'due_date', i.due_date,
        'is_deposit', i.is_deposit,
        'is_interest', i.interest_of_invoice_id is not null,
        'job_number', p.job_number,
        'job_name', p.name,
        'site', p.client_address,
        'balance', b.bal,
        'interest_accrued', case when i.interest_enabled then interest_accrued(i) else 0 end
      ) as r
    from invoices i
    left join cost_centres cc on cc.id = i.cost_centre_id
    left join projects p on p.id = coalesce(i.project_id, cc.project_id)
    cross join lateral (select get_invoice_balance_due(i.id) as bal) b
    where coalesce(i.client_id, p.client_id) = v_client.id
      and i.paid_at is null
      and b.bal > 0.004
  ) x;

  return jsonb_build_object(
    'company', v_company,
    'client', jsonb_build_object('name', v_client.name, 'address', v_client.address),
    'as_at', sydney_today(),
    'invoices', v_rows
  );
end;
$$;
revoke execute on function public.get_client_statement_by_token(uuid) from public;
grant execute on function public.get_client_statement_by_token(uuid) to anon, authenticated;
