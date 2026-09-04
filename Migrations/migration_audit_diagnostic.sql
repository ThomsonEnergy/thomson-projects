-- Migration audit — run this whole thing in Supabase SQL Editor, then
-- paste me the results. Each row is one migration; "present" means the
-- database shows real evidence it was run, "MISSING" means it wasn't.
-- This checks your actual live schema, not your GitHub files, so it
-- catches migrations that exist in your repo but were never executed.

select '007' as migration, 'roles_permissions' as name,
  case when exists (select 1 from information_schema.routines where routine_name = 'is_admin') then 'present' else 'MISSING' end as status
union all
select '008', 'proposal_templates_prebuilds',
  case when exists (select 1 from information_schema.tables where table_name = 'prebuilds') then 'present' else 'MISSING' end
union all
select '009', 'estimate_disclaimer_maps',
  case when exists (select 1 from information_schema.columns where table_name = 'company_settings' and column_name = 'google_maps_api_key') then 'present' else 'MISSING' end
union all
select '010', 'lead_capture',
  case when exists (select 1 from information_schema.tables where table_name = 'leads') then 'present' else 'MISSING' end
union all
select '011', 'client_base',
  case when exists (select 1 from information_schema.tables where table_name = 'clients') then 'present' else 'MISSING' end
union all
select '012', 'job_contact_assignment',
  case when exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'site_contact_id') then 'present' else 'MISSING' end
union all
select '013', 'timesheets_leave_schedule',
  case when exists (select 1 from information_schema.tables where table_name = 'time_entries') then 'present' else 'MISSING' end
union all
select '014', 'cost_centre_time_split',
  case when exists (select 1 from information_schema.columns where table_name = 'time_entries' and column_name = 'cost_centre_id') then 'present' else 'MISSING' end
union all
select '015', 'numbering_and_clockin',
  case when exists (select 1 from information_schema.columns where table_name = 'company_settings' and column_name = 'next_quote_number') then 'present' else 'MISSING' end
union all
select '016', 'xero_integration',
  case when exists (select 1 from information_schema.tables where table_name = 'xero_account_mapping') then 'present' else 'MISSING' end
union all
select '017', 'invoicing_restructure',
  case when exists (select 1 from information_schema.columns where table_name = 'clients' and column_name = 'client_type') then 'present' else 'MISSING' end
union all
select '018', 'standalone_invoices_and_direct_jobs',
  case when exists (select 1 from information_schema.columns where table_name = 'invoices' and column_name = 'client_id') then 'present' else 'MISSING' end
union all
select '019', 'company_feed',
  case when exists (select 1 from information_schema.tables where table_name = 'feed_posts') then 'present' else 'MISSING' end
union all
select '020', 'fixes',
  case when exists (select 1 from information_schema.routines where routine_name = 'get_next_number_serverside') then 'present' else 'MISSING' end
union all
select '021', 'user_profiles',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'mobile_number') then 'present' else 'MISSING' end
union all
select '022', 'airwallex_payment_links',
  case when exists (select 1 from information_schema.columns where table_name = 'invoices' and column_name = 'airwallex_payment_link_id') then 'present' else 'MISSING' end
union all
select '023', 'invoice_balance_due',
  case when exists (select 1 from information_schema.routines where routine_name = 'calculate_balance_due') then 'present' else 'MISSING' end
union all
select '024', 'billable_rates',
  case when exists (select 1 from information_schema.tables where table_name = 'billable_rate_tiers') then 'present' else 'MISSING' end
union all
select '025', 'labour_cost_calculation',
  case when exists (select 1 from information_schema.routines where routine_name = 'classify_timesheet_rate_category') then 'present' else 'MISSING' end
union all
select '026', 'schedule_times',
  case when exists (select 1 from information_schema.columns where table_name = 'schedule_assignments' and column_name = 'start_time') then 'present' else 'MISSING' end
union all
select '027', 'nonbillable_categories',
  case when exists (select 1 from information_schema.columns where table_name = 'time_entries' and column_name = 'time_category') then 'present' else 'MISSING' end
union all
select '028', 'site_visits',
  case when exists (select 1 from information_schema.check_constraints where constraint_name = 'schedule_assignments_block_type_check' and check_clause like '%site_visit%') then 'present' else 'MISSING' end
union all
select '029', 'stock_fleet_supplier_dnsp',
  case when exists (select 1 from information_schema.tables where table_name = 'materials') then 'present' else 'MISSING' end
union all
select '030', 'ccew',
  case when exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'ccew_file_path') then 'present' else 'MISSING' end
union all
select '031', 'supplier_bill_line_items',
  case when exists (select 1 from information_schema.tables where table_name = 'supplier_bill_line_items') then 'present' else 'MISSING' end
union all
select '032', 'supplier_system',
  case when exists (select 1 from information_schema.tables where table_name = 'suppliers') then 'present' else 'MISSING' end
union all
select '033', 'supplier_payments',
  case when exists (select 1 from information_schema.columns where table_name = 'suppliers' and column_name = 'bank_account_name') then 'present' else 'MISSING' end
union all
select '034', 'supplier_matching_and_jobs',
  case when exists (select 1 from information_schema.columns where table_name = 'suppliers' and column_name = 'our_account_number') then 'present' else 'MISSING' end
union all
select '035', 'bpay',
  case when exists (select 1 from information_schema.columns where table_name = 'suppliers' and column_name = 'bpay_biller_code') then 'present' else 'MISSING' end
union all
select '036', 'po_receiving_signoff',
  case when exists (select 1 from information_schema.columns where table_name = 'purchase_orders' and column_name = 'received') then 'present' else 'MISSING' end
union all
select '037', 'stock_minimums_job_material_cost',
  case when exists (select 1 from information_schema.tables where table_name = 'job_material_usage') then 'present' else 'MISSING' end
union all
select '038', 'stock_locations',
  case when exists (select 1 from information_schema.tables where table_name = 'material_stock_by_location') then 'present' else 'MISSING' end
union all
select '039', 'vehicle_pos',
  case when exists (select 1 from information_schema.columns where table_name = 'purchase_orders' and column_name = 'vehicle_id') then 'present' else 'MISSING' end
union all
select '040', 'line_item_receiving',
  case when exists (select 1 from information_schema.columns where table_name = 'purchase_order_line_items' and column_name = 'destination_type') then 'present' else 'MISSING' end
union all
select '041', 'po_numbering',
  case when exists (select 1 from information_schema.columns where table_name = 'company_settings' and column_name = 'next_po_number') then 'present' else 'MISSING' end
union all
select '042', 'activity_log',
  case when exists (select 1 from information_schema.tables where table_name = 'activity_log') then 'present' else 'MISSING' end
union all
select '043', 'job_tasks',
  case when exists (select 1 from information_schema.tables where table_name = 'job_tasks') then 'present' else 'MISSING' end
union all
select '044', 'markup',
  case when exists (select 1 from information_schema.columns where table_name = 'cost_centres' and column_name = 'markup_percent') then 'present' else 'MISSING' end
union all
select '045', 'photos_terms',
  case when exists (select 1 from information_schema.tables where table_name = 'company_settings') then 'present' else 'MISSING' end
union all
select '046', 'sow_lineitems_branding',
  case when exists (select 1 from information_schema.columns where table_name = 'company_settings' and column_name = 'company_name') then 'present' else 'MISSING' end
union all
select '047', 'photos_deposit_pylon',
  case when exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'pylon_link') then 'present' else 'MISSING' end
union all
select '048', 'purchase_orders',
  case when exists (select 1 from information_schema.tables where table_name = 'purchase_orders') then 'present' else 'MISSING' end
union all
select '049', 'daily_greetings',
  case when exists (select 1 from information_schema.tables where table_name = 'daily_greetings') then 'present' else 'MISSING' end
union all
select '050', 'project_documents',
  case when exists (select 1 from information_schema.tables where table_name = 'project_documents') then 'present' else 'MISSING' end
union all
select '051', 'insurance_licensing',
  case when exists (select 1 from information_schema.tables where table_name = 'company_credentials') then 'present' else 'MISSING' end
union all
select '052', 'job_tasks (duplicate of 043)',
  case when exists (select 1 from information_schema.tables where table_name = 'job_tasks') then 'present' else 'MISSING' end
union all
select '053', 'bug_reports',
  case when exists (select 1 from information_schema.tables where table_name = 'bug_reports') then 'present' else 'MISSING' end
union all
select '054', 'variations',
  case when exists (select 1 from information_schema.tables where table_name = 'variations') then 'present' else 'MISSING' end
union all
select '055', 'multi_stage_invoices',
  case when exists (select 1 from information_schema.tables where table_name = 'invoice_claims') then 'present' else 'MISSING' end
union all
select '056', 'fix_invoice_constraint',
  case when exists (select 1 from information_schema.check_constraints where constraint_name = 'invoices_client_or_stage_check' and check_clause like '%project_id%') then 'present' else 'MISSING' end
union all
select '057', 'job_task_scheduling',
  case when exists (select 1 from information_schema.columns where table_name = 'job_tasks' and column_name = 'due_date') then 'present' else 'MISSING' end
union all
select '058', 'team_licences_visible_to_all_staff',
  case when exists (select 1 from pg_policies where tablename = 'profile_licences' and policyname = 'staff can view all profile licences') then 'present' else 'MISSING' end
union all
select '059', 'profiles_visible_to_all_staff',
  case when exists (select 1 from pg_policies where tablename = 'profiles' and policyname = 'staff can view all profiles') then 'present' else 'MISSING' end
union all
select '060', 'pay_rate_masking_and_self_service_profile',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'bank_bsb') then 'present' else 'MISSING' end
union all
select '061', 'quote_job_split',
  case when exists (select 1 from information_schema.columns where table_name = 'projects' and column_name = 'source_quote_id') then 'present' else 'MISSING' end
union all
select '062', 'job_titles_and_finance_profile_access',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'job_title') then 'present' else 'MISSING' end
union all
select '063', 'job_task_types',
  case when exists (select 1 from information_schema.columns where table_name = 'job_tasks' and column_name = 'task_type') then 'present' else 'MISSING' end
union all
select '064', 'stc_calculator',
  case when exists (select 1 from information_schema.columns where table_name = 'cost_centres' and column_name = 'stc_system_kw') then 'present' else 'MISSING' end
union all
select '065', 'employee_onboarding',
  case when exists (select 1 from information_schema.tables where table_name = 'employee_contracts') then 'present' else 'MISSING' end
union all
select '066', 'onboarding_document_seed',
  case when exists (select 1 from onboarding_documents where is_contract) then 'present' else 'MISSING' end
union all
select '067', 'contract_answers',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'has_probationary_period') then 'present' else 'MISSING' end
union all
select '068', 'invoice_labels_and_due_dates',
  case when exists (select 1 from information_schema.columns where table_name = 'invoices' and column_name = 'due_date') then 'present' else 'MISSING' end
union all
select '069', 'bug_report_approval_and_comments',
  case when exists (select 1 from information_schema.tables where table_name = 'bug_report_comments') then 'present' else 'MISSING' end
union all
select '070', 'payment_milestones',
  case when exists (select 1 from information_schema.tables where table_name = 'payment_milestones') then 'present' else 'MISSING' end
union all
select '071', 'office_tasks',
  case when exists (select 1 from information_schema.columns where table_name = 'job_tasks' and column_name = 'project_id' and is_nullable = 'YES') then 'present' else 'MISSING' end
union all
select '072', 'po_backorder',
  case when exists (select 1 from information_schema.columns where table_name = 'purchase_order_line_items' and column_name = 'is_backordered') then 'present' else 'MISSING' end
union all
select '073', 'split_overnight_timesheets',
  case when not exists (
    select 1 from time_entries
    where clock_out is not null
      and (clock_out at time zone 'Australia/Sydney') > (((clock_in at time zone 'Australia/Sydney')::date + 1)::timestamp)
  ) then 'present' else 'MISSING' end
union all
select '074', 'recurring_tasks',
  case when exists (select 1 from information_schema.columns where table_name = 'job_tasks' and column_name = 'recurrence') then 'present' else 'MISSING' end
union all
select '075', 'clockout_breaks',
  case when exists (select 1 from information_schema.columns where table_name = 'time_entries' and column_name = 'break_taken') then 'present' else 'MISSING' end
union all
select '076', 'onboarding_reissue',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'onboarding_cycle_started_at') then 'present' else 'MISSING' end
union all
select '077', 'structured_address',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles' and column_name = 'residential_postcode') then 'present' else 'MISSING' end
union all
select '078', 'reharden_sensitive_columns (view update only - see 079 for the real fix)',
  case when exists (select 1 from information_schema.columns where table_name = 'profiles_sensitive_secure' and column_name = 'bank_account_number') then 'present' else 'MISSING' end
union all
select '079', 'fix_column_masking_table_grant',
  case when not exists (
    select 1 from information_schema.column_privileges
    where table_name = 'profiles' and grantee in ('authenticated','anon') and privilege_type = 'SELECT'
      and column_name in ('tax_file_number','bank_account_number','ordinary_rate','annual_salary','date_of_birth')
  ) then 'present' else 'MISSING' end
order by 1;
