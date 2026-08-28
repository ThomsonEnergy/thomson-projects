# Thomson Energy Projects: setup guide

This gives you a private internal tool at a URL like `projects.thomsonenergy.com.au`.
It does not touch your existing website at all.

## 1. Create a Supabase project (free)

1. Go to https://supabase.com, sign up, create a new project (any name, e.g. "thomson-projects").
2. Once it's ready, go to the **SQL Editor**, open a new query, paste in the entire contents
   of `schema.sql` from this folder, and click **Run**. This creates your tables.
3. Go to **Authentication > Users** and click **Add user** for each staff member (3 to 10
   people). Give each person an email and a temporary password, they can change it later.
4. Go to **Settings > API**. Copy the **Project URL** and the **anon public key**.
5. Open `public/js/supabase-client.js` in this folder and paste those two values in at the top
   (`SUPABASE_URL` and `SUPABASE_ANON_KEY`).
6. Also copy the **service_role key** from that same API settings page (keep this one secret,
   never put it in the public folder). You'll need it in step 3 below.

## 2. Get your ServiceM8 API key

1. In ServiceM8, go to **Settings > API Keys** and generate a new key.
2. Keep it handy for step 3.

## 3. (Optional) Get an Anthropic API key, for AI-drafted scope of works

This is separate from a claude.ai login. It's a pay-per-use API account:

1. Go to https://console.anthropic.com, sign up, and add a payment method under
   **Settings > Billing**. Usage for this feature costs a few cents per proposal.
2. Go to **API Keys**, create a new key, and keep it handy for the next step.
3. If you'd rather skip this for now, just leave `ANTHROPIC_API_KEY` unset below.
   The rest of the app works fine, you'll just type stage descriptions in by hand.

## 4. Deploy to Netlify

1. Push this whole folder to a new GitHub repository (or drag-and-drop deploy it directly in
   the Netlify dashboard if you'd rather not use GitHub).
2. In Netlify, click **Add new site > Import an existing project**, point it at this repo.
   Build settings are already set in `netlify.toml`, so you shouldn't need to change anything.
3. Once the site is created, go to **Site configuration > Environment variables** and add:
   - `SUPABASE_URL` — same value as before
   - `SUPABASE_SERVICE_ROLE_KEY` — the service_role key from step 1.6
   - `SERVICEM8_API_KEY` — the key from step 2
   - `ANTHROPIC_API_KEY` — the key from step 3, if you set that up
   - `DEV_MODE_PASSWORD` — the password for unlocking Dev Mode (Settings page, admin-only) - a time-limited (20 min) unlock for API Keys, Company Details, Xero Mapping, and bulk-delete on Quotes/Projects/Timesheets. Checked server-side by a Netlify function, never shipped to the browser. Pick your own value here rather than reusing one from elsewhere.
   - `GITHUB_TOKEN` — lets the Bugs & Updates page (`/bugs.html`) commit `BUGS_AND_UPDATES.md` straight into this GitHub repo whenever someone submits a bug/update or changes its status, so it can be read directly from the repo folder later (by a Claude Code session, or anyone) without needing database access. Create one at **GitHub > Settings > Developer settings > Fine-grained personal access tokens** - scope it to this repository only, with **Contents: Read and write** permission, nothing else. Treat it like any other secret; it's only ever used server-side in the Netlify function.
4. Trigger a deploy (Deploys tab > Trigger deploy).
5. Under **Domain settings**, add a custom domain like `projects.thomsonenergy.com.au` and
   point it at this Netlify site with a CNAME record in whoever manages your DNS (probably the
   same place your main thomsonenergy.com.au domain is registered). Netlify will show you the
   exact record to add.

## 5. Add your branding, company details, photos, and terms

Once deployed and logged in, visit `/settings.html` and:
- Upload your logo (replaces the default text in the top-left corner of client proposals).
- Fill in your company name, ABN, address, phone, website, and license numbers, these show on
  every proposal's cover page.
- Upload a handful of photos from past jobs, these appear on the title page of every quote.
- Paste in your standard terms and conditions, they'll be prefilled on every new quote (still
  editable per quote if a job needs something different).

## 6. Try it

- Visit your new domain, log in with one of the staff accounts you created.
- Click **New quote**, fill in a project with a few stages, save it.
- Open the project, copy the client quote link (or click "Email quote to client"), open it in
  a private/incognito window to see what the client sees.
- Accept the quote from that public page.
- Back on the project page, click **Create ServiceM8 jobs for this project**. Check ServiceM8,
  you should see one new job per stage under the client's company record.
- Log some time and materials against one of those jobs in ServiceM8 as a test, then come back
  and click **Sync costs from ServiceM8** to pull it through.

## 7. Keeping costs in sync automatically (optional)

Right now costs only update when someone clicks "Sync costs from ServiceM8" on a project page.
To make this automatic:

- Simplest: use a free service like https://cron-job.org to hit
  `https://projects.thomsonenergy.com.au/.netlify/functions/sync-costs`
  once every hour or so. No project ID means it syncs every linked job across all projects.
- Alternative: if your Netlify plan supports Scheduled Functions, you can configure `sync-costs`
  to run on a schedule directly in Netlify instead.

- If you already ran `schema.sql` before, you'll also need every `migration_0NN_*.sql` file in
  this folder, run in numeric order, in the Supabase SQL Editor - see `README.md` for the full
  list and `migration_audit_diagnostic.sql` to check which ones your database is still missing.
  If you're setting up fresh, the current `schema.sql` already includes everything up to the
  point it was last regenerated; you'll still want to run any migrations numbered after that.

## Pylon (solar design software)

Pylon's own interactive proposal page can't be embedded in our quote - confirmed by checking a
real Pylon proposal link, it sends `X-Frame-Options: SAMEORIGIN`, which every browser treats as
a hard instruction to refuse framing it from any other domain. So the "Pylon proposal link"
field always opens Pylon in a new tab via a button on the client's proposal page - that part
isn't going to change unless Pylon offers a different embeddable link (worth asking their
support about).

What does show inline on the quote is a plain-text hardware summary (panel/inverter/battery
counts, e.g. "10.56kW system - 24x Longi LR5-54HTH 440W - 1x SolarEdge SE10000H"), pulled from
Pylon's documented API (https://app.getpylon.com/docs/api) via the "Pull from Pylon" button.
Pylon's API does not expose production or ROI figures at all - only hardware counts - so the
full interactive design and ROI calculation always stays behind the Pylon link itself.

To use it: create a Pylon API token (in Pylon, under Settings > API), then paste it into this
app's own Settings > API Keys > Pylon field (not a Netlify environment variable - it's read from
the `api_keys` table so it can be rotated without a redeploy). `netlify/functions/pylon-sync.js`
calls Pylon's `GET /v1/solar_designs/{id}` endpoint - the field names it reads
(`module_types`/`inverter_types`/`storage_types`/`summary.dc_output_kw`) come from Pylon's docs
but haven't been verified against a live response from your account. If the "Pull from Pylon"
button comes back with no summary or an error, check the Netlify function logs (it logs the raw
Pylon response) against the current docs and adjust the field names in that file if Pylon's
actual response differs.

- Purchase orders and supplier invoices logged in this tool are kept separate from the
  labour/material actuals synced from ServiceM8, on purpose, so nothing gets double-counted.
  If your ServiceM8 account already tracks purchase costs (via the MyPO add-on or an accounting
  integration), those already flow into the "Cost allocated" figures automatically. The
  purchase order tracker here is for having everything in one place per project, not a
  replacement for that.

## Notes on accuracy

- Labour cost is calculated from ServiceM8's recorded time (check-ins) multiplied by the cost
  rate ServiceM8 has stored for that time entry. If your ServiceM8 account doesn't have cost
  rates configured per staff member, this will come through as $0 and you'll want to set those
  up in ServiceM8 under staff settings so the numbers mean something.
- Material cost pulls from each job's line items (JobMaterial) using their cost price, not sell
  price.
- "Invoiced" reflects `total_invoice_amount` on the ServiceM8 job. If you invoice a stage in
  multiple parts, this should still total correctly once ServiceM8 marks it invoiced.
- This is a first working version, not a finished product. Once you're using it for a couple
  of real projects, there will very likely be some field or edge case in ServiceM8 that needs
  adjusting in `netlify/functions/_servicem8.js`. That file is where all the ServiceM8-specific
  logic lives.
