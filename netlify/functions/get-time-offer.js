// GET /.netlify/functions/get-time-offer?token=<uuid>   (public, the private link is the check)
// What the client's pick-a-time page shows: the job, the site, who would come, each option and
// whether it is still free, and the offer's state. Nothing else about the job leaves here.

const { getAdminClient } = require('./_shared/require-admin');
const E = require('./_shared/schedule-emails');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const token = (event.queryStringParameters || {}).token || '';
  if (!UUID.test(token)) return json(404, { ok: false, error: 'This link is not valid.' });
  try {
    const admin = getAdminClient();
    const { data: offer } = await admin.from('schedule_time_offers').select('*').eq('token', token).maybeSingle();
    if (!offer) return json(404, { ok: false, error: 'This link is not valid.' });
    if (offer.status === 'withdrawn') return json(410, { ok: false, error: 'These times are no longer open. Please contact us.' });
    const [{ data: project }, { data: company }, { data: options }, who] = await Promise.all([
      admin.from('projects').select('name, job_number, quote_number, client_address').eq('id', offer.project_id).maybeSingle(),
      admin.from('company_settings').select('company_name, phone, logo_url').eq('id', 1).maybeSingle(),
      admin.rpc('time_offer_option_status', { p_offer_id: offer.id }),
      E.namesFor(admin, offer.staff_ids || []),
    ]);
    if (!project) return json(404, { ok: false, error: 'This link is not valid.' });
    if (!offer.viewed_at) await admin.from('schedule_time_offers').update({ viewed_at: new Date().toISOString() }).eq('id', offer.id);
    return json(200, {
      ok: true,
      offer: {
        status: offer.status,
        picked_date: offer.picked_date,
        job: E.jobTitle(project),
        address: project.client_address || '',
        start: E.fmtTime(offer.start_time), end: E.fmtTime(offer.end_time),
        days: offer.days, weekdays_only: offer.weekdays_only,
        who: who.map((n) => String(n).split(/\s+/)[0]),
        message: offer.message || '',
        options: (options || []).map((o) => ({ date: o.date, dates: o.dates, label: E.optionLabel(o.date, offer.days, offer.weekdays_only), available: !!o.available, past: !!o.past })),
      },
      company: company ? { name: company.company_name, phone: company.phone, logo_url: company.logo_url } : null,
    });
  } catch (err) {
    console.error('get-time-offer failed:', err);
    return json(500, { ok: false, error: 'Something went wrong loading this link. Please try again.' });
  }
};
