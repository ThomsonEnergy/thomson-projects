// POST /.netlify/functions/approval-actions
// Body: { kind: 'quote' | 'variation', id, action: 'approve' | 'decline' | 'reopen' | 'extend',
//         method?: 'email' | 'phone' | 'in_person', note?, emailThreadId?, reason?, validUntil? }
//
// Pricing roles only. Records what the client said outside the app:
//   approve  a fixed-price variation approved by email, phone or in person (quotes are
//            approved through manually-approve-quote.js, which makes the job). With
//            'email' the client's email (a thread tagged to the job or quote) is linked
//            as the proof; otherwise a note is required.
//   decline  the client said no: a reason is required, an email can be linked as proof.
//            A declined quote moves to the Declined tab on Quotes; a declined variation
//            never reaches an invoice.
//   reopen   undoes a decline: a quote goes back to Sent, a variation back to Draft, with a
//            fresh valid until date (today + the valid days in Settings).
//   extend   a new valid until date (validUntil, YYYY-MM-DD). One that expired is reopened
//            (back to Sent) at the same time. Migration 20261030000000.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { approveVariation } = require('./_shared/approve-variation');

const METHODS = ['email', 'phone', 'in_person'];
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDate = (ymd) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
async function freshValidUntil(supabaseAdmin) {
  const { data } = await supabaseAdmin.from('company_settings').select('quote_valid_days').eq('id', 1).maybeSingle();
  return addDays(sydneyToday(), Number(data?.quote_valid_days) || 30);
}
const CLEAR_DECLINE = { declined_at: null, declined_by: null, decline_reason: null, approval_email_thread_id: null, expired: false };
const bad = (msg, code = 400) => ({ statusCode: code, body: JSON.stringify({ ok: false, error: msg }) });

// The email must be tagged to this job (or the quote it came from), so the proof is on record.
async function checkThread(supabaseAdmin, threadId, projectIds) {
  if (!threadId) return null;
  const { data } = await supabaseAdmin.from('email_job_links').select('id').eq('thread_id', threadId).in('project_id', projectIds).limit(1);
  if (!data || !data.length) throw Object.assign(new Error('That email is not tagged to this job. Tag it first, then pick it.'), { statusCode: 400 });
  return threadId;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return bad('Not authorized', 403);
  const { supabaseAdmin, user } = auth;

  try {
    const { kind, id, action, method, note, emailThreadId, reason, validUntil } = JSON.parse(event.body || '{}');
    if (!id || !['quote', 'variation'].includes(kind) || !['approve', 'decline', 'reopen', 'extend'].includes(action)) return bad('kind, id and action are required');
    if (action === 'extend' && !(/^\d{4}-\d{2}-\d{2}$/.test(validUntil || '') && validUntil >= sydneyToday())) return bad('Pick a date from today on.');
    const { data: actor } = await supabaseAdmin.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
    const byName = actor?.full_name || 'someone';
    const cleanNote = String(note || '').trim();
    const cleanReason = String(reason || '').trim();
    const now = new Date().toISOString();

    if (kind === 'variation') {
      const { data: entry } = await supabaseAdmin.from('job_variation_entries').select('*').eq('id', id).eq('variation_type', 'fixed').maybeSingle();
      if (!entry) return bad('Variation not found', 404);
      const { data: job } = await supabaseAdmin.from('projects').select('id, client_name, source_quote_id').eq('id', entry.project_id).single();
      const projectIds = [job.id, job.source_quote_id].filter(Boolean);
      const label = `Variation ${entry.variation_number || ''}`.trim();

      if (action === 'approve') {
        if (entry.approval_status === 'approved') return bad('This variation is already approved.');
        if (!METHODS.includes(method)) return bad('Pick how the client approved it.');
        if (method === 'email' && !emailThreadId) return bad('Pick the client\'s email.');
        if (method !== 'email' && !cleanNote) return bad('Add a note: who approved it and when.');
        const thread = await checkThread(supabaseAdmin, emailThreadId, projectIds);
        await approveVariation(supabaseAdmin, { ...entry, client_name: job.client_name }, {
          method, note: cleanNote, approvedBy: user.id, emailThreadId: thread, fromStatuses: ['draft', 'sent', 'declined'],
        });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'decline') {
        if (entry.approval_status === 'approved') return bad('This variation is already approved and on the job.');
        if (!cleanReason) return bad('Add the reason the client gave.');
        const thread = await checkThread(supabaseAdmin, emailThreadId, projectIds);
        const { error } = await supabaseAdmin.from('job_variation_entries').update({
          approval_status: 'declined', declined_at: now, declined_by: user.id, decline_reason: cleanReason, approval_email_thread_id: thread,
        }).eq('id', id).neq('approval_status', 'approved');
        if (error) throw error;
        await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: entry.project_id, action: 'variation_declined', description: `${label} marked declined: ${cleanReason}`, changed_by: user.id });
        return { statusCode: 200, body: JSON.stringify({ ok: true }) };
      }
      if (action === 'extend') {
        if (entry.approval_status === 'approved') return bad('This variation is already approved.');
        const reopen = entry.approval_status === 'declined';
        if (reopen && !entry.expired) return bad('This variation was declined by the client. Reopen it instead.');
        const { error } = await supabaseAdmin.from('job_variation_entries').update({
          valid_until: validUntil, ...(reopen ? { approval_status: 'sent', ...CLEAR_DECLINE } : {}),
        }).eq('id', id).neq('approval_status', 'approved');
        if (error) throw error;
        await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: entry.project_id, action: 'variation_extended', description: `${label} extended to ${longDate(validUntil)} by ${byName}${reopen ? ' (reopened after it expired)' : ''}`, changed_by: user.id });
        return { statusCode: 200, body: JSON.stringify({ ok: true, reopened: reopen }) };
      }
      // reopen
      if (entry.approval_status !== 'declined') return bad('Only a declined variation can be reopened.');
      const { error } = await supabaseAdmin.from('job_variation_entries').update({
        approval_status: 'draft', ...CLEAR_DECLINE, valid_until: null,
      }).eq('id', id).eq('approval_status', 'declined');
      if (error) throw error;
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: entry.project_id, action: 'variation_reopened', description: `${label} reopened (back to draft)`, changed_by: user.id });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }

    // quotes
    const { data: quote } = await supabaseAdmin.from('projects').select('id, status, job_number, quote_number, expired').eq('id', id).maybeSingle();
    if (!quote || quote.job_number) return bad('Quote not found', 404);
    const qLabel = quote.quote_number ? `Quote Q${quote.quote_number}` : 'Quote';
    if (action === 'approve') return bad('Use Mark approved on the quote.');
    if (action === 'decline') {
      if (quote.status === 'approved') return bad('This quote is already approved.');
      if (!cleanReason) return bad('Add the reason the client gave.');
      const thread = await checkThread(supabaseAdmin, emailThreadId, [quote.id]);
      const { error } = await supabaseAdmin.from('projects').update({
        status: 'declined', pipeline_stage: 'archived', declined_at: now, declined_by: user.id, decline_reason: cleanReason, approval_email_thread_id: thread,
      }).eq('id', id).neq('status', 'approved');
      if (error) throw error;
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: quote.id, action: 'quote_declined', description: `${qLabel} marked declined: ${cleanReason}`, changed_by: user.id });
      return { statusCode: 200, body: JSON.stringify({ ok: true }) };
    }
    if (action === 'extend') {
      if (quote.status === 'approved') return bad('This quote is already approved.');
      const reopen = quote.status === 'declined';
      if (reopen && !quote.expired) return bad('This quote was declined by the client. Reopen it instead.');
      const { error } = await supabaseAdmin.from('projects').update({
        valid_until: validUntil, ...(reopen ? { status: 'sent', pipeline_stage: 'quote_sent', ...CLEAR_DECLINE } : {}),
      }).eq('id', id).neq('status', 'approved');
      if (error) throw error;
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: quote.id, action: 'quote_extended', description: `${qLabel} extended to ${longDate(validUntil)} by ${byName}${reopen ? ' (reopened after it expired)' : ''}`, changed_by: user.id });
      return { statusCode: 200, body: JSON.stringify({ ok: true, reopened: reopen }) };
    }
    if (quote.status !== 'declined') return bad('Only a declined quote can be reopened.');
    const { error } = await supabaseAdmin.from('projects').update({
      status: 'sent', pipeline_stage: 'quote_sent', ...CLEAR_DECLINE, valid_until: await freshValidUntil(supabaseAdmin),
    }).eq('id', id).eq('status', 'declined');
    if (error) throw error;
    await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: quote.id, action: 'quote_reopened', description: `${qLabel} reopened (back to Sent)`, changed_by: user.id });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error('approval-actions error:', err.message);
    return { statusCode: err.statusCode || 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
