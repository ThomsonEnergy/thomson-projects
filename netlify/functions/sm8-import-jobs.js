// POST /.netlify/functions/sm8-import-jobs
// Body: { rows: [{ sm8JobUuid, sm8JobNumber, companyUuid, companyName,
//   companyAddress, clientEmail, clientPhone, siteAddress, description,
//   notesText, name, clientId ('new' or an existing client id),
//   jobType ('quoted' | 'do_and_charge'),
//   stage: { name, quotedExGst, invoicedExGst,
//     lines: [{ item_type, description, quantity, cost, price, group, base_quantity }],
//     groups: [{ key, description }] } }] }
// Admin only. Writes the rows the admin ticked on the review screen
// (sm8-import-preview.js + sm8-import-lines.js) as jobs, a few at a time -
// the page sends them in small batches so no single call runs past the
// function time limit.
//
// Each job is created like a job from an approved quote (ready_to_book, job
// number from the usual trigger) with one stage holding:
//   * every ServiceM8 bundle as a prebuild group of its real components,
//     plus the standalone lines - labour at ServiceM8's sell rate (on the
//     matching rate tier), materials at ServiceM8 cost, and the stage
//     markup that makes them sell for exactly the ServiceM8 value
//     (stageFromLines), so labour and materials split properly for Xero
//   * invoiced_amount = the Completed ServiceM8 claims, so "Invoice
//     project" only bills what ServiceM8 hasn't already billed
// A "quoted" job is a normal quoted job (new_build); "do_and_charge" is a
// Direct Job, invoiced from actual time and materials logged in the app.
// Also the ServiceM8 notes (projects.notes) and sm8_job_uuid /
// sm8_job_number, which make a re-run skip it. Nothing is read from or
// written to ServiceM8.

const crypto = require('crypto');
const { requireAdmin } = require('./_shared/require-admin');
const { stageFromLines, stcsText } = require('./_shared/sm8-import');

const MAX_ROWS = 10;
const MAX_LINES = 3000;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 20000) => String(v ?? '').trim().slice(0, max);

// The rate tier a labour line belongs to: the tier whose name it starts
// with ("Licensed Electrical Specialist (14/05/2026)"), longest name first.
function tierFor(tierIds, description) {
  const d = String(description || '').trim().toLowerCase();
  const hit = [...tierIds.keys()].sort((a, b) => b.length - a.length).find(name => d.startsWith(name));
  return hit ? tierIds.get(hit) : null;
}

async function resolveClient(supabaseAdmin, row) {
  if (row.clientId && row.clientId !== 'new') {
    const { data: client, error } = await supabaseAdmin
      .from('clients').select('id, name, email, phone, sm8_company_uuid').eq('id', row.clientId).maybeSingle();
    if (error) throw error;
    if (!client) throw new Error('The chosen client no longer exists - re-run the preview');
    // Remember the link so a later run matches straight to this client. A
    // unique clash (another client already holds this ServiceM8 company)
    // just means the link stays where it is.
    if (!client.sm8_company_uuid && row.companyUuid) {
      await supabaseAdmin.from('clients').update({ sm8_company_uuid: row.companyUuid }).eq('id', client.id).is('sm8_company_uuid', null);
    }
    return client;
  }

  // "New client": an earlier job in this run may already have created it
  // (several open jobs for the same ServiceM8 company).
  if (row.companyUuid) {
    const { data: existing } = await supabaseAdmin
      .from('clients').select('id, name, email, phone').eq('sm8_company_uuid', row.companyUuid).maybeSingle();
    if (existing) return existing;
  }

  const { data: created, error } = await supabaseAdmin
    .from('clients')
    .insert({
      name: str(row.companyName, 300) || 'Unknown client',
      email: str(row.clientEmail, 300) || null,
      phone: str(row.clientPhone, 100) || null,
      address: str(row.companyAddress, 500) || str(row.siteAddress, 500) || null,
      sm8_company_uuid: row.companyUuid || null,
    })
    .select('id, name, email, phone')
    .single();
  if (error) throw error;
  return created;
}

async function importRow(supabaseAdmin, userId, row, tierIds) {
  const sm8JobUuid = str(row.sm8JobUuid, 100);
  if (!sm8JobUuid) throw new Error('Missing ServiceM8 job id');
  const name = str(row.name, 300);
  if (!name) throw new Error('Job name is required');
  const jobType = row.jobType === 'do_and_charge' ? 'do_and_charge' : 'quoted';
  const s = row.stage || {};
  const stageName = str(s.name, 200) || 'Labour & Materials';
  const rawLines = Array.isArray(s.lines) ? s.lines : [];
  if (rawLines.length > MAX_LINES) throw new Error(`More than ${MAX_LINES} line items`);
  const lines = rawLines.map(l => ({
    item_type: l.item_type === 'labour' ? 'labour' : 'material',
    description: str(l.description, 1000) || 'ServiceM8 item',
    quantity: n(l.quantity), cost: n(l.cost), price: n(l.price),
    group: l.group ? str(l.group, 100) : null,
    base_quantity: l.base_quantity == null ? null : n(l.base_quantity),
  }));
  if (lines.some(l => [l.quantity, l.cost, l.price].some(Number.isNaN) || Number.isNaN(l.base_quantity))) throw new Error('A line item has a non-numeric amount');
  // With line items the value is theirs (ServiceM8's sell prices); without,
  // it is the figure typed on the review screen.
  const quoted = lines.length ? r2(lines.reduce((t, l) => t + r2(l.quantity * l.price), 0)) : r2(s.quotedExGst);
  const invoiced = r2(s.invoicedExGst);
  // ServiceM8's STC rebate lines, kept for staff to enter by hand.
  const stcs = (Array.isArray(s.stcs) ? s.stcs : []).slice(0, 10).map(x => ({
    type: ['pv', 'bstc', 'swh'].includes(x.type) ? x.type : 'pv',
    count: Math.round(n(x.count)), price: r2(x.price), total: r2(x.total), label: str(x.label, 200),
  }));
  if (stcs.some(x => !(x.count >= 0) || !(x.price >= 0))) throw new Error('Bad STC figures');
  const stcNote = stcs.length
    ? `\n\nSTCs in ServiceM8, NOT applied to this job yet: ${stcsText(stcs)}.\nEnter them on the job's STCs tab (+ Add STCs) and set the stage's STC credit in Edit stages.`
    : '';
  if (Number.isNaN(quoted) || quoted < 0 || !(invoiced >= 0)) throw new Error('Value and invoiced must be numbers, 0 or more');
  if (invoiced > quoted + 0.01) throw new Error(`Invoiced ($${invoiced.toFixed(2)}) is more than the job value ($${quoted.toFixed(2)})`);
  const groupDescriptions = new Map((Array.isArray(s.groups) ? s.groups : []).map(g => [str(g.key, 100), str(g.description, 5000)]));

  const { data: existing } = await supabaseAdmin
    .from('projects').select('id, job_number').eq('sm8_job_uuid', sm8JobUuid).maybeSingle();
  if (existing) return { skipped: true, projectId: existing.id, jobNumber: existing.job_number };

  const client = await resolveClient(supabaseAdmin, row);

  const { data: project, error: projectErr } = await supabaseAdmin
    .from('projects')
    .insert({
      name,
      sow_text: str(row.description) || null,
      notes: (str(row.notesText, 100000) + stcNote).trim() || null,
      sm8_stcs: stcs.length ? stcs : null,
      client_id: client.id,
      client_name: client.name,
      client_email: client.email || str(row.clientEmail, 300) || null,
      client_phone: client.phone || str(row.clientPhone, 100) || null,
      client_address: str(row.siteAddress, 500) || null,
      // new_build: the general quoted electrical job, invoiced as a share
      // of its quoted value ("Invoice project"). direct_job: invoiced from
      // actual time and materials.
      proposal_template: jobType === 'quoted' ? 'new_build' : 'direct_job',
      // Job Booked once someone is scheduled or clocks in (database rule, migration 20261023000000).
      pipeline_stage: 'ready_to_book',
      status: 'in_progress',
      created_by: userId,
      sm8_job_uuid: sm8JobUuid,
      sm8_job_number: str(row.sm8JobNumber, 50) || null,
    })
    .select('id, job_number')
    .single();
  if (projectErr) {
    // Unique index on sm8_job_uuid: another tab got there first.
    if (projectErr.code === '23505') {
      const { data: raced } = await supabaseAdmin.from('projects').select('id, job_number').eq('sm8_job_uuid', sm8JobUuid).maybeSingle();
      if (raced) return { skipped: true, projectId: raced.id, jobNumber: raced.job_number };
    }
    throw projectErr;
  }

  try {
    const calc = lines.length ? stageFromLines(lines) : null;
    const { data: centre, error: ccErr } = await supabaseAdmin.from('cost_centres').insert({
      project_id: project.id,
      name: stageName,
      sort_order: 0,
      markup_percent: calc ? calc.markupPercent : 45,
      estimated_labour_cost: calc ? calc.estimatedLabour : 0,
      estimated_material_cost: calc ? calc.estimatedMaterial : 0,
      quoted_amount: quoted,
      invoiced_amount: invoiced,
      // STCs are not applied here - staff enter them on the job (STCs tab
      // and this stage's STC credit) from projects.sm8_stcs / the notes.
    }).select('id').single();
    if (ccErr) throw ccErr;

    if (calc) {
      const groupIds = new Map();
      const items = calc.items.map((l, i) => {
        if (l.group && !groupIds.has(l.group)) groupIds.set(l.group, crypto.randomUUID());
        return {
          cost_centre_id: centre.id,
          description: l.description,
          item_type: l.item_type,
          quantity: l.quantity,
          unit_cost: l.unit_cost,
          sort_order: i,
          rate_tier_id: l.item_type === 'labour' ? tierFor(tierIds, l.description) : null,
          prebuild_group_id: l.group ? groupIds.get(l.group) : null,
          prebuild_client_description: l.group ? (groupDescriptions.get(l.group) || null) : null,
          prebuild_base_quantity: l.group ? l.base_quantity : null,
        };
      });
      for (let i = 0; i < items.length; i += 500) {
        const { error: liErr } = await supabaseAdmin.from('cost_centre_line_items').insert(items.slice(i, i + 500));
        if (liErr) throw liErr;
      }
    }
  } catch (err) {
    // A job without its stage or line items is half made - take it back out
    // (stages and line items cascade) so a re-run creates it cleanly.
    await supabaseAdmin.from('projects').delete().eq('id', project.id);
    throw err;
  }

  return { projectId: project.id, jobNumber: project.job_number };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireAdmin(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  try {
    const { rows } = JSON.parse(event.body || '{}');
    if (!Array.isArray(rows) || !rows.length) {
      return { statusCode: 400, body: JSON.stringify({ error: 'rows is required' }) };
    }
    if (rows.length > MAX_ROWS) {
      return { statusCode: 400, body: JSON.stringify({ error: `Send at most ${MAX_ROWS} jobs per call` }) };
    }

    // Labour lines land on the rate tier of the same name ("Licensed
    // Electrical Specialist"), like a prebuild's labour does.
    const { data: tiers, error: tierErr } = await supabaseAdmin.from('billable_rate_tiers').select('id, name');
    if (tierErr) throw tierErr;
    const tierIds = new Map((tiers || []).map(t => [String(t.name).trim().toLowerCase(), t.id]));

    // One at a time, not in parallel: two jobs for the same new client
    // must not both create it.
    const results = [];
    for (const row of rows) {
      try {
        const r = await importRow(supabaseAdmin, user.id, row, tierIds);
        results.push({ sm8JobUuid: row.sm8JobUuid, ok: true, ...r });
      } catch (err) {
        console.error('sm8-import-jobs row error:', row.sm8JobUuid, err.message);
        results.push({ sm8JobUuid: row.sm8JobUuid, ok: false, error: err.message });
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    console.error('sm8-import-jobs error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
