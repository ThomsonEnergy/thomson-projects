// POST /.netlify/functions/decline-by-client
// Body: { quoteToken? | variationToken?, reason? }
//
// Public, called from the client's own quote or variation page (the "Decline" button).
// Security is the random token, the same as accept-quote.js / accept-variation.js.
// The person who made the quote or variation is notified. Staff can reopen it.

const { getAdminClient } = require('./_shared/require-admin');

const reply = (code, body) => ({ statusCode: code, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const supabaseAdmin = getAdminClient();
  try {
    const { quoteToken, variationToken, reason } = JSON.parse(event.body || '{}');
    const why = String(reason || '').trim().slice(0, 2000) || null;
    const now = new Date().toISOString();

    if (variationToken) {
      const { data: entry } = await supabaseAdmin.from('job_variation_entries').select('id, project_id, variation_number, description, approval_status, created_by')
        .eq('variation_token', variationToken).eq('variation_type', 'fixed').maybeSingle();
      if (!entry || entry.approval_status !== 'sent') return reply(400, { ok: false, error: 'This variation is not open for a decision. Please contact us.' });
      const { error } = await supabaseAdmin.from('job_variation_entries').update({ approval_status: 'declined', declined_at: now, declined_by: null, decline_reason: why })
        .eq('id', entry.id).eq('approval_status', 'sent');
      if (error) throw error;
      const label = `Variation ${entry.variation_number || ''}`.trim();
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: entry.project_id, action: 'variation_declined', description: `${label} declined by the client${why ? ': ' + why : ''}`, changed_by: null });
      if (entry.created_by) {
        await supabaseAdmin.rpc('create_notification', {
          p_user: entry.created_by, p_kind: 'variation', p_title: `Variation declined: ${entry.description}`,
          p_body: why ? `Reason: ${why}` : 'The client declined it on the variation page.',
          p_link: `/project.html?id=${entry.project_id}`, p_actor: null, p_dedupe: `variation-declined-${entry.id}-${now}`,
        });
      }
      return reply(200, { ok: true });
    }

    if (quoteToken) {
      const { data: quote } = await supabaseAdmin.from('projects').select('id, status, job_number, quote_number, name, created_by').eq('quote_token', quoteToken).maybeSingle();
      if (!quote || quote.job_number || ['approved', 'declined'].includes(quote.status)) return reply(400, { ok: false, error: 'This quote is not open for a decision. Please contact us.' });
      const { error } = await supabaseAdmin.from('projects').update({ status: 'declined', pipeline_stage: 'archived', declined_at: now, declined_by: null, decline_reason: why })
        .eq('id', quote.id).neq('status', 'approved');
      if (error) throw error;
      const label = quote.quote_number ? `Quote Q${quote.quote_number}` : 'Quote';
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: quote.id, action: 'quote_declined', description: `${label} declined by the client${why ? ': ' + why : ''}`, changed_by: null });
      if (quote.created_by) {
        await supabaseAdmin.rpc('create_notification', {
          p_user: quote.created_by, p_kind: 'quote', p_title: `Quote declined: ${quote.name}`,
          p_body: why ? `Reason: ${why}` : 'The client declined it on the quote page.',
          p_link: `/project.html?id=${quote.id}`, p_actor: null, p_dedupe: `quote-declined-${quote.id}-${now}`,
        });
      }
      return reply(200, { ok: true });
    }
    return reply(400, { ok: false, error: 'A quote or variation token is required' });
  } catch (err) {
    console.error('decline-by-client error:', err.message);
    return reply(500, { ok: false, error: err.message });
  }
};
