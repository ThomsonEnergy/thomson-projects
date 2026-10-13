# Overheads and net profit: plan, decisions and status

Handoff for another Claude chat. Repo `ThomsonEnergy/thomson-projects`, Supabase project `ziakpklnzkbbjjnqgkmz`, Netlify site `thomsonprojects` (live at projects.thomsonenergy.com.au). Written 14 Oct 2026. Rule for all text and code in this project: no em dashes.

## What Jasper asked for (Bugs & Updates board item "Overheads calculator")
"Build an overheads calculator only finance and above can see that adds the overhead cost onto our employees hourly rate. We will have 1 for employee direct costs and 1 for company direct costs. Then based on materials and labour we can figure out our net profit per job rather than gross. I'd like to be able to sync it to Xero against our p/l report so it stays live and changes as the company changes."

## Decisions Jasper has made
1. **Company costs** are shared across jobs as a **percentage of each job's profit** (not per hour). The percentage = yearly company costs divided by the profit the business expects to make in a year. A switch lets the base be job price instead of profit.
2. **Hours:** start with **1600 paid hours per year per staff member**. Must be editable per person (part-timers, admin-only staff). Later it should switch to automatic, using real timesheet hours over the last few months ("once we get a few months going"). He also wants to edit it "month to month".
3. **All non-billable wages go into the company wages overhead.** Office and admin staff pay in full, plus everyone's non-job time (admin, training, quoting).
4. **Employee overhead is the same for everyone** but changeable per person (part time, purely admin).
5. **Xero:** all the relevant expense accounts are kept separately in Xero (super, workers comp, payroll tax and so on), so account-by-account mapping works.
6. **Where it shows:** a monthly summary, the job page, and an Overheads page. **The job (project) page shows costs including overheads, but must NOT show a "net profit" figure or card.** Net / after-overhead profit appears only in the monthly summary and on the Overheads page.
7. Finance and Admin roles only for all overhead data.

## Model
- **Employee direct costs** (yearly $): super, workers comp, payroll tax, tools, vehicles, phones, uniforms, training. Divided by the total paid hours of people who bill their time, giving `employee_rate` ($/hr) added to each billable person's hourly cost (their "loaded rate").
- **Company direct costs** (yearly $): rent, insurance, accounting, software, marketing... plus the calculated **non-billable wages**. Divided by `expected_annual_base` (expected yearly job profit or price, typed in for now) to give `company_pct`.
- **Job cost including overheads** = materials + wages + employee_rate x hours worked + company_pct x the job's profit (profit never below 0 for this).
- **Non-billable wages (per year)** = non-job hours of billable people x their hourly cost, plus a full year for anyone flagged not billable (their `annual_salary` if set, else hourly cost x hours).
- Defaults: a person is billable if their role is `staff` or `sales`; `admin` and `finance` default to not billable. Jasper can flip anyone. "Claude" and "Test account" are set to not billable with 0 hours.
- **Xero:** read the Profit and Loss for the last N months (3, 6 or 12), list expense accounts (not cost of sales), map each to employee / company / ignore, scale to a year, refresh nightly. Wage accounts must be left as "Ignore" because non-billable wages are calculated here.

## Database (already applied live)
- Migration 141 (`overheads`): tables `overhead_lines` (bucket employee|company, name, annual_amount, source manual|xero, xero_account_id), `overhead_xero_map` (account_id, bucket employee|company|ignore), `overhead_settings` (single row). Finance-only RLS (`is_finance_role()`).
- Migration 142 (`overheads_v2_people_and_monthly`, file `Migrations/migration_142_overheads_v2.sql`): per-person table `overhead_people`, settings columns `company_basis`, `expected_annual_base`, `default_hours_per_person` (1600), and functions:
  - `overhead_people_basis(mode)` and `compute_overhead_rates()`: internal, no caller check, not granted to anyone (the nightly job uses them).
  - `get_overhead_rates()`, `get_overhead_people(mode)`, `get_monthly_net_summary(months)`: finance-only wrappers the pages call. Anyone else gets no rows.
- Migration 141's original hours functions were dropped by 142.
- Current live numbers: no overhead lines yet, `expected_annual_base` 0 (so company_pct 0), non-billable wages about $168,000 a year (Jasper and Nathan flagged non-billable by default, worth Jasper reviewing).

## Code (branch `overheads-wip`, NOT merged to main)
Done:
- `public/overheads.html`: the Overheads page (stats, people and hours, employee lines, company lines with the calculated wages row, percentage settings, Xero mapping and sync, month by month table). Finance and Admin only.
- `public/js/supabase-client.js`: `isFinanceRole()`, finance-only nav item "Overheads".
- `netlify/functions/_shared/overheads-xero.js` (P&L parser and `applyMapping`), `get-overhead-xero-accounts.js`, `sync-overheads.js`, `sync-overheads-nightly.js` plus a daily schedule in `netlify.toml`. The parser is tested against a sample report; nothing has been run against real Xero yet.
- Migrations 141 and 142.

Not done / needs finishing:
1. **`public/project.html`**: the branch still contains a first-draft "Net profit" card (`loadNetProfitCard`) written for the old rates. It uses fields that no longer exist and **contradicts decision 6**. Remove it and instead make the Summary cost figures include overheads for Finance and Admin only: Estimated cost and Actual cost tiles include employee overhead (employee_rate x hours: `quotedHoursTotal` / `actualHoursTotal` already exist in `render()`) and company overhead (company_pct x profit). Label them "includes overheads". No net profit wording. Sales and other roles keep seeing the current numbers (they cannot read overhead rates).
2. Switching the dashboard / project lists to overhead-inclusive costs is not requested; skip unless asked.
3. "Month to month" editing: currently yearly figures divided by 12 in the monthly summary. Jasper said he wants to edit month to month; ask whether that means per-month overrides of cost lines and hours, or only editing at any time. Not built.
4. Automatic expected yearly profit (from the last 12 months of completed jobs) is not built; typed in for now.
5. Xero connection scope: the custom connection needs `accounting.reports.read` added in the Xero developer portal (Jasper has to do this). Without it the sync shows a plain message saying so. Nothing is verified against real Xero data.
6. Test everything logged in as a finance user (the SQL tool has no login, so the guarded functions only return rows for a real session). Check that a sales or staff login sees no Overheads nav item, gets the "Finance and Admin only" message on the page, and no overhead numbers on job pages.
7. Add the item to `BUGS_AND_UPDATES` as resolved only once the job page and Xero sync are verified, and update `PROJECT_SPEC.md` (Tier 3 item 2, section D5/H4).

## Related things to know
- Another chat made branch `claimed-calls-and-reminders` and the working folder may be checked out on it. Do your work in a separate git worktree off `main`.
- Timesheet and leave approval was started and paused (design only, nothing committed): managers per person, weekly submit and approve, Finance and Admin approve all, Xero push only for approved weeks. It is next on the list after overheads.
- Gross profit figures, the Xero payroll push and existing job costing are untouched by this feature.
