const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

// NOTE: this is a best-effort starting point, not a verified integration.
// Pylon's API requires contacting their support team to get API access and
// exact endpoint/auth details (see https://getpylon.com/developers/). Once
// you have that, you will very likely need to adjust the URL and auth header
// below, and the field names read back from the response. Until then, the
// reliable option is just pasting the Pylon proposal link into the project
// (the "Pylon design link" field), which works today with no API needed.

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { projectId, pylonProjectId } = JSON.parse(event.body);
    if (!projectId || !pylonProjectId) {
      return { statusCode: 400, body: 'projectId and pylonProjectId are required' };
    }

    const apiKey = process.env.PYLON_API_KEY;
    if (!apiKey) throw new Error('PYLON_API_KEY is not set in Netlify environment variables');

    // Best-effort guess at Pylon's REST shape, confirm the real path/auth with
    // Pylon support and update this line once known.
    const res = await fetch(`https://api.getpylon.com/v1/projects/${pylonProjectId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Pylon API request failed: ${res.status} ${text}`);
    }

    const pylonData = await res.json();

    const { error } = await supabase
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
