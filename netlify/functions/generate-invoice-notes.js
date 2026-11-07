// POST { projectId, invoiceId?, lines? }   (pricing roles: Admin, Finance, Sales)
//
// Writes the "Work completed" note for an invoice (item 59) from what the installers wrote on the
// job: site notes saved at clock off (project_field_notes), job feed posts and finished tasks with
// their notes, between the job's previous invoice and this one (the whole job for the first).
// For a new invoice (Invoice actual costs panel, js/project-invoice-actuals.js) the window ends now
// and the page sends the lines it is about to bill as `lines`; for an existing invoice (the invoice
// card's Notes button, js/invoice-notes.js) the window ends at that invoice and its own lines are read
// here. Returns { ok, notes } for a person to edit; saves nothing (the page saves invoices.notes).
// Prompt: agents/prompts/invoice-notes.js.

const fetch = require('node-fetch');
const { requirePricingRole } = require('./_shared/require-pricing-role');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { claudeJson, safeSlice } = require('./_shared/claude-json');
const { INVOICE_NOTES_PROMPT } = require('../../agents/prompts/invoice-notes.js');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const NOTES_CHARS = 12000;
const LINES_CHARS = 3000;
const dayText = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney', day: 'numeric', month: 'short' });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin } = auth;

  try {
    const { projectId, invoiceId, lines } = JSON.parse(event.body || '{}');
    if (!projectId) return json(400, { ok: false, error: 'projectId is required' });

    const [{ data: project }, { data: invoices }] = await Promise.all([
      supabaseAdmin.from('projects').select('id, name, job_number, client_address').eq('id', projectId).maybeSingle(),
      supabaseAdmin.from('invoices').select('id, created_at').eq('project_id', projectId).order('created_at'),
    ]);
    if (!project) return json(404, { ok: false, error: 'Job not found' });

    // The window: after the job's previous invoice, up to this invoice (or now for a new one).
    let until = null;
    let billed = Array.isArray(lines) ? lines.map(l => String(l || '').trim()).filter(Boolean) : [];
    if (invoiceId) {
      const own = (invoices || []).find(i => i.id === invoiceId);
      if (!own) return json(404, { ok: false, error: 'That invoice is not on this job' });
      until = own.created_at;
      const { data: items } = await supabaseAdmin.from('invoice_line_items').select('kind, description, quantity').eq('invoice_id', invoiceId).order('sort_order');
      billed = (items || []).filter(i => i.description).map(i => `${i.kind === 'labour' ? 'Labour' : 'Material'}: ${i.description}${i.kind !== 'labour' && i.quantity ? ` x ${Number(i.quantity)}` : ''}`);
    }
    const earlier = (invoices || []).filter(i => i.id !== invoiceId && (!until || i.created_at < until));
    const since = earlier.length ? earlier[earlier.length - 1].created_at : null;
    const inWindow = (q) => {
      let out = q;
      if (since) out = out.gt('created_at', since);
      if (until) out = out.lte('created_at', until);
      return out;
    };

    const [{ data: fieldNotes }, { data: posts }, { data: tasks }] = await Promise.all([
      inWindow(supabaseAdmin.from('project_field_notes').select('note, created_at').eq('project_id', projectId)).order('created_at'),
      inWindow(supabaseAdmin.from('feed_posts').select('message, created_at').eq('project_id', projectId)).order('created_at'),
      supabaseAdmin.from('job_tasks').select('description, notes, completed_at').eq('project_id', projectId).eq('completed', true)
        .gt('completed_at', since || '1970-01-01').lte('completed_at', until || new Date().toISOString()).order('completed_at'),
    ]);

    const noteLines = [
      ...(fieldNotes || []).map(n => ({ at: n.created_at, text: `Site note: ${n.note}` })),
      ...(posts || []).map(p => ({ at: p.created_at, text: `Job feed: ${p.message}` })),
      ...(tasks || []).map(t => ({ at: t.completed_at, text: `Task done: ${t.description}${t.notes ? ` (${t.notes})` : ''}` })),
    ].filter(n => n.text.trim()).sort((a, b) => String(a.at).localeCompare(String(b.at)))
      .map(n => `- ${dayText(n.at)}: ${n.text.replace(/\s+/g, ' ').trim()}`);
    if (!noteLines.length) {
      return json(200, { ok: false, error: `No site notes, feed posts or finished tasks on this job ${since ? 'since the last invoice' : 'yet'}. Write the notes by hand.` });
    }

    const prompt = INVOICE_NOTES_PROMPT
      .replace('{{job}}', `${project.job_number ? `J${project.job_number} ` : ''}${project.name || ''}${project.client_address ? `, ${project.client_address}` : ''}`)
      .replace('{{notes}}', safeSlice(noteLines.join('\n'), NOTES_CHARS))
      .replace('{{lines}}', safeSlice(billed.map(l => `- ${l}`).join('\n') || '(not given)', LINES_CHARS));

    const apiKey = await getIntegrationKey('anthropic');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: claudeJson({ model: 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = (data.content || []).map(b => b.text || '').join('').trim().replace(/\s*—\s*/g, ', ');
    if (!text || text === 'NOTHING') {
      return json(200, { ok: false, error: 'The site notes do not say what work was done. Write the notes by hand.' });
    }
    return json(200, { ok: true, notes: text });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message });
  }
};
