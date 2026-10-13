// POST /.netlify/functions/create-variation
// Body: { projectId, type: 'do_and_charge' | 'fixed', description, workDate?, notes?,
//         startHours?, reason?, lines? }
// Any active staff member can log a "do and charge" variation (work done first,
// billed for what it took). It gets its own cost centre straight away so the team
// can pick it when clocking in on My Day. Only pricing roles can start a "fixed"
// variation (a price agreed up front, sent to the client to sign): it is saved as a
// draft with its priced lines and only becomes a stage on the job once the client
// approves it (accept-variation.js).
// A server function because staff cannot create cost centres themselves.

const { requireActiveUser } = require('./_shared/require-active-user');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  const { supabaseAdmin, user } = auth;

  try {
    const { projectId, type, description, workDate, notes, startHours, reason, lines } = JSON.parse(event.body || '{}');
    if (!projectId || !description || !String(description).trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: 'projectId and a description are required' }) };
    }
    if (type !== 'do_and_charge' && type !== 'fixed') {
      return { statusCode: 400, body: JSON.stringify({ error: 'type must be do_and_charge or fixed' }) };
    }

    const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
    const isPricing = ['admin', 'finance', 'sales'].includes(profile?.role);
    if (type === 'fixed' && !isPricing) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Only admin, finance and sales can set up a fixed-price variation.' }) };
    }

    const { data: project } = await supabaseAdmin.from('projects').select('id, job_number').eq('id', projectId).single();
    if (!project || !project.job_number) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Variations can only be added to a job.' }) };
    }

    const { data: lastNo } = await supabaseAdmin.from('job_variation_entries').select('variation_number').eq('project_id', projectId).order('variation_number', { ascending: false, nullsFirst: false }).limit(1);
    const number = ((lastNo || [])[0]?.variation_number || 0) + 1;
    const desc = String(description).trim();
    const date = workDate || new Date().toISOString().slice(0, 10);

    let fixedLines = [];
    if (type === 'fixed') {
      fixedLines = (Array.isArray(lines) ? lines : [])
        .map(l => ({
          description: String(l.description || '').trim(),
          item_type: l.item_type === 'labour' ? 'labour' : 'material',
          amount: Math.round((Number(l.amount) || 0) * 100) / 100,
        }))
        .filter(l => l.description && l.amount > 0);
      if (!fixedLines.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Add at least one priced line to a fixed-price variation.' }) };
      }
    }

    const { data: entry, error: entErr } = await supabaseAdmin.from('job_variation_entries').insert({
      project_id: projectId, description: desc, work_date: date, created_by: user.id,
      materials: notes ? String(notes).trim() || null : null,
      variation_type: type, variation_number: number,
      reason: type === 'fixed' ? (String(reason || '').trim() || null) : null,
      fixed_lines: fixedLines,
      approval_status: type === 'fixed' ? 'draft' : null,
    }).select('id').single();
    if (entErr) throw entErr;

    if (type === 'do_and_charge') {
      const { data: settings } = await supabaseAdmin.from('company_settings').select('default_markup_percent').eq('id', 1).maybeSingle();
      const { data: last } = await supabaseAdmin.from('cost_centres').select('sort_order').eq('project_id', projectId).order('sort_order', { ascending: false }).limit(1);
      const nextSort = ((last || [])[0]?.sort_order ?? -1) + 1;
      const { data: centre, error: ccErr } = await supabaseAdmin.from('cost_centres').insert({
        project_id: projectId, name: `Variation ${number}: ${desc}`.slice(0, 90), description: `Out-of-scope work logged ${date}`,
        sort_order: nextSort, markup_percent: Number(settings?.default_markup_percent) || 45, quoted_amount: 0,
        variation_entry_id: entry.id,
      }).select('id').single();
      if (ccErr) throw ccErr;
      await supabaseAdmin.from('job_variation_entries').update({ cost_centre_id: centre.id }).eq('id', entry.id);

      const hrs = Number(startHours);
      if (hrs > 0) {
        await supabaseAdmin.from('job_variation_hours').insert({
          variation_id: entry.id, project_id: projectId, staff_id: user.id, work_date: date, hours: hrs, created_by: user.id,
        });
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, id: entry.id, number }) };
  } catch (err) {
    console.error('create-variation error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
