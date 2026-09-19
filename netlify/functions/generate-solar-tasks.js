// POST /.netlify/functions/generate-solar-tasks
// Body: { missing: [{id, label}], equipment: {panels, inverters, batteries} }
//
// Client-facing wrapper around _shared/word-solar-tasks.js, used from the
// quote page's compliance checklist panel to turn the missing items from
// check-solar-compliance.js into specific task descriptions before they're
// inserted as job_tasks. See word-solar-tasks.js for the full explanation.

const { wordSolarTasks } = require('./_shared/word-solar-tasks');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { missing = [], equipment = {} } = JSON.parse(event.body || '{}');
    if (!Array.isArray(missing) || !missing.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'At least one missing item is required' }) };
    }

    const tasks = await wordSolarTasks({ missing, equipment });
    return { statusCode: 200, body: JSON.stringify({ ok: true, tasks }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
