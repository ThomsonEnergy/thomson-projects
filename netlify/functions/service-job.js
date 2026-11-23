// POST /.netlify/functions/service-job
// Body: { action, projectId, ... }
// Price list jobs (disconnect and reconnect, backlog item 109). Checks the caller, then calls
// _shared/service-jobs.js, which owns how.
//   Any active staff member (the crew on site):
//     sheet        the sheet for a job: items, quantities, photos. No prices unless a pricing role asks.
//     save-sheet   { kind, quantities, worthReplacing, finish }
//     save-answer  { itemId, photoPath | answerYesNo }
//   Pricing roles (the office):
//     setup            make the job a price list job; { emailQuestions } also emails the roofer the booking questions
//     send-questions   email the booking questions again
//     price-email      the drafted price email, to check
//     send-price       { to, subject, bodyText } send it
//     price-list-link  the link to the price list page
// Writes: see _shared/service-jobs.js.

const { requireActiveUser } = require('./_shared/require-active-user');
const service = require('./_shared/service-jobs');
const { publicBaseUrl } = require('./_shared/site-url');

const PRICING = ['admin', 'finance', 'sales'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user, role } = auth;
  const pricing = PRICING.includes(role);

  try {
    const input = JSON.parse(event.body || '{}');
    const { action, projectId } = input;
    if (action === 'price-list-link') {
      if (!pricing) return json(403, { ok: false, error: 'Not authorized' });
      const { data, error } = await admin.from('company_settings').select('service_prices_token').eq('id', 1).single();
      if (error) throw error;
      return json(200, { ok: true, url: `${publicBaseUrl()}/service-prices.html?token=${data.service_prices_token}` });
    }
    if (!UUID.test(projectId || '')) return json(400, { ok: false, error: 'projectId is required' });

    if (action === 'sheet') return json(200, { ok: true, ...(await service.sheetData(admin, projectId, { withPrices: pricing })) });
    if (action === 'save-sheet') return json(200, await service.saveSheet(admin, projectId, user, input));
    if (action === 'save-answer') return json(200, await service.saveAnswer(admin, projectId, user, input));

    if (!pricing) return json(403, { ok: false, error: 'Not authorized' });
    if (action === 'setup') return json(200, await service.setupServiceJob(admin, projectId, user.id, { emailQuestions: !!input.emailQuestions }));
    if (action === 'send-questions') return json(200, await service.sendQuestionsEmail(admin, projectId, user.id));
    if (action === 'price-email') return json(200, { ok: true, ...(await service.priceEmailDraft(admin, projectId)) });
    if (action === 'send-price') return json(200, await service.sendPriceEmail(admin, projectId, user.id, input));
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    if (err.statusCode === 400) return json(400, { ok: false, error: err.message });
    console.error('service-job error:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
