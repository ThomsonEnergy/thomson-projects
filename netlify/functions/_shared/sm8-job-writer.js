// Writes one ServiceM8 job into TEops (item 111). Called by _shared/sm8-run.js, one job at a time,
// with the row _shared/sm8-import.js shapeSm8Job() made and the TEops client it belongs to.
// Tables: projects, cost_centres, cost_centre_line_items, client_sites. Nothing is read from or
// written to ServiceM8.
//
// What a job becomes, by row.kind:
//   quote      a TEops quote with a Q number: Quote sent (with ServiceM8's sent date) or Draft quote.
//   job        a job at Ready to Book with a new J number from the usual trigger.
//   completed  a job at Archived under its old ServiceM8 number (#4809 is J4809: TEops J numbers
//              start at 7000 and ServiceM8's are below that), dated when ServiceM8 says it was made
//              and finished. A number that is not a plain number below the J counter, or is already
//              a J number, takes the next J number instead.
//
// Each job gets one stage holding:
//   * every ServiceM8 bundle as a prebuild group of its real components, plus the standalone
//     lines: labour at ServiceM8's sell rate (on the matching rate tier), materials at ServiceM8
//     cost, and the stage markup that makes them sell for exactly the ServiceM8 value
//     (stageFromLines), so labour and materials split properly for Xero
//   * invoiced_amount = the ServiceM8 claims and deposits in row.stage.claims, kept on the stage as
//     imported_claims, so "Invoice project" only bills what ServiceM8 has not already billed or
//     taken. A completed job's claims add up to its whole value: nothing is left to invoice.
// A job already in the app is not made again; a deposit it is missing is added to its first stage
// as a paid claim (item 71). A job with a value is a quoted job (new_build); one with none is a
// Direct Job, invoiced from actual time and materials. sm8_job_uuid makes a re-run skip it.

const crypto = require('crypto');
const { resolveClientSite } = require('./client-sites');
const { stageFromLines, stcsText } = require('./sm8-import');

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

// A job brought across earlier: the paid claims (deposits) in this run that are not on any of
// its stages yet go onto its first stage, and its invoiced figure moves up by the same amount.
// Matched by claim number, so pressing Import twice adds nothing twice.
async function addMissingDeposits(supabaseAdmin, project, claims) {
  // deposits only: a final invoice paid in ServiceM8 since then is not put on a job TEops now runs
  const paid = claims.filter(c => c.paid && /deposit/i.test(String(c.number)));
  if (!paid.length || !project.job_number) return { added: [] };
  const { data: stages, error } = await supabaseAdmin.from('cost_centres').select('id, invoiced_amount, imported_claims').eq('project_id', project.id).order('sort_order');
  if (error) throw error;
  if (!stages || !stages.length) return { added: [] };
  const have = new Set(stages.flatMap(s => (Array.isArray(s.imported_claims) ? s.imported_claims : []).map(c => String(c.number))));
  const missing = paid.filter(c => !have.has(String(c.number)));
  if (!missing.length) return { added: [] };
  const first = stages[0];
  const { error: upErr } = await supabaseAdmin.from('cost_centres').update({
    imported_claims: [...(Array.isArray(first.imported_claims) ? first.imported_claims : []), ...missing],
    invoiced_amount: r2(Number(first.invoiced_amount || 0) + missing.reduce((t, c) => t + c.amount, 0)),
  }).eq('id', first.id);
  if (upErr) throw upErr;
  return { added: missing.map(c => ({ number: c.number, amount: c.amount })) };
}

// tierIds: Map of rate tier name (lower case) -> id. Returns { projectId, jobNumber, quoteNumber,
// skipped (already in the app), added (deposits added to a job already in the app) }.
async function writeSm8Job(supabaseAdmin, userId, row, client, tierIds) {
  const sm8JobUuid = str(row.sm8JobUuid, 100);
  if (!sm8JobUuid) throw new Error('Missing ServiceM8 job id');
  const name = str(row.name, 300);
  if (!name) throw new Error('Job name is required');
  // A ServiceM8 quote comes across as a TEops quote: Q number, no job
  // number, Draft quote or Quote sent by whether ServiceM8 sent it.
  const isQuote = row.kind === 'quote';
  const isCompleted = row.kind === 'completed';
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
  const invoiced = isQuote ? 0 : r2(s.invoicedExGst);
  // The Completed ServiceM8 claims behind that figure, kept on the stage so the claims card, the
  // Invoice project panel, the claim numbering and the invoice's Claim summary count them (item 45).
  const importedClaims = isQuote ? [] : (Array.isArray(s.claims) ? s.claims : []).slice(0, 50).map(c => ({
    number: str(c.number, 50) || '?', amount: r2(c.amount), source: 'servicem8',
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')) ? c.date : null,
    // a deposit, or an invoice paid in ServiceM8: the payment date and method
    ...(/^\d{4}-\d{2}-\d{2}$/.test(String(c.paid || '')) ? { paid: c.paid, method: str(c.method, 50) || 'ServiceM8', ...(n(c.amount_inc) > 0 ? { amount_inc: r2(c.amount_inc) } : {}) } : {}),
  }));
  if (importedClaims.some(c => !(c.amount >= 0))) throw new Error('A ServiceM8 claim has a bad amount');
  if (importedClaims.length && Math.abs(r2(importedClaims.reduce((t, c) => t + c.amount, 0)) - invoiced) > 0.01) throw new Error('The ServiceM8 claims do not add up to the invoiced figure');

  // Already in the app from an earlier run: only a deposit it is missing is added.
  const { data: priorJob, error: priorErr } = await supabaseAdmin.from('projects').select('id, job_number, quote_number').eq('sm8_job_uuid', sm8JobUuid).maybeSingle();
  if (priorErr) throw priorErr;
  if (priorJob) {
    return { skipped: true, projectId: priorJob.id, jobNumber: priorJob.job_number, quoteNumber: priorJob.quote_number, ...(await addMissingDeposits(supabaseAdmin, priorJob, importedClaims)) };
  }
  // ServiceM8's STC rebate lines: kept as the list the STCs tab offers for Formbay, and set as the
  // job's STC and BSTC credits (hot water STCs are STCs too) so they come off the invoice.
  const stcs = (Array.isArray(s.stcs) ? s.stcs : []).slice(0, 10).map(x => ({
    type: ['pv', 'bstc', 'swh'].includes(x.type) ? x.type : 'pv',
    count: Math.round(n(x.count)), price: r2(x.price), total: r2(x.total), label: str(x.label, 200),
  }));
  if (stcs.some(x => !(x.count >= 0) || !(x.price >= 0))) throw new Error('Bad STC figures');
  const creditOf = (types) => {
    const list = stcs.filter(x => types.includes(x.type));
    const qty = list.reduce((t, x) => t + x.count, 0);
    const total = r2(list.reduce((t, x) => t + x.total, 0));
    return qty > 0 ? { qty, total, price: r2(total / qty) } : null;
  };
  const stcCredit = creditOf(['pv', 'swh']);
  const bstcCredit = creditOf(['bstc']);
  const stcNote = stcs.length
    ? `\n\nSTCs in ServiceM8, applied as credits: ${stcsText(stcs)}.\nThey come off the invoice as the job's STC and BSTC credits; add them on the STCs tab (+ Add STCs) to track them with Formbay.`
    : '';
  if (Number.isNaN(quoted) || quoted < 0 || !(invoiced >= 0)) throw new Error('Value and invoiced must be numbers, 0 or more');
  if (invoiced > quoted + 0.01) throw new Error(`Invoiced ($${invoiced.toFixed(2)}) is more than the job value ($${quoted.toFixed(2)})`);
  const groupDescriptions = new Map((Array.isArray(s.groups) ? s.groups : []).map(g => [str(g.key, 100), str(g.description, 5000)]));

  const { data: existing } = await supabaseAdmin
    .from('projects').select('id, job_number, quote_number').eq('sm8_job_uuid', sm8JobUuid).maybeSingle();
  // Includes a ServiceM8 quote that became a Work Order after its quote was
  // brought across: approve the TEops quote to make it the job.
  if (existing) return { skipped: true, projectId: existing.id, jobNumber: existing.job_number, quoteNumber: existing.quote_number };

  let quoteNumber = null;
  if (isQuote) {
    const { data: qn, error: qErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'quote' });
    if (qErr) throw qErr;
    quoteNumber = qn;
  }
  const isYmd = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const sentAt = isQuote && row.quoteSent ? (isYmd(row.quoteSentDate) ? `${row.quoteSentDate}T09:00:00+10:00` : new Date().toISOString()) : null;
  // A completed job keeps its ServiceM8 number as its J number when that number is free.
  let jobNumber = null;
  if (isCompleted) {
    const { data: settings, error: setErr } = await supabaseAdmin.from('company_settings').select('next_job_number').eq('id', 1).maybeSingle();
    if (setErr) throw setErr;
    const wanted = /^\d{1,9}$/.test(String(row.sm8JobNumber || '')) ? Number(row.sm8JobNumber) : 0;
    if (wanted > 0 && settings && wanted < Number(settings.next_job_number)) {
      const { data: taken, error: takenErr } = await supabaseAdmin.from('projects').select('id').eq('job_number', wanted).limit(1);
      if (takenErr) throw takenErr;
      if (!taken.length) jobNumber = wanted;
    }
    if (!jobNumber) {
      const { data: jn, error: jErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'job' });
      if (jErr) throw jErr;
      jobNumber = jn;
    }
  }

  const { data: project, error: projectErr } = await supabaseAdmin
    .from('projects')
    .insert({
      name,
      sow_text: str(row.description) || null,
      notes: (str(row.notesText, 100000) + stcNote).trim() || null,
      sm8_stcs: stcs.length ? stcs : null,
      ...(stcCredit ? { stc_quantity: stcCredit.qty, stc_price_per_certificate: stcCredit.price, stc_total: stcCredit.total } : {}),
      ...(bstcCredit ? { bstc_quantity: bstcCredit.qty, bstc_price_per_certificate: bstcCredit.price, bstc_total: bstcCredit.total } : {}),
      client_id: client.id,
      client_name: client.name,
      client_email: client.email || str(row.clientEmail, 300) || null,
      client_phone: client.phone || str(row.clientPhone, 100) || null,
      client_address: str(row.siteAddress, 500) || null,
      client_site_id: await resolveClientSite(supabaseAdmin, client.id, str(row.siteAddress, 500), client.address),
      // new_build: the general quoted electrical job, invoiced as a share
      // of its quoted value ("Invoice project"). direct_job: invoiced from
      // actual time and materials.
      // a job with no value has nothing to claim against: it is invoiced from actual costs
      proposal_template: quoted > 0 ? 'new_build' : 'direct_job',
      // Job Booked once someone is scheduled or clocks in (database rule, migration 20261023000000).
      pipeline_stage: isQuote ? (sentAt ? 'quote_sent' : 'draft_quote') : isCompleted ? 'archived' : 'ready_to_book',
      status: isQuote ? (sentAt ? 'sent' : 'draft') : 'in_progress',
      ...(isQuote ? { quote_number: quoteNumber, sent_at: sentAt } : {}),
      ...(isCompleted ? {
        job_number: jobNumber,
        completed_at: isYmd(row.completedOn) ? `${row.completedOn}T09:00:00+10:00` : new Date().toISOString(),
        ...(isYmd(row.sm8Date) ? { created_at: `${row.sm8Date}T09:00:00+10:00` } : {}),
      } : {}),
      created_by: userId,
      sm8_job_uuid: sm8JobUuid,
      sm8_job_number: str(row.sm8JobNumber, 50) || null,
    })
    .select('id, job_number, quote_number')
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
      imported_claims: importedClaims,
      // STCs are the job's credits (projects.stc_total and bstc_total above), not this stage's.
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

  return { projectId: project.id, jobNumber: project.job_number, quoteNumber: project.quote_number };
}

module.exports = { writeSm8Job };
