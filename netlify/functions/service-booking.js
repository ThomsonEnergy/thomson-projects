// GET  /.netlify/functions/service-booking?token=...   the booking questions for one job
// POST /.netlify/functions/service-booking             { token, answers }
// The roofer's link to the booking questions on a disconnect and reconnect job (backlog item 109).
// Public by design: no login, the random token in the link (projects.service_booking_token) is the
// check, and all it can do is read that one job's questions and save the answers to them, until the
// panels come off. Writes projects.service_booking, job_contacts, activity_log, notifications
// (_shared/service-jobs.js).

const { getAdminClient } = require('./_shared/require-admin');
const service = require('./_shared/service-jobs');

const json = (statusCode, body) => ({ statusCode, headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

exports.handler = async (event) => {
  try {
    const admin = getAdminClient();
    if (event.httpMethod === 'GET') {
      const job = await service.bookingByToken(admin, (event.queryStringParameters || {}).token);
      if (!job) return json(404, { ok: false, error: 'This link is not valid.' });
      const { id, ...shown } = job;
      return json(200, { ok: true, ...shown });
    }
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
    const { token, answers } = JSON.parse(event.body || '{}');
    const job = await service.bookingByToken(admin, token);
    if (!job) return json(404, { ok: false, error: 'This link is not valid.' });
    return json(200, await service.saveBooking(admin, job.id, answers, 'the client, from the emailed link'));
  } catch (err) {
    if (err.statusCode === 400) return json(400, { ok: false, error: err.message });
    console.error('service-booking error:', err.message);
    return json(500, { ok: false, error: 'Something went wrong. Please call us.' });
  }
};
