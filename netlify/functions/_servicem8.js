// Shared helper used by the other functions to call the ServiceM8 REST API.
// Auth: private API key sent as X-API-Key (Settings > API Keys in ServiceM8).
const fetch = require('node-fetch');

const SM8_BASE = 'https://api.servicem8.com/api_1.0';

async function sm8(path, { method = 'GET', body } = {}) {
  const apiKey = process.env.SERVICEM8_API_KEY;
  if (!apiKey) throw new Error('SERVICEM8_API_KEY is not set in Netlify environment variables');

  const res = await fetch(`${SM8_BASE}/${path}`, {
    method,
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ServiceM8 API ${method} ${path} failed: ${res.status} ${text}`);
  }

  // ServiceM8 POST/create responses are often empty with the new record's
  // UUID returned in the x-record-uuid header.
  const recordUuid = res.headers.get('x-record-uuid');
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { data, recordUuid };
}

// Find (or create) the ServiceM8 Company record for a client, so jobs link
// to a real client card rather than living as orphan jobs.
async function findOrCreateCompany({ name, email, address }) {
  const { data: companies } = await sm8(
    `company.json?%24filter=name eq '${name.replace(/'/g, "''")}'`
  );
  if (companies && companies.length > 0) return companies[0].uuid;

  const { recordUuid } = await sm8('company.json', {
    method: 'POST',
    body: {
      name,
      email: email || '',
      address: address || '',
      active: 1,
    },
  });
  return recordUuid;
}

// Create one ServiceM8 Job for a single cost centre / project stage.
async function createJob({ projectName, costCentreName, description, companyUuid, quotedAmount }) {
  const jobName = `${projectName} - ${costCentreName}`;
  const { recordUuid } = await sm8('job.json', {
    method: 'POST',
    body: {
      company_uuid: companyUuid,
      status: 'Quote',
      job_description: description || jobName,
      job_name: jobName,
      generated_job_id: undefined, // let ServiceM8 assign its own job number
      queue_uuid: undefined,
      total_invoice_amount: quotedAmount || 0,
    },
  });
  return recordUuid;
}

// Pull back labour cost, material cost and invoiced amount for one job.
async function getJobCosts(jobUuid) {
  const [{ data: materials }, { data: activities }, { data: job }] = await Promise.all([
    sm8(`jobmaterial.json?%24filter=job_uuid eq '${jobUuid}'`),
    sm8(`jobactivity.json?%24filter=job_uuid eq '${jobUuid}' and activity_was_scheduled eq 0`),
    sm8(`job.json/${jobUuid}`),
  ]);

  const materialCost = (materials || []).reduce(
    (sum, m) => sum + (parseFloat(m.cost_ex_tax) || 0) * (parseFloat(m.quantity) || 1),
    0
  );

  // Labour cost = recorded hours * staff hourly cost rate. ServiceM8 exposes
  // the cost rate per activity in some accounts; where it isn't present we
  // fall back to hours only so you can multiply by your own rate later.
  const labourCost = (activities || []).reduce((sum, a) => {
    const hours =
      (new Date(a.end_date).getTime() - new Date(a.start_date).getTime()) / 1000 / 3600;
    const rate = parseFloat(a.cost_rate) || 0;
    return sum + hours * rate;
  }, 0);

  const invoicedAmount = job ? parseFloat(job.total_invoice_amount) || 0 : 0;
  const jobStatus = job ? job.status : 'unknown';

  return { materialCost, labourCost, invoicedAmount, jobStatus };
}

module.exports = { sm8, findOrCreateCompany, createJob, getJobCosts };
