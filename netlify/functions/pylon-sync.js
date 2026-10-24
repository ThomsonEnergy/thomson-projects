const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');

// Pulls a hardware summary (panel/inverter/battery counts) from Pylon's
// documented solar_designs API (https://app.getpylon.com/docs/api) so it
// can be shown as plain text right on our own quote page. This is as far
// as integration goes - Pylon's proposal page itself can't be embedded
// (it sends X-Frame-Options: SAMEORIGIN, confirmed against a live
// proposal link) and its API doesn't expose production or ROI figures at
// all, only hardware counts - the full interactive design + ROI calc
// still only exists behind the Pylon link itself.
//
// NOTE: the field names read below (module_types/inverter_types/
// storage_types/summary.dc_output_kw) are taken from Pylon's docs, not
// verified against a live response - the raw response is logged below so
// if this comes back empty or errors once a real API key is set, check
// the function logs against https://app.getpylon.com/docs/api and adjust.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Pricing roles only (the same gate as push-to-pylon): the Pylon key is spent and the quote's
  // hardware summary, shown to the client, is overwritten through the service role.
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  const supabaseAdmin = auth.supabaseAdmin;

  try {
    const { projectId, pylonProjectId } = JSON.parse(event.body || '{}');
    if (!projectId || !pylonProjectId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'projectId and pylonProjectId are required' }) };
    }

    // the quote has to exist before the Pylon key is spent on it
    const { data: project, error: projectErr } = await supabaseAdmin.from('projects').select('id').eq('id', projectId).maybeSingle();
    if (projectErr) throw projectErr;
    if (!project) return { statusCode: 404, body: JSON.stringify({ ok: false, error: 'Quote not found' }) };

    const apiKey = await getIntegrationKey('pylon');

    const query = new URLSearchParams({ 'fields[solar_designs]': 'summary,module_types,inverter_types,storage_types' });
    const res = await fetch(`https://api.getpylon.com/v1/solar_designs/${encodeURIComponent(pylonProjectId)}?${query}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/vnd.api+json' },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Pylon API request failed: ${res.status} ${text}`);
    }

    const json = await res.json();
    console.log('Pylon solar design response:', JSON.stringify(json));
    const pylonData = json.data?.attributes || {};

    const { error } = await supabaseAdmin
      .from('projects')
      .update({ pylon_data: pylonData, pylon_project_id: pylonProjectId })
      .eq('id', projectId);
    if (error) throw error;

    return { statusCode: 200, body: JSON.stringify({ ok: true, pylonData }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
