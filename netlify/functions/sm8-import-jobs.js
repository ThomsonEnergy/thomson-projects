// POST /.netlify/functions/sm8-import-jobs
// Body: { rows: [{ sm8JobUuid, sm8JobNumber, companyUuid, companyName,
//   companyAddress, clientEmail, clientPhone, siteAddress, description,
//   notesText, name, clientId ('new' or an existing client id),
//   stages: [{ name, quotedExGst, invoicedExGst }] }] }
// Admin only. Writes the rows the admin ticked on the review screen
// (sm8-import-preview.js) as Direct Jobs, a few at a time - the page
// sends them in small batches so no single call runs past the function
// time limit.
//
// Each job is created exactly like a Direct Job from the Quick Job panel
// (job_booked, job number from the usual trigger), plus:
//   * one stage per ServiceM8 claim (4515a, 4515b...) and one for the
//     balance left on the main job, each with quoted_amount /
//     invoiced_amount, so invoicing from the app only bills what
//     ServiceM8 hasn't already billed
//   * the ServiceM8 job's notes in projects.notes
//   * sm8_job_uuid / sm8_job_number, which make a re-run skip it
// Reads nothing from and writes nothing to ServiceM8.

const { requireAdmin } = require('./_shared/require-admin');

const MAX_ROWS = 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const str = (v, max = 20000) => String(v ?? '').trim().slice(0, max);

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

async function importRow(supabaseAdmin, userId, row) {
  const sm8JobUuid = str(row.sm8JobUuid, 100);
  if (!sm8JobUuid) throw new Error('Missing ServiceM8 job id');
  const name = str(row.name, 300);
  if (!name) throw new Error('Job name is required');
  const stages = (Array.isArray(row.stages) ? row.stages : []).slice(0, 30).map(s => ({
    name: str(s.name, 200), quoted: r2(s.quotedExGst), invoiced: r2(s.invoicedExGst),
  }));
  if (!stages.length) throw new Error('At least one stage is required');
  for (const s of stages) {
    if (!s.name) throw new Error('Every stage needs a name');
    if (s.quoted < 0 || s.invoiced < 0) throw new Error(`${s.name}: amounts cannot be negative`);
    if (s.invoiced > s.quoted + 0.01) throw new Error(`${s.name}: invoiced is more than its value`);
  }

  const { data: existing } = await supabaseAdmin
    .from('projects').select('id, job_number').eq('sm8_job_uuid', sm8JobUuid).maybeSingle();
  if (existing) return { skipped: true, projectId: existing.id, jobNumber: existing.job_number };

  const client = await resolveClient(supabaseAdmin, row);

  const { data: project, error: projectErr } = await supabaseAdmin
    .from('projects')
    .insert({
      name,
      sow_text: str(row.description) || null,
      notes: str(row.notesText, 100000) || null,
      client_id: client.id,
      client_name: client.name,
      client_email: client.email || str(row.clientEmail, 300) || null,
      client_phone: client.phone || str(row.clientPhone, 100) || null,
      client_address: str(row.siteAddress, 500) || null,
      proposal_template: 'direct_job',
      pipeline_stage: 'job_booked',
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

  const { error: ccErr } = await supabaseAdmin.from('cost_centres').insert(stages.map((s, i) => ({
    project_id: project.id,
    name: s.name,
    sort_order: i,
    markup_percent: 45,
    quoted_amount: s.quoted,
    invoiced_amount: s.invoiced,
  })));
  if (ccErr) {
    // No stages means nowhere to log time or invoice against - take the
    // half-made job back out so a re-run creates it cleanly.
    await supabaseAdmin.from('projects').delete().eq('id', project.id);
    throw ccErr;
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

    // One at a time, not in parallel: two jobs for the same new client
    // must not both create it.
    const results = [];
    for (const row of rows) {
      try {
        const r = await importRow(supabaseAdmin, user.id, row);
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
