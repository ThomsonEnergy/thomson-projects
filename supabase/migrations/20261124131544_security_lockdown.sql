-- Security sweep of 23 Oct 2026 (docs/BUG_REVIEW_2026-10-23.md), delivery 1: database lockdown.
-- Owner's yes 23 Oct. Applied to production by hand in chunks the same night (the database tool
-- cannot run a drop statement, so the live apply used alter policy, revokes and create or replace;
-- the drop lines below run on staging and on any rebuild).
--
-- Sections
--   1  the four "secure" views: no writes through them, no anon reads, the two unused cost views go
--   2  anon (the public key): no table or function access except the client token functions and the website inserts
--   3  blanket "staff full access" policies replaced by role policies (S2, S20, S30, S39) and public selects to logged-in only (S4, S7)
--   4  guard triggers where every role still writes: projects, project_documents, profile_licences (S2, S17, S33, S36)
--   5  company settings behind a function for the public pages (S3) and the token functions trimmed (S10, S42)
--   6  function fixes: variation_material_add (M20), materials_price_fill (M33), po_line_set_tool (M34), schedule offer token (S18)
--   7  profiles: the missing column grants (F1) and the wider write guard (S17)
--   8  storage: delete your own files or be a pricing role (S23); lead uploads limited (S24)
--   9  column grants: api_keys values and the schedule offer token never reach the browser (S22, S18)
--  10  advisors: 120 foreign key indexes, 27 search paths (F22); the 107 policy rewrites are in 2b
--  11  the leftover tidy table (S5)

-- ---------------------------------------------------------------------------------------------------
-- 1. Views
-- ---------------------------------------------------------------------------------------------------
-- The profile views stay security definer on purpose: they mask pay and personal columns with
-- can_view_pay_rates(), and the API roles have no column grant on those columns (security_invoker would fail).
-- What was wrong: anon and authenticated held insert, update and delete on all four auto-updatable views.
revoke insert, update, delete, truncate, references, trigger on public.profiles_pay_rates_secure, public.profiles_sensitive_secure from public, anon, authenticated;
revoke select on public.profiles_pay_rates_secure, public.profiles_sensitive_secure from public, anon;
revoke all on public.cost_centre_line_items_secure, public.cost_centres_secure from public, anon, authenticated;
drop view if exists public.cost_centre_line_items_secure;
drop view if exists public.cost_centres_secure;

-- ---------------------------------------------------------------------------------------------------
-- 2. The public key (anon) can only use the client token functions and the website inserts
-- ---------------------------------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
grant insert on public.leads, public.callback_requests to anon;
revoke execute on all functions in schema public from anon;
-- Postgres grants execute to PUBLIC (every role) on each function by default. These were still open that way.
revoke execute on function public._po_qty(numeric) from public, anon;
grant execute on function public._po_qty(numeric) to authenticated;
revoke execute on function public.calculate_balance_due(numeric, numeric, numeric) from public, anon;
grant execute on function public.calculate_balance_due(numeric, numeric, numeric) to authenticated;
revoke execute on function public.calculate_balance_due(numeric, numeric, numeric, text) from public, anon;
grant execute on function public.calculate_balance_due(numeric, numeric, numeric, text) to authenticated;
revoke execute on function public.can_view_pay_rates(uuid) from public, anon;
grant execute on function public.can_view_pay_rates(uuid) to authenticated;
revoke execute on function public.can_view_sensitive_profile_data(uuid) from public, anon;
grant execute on function public.can_view_sensitive_profile_data(uuid) to authenticated;
revoke execute on function public.classify_timesheet_rate_category(timestamp with time zone) from public, anon;
grant execute on function public.classify_timesheet_rate_category(timestamp with time zone) to authenticated;
revoke execute on function public.current_profile_role() from public, anon;
grant execute on function public.current_profile_role() to authenticated;
revoke execute on function public.easter_sunday(integer) from public, anon;
grant execute on function public.easter_sunday(integer) to authenticated;
revoke execute on function public.get_next_number(text) from public, anon;
grant execute on function public.get_next_number(text) to authenticated;
revoke execute on function public.invoice_client_type(uuid) from public, anon;
grant execute on function public.invoice_client_type(uuid) to authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
revoke execute on function public.is_finance_role() from public, anon;
grant execute on function public.is_finance_role() to authenticated;
revoke execute on function public.is_pricing_role() from public, anon;
grant execute on function public.is_pricing_role() to authenticated;
revoke execute on function public.quote_valid_days() from public, anon;
grant execute on function public.quote_valid_days() to authenticated;
revoke execute on function public.stc_credit_inc_gst(numeric, text) from public, anon;
grant execute on function public.stc_credit_inc_gst(numeric, text) to authenticated;
revoke execute on function public.sydney_today() from public, anon;
grant execute on function public.sydney_today() to authenticated;
-- locked: nobody calls these from the API any more (S34, S10)
revoke execute on function public.generate_nsw_public_holidays(integer) from public, anon, authenticated;
revoke execute on function public.get_invoice_by_token(uuid) from public, anon, authenticated;
revoke execute on function public.get_invoice_by_token_v2(uuid) from public, anon, authenticated;
-- the client token functions and the website booking functions (anon by design)
revoke execute on function public.get_quote_by_token(text) from public;
grant execute on function public.get_quote_by_token(text) to anon, authenticated;
revoke execute on function public.get_variation_by_token(uuid) from public;
grant execute on function public.get_variation_by_token(uuid) to anon, authenticated;
revoke execute on function public.get_invoice_by_token_v3(uuid) from public;
grant execute on function public.get_invoice_by_token_v3(uuid) to anon, authenticated;
revoke execute on function public.get_po_by_token(uuid) from public;
grant execute on function public.get_po_by_token(uuid) to anon, authenticated;
revoke execute on function public.get_schedule_of_rates() from public;
grant execute on function public.get_schedule_of_rates() to anon, authenticated;
revoke execute on function public.book_callback_slot(date, time without time zone, text, text, text, text) from public;
grant execute on function public.book_callback_slot(date, time without time zone, text, text, text, text) to anon, authenticated;
revoke execute on function public.get_available_callback_slots(date, date) from public;
grant execute on function public.get_available_callback_slots(date, date) to anon, authenticated;
-- nothing made later is open to the public key or to every role by default
alter default privileges for role postgres in schema public revoke select, insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges for role postgres in schema public revoke usage, select, update on sequences from anon;
alter default privileges for role postgres in schema public revoke execute on functions from anon;
alter default privileges for role postgres in schema public revoke execute on functions from public;

-- ---------------------------------------------------------------------------------------------------
-- 2b. Advisor auth_rls_initplan (F22), before the hand-written policy changes below so those win
-- ---------------------------------------------------------------------------------------------------
-- Advisor auth_rls_initplan: every policy that re-evaluated auth.uid() or a role helper per row, rewritten with (select ...). Same names, roles and commands. Generated 23 Oct 2026 from production pg_policies.
alter policy "Everyone can write activity log" on public.activity_log
  with check (((select auth.uid()) IS NOT NULL));
alter policy "staff can manage their own chat jobs" on public.ai_chat_jobs
  using (((select auth.uid()) = user_id))
  with check (((select auth.uid()) = user_id));
alter policy "Users manage their own extraction jobs" on public.ai_extraction_jobs
  using (((created_by = (select auth.uid())) OR (select is_pricing_role())))
  with check (((created_by = (select auth.uid())) OR (select is_pricing_role())));
alter policy "Admins only" on public.api_keys
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "Pricing roles manage rate tiers" on public.billable_rate_tiers
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Authenticated can update callback requests" on public.callback_requests
  using (((select auth.uid()) IS NOT NULL));
alter policy "Authenticated can view callback requests" on public.callback_requests
  using (((select auth.uid()) IS NOT NULL));
alter policy "Pricing roles manage client contacts" on public.client_contacts
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Pricing roles manage clients" on public.clients
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Pricing roles can read company settings" on public.company_settings
  using ((select is_pricing_role()));
alter policy "Pricing roles can write company settings" on public.company_settings
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Authenticated can select line item rows" on public.cost_centre_line_items
  using (((select auth.uid()) IS NOT NULL));
alter policy "Only pricing roles can write line items" on public.cost_centre_line_items
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Authenticated can select rows" on public.cost_centres
  using (((select auth.uid()) IS NOT NULL));
alter policy "Only pricing roles can write" on public.cost_centres
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Finance/Admin manage credit notes" on public.credit_notes
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "Pricing roles manage dnsp records" on public.dnsp_records
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Admin manages allowances" on public.employee_allowances
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "admins manage employee contracts" on public.employee_contracts
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "Author or admin can delete comments" on public.feed_comments
  using ((((select auth.uid()) = author_id) OR (select is_admin())));
alter policy "Everyone can create comments" on public.feed_comments
  with check (((select auth.uid()) = author_id));
alter policy "Everyone can like" on public.feed_likes
  with check (((select auth.uid()) = author_id));
alter policy "Everyone can unlike their own like" on public.feed_likes
  using (((select auth.uid()) = author_id));
alter policy "Author can tag people" on public.feed_mentions
  with check ((((comment_id IS NULL) AND (EXISTS ( SELECT 1
   FROM feed_posts p
  WHERE ((p.id = feed_mentions.post_id) AND (p.author_id = (select auth.uid())))))) OR ((comment_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM feed_comments c
  WHERE ((c.id = feed_mentions.comment_id) AND (c.author_id = (select auth.uid()))))))));
alter policy "Author can untag" on public.feed_mentions
  using ((((comment_id IS NULL) AND (EXISTS ( SELECT 1
   FROM feed_posts p
  WHERE ((p.id = feed_mentions.post_id) AND (p.author_id = (select auth.uid())))))) OR ((comment_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM feed_comments c
  WHERE ((c.id = feed_mentions.comment_id) AND (c.author_id = (select auth.uid()))))))));
alter policy "Tagged person can mark seen" on public.feed_mentions
  using ((profile_id = (select auth.uid())))
  with check ((profile_id = (select auth.uid())));
alter policy "Author or admin can delete posts" on public.feed_posts
  using ((((select auth.uid()) = author_id) OR (select is_admin())));
alter policy "Author or admin can update posts" on public.feed_posts
  using ((((select auth.uid()) = author_id) OR (select is_admin())));
alter policy "Everyone can create posts" on public.feed_posts
  with check (((select auth.uid()) = author_id));
alter policy "Admin manages fleet" on public.fleet_vehicles
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "pricing roles on formbay_payment_advice_lines" on public.formbay_payment_advice_lines
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "pricing roles on formbay_payment_advices" on public.formbay_payment_advices
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "admin/finance manage incident actions" on public.incident_actions
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "admin/finance manage incident files" on public.incident_files
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "admin/finance manage incident people" on public.incident_people
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "admin/finance manage incident reports" on public.incident_reports
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "Everyone can view checklist items" on public.inspection_checklist_items
  using (((select auth.uid()) IS NOT NULL));
alter policy "Pricing roles delete checklist items" on public.inspection_checklist_items
  using ((select is_pricing_role()));
alter policy "Pricing roles manage checklist items" on public.inspection_checklist_items
  with check ((select is_pricing_role()));
alter policy "Pricing roles update checklist items" on public.inspection_checklist_items
  using ((select is_pricing_role()));
alter policy "Everyone can view checklist templates" on public.inspection_checklist_templates
  using (((select auth.uid()) IS NOT NULL));
alter policy "Pricing roles delete checklist templates" on public.inspection_checklist_templates
  using ((select is_pricing_role()));
alter policy "Pricing roles manage checklist templates" on public.inspection_checklist_templates
  with check ((select is_pricing_role()));
alter policy "Pricing roles update checklist templates" on public.inspection_checklist_templates
  using ((select is_pricing_role()));
alter policy "Pricing roles manage invoice line items" on public.invoice_line_items
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Pricing roles manage invoices" on public.invoices
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "pricing roles on job_stcs" on public.job_stcs
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Everyone can manage job tasks" on public.job_tasks
  using (((select auth.uid()) IS NOT NULL))
  with check (((select auth.uid()) IS NOT NULL));
alter policy "variation entries deletable" on public.job_variation_entries
  using ((((created_by = (select auth.uid())) AND (status = 'to_bill'::text)) OR (select is_pricing_role())));
alter policy "variation entries editable" on public.job_variation_entries
  using ((((created_by = (select auth.uid())) AND (status = 'to_bill'::text)) OR (select is_pricing_role())))
  with check ((((created_by = (select auth.uid())) AND (status = 'to_bill'::text)) OR (select is_pricing_role())));
alter policy "variation entries insertable" on public.job_variation_entries
  with check ((created_by = (select auth.uid())));
alter policy "variation hours deletable" on public.job_variation_hours
  using (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_hours.variation_id) AND (e.status = 'to_bill'::text)))))));
alter policy "variation hours editable" on public.job_variation_hours
  using (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_hours.variation_id) AND (e.status = 'to_bill'::text)))))))
  with check (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_hours.variation_id) AND (e.status = 'to_bill'::text)))))));
alter policy "variation hours insertable" on public.job_variation_hours
  with check (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (staff_id = (select auth.uid())) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_hours.variation_id) AND (e.status = 'to_bill'::text)))))));
alter policy "variation materials deletable" on public.job_variation_materials
  using (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (kind <> 'other'::text) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_materials.variation_id) AND (e.status = 'to_bill'::text)))))));
alter policy "variation materials editable" on public.job_variation_materials
  using (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (kind <> 'other'::text) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_materials.variation_id) AND (e.status = 'to_bill'::text)))))))
  with check (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (kind <> 'other'::text) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_materials.variation_id) AND (e.status = 'to_bill'::text)))))));
alter policy "variation materials insertable" on public.job_variation_materials
  with check (((select is_pricing_role()) OR ((created_by = (select auth.uid())) AND (kind <> 'other'::text) AND (EXISTS ( SELECT 1
   FROM job_variation_entries e
  WHERE ((e.id = job_variation_materials.variation_id) AND (e.status = 'to_bill'::text)))))));
alter policy "Pricing roles can update leads" on public.leads
  using ((select is_pricing_role()));
alter policy "Pricing roles can view leads" on public.leads
  using ((select is_pricing_role()));
alter policy "Admins can decide leave requests" on public.leave_requests
  using (((select is_admin()) OR (select is_finance_role())));
alter policy "Admins can view and decide all leave requests" on public.leave_requests
  using (((select is_admin()) OR (select is_pricing_role())));
alter policy "Admin manages licence shares" on public.licence_shares
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "Pricing roles manage materials" on public.materials
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Users delete own notifications" on public.notifications
  using ((user_id = (select auth.uid())));
alter policy "Users read own notifications" on public.notifications
  using ((user_id = (select auth.uid())));
alter policy "Users update own notifications" on public.notifications
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));
alter policy "staff can sign their own onboarding documents" on public.onboarding_document_signatures
  with check ((profile_id = (select auth.uid())));
alter policy "admins can manage onboarding documents" on public.onboarding_documents
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "finance full access on overhead_lines" on public.overhead_lines
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "finance full access on overhead_people" on public.overhead_people
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "finance full access on overhead_settings" on public.overhead_settings
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "finance full access on overhead_xero_map" on public.overhead_xero_map
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "Pricing roles manage prebuild components" on public.prebuild_components
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Pricing roles manage prebuilds" on public.prebuilds
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Admin manages licences" on public.profile_licences
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "staff can manage own licences" on public.profile_licences
  using ((profile_id = (select auth.uid())))
  with check ((profile_id = (select auth.uid())));
alter policy "Admins can update any profile" on public.profiles
  using ((select is_admin()));
alter policy "Finance can update any profile" on public.profiles
  using (((select current_profile_role()) = 'finance'::text))
  with check (((select current_profile_role()) = 'finance'::text));
alter policy "Users can update own profile" on public.profiles
  using (((select auth.uid()) = id));
alter policy "View own or admin views all" on public.profiles
  using ((((select auth.uid()) = id) OR (select is_admin())));
alter policy "Everyone can add project field notes" on public.project_field_notes
  with check (((select auth.uid()) IS NOT NULL));
alter policy "Everyone can add project photos" on public.project_photos
  with check (((select auth.uid()) IS NOT NULL));
alter policy "Everyone can rename project photos" on public.project_photos
  using (((select auth.uid()) IS NOT NULL))
  with check (((select auth.uid()) IS NOT NULL));
alter policy "Authenticated can access projects" on public.projects
  using (((select auth.uid()) IS NOT NULL))
  with check (((select auth.uid()) IS NOT NULL));
alter policy "Admin manages public holidays" on public.public_holidays
  using ((select is_admin()))
  with check ((select is_admin()));
alter policy "Everyone can add PO line items" on public.purchase_order_line_items
  with check (((select auth.uid()) IS NOT NULL));
alter policy "Users manage own push subscriptions" on public.push_subscriptions
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));
alter policy "Pricing roles manage quote compliance answers" on public.quote_compliance_answers
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Authenticated can view schedule" on public.schedule_assignments
  using (((select auth.uid()) IS NOT NULL));
alter policy "Pricing roles can manage schedule" on public.schedule_assignments
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Authenticated can update site inspections" on public.site_inspections
  using (((select auth.uid()) IS NOT NULL));
alter policy "Everyone can view site inspections" on public.site_inspections
  using (((select auth.uid()) IS NOT NULL));
alter policy "Pricing roles create site inspections" on public.site_inspections
  with check ((select is_pricing_role()));
alter policy "Pricing roles delete site inspections" on public.site_inspections
  using ((select is_pricing_role()));
alter policy "admins read sm8_attachment_copies" on public.sm8_attachment_copies
  using ((select is_admin()));
alter policy "admin/finance manage staff files" on public.staff_files
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "admin/finance manage staff kpis" on public.staff_kpis
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "employee reads own kpis" on public.staff_kpis
  using ((profile_id = (select auth.uid())));
alter policy "admin/finance manage staff warnings" on public.staff_warnings
  using ((select is_finance_role()))
  with check ((select is_finance_role()));
alter policy "employee reads own sent letters" on public.staff_warnings
  using (((profile_id = (select auth.uid())) AND (sent_to_employee_at IS NOT NULL) AND (status <> 'draft'::text)));
alter policy "Pricing roles manage suppliers" on public.suppliers
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));
alter policy "Finance roles can add time entries for staff" on public.time_entries
  with check ((select is_finance_role()));
alter policy "Finance roles can delete time entries for staff" on public.time_entries
  using ((select is_finance_role()));
alter policy "Pricing roles can correct time entries" on public.time_entries
  using ((select is_pricing_role()));
alter policy "Pricing roles can view all time entries" on public.time_entries
  using ((select is_pricing_role()));
alter policy "Staff can manage own time entries" on public.time_entries
  using (((select auth.uid()) = staff_id))
  with check (((select auth.uid()) = staff_id));
alter policy "Pricing roles manage Xero mapping" on public.xero_account_mapping
  using ((select is_pricing_role()))
  with check ((select is_pricing_role()));


-- ---------------------------------------------------------------------------------------------------
-- 3. Blanket policies replaced by role policies; public selects to logged-in users only
-- ---------------------------------------------------------------------------------------------------
-- company_settings: logged-in users read, pricing roles write (the public pages use get_public_company_settings)
alter policy "staff full access on company_settings" on public.company_settings to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff full access on company_settings" on public.company_settings rename to "Pricing roles manage company settings";
alter policy "public can read company_settings" on public.company_settings to authenticated;
alter policy "public can read company_settings" on public.company_settings rename to "Logged-in users can read company settings";
-- stages, line items, claims, milestones: pricing roles write (claims on credit notes: finance). Everyone reads stages.
alter policy "staff full access on cost_centres" on public.cost_centres to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff full access on cost_centres" on public.cost_centres rename to "Pricing roles manage cost centres";
drop policy if exists "Any role can add the blank first stage of a quick job" on public.cost_centres;
create policy "Any role can add the blank first stage of a quick job" on public.cost_centres for insert to authenticated
  with check (coalesce(quoted_amount, 0) = 0 and coalesce(estimated_labour_cost, 0) = 0 and coalesce(estimated_material_cost, 0) = 0
              and coalesce(stc_total, 0) = 0 and coalesce(invoiced_amount, 0) = 0 and variation_entry_id is null);
alter policy "staff full access on cost_centre_line_items" on public.cost_centre_line_items to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff full access on cost_centre_line_items" on public.cost_centre_line_items rename to "Pricing roles manage line items";
alter policy "staff full access on invoice_claims" on public.invoice_claims to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff full access on invoice_claims" on public.invoice_claims rename to "Pricing roles manage invoice claims";
alter policy "staff full access on credit_note_claims" on public.credit_note_claims to authenticated using ((select is_finance_role())) with check ((select is_finance_role()));
alter policy "staff full access on credit_note_claims" on public.credit_note_claims rename to "Finance roles manage credit note claims";
alter policy "staff manage payment milestones" on public.payment_milestones to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff manage payment milestones" on public.payment_milestones rename to "Pricing roles manage payment milestones";
-- variations (signed stage changes): pricing roles write, everyone reads
alter policy "staff full access on variations" on public.variations to authenticated using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff full access on variations" on public.variations rename to "Pricing roles manage variations";
drop policy if exists "Logged-in users can read variations" on public.variations;
create policy "Logged-in users can read variations" on public.variations for select to authenticated using (true);
-- projects and project_documents keep their open policies: every role writes them on site. The guard triggers in
-- section 4 decide which columns and rows a non-pricing role may touch.
alter policy "Authenticated can access projects" on public.projects to authenticated using (((select auth.uid()) is not null)) with check (((select auth.uid()) is not null));
-- supplier bills and payments: finance writes, pricing roles read (S20)
alter policy "Pricing roles manage supplier bills" on public.supplier_bills using ((select is_finance_role())) with check ((select is_finance_role()));
alter policy "Pricing roles manage supplier bills" on public.supplier_bills rename to "Finance roles manage supplier bills";
drop policy if exists "Pricing roles read supplier bills" on public.supplier_bills;
create policy "Pricing roles read supplier bills" on public.supplier_bills for select to authenticated using ((select is_pricing_role()));
alter policy "Pricing roles manage supplier payments" on public.supplier_payments using ((select is_finance_role())) with check ((select is_finance_role()));
alter policy "Pricing roles manage supplier payments" on public.supplier_payments rename to "Finance roles manage supplier payments";
drop policy if exists "Pricing roles read supplier payments" on public.supplier_payments;
create policy "Pricing roles read supplier payments" on public.supplier_payments for select to authenticated using ((select is_pricing_role()));
-- Xero account mapping: admin only (S39)
alter policy "Pricing roles manage Xero mapping" on public.xero_account_mapping to authenticated using ((select is_admin())) with check ((select is_admin()));
alter policy "Pricing roles manage Xero mapping" on public.xero_account_mapping rename to "Admin manages Xero mapping";
-- client sites: any role may add one (quick job at a new address), pricing roles change or remove (S30)
alter policy "staff edit client_sites" on public.client_sites using ((select is_pricing_role())) with check ((select is_pricing_role()));
alter policy "staff remove client_sites" on public.client_sites using ((select is_pricing_role()));
-- activity log: logged-in users read, and a row is always written as yourself (S4)
alter policy "Everyone can view activity log" on public.activity_log to authenticated;
alter policy "Everyone can write activity log" on public.activity_log to authenticated with check ((changed_by = (select auth.uid())));
-- tables anyone with the public key could read: logged-in users only (S7)
alter policy "Everyone can view project field notes" on public.project_field_notes to authenticated;
alter policy "Everyone can read posts" on public.feed_posts to authenticated;
alter policy "Everyone can read comments" on public.feed_comments to authenticated;
alter policy "Everyone can read likes" on public.feed_likes to authenticated;
alter policy "Everyone can view fleet" on public.fleet_vehicles to authenticated;
alter policy "Everyone can view project photos" on public.project_photos to authenticated;
alter policy "Everyone can read public holidays" on public.public_holidays to authenticated;
alter policy "Everyone can view job tasks" on public.job_tasks to authenticated;
alter policy "Everyone can manage job tasks" on public.job_tasks to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 4. Guard triggers (named aaa_ so they run before the other before-triggers and see the row as sent)
-- ---------------------------------------------------------------------------------------------------
create or replace function public.guard_projects_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_allowed text[] := array['pipeline_stage', 'ccew_file_path', 'ccew_not_required_reason', 'nmi', 'panel_serial_numbers',
                            'inverter_serial_numbers', 'notes', 'needs_site_visit'];
  v_key text;
begin
  -- the server (service role) and migrations have no user: nothing to guard
  if v_uid is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    if not is_pricing_role() then
      raise exception 'Only Admin, Finance or Sales can delete a job or quote.';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if not is_pricing_role() then
      -- a job with no quote (My Day "+ New job") is the only kind a field role can add
      if new.proposal_template is distinct from 'direct_job' or new.pipeline_stage is distinct from 'ready_to_book'
         or new.quote_number is not null or coalesce(new.stc_total, 0) <> 0 or coalesce(new.bstc_total, 0) <> 0
         or new.deposit_percent is not null or new.roi_inputs is not null or new.bill_reading is not null
         or new.approved_at is not null or new.send_gate_override_at is not null then
        raise exception 'Only Admin, Finance or Sales can create a quote. You can add a job with no quote.';
      end if;
    end if;
    return new;
  end if;

  -- UPDATE
  if is_pricing_role() then
    if not is_finance_role()
       and (new.send_gate_override_reason is distinct from old.send_gate_override_reason
            or new.send_gate_override_at is distinct from old.send_gate_override_at) then
      raise exception 'Only Admin or Finance can override the ready-to-send check.';
    end if;
    return new;
  end if;

  -- a field role: only the site columns may change
  for v_key in select key from jsonb_each(to_jsonb(new)) loop
    if not (v_key = any (v_allowed)) and (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
      raise exception 'Only Admin, Finance or Sales can change % on a job or quote.', v_key;
    end if;
  end loop;
  if new.pipeline_stage is distinct from old.pipeline_stage
     and new.pipeline_stage not in ('client_handover', 'job_not_complete', 'ready_to_invoice', 'awaiting_action', 'ready_to_book', 'quote_sent') then
    raise exception 'That stage move needs Admin, Finance or Sales.';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_projects_writes() from public, anon, authenticated;
drop trigger if exists aaa_guard_projects_writes on public.projects;
create trigger aaa_guard_projects_writes before insert or update or delete on public.projects
  for each row execute function public.guard_projects_writes();

create or replace function public.guard_project_documents_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_key text;
begin
  if v_uid is null or is_pricing_role() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.uploaded_by is distinct from v_uid then
      raise exception 'Only the person who uploaded this document, or Admin, Finance or Sales, can delete it.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.uploaded_by is distinct from v_uid then
      raise exception 'A document is always filed as yourself.';
    end if;
    if new.folder = 'Electricity bill' then
      raise exception 'Only Admin, Finance or Sales can file an electricity bill.';
    end if;
    return new;
  end if;
  -- UPDATE: rename pages, replace with a marked-up copy, save the plan summary; nothing else
  for v_key in select key from jsonb_each(to_jsonb(new)) loop
    if v_key not in ('file_path', 'file_name', 'page_names', 'plan_summary')
       and (to_jsonb(new) -> v_key) is distinct from (to_jsonb(old) -> v_key) then
      raise exception 'Only Admin, Finance or Sales can change % on a document.', v_key;
    end if;
  end loop;
  return new;
end;
$$;
revoke execute on function public.guard_project_documents_writes() from public, anon, authenticated;
drop trigger if exists aaa_guard_project_documents_writes on public.project_documents;
create trigger aaa_guard_project_documents_writes before insert or update or delete on public.project_documents
  for each row execute function public.guard_project_documents_writes();

create or replace function public.guard_profile_licences_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or is_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  -- a licence file is the one you uploaded through the licence form, never another path in the bucket (S36)
  if new.file_path is not null and new.file_path !~ '^licence-docs/' then
    raise exception 'Upload the licence file through the licence form.';
  end if;
  if tg_op = 'UPDATE' and (new.profile_id is distinct from old.profile_id
       or new.update_requested_at is distinct from old.update_requested_at
       or new.update_requested_by is distinct from old.update_requested_by
       or new.notes_updated_by is distinct from old.notes_updated_by) then
    raise exception 'Those fields are set by the app.';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_profile_licences_writes() from public, anon, authenticated;
drop trigger if exists aaa_guard_profile_licences_writes on public.profile_licences;
create trigger aaa_guard_profile_licences_writes before insert or update or delete on public.profile_licences
  for each row execute function public.guard_profile_licences_writes();

-- ---------------------------------------------------------------------------------------------------
-- 5. Company settings for the public pages, and the token functions trimmed to what the pages read
-- ---------------------------------------------------------------------------------------------------
create or replace function public.get_public_company_settings()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'company_name', company_name, 'abn', abn, 'address', address, 'phone', phone, 'website', website,
    'licenses', licenses, 'logo_url', logo_url, 'tagline', tagline, 'rates_reviewed_on', rates_reviewed_on)
  from company_settings where id = 1;
$$;
revoke execute on function public.get_public_company_settings() from public, anon, authenticated;
grant execute on function public.get_public_company_settings() to anon, authenticated;

-- get_invoice_by_token_v3: the invoice row and the company row are no longer sent whole (Xero ids, pdf paths,
-- the Google Maps key, counters), and the internal cost price of every material line is gone (S10).
create or replace function public.get_invoice_by_token_v3(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice invoices%rowtype;
  v_company jsonb;
  v_project jsonb;
  v_claims jsonb := '[]'::jsonb;
  v_previous jsonb := '[]'::jsonb;
  v_balance numeric;
  v_is_standalone boolean;
  v_project_id uuid;
  v_client_type text;
begin
  select * into v_invoice from invoices where invoice_token = p_token;
  if not found then
    return null;
  end if;

  select get_invoice_balance_due(v_invoice.id) into v_balance;
  v_client_type := invoice_client_type(v_invoice.id);
  select jsonb_build_object(
    'company_name', cs.company_name, 'abn', cs.abn, 'address', cs.address, 'phone', cs.phone, 'website', cs.website,
    'licenses', cs.licenses, 'logo_url', cs.logo_url, 'bank_name', cs.bank_name, 'bank_account_name', cs.bank_account_name,
    'bank_bsb', cs.bank_bsb, 'bank_account_number', cs.bank_account_number, 'payment_details_text', cs.payment_details_text)
  into v_company from company_settings cs where cs.id = 1;

  v_is_standalone := v_invoice.project_id is null and v_invoice.cost_centre_id is null;
  v_project_id := coalesce(v_invoice.project_id, (select cc.project_id from cost_centres cc where cc.id = v_invoice.cost_centre_id));

  if not v_is_standalone then
    select jsonb_build_object(
      'job_number', p.job_number,
      'quote_number', p.quote_number,
      'name', p.name,
      'client_name', p.client_name,
      'client_address', p.client_address,
      'client_office_address', (select c.address from clients c where c.id = p.client_id)
    ) into v_project
    from projects p where p.id = v_project_id;
  else
    select jsonb_build_object('client_name', c.name, 'client_address', c.address, 'client_office_address', c.address)
    into v_project
    from clients c where c.id = v_invoice.client_id;
  end if;

  if exists (select 1 from invoice_claims ic where ic.invoice_id = v_invoice.id) then
    select jsonb_agg(jsonb_build_object(
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', ic.labour_amount,
      'material_amount', ic.material_amount,
      'claimed_before', coalesce((
        select sum(x.amt) from (
          select ic2.labour_amount + ic2.material_amount as amt
          from invoice_claims ic2 join invoices i2 on i2.id = ic2.invoice_id
          where ic2.cost_centre_id = cc.id and i2.id <> v_invoice.id and i2.created_at < v_invoice.created_at
          union all
          select i3.labour_amount + i3.material_amount
          from invoices i3
          where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
            and not exists (select 1 from invoice_claims ic3 where ic3.invoice_id = i3.id)
          union all
          select -(cnc.labour_amount + cnc.material_amount)
          from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
          where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
        ) x
      ), 0),
      'invoice_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'description', ili.description, 'quantity', ili.quantity,
          'unit_price', ili.unit_price, 'labour_amount', ili.labour_amount, 'material_amount', ili.material_amount
        ) order by ili.sort_order, ili.created_at)
        from invoice_line_items ili where ili.invoice_claim_id = ic.id
      ), '[]'::jsonb)
    ) order by cc.sort_order)
    into v_claims
    from invoice_claims ic join cost_centres cc on cc.id = ic.cost_centre_id
    where ic.invoice_id = v_invoice.id;
  elsif v_invoice.cost_centre_id is not null then
    select jsonb_build_array(jsonb_build_object(
      'cost_centre_name', cc.name,
      'quoted_amount', cc.quoted_amount,
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'claimed_before', coalesce((
        select sum(i3.labour_amount + i3.material_amount)
        from invoices i3
        where i3.cost_centre_id = cc.id and i3.id <> v_invoice.id and i3.created_at < v_invoice.created_at
      ), 0) - coalesce((
        select sum(cnc.labour_amount + cnc.material_amount)
        from credit_note_claims cnc join credit_notes cn on cn.id = cnc.credit_note_id
        where cnc.cost_centre_id = cc.id and cn.created_at < v_invoice.created_at
      ), 0),
      'invoice_items', '[]'::jsonb
    ))
    into v_claims
    from cost_centres cc where cc.id = v_invoice.cost_centre_id;
  end if;

  if not v_is_standalone then
    select coalesce(jsonb_agg(jsonb_build_object(
      'invoice_number', i.invoice_number,
      'sent_at', i.sent_at,
      'amount', i.labour_amount + i.material_amount
    ) order by i.sent_at), '[]'::jsonb)
    into v_previous
    from invoices i
    where i.id <> v_invoice.id
      and coalesce(i.project_id, (select cc.project_id from cost_centres cc where cc.id = i.cost_centre_id)) = v_project_id
      and i.created_at < v_invoice.created_at;
  end if;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'invoice_number', v_invoice.invoice_number,
      'description', v_invoice.description,
      'labour_amount', v_invoice.labour_amount,
      'material_amount', v_invoice.material_amount,
      'stc_amount', v_invoice.stc_amount,
      'bstc_amount', v_invoice.bstc_amount,
      'is_deposit', v_invoice.is_deposit,
      'sent_at', v_invoice.sent_at,
      'due_date', v_invoice.due_date,
      'paid_at', v_invoice.paid_at,
      'balance_due', v_balance,
      'client_type', v_client_type,
      'stc_credit_inc_gst', stc_credit_inc_gst(v_invoice.stc_amount, v_client_type),
      'bstc_credit_inc_gst', stc_credit_inc_gst(v_invoice.bstc_amount, v_client_type)
    ),
    'project', v_project,
    'company', v_company,
    'is_standalone', v_is_standalone,
    'claims', v_claims,
    'previous_invoices', v_previous
  );
end;
$$;
revoke execute on function public.get_invoice_by_token_v3(uuid) from public;
grant execute on function public.get_invoice_by_token_v3(uuid) to anon, authenticated;

-- get_quote_by_token: the bill reading, the Pylon data and the savings inputs go out as the fields the
-- proposal reads, not whole (NMI, account holder, supply address, installer notes and the reader's uuid stay in) (S42).
-- client_office_address now also sits under project, where quote.html looks for it.
create or replace function public.get_quote_by_token(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'project', (
      (select jsonb_object_agg(e.key, e.value)
       from jsonb_each(to_jsonb(p)) e
       where e.key = any (array['id', 'name', 'client_name', 'client_address', 'status', 'quote_token', 'quote_number', 'job_number',
         'terms_text', 'cover_photos', 'reference_photos', 'created_at', 'sent_at', 'sow_text', 'proposal_subtitle', 'deposit_percent',
         'pylon_link', 'proposal_template', 'estimate_disclaimer_text', 'approved_at', 'approval_method', 'approval_note',
         'accepted_signed_by_name', 'accepted_signature_data_url', 'declined_at', 'valid_until', 'expired', 'show_investment_breakdown',
         'stc_quantity', 'stc_total', 'bstc_quantity', 'bstc_total', 'stc_system_kw', 'stc_zone_rating', 'show_roi', 'battery_kwh']))
      || jsonb_build_object(
        'client_office_address', (select cl.address from clients cl where cl.id = p.client_id),
        'bill_reading', case when p.bill_reading is null then null else (
          select jsonb_object_agg(e.key, e.value) from jsonb_each(p.bill_reading) e
          where e.key = any (array['retailer', 'billing_days', 'bill_total', 'total_kwh', 'daily_average_kwh', 'peak_kwh', 'off_peak_kwh',
            'shoulder_kwh', 'controlled_load_kwh', 'solar_export_kwh', 'solar_soak_kwh', 'feed_in_c_per_kwh', 'usage_rate_c_per_kwh',
            'usage_rates', 'supply_charge_c_per_day', 'tariff_type', 'tou_hours', 'tou_other', 'tou_schedule'])) end,
        'pylon_data', case when p.pylon_data is null then null else jsonb_build_object(
          'module_types', p.pylon_data -> 'module_types',
          'inverter_types', p.pylon_data -> 'inverter_types',
          'storage_types', p.pylon_data -> 'storage_types',
          'summary', jsonb_build_object('dc_output_kw', p.pylon_data -> 'summary' -> 'dc_output_kw')) end,
        'roi_inputs', case when p.roi_inputs is null then null else (
          select jsonb_object_agg(e.key, e.value) from jsonb_each(p.roi_inputs) e
          where e.key = any (array['solar_price', 'battery_price', 'current', 'alt', 'plan_options'])) end
      )
    ),
    -- the pre-quote answers the savings estimate needs (never the whole set: it holds private notes)
    'roi_answers', jsonb_build_object(
      'existing_system', p.template_answers ->> 'existing_system',
      'existing_system_detail', p.template_answers ->> 'existing_system_detail',
      'existing_pv', p.template_answers ->> 'existing_pv',
      'with_battery', p.template_answers ->> 'with_battery',
      'battery_kwh_wanted', p.template_answers ->> 'battery_kwh_wanted',
      'export_limit', p.template_answers ->> 'export_limit'
    ),
    'client_type', coalesce((select cl.client_type from clients cl where cl.id = p.client_id), 'individual'),
    'client_office_address', (select cl.address from clients cl where cl.id = p.client_id),
    'prepared_by', (select pr.full_name from profiles pr where pr.id = p.created_by),
    'cost_centres', (
      select coalesce(jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'name', c.name,
          'description', c.description,
          'sort_order', c.sort_order,
          'quoted_amount', c.quoted_amount,
          'stc_total', c.stc_total,
          'is_variation', (c.variation_entry_id is not null),
          'photo_groups', (
            select coalesce(jsonb_agg(
              jsonb_build_object('description', g.description, 'photos', g.photos)
              order by g.sort_order
            ), '[]'::jsonb)
            from cost_centre_photo_groups g
            where g.cost_centre_id = c.id
          ),
          'line_items', (
            select coalesce(jsonb_agg(
              jsonb_build_object('description', li.description, 'amount', li.amount, 'quantity', li.quantity, 'item_type', li.item_type)
              order by li.sort_order
            ), '[]'::jsonb)
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
      ), '[]'::jsonb)
      from cost_centres c
      left join job_variation_entries ve on ve.id = c.variation_entry_id
      where c.project_id = p.id
        and (c.variation_entry_id is null or (ve.variation_type = 'fixed' and ve.approval_status = 'approved'))
    ),
    'payment_milestones', (
      select coalesce(jsonb_agg(
        jsonb_build_object('label', m.label, 'percent', m.percent)
        order by m.sort_order
      ), '[]'::jsonb)
      from payment_milestones m where m.project_id = p.id
    ),
    'schedule_of_rates', (
      case when p.proposal_template = 'quick_estimate' then (
        select coalesce(jsonb_agg(
          jsonb_build_object('name', t.name, 'sell_rate', t.sell_rate)
          order by t.sort_order
        ), '[]'::jsonb)
        from billable_rate_tiers t
      ) else null end
    )
  ) into result
  from projects p
  where p.quote_token = p_token;

  return result::json;
end;
$$;
revoke execute on function public.get_quote_by_token(text) from public;
grant execute on function public.get_quote_by_token(text) to anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 6. Function fixes
-- ---------------------------------------------------------------------------------------------------
-- M20: a field role can only add materials to a do-and-charge variation that is still open
create or replace function public.variation_material_add(p_variation_id uuid, p_kind text, p_material_id uuid, p_prebuild_id uuid, p_description text, p_quantity numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_project uuid;
  v_id uuid;
  v_have numeric;
  m materials;
  e job_variation_entries;
begin
  if auth.uid() is null then raise exception 'Log in first.'; end if;
  if p_kind not in ('material', 'prebuild') then raise exception 'Pick a Stock item or a prebuild.'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Enter the quantity.'; end if;
  select * into e from job_variation_entries where id = p_variation_id;
  if e.id is null then raise exception 'Variation not found.'; end if;
  v_project := e.project_id;
  if not coalesce(is_pricing_role() or (e.status = 'to_bill' and coalesce(e.variation_type, '') <> 'fixed'), false) then
    raise exception 'This variation is no longer open. Ask Admin, Finance or Sales to add to it.';
  end if;
  if p_kind = 'material' then
    select * into m from materials where id = p_material_id for update;
    if not found then raise exception 'Stock item not found.'; end if;
  end if;
  insert into job_variation_materials (variation_id, project_id, kind, material_id, prebuild_id, description, quantity, created_by, stock_deducted)
  values (p_variation_id, v_project, p_kind, case when p_kind = 'material' then p_material_id end, case when p_kind = 'prebuild' then p_prebuild_id end,
          coalesce(nullif(trim(p_description), ''), m.name, 'Item'), p_quantity, auth.uid(), p_kind = 'material')
  returning id into v_id;
  if p_kind = 'material' then
    select coalesce(sum(quantity), 0) into v_have from material_stock_by_location where material_id = m.id and location_type = 'warehouse';
    perform _stock_adjust(m.id, 'warehouse', null, -p_quantity, true);
    if v_have < p_quantity then
      perform _po_log('material', m.id, 'stock_count_corrected', format('Warehouse count set to 0: app had %s, %s taken for a variation on %s', _po_qty(v_have), _po_qty(p_quantity), _po_job_ref(v_project)));
    end if;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.variation_material_add(uuid, text, uuid, uuid, text, numeric) from public, anon;
grant execute on function public.variation_material_add(uuid, text, uuid, uuid, text, numeric) to authenticated;

-- M33: pricing a $0 material only reprices the job cost rows that came out of stock, never a line received from a PO at $0
create or replace function public.materials_price_fill()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.cost_price, 0) > 0 and coalesce(old.cost_price, 0) = 0 then
    new.needs_price := false;
    perform set_config('teops.po_step', 'on', true);
    update purchase_order_line_items l set unit_cost = new.cost_price
      from purchase_orders p where p.id = l.po_id and p.stock_source is not null and l.material_id = new.id and coalesce(l.unit_cost, 0) = 0;
    update job_material_usage set unit_cost = new.cost_price where material_id = new.id and coalesce(unit_cost, 0) = 0 and source = 'from_stock';
    perform _po_log('material', new.id, 'priced', format('Priced at $%s: stock pull lines and job costs that were at $0 updated', to_char(new.cost_price, 'FM999G999G990D00')));
  end if;
  return new;
end;
$$;

-- M34: "This is a tool" / "Not a tool" respects a closed PO like every other PO step
create or replace function public.po_line_set_tool(p_line_id uuid, p_is_tool boolean, p_kind text default 'tool'::text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  li purchase_order_line_items;
  po purchase_orders;
  v_vehicle uuid;
begin
  if not is_pricing_role() then raise exception 'Only Admin, Finance or Sales can mark a line as a tool.'; end if;
  perform set_config('teops.po_step', 'on', true);
  select * into li from purchase_order_line_items where id = p_line_id for update;
  if not found then raise exception 'That line no longer exists.'; end if;
  select * into po from purchase_orders where id = li.po_id;
  if po.closed_at is not null then raise exception 'This PO is closed. Reopen it first.'; end if;
  if p_is_tool and coalesce(p_kind, 'tool') not in ('tool', 'perishable') then raise exception 'Tool or perishable?'; end if;
  if li.received then
    v_vehicle := li.destination_vehicle_id;
    perform _po_line_take_back(li.id, li.quantity);
    update purchase_order_line_items set is_tool = p_is_tool, tool_kind = case when p_is_tool then coalesce(p_kind, 'tool') end, received = false where id = li.id;
    if p_is_tool then
      perform _po_line_land(li.id, 'tools', null, v_vehicle, null, false);
    else
      perform _po_line_land(li.id, case when po.project_id is not null then 'job' when v_vehicle is not null then 'vehicle' else 'warehouse' end, po.project_id, v_vehicle, po.cost_centre_id, false);
    end if;
  else
    update purchase_order_line_items set is_tool = p_is_tool, tool_kind = case when p_is_tool then coalesce(p_kind, 'tool') end where id = li.id;
  end if;
  perform _po_log('purchase_order', po.id, 'line_tool', format('%s x%s marked %s', li.description, _po_qty(li.quantity), case when p_is_tool then 'a ' || coalesce(p_kind, 'tool') || ' (goes to the Tools register, not the job or stock)' else 'not a tool' end));
  if po.project_id is not null then perform _po_log('project', po.project_id, 'po_line_tool', format('PO %s: %s marked %s', po.po_number, li.description, case when p_is_tool then 'a tool, off this job''s costs' else 'not a tool, costed to this job' end)); end if;
  perform _po_sync_received(po.id);
end;
$$;
revoke execute on function public.po_line_set_tool(uuid, boolean, text) from public, anon;
grant execute on function public.po_line_set_tool(uuid, boolean, text) to authenticated;

-- S18: the client's pick-a-time link is handed out only to pricing roles, by this function, never by a select
create or replace function public.schedule_offer_token(p_offer_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.token from schedule_time_offers o where o.id = p_offer_id and is_pricing_role();
$$;
revoke execute on function public.schedule_offer_token(uuid) from public, anon;
grant execute on function public.schedule_offer_token(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 7. Profiles
-- ---------------------------------------------------------------------------------------------------
-- F1: the three columns added since 19 Oct had no select grant, so the Staff page threw for everyone (applied 23 Oct, kept for the record)
grant select (site_rank, spellcheck_mode, notification_prefs) on public.profiles to authenticated;

-- S17: a staff member can no longer set their own Xero link, payroll status, site rank, the Admin's notes or the pay flags.
-- (onboarding_completed_at stays: the onboarding page sets it after the documents are signed.)
create or replace function public.guard_profiles_writes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    return new;
  end if;

  if is_admin() then
    return new;
  end if;

  if current_profile_role() = 'finance' and old.id <> auth.uid() then
    if (to_jsonb(new) - 'job_title') is distinct from (to_jsonb(old) - 'job_title') then
      raise exception 'Finance can only update job_title on another employee''s profile.';
    end if;
    return new;
  end if;

  if new.role is distinct from old.role
    or new.active is distinct from old.active
    or new.ordinary_rate is distinct from old.ordinary_rate
    or new.rate_1_5x is distinct from old.rate_1_5x
    or new.rate_2x is distinct from old.rate_2x
    or new.rate_2_5x is distinct from old.rate_2_5x
    or new.annual_salary is distinct from old.annual_salary
    or new.rate_tier_id is distinct from old.rate_tier_id
    or new.employment_type is distinct from old.employment_type
    or new.pay_type is distinct from old.pay_type
    or new.employment_start_date is distinct from old.employment_start_date
    or new.salary_includes_super is distinct from old.salary_includes_super
    or new.has_probationary_period is distinct from old.has_probationary_period
    or new.xero_employee_id is distinct from old.xero_employee_id
    or new.xero_payroll_status is distinct from old.xero_payroll_status
    or new.xero_payroll_error is distinct from old.xero_payroll_error
    or new.xero_rates_pushed is distinct from old.xero_rates_pushed
    or new.xero_rates_pushed_at is distinct from old.xero_rates_pushed_at
    or new.site_rank is distinct from old.site_rank
    or new.notes is distinct from old.notes
  then
    raise exception 'Only an admin can change role, active status, pay rates, employment classification, the Xero link, site rank or notes.';
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------------
-- 8. Storage
-- ---------------------------------------------------------------------------------------------------
-- S23: you can delete a file you uploaded; pricing roles can delete any (server uploads have no owner, so pricing roles only)
alter policy "staff can delete project documents" on storage.objects using ((bucket_id = 'project-documents'::text) and (owner_id = ((select auth.uid()))::text or (select is_pricing_role())));
alter policy "staff can delete knowledge files" on storage.objects using ((bucket_id = 'knowledge-files'::text) and (owner_id = ((select auth.uid()))::text or (select is_pricing_role())));
alter policy "staff can delete email attachments" on storage.objects using ((bucket_id = 'email-attachments'::text) and (owner_id = ((select auth.uid()))::text or (select is_pricing_role())));
alter policy "staff can delete meeting audio" on storage.objects using ((bucket_id = 'meeting-audio'::text) and (owner_id = ((select auth.uid()))::text or (select is_pricing_role())));
alter policy "staff can delete site photos" on storage.objects using ((bucket_id = 'site-photos'::text) and (owner_id = ((select auth.uid()))::text or (select is_finance_role())));
alter policy "staff can delete proposal photos" on storage.objects using ((bucket_id = 'proposal-photos'::text) and (owner_id = ((select auth.uid()))::text or (select is_pricing_role())));
-- S24: the website's lead attachments: 15 MB each, images and PDFs only
update storage.buckets set file_size_limit = 15728640,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'application/pdf']
  where id = 'lead-uploads';

-- ---------------------------------------------------------------------------------------------------
-- 9. Column grants
-- ---------------------------------------------------------------------------------------------------
-- S22: the key values never travel to a browser (the Settings page only writes them; status comes from the server)
revoke select on public.api_keys from anon, authenticated;
grant select (key_name, updated_at, updated_by) on public.api_keys to authenticated;
-- S18: the pick-a-time token is not part of the Schedule tab's select
revoke select on public.schedule_time_offers from anon, authenticated;
grant select (id, project_id, staff_ids, start_time, end_time, days, weekdays_only, option_dates, message, to_email, to_name, status,
              picked_date, picked_at, client_message, email_id, created_by, created_at, viewed_at) on public.schedule_time_offers to authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 10. Advisors (F22)
-- ---------------------------------------------------------------------------------------------------
-- Functions on production with no fixed search_path (advisor function_search_path_mutable), 23 Oct 2026
alter function public._bill_num_norm(p text) set search_path = public;
alter function public._is_freight(p text) set search_path = public;
alter function public._po_qty(n numeric) set search_path = public;
alter function public.assign_job_number_on_approval() set search_path = public;
alter function public.calculate_balance_due(p_labour numeric, p_material numeric, p_stc numeric) set search_path = public;
alter function public.calculate_balance_due(p_labour numeric, p_material numeric, p_stc numeric, p_client_type text) set search_path = public;
alter function public.can_view_pay_rates(p_profile_id uuid) set search_path = public;
alter function public.can_view_sensitive_profile_data(p_profile_id uuid) set search_path = public;
alter function public.classify_timesheet_rate_category(p_clock_in timestamp with time zone) set search_path = public;
alter function public.current_profile_role() set search_path = public;
alter function public.easter_sunday(p_year integer) set search_path = public;
alter function public.generate_nsw_public_holidays(p_year integer) set search_path = public;
alter function public.get_invoice_by_token(p_token uuid) set search_path = public;
alter function public.get_invoice_by_token_v2(p_token uuid) set search_path = public;
alter function public.get_next_number(counter_name text) set search_path = public;
alter function public.get_next_number_serverside(counter_name text) set search_path = public;
alter function public.get_nonbillable_cost_by_category(p_start date, p_end date) set search_path = public;
alter function public.get_stage_actual_hours(p_cost_centre_id uuid) set search_path = public;
alter function public.get_stage_actual_labour_cost(p_cost_centre_id uuid) set search_path = public;
alter function public.get_stage_actual_material_cost(p_cost_centre_id uuid) set search_path = public;
alter function public.is_admin() set search_path = public;
alter function public.is_finance_role() set search_path = public;
alter function public.is_pricing_role() set search_path = public;
alter function public.job_tasks_spawn_next_occurrence() set search_path = public;
alter function public.stc_credit_inc_gst(p_stc numeric, p_client_type text) set search_path = public;
alter function public.sync_material_quantity_on_hand() set search_path = public;
alter function public.time_entries_no_job_means_office() set search_path = public;

-- Every foreign key on production with no leading index (advisor unindexed_foreign_keys), 23 Oct 2026
create index if not exists idx_activity_log_changed_by on public.activity_log (changed_by);
create index if not exists idx_ai_extraction_jobs_created_by on public.ai_extraction_jobs (created_by);
create index if not exists idx_api_keys_updated_by on public.api_keys (updated_by);
create index if not exists idx_asset_reminder_log_client_id on public.asset_reminder_log (client_id);
create index if not exists idx_asset_reminder_log_sent_by on public.asset_reminder_log (sent_by);
create index if not exists idx_bug_report_comments_author_id on public.bug_report_comments (author_id);
create index if not exists idx_bug_reports_approved_by on public.bug_reports (approved_by);
create index if not exists idx_bug_reports_created_by on public.bug_reports (created_by);
create index if not exists idx_callback_requests_claimed_by on public.callback_requests (claimed_by);
create index if not exists idx_client_contacts_client_id on public.client_contacts (client_id);
create index if not exists idx_cost_centre_line_items_rate_tier_id on public.cost_centre_line_items (rate_tier_id);
create index if not exists idx_credit_notes_created_by on public.credit_notes (created_by);
create index if not exists idx_customer_assets_created_by on public.customer_assets (created_by);
create index if not exists idx_dnsp_records_project_id on public.dnsp_records (project_id);
create index if not exists idx_email_job_links_created_by on public.email_job_links (created_by);
create index if not exists idx_email_threads_lead_id on public.email_threads (lead_id);
create index if not exists idx_emails_created_by on public.emails (created_by);
create index if not exists idx_employee_allowances_profile_id on public.employee_allowances (profile_id);
create index if not exists idx_feed_comments_author_id on public.feed_comments (author_id);
create index if not exists idx_feed_comments_post_id on public.feed_comments (post_id);
create index if not exists idx_feed_likes_author_id on public.feed_likes (author_id);
create index if not exists idx_feed_mentions_comment_id on public.feed_mentions (comment_id);
create index if not exists idx_feed_posts_author_id on public.feed_posts (author_id);
create index if not exists idx_fleet_vehicles_assigned_staff_id on public.fleet_vehicles (assigned_staff_id);
create index if not exists idx_formbay_payment_advices_created_by on public.formbay_payment_advices (created_by);
create index if not exists idx_incident_actions_assigned_to on public.incident_actions (assigned_to);
create index if not exists idx_incident_files_uploaded_by on public.incident_files (uploaded_by);
create index if not exists idx_incident_reports_created_by on public.incident_reports (created_by);
create index if not exists idx_incident_reports_injured_profile_id on public.incident_reports (injured_profile_id);
create index if not exists idx_incident_reports_project_id on public.incident_reports (project_id);
create index if not exists idx_inspection_checklist_templates_created_by on public.inspection_checklist_templates (created_by);
create index if not exists idx_invoice_line_items_cost_centre_id on public.invoice_line_items (cost_centre_id);
create index if not exists idx_invoice_line_items_created_by on public.invoice_line_items (created_by);
create index if not exists idx_invoice_line_items_job_material_usage_id on public.invoice_line_items (job_material_usage_id);
create index if not exists idx_invoice_line_items_material_id on public.invoice_line_items (material_id);
create index if not exists idx_invoice_line_items_prebuild_id on public.invoice_line_items (prebuild_id);
create index if not exists idx_invoices_bill_to_client_id on public.invoices (bill_to_client_id);
create index if not exists idx_invoices_client_id on public.invoices (client_id);
create index if not exists idx_invoices_cost_centre_id on public.invoices (cost_centre_id);
create index if not exists idx_invoices_created_by on public.invoices (created_by);
create index if not exists idx_invoices_project_id on public.invoices (project_id);
create index if not exists idx_job_material_usage_cost_centre_id on public.job_material_usage (cost_centre_id);
create index if not exists idx_job_material_usage_created_by on public.job_material_usage (created_by);
create index if not exists idx_job_material_usage_material_id on public.job_material_usage (material_id);
create index if not exists idx_job_material_usage_project_id on public.job_material_usage (project_id);
create index if not exists idx_job_stcs_created_by on public.job_stcs (created_by);
create index if not exists idx_job_tasks_assigned_to_user_id on public.job_tasks (assigned_to_user_id);
create index if not exists idx_job_tasks_completed_by on public.job_tasks (completed_by);
create index if not exists idx_job_tasks_created_by on public.job_tasks (created_by);
create index if not exists idx_job_tasks_followed_up_by on public.job_tasks (followed_up_by);
create index if not exists idx_job_tasks_schedule_assignment_id on public.job_tasks (schedule_assignment_id);
create index if not exists idx_job_variation_entries_cost_centre_id on public.job_variation_entries (cost_centre_id);
create index if not exists idx_job_variation_entries_created_by on public.job_variation_entries (created_by);
create index if not exists idx_job_variation_entries_invoice_id on public.job_variation_entries (invoice_id);
create index if not exists idx_job_variation_entries_status_changed_by on public.job_variation_entries (status_changed_by);
create index if not exists idx_job_variation_hours_created_by on public.job_variation_hours (created_by);
create index if not exists idx_job_variation_hours_project_id on public.job_variation_hours (project_id);
create index if not exists idx_job_variation_hours_staff_id on public.job_variation_hours (staff_id);
create index if not exists idx_job_variation_materials_created_by on public.job_variation_materials (created_by);
create index if not exists idx_job_variation_materials_material_id on public.job_variation_materials (material_id);
create index if not exists idx_job_variation_materials_prebuild_id on public.job_variation_materials (prebuild_id);
create index if not exists idx_job_variation_materials_project_id on public.job_variation_materials (project_id);
create index if not exists idx_knowledge_entries_created_by on public.knowledge_entries (created_by);
create index if not exists idx_leave_requests_decided_by on public.leave_requests (decided_by);
create index if not exists idx_leave_requests_staff_id on public.leave_requests (staff_id);
create index if not exists idx_licence_shares_created_by on public.licence_shares (created_by);
create index if not exists idx_material_stock_by_location_vehicle_id on public.material_stock_by_location (vehicle_id);
create index if not exists idx_materials_supplier_id on public.materials (supplier_id);
create index if not exists idx_meetings_created_by on public.meetings (created_by);
create index if not exists idx_notifications_actor_id on public.notifications (actor_id);
create index if not exists idx_payment_milestones_project_id on public.payment_milestones (project_id);
create index if not exists idx_prebuild_components_prebuild_id on public.prebuild_components (prebuild_id);
create index if not exists idx_profiles_rate_tier_id on public.profiles (rate_tier_id);
create index if not exists idx_project_documents_uploaded_by on public.project_documents (uploaded_by);
create index if not exists idx_project_field_notes_project_id on public.project_field_notes (project_id);
create index if not exists idx_project_field_notes_staff_id on public.project_field_notes (staff_id);
create index if not exists idx_project_photos_project_id on public.project_photos (project_id);
create index if not exists idx_project_photos_staff_id on public.project_photos (staff_id);
create index if not exists idx_projects_accounts_contact_id on public.projects (accounts_contact_id);
create index if not exists idx_projects_approved_by on public.projects (approved_by);
create index if not exists idx_projects_client_id on public.projects (client_id);
create index if not exists idx_projects_created_by on public.projects (created_by);
create index if not exists idx_projects_job_contact_id on public.projects (job_contact_id);
create index if not exists idx_projects_lead_id on public.projects (lead_id);
create index if not exists idx_projects_project_manager_contact_id on public.projects (project_manager_contact_id);
create index if not exists idx_projects_sales_contact_id on public.projects (sales_contact_id);
create index if not exists idx_projects_site_contact_id on public.projects (site_contact_id);
create index if not exists idx_purchase_order_line_items_added_by on public.purchase_order_line_items (added_by);
create index if not exists idx_purchase_order_line_items_destination_vehicle_id on public.purchase_order_line_items (destination_vehicle_id);
create index if not exists idx_purchase_order_line_items_material_id on public.purchase_order_line_items (material_id);
create index if not exists idx_purchase_order_line_items_po_id on public.purchase_order_line_items (po_id);
create index if not exists idx_purchase_order_line_items_received_by on public.purchase_order_line_items (received_by);
create index if not exists idx_purchase_orders_approved_by on public.purchase_orders (approved_by);
create index if not exists idx_purchase_orders_cost_centre_id on public.purchase_orders (cost_centre_id);
create index if not exists idx_purchase_orders_received_by on public.purchase_orders (received_by);
create index if not exists idx_purchase_orders_supplier_id on public.purchase_orders (supplier_id);
create index if not exists idx_purchase_orders_vehicle_id on public.purchase_orders (vehicle_id);
create index if not exists idx_quote_compliance_answers_answered_by on public.quote_compliance_answers (answered_by);
create index if not exists idx_quote_compliance_answers_item_id on public.quote_compliance_answers (item_id);
create index if not exists idx_review_requests_created_by on public.review_requests (created_by);
create index if not exists idx_schedule_assignments_site_inspection_id on public.schedule_assignments (site_inspection_id);
create index if not exists idx_site_inspection_answers_answered_by on public.site_inspection_answers (answered_by);
create index if not exists idx_site_inspection_answers_item_id on public.site_inspection_answers (item_id);
create index if not exists idx_site_inspections_created_by on public.site_inspections (created_by);
create index if not exists idx_site_inspections_template_id on public.site_inspections (template_id);
create index if not exists idx_sm8_attachment_copies_project_document_id on public.sm8_attachment_copies (project_document_id);
create index if not exists idx_sm8_attachment_copies_project_id on public.sm8_attachment_copies (project_id);
create index if not exists idx_sm8_attachment_copies_project_photo_id on public.sm8_attachment_copies (project_photo_id);
create index if not exists idx_staff_files_uploaded_by on public.staff_files (uploaded_by);
create index if not exists idx_staff_warnings_issued_by on public.staff_warnings (issued_by);
create index if not exists idx_supplier_bill_line_items_material_id on public.supplier_bill_line_items (material_id);
create index if not exists idx_supplier_bill_line_items_po_line_item_id on public.supplier_bill_line_items (po_line_item_id);
create index if not exists idx_supplier_bills_created_by on public.supplier_bills (created_by);
create index if not exists idx_supplier_bills_po_id on public.supplier_bills (po_id);
create index if not exists idx_supplier_bills_project_id on public.supplier_bills (project_id);
create index if not exists idx_supplier_payments_supplier_id on public.supplier_payments (supplier_id);
create index if not exists idx_supplier_statements_created_by on public.supplier_statements (created_by);
create index if not exists idx_tech_support_contacts_created_by on public.tech_support_contacts (created_by);
create index if not exists idx_time_entries_cost_centre_id on public.time_entries (cost_centre_id);
create index if not exists idx_variations_created_by on public.variations (created_by);

-- ---------------------------------------------------------------------------------------------------
-- 11. The hand-made tidy table left on production with RLS off (S5)
-- ---------------------------------------------------------------------------------------------------
revoke all on public.notifications_tidy_20261023 from public, anon, authenticated;
drop table if exists public.notifications_tidy_20261023;
