-- Bug fix (10 Nov 2026): sales and finance logins saw "Not mapped - set this in Settings > Xero Mapping"
-- under every invoice on the job page and in the invoice panel, although every mapping exists. Only admins
-- could read xero_account_mapping (one "Admin manages Xero mapping" policy for everything), so the browser
-- got an empty list for everyone else. Pricing roles can now read the table; writing stays admin only.
-- Push to Xero was never affected (it runs on the server).

drop policy if exists "Pricing roles read Xero mapping" on public.xero_account_mapping;
create policy "Pricing roles read Xero mapping" on public.xero_account_mapping
  for select to authenticated using ((select is_pricing_role()));
