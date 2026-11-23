// POST /.netlify/functions/client-cleanup-background
// Body: { run: 'abns' | 'duplicates' }
// Background: the two clean-up scans on the Clients page (backlog item 110), started by a button
// and left to run while the person carries on (a scan takes longer than the 10 second limit).
//   abns        pricing roles. Looks up every business client with no ABN in the ABN register
//               (_shared/client-abns.js) and keeps the matches for review.
//   duplicates  Admin only. Pairs likely duplicates by rule and asks the AI which are one customer
//               and which record to keep (_shared/client-duplicates.js). It only recommends.
// When it finishes, the person who pressed the button gets a notification that opens the list.
// Reports to the ops manager as "client-cleanup" (runs, AI use, a failure alert). Writes
// client_abn_suggestions or client_merge_suggestions, and notifications.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { runAgent } = require('./_shared/agent-log');
const { searchClientAbns } = require('./_shared/client-abns');
const { scanDuplicates } = require('./_shared/client-duplicates');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: '' };
  const { supabaseAdmin: admin, user } = auth;
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 202, body: '' }; }
  const run = body.run === 'duplicates' ? 'duplicates' : body.run === 'abns' ? 'abns' : null;
  if (!run) return { statusCode: 202, body: '' };
  if (run === 'duplicates') {
    const { data: me } = await admin.from('profiles').select('role').eq('id', user.id).single();
    if (!me || me.role !== 'admin') return { statusCode: 403, body: '' };
  }
  const tell = (title, text, link) => admin.rpc('create_notification', {
    p_user: user.id, p_kind: 'booking_reminder', p_title: title, p_body: text, p_link: link, p_actor: null, p_dedupe: `client-cleanup:${run}:${Date.now()}`,
  });

  return runAgent('client-cleanup', async () => {
    try {
      if (run === 'abns') {
        const out = await searchClientAbns(admin);
        const summary = `ABN search: ${out.searched} clients looked up, ${out.found} with a match (${out.exact} exact)${out.left ? `, ${out.left} still to search` : ''}`;
        await tell('ABN search finished', `${out.found} client${out.found === 1 ? '' : 's'} to review${out.left ? `. ${out.left} more to search: press Find ABNs again.` : '.'}`, '/clients.html?review=abns');
        return { summary };
      }
      const out = await scanDuplicates(admin);
      await tell('Duplicate scan finished', `${out.pairs} pair${out.pairs === 1 ? '' : 's'} to review, ${out.same} the AI thinks are the same customer.${out.aiNote ? ` ${out.aiNote}` : ''}`, '/clients.html?review=duplicates');
      return { summary: `Duplicate scan: ${out.pairs} pairs, ${out.same} marked the same customer${out.aiNote ? ' (rules only, the AI was not reached)' : ''}`, usage: out.usage };
    } catch (err) {
      await tell(run === 'abns' ? 'ABN search stopped' : 'Duplicate scan stopped', String(err.message).slice(0, 200), '/clients.html');
      throw err;
    }
  });
};
