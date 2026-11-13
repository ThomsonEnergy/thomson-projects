// Left to invoice on do and charge jobs (backlog item 85): the work done and not yet on an invoice,
// at the price the next invoice would carry, less anything invoiced as a plain amount. Asked of
// jobs-left-to-invoice.js (pricing roles only, maths in _shared/job-actuals.js). Used by the Jobs
// list (projects.html) and the job page's money strip (project.html). A quoted job's figure is
// signed minus invoiced: the page has that already. Reads only.

// { [projectId]: dollars } for the do and charge jobs among projectIds. null when the person is not
// a pricing role (the figure is not theirs to see). The server answers a batch of jobs all or
// nothing, so a job missing from the answer was in a batch that could not be read.
async function fetchLeftToInvoice(projectIds) {
  if (!projectIds.length || !isPricingRole(await getMyRole())) return null;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return null;
  const chunks = [];
  for (let i = 0; i < projectIds.length; i += 40) chunks.push(projectIds.slice(i, i + 40));
  const out = {};
  await Promise.all(chunks.map(async (ids) => {
    try {
      const res = await fetch('/.netlify/functions/jobs-left-to-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ projectIds: ids }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      Object.entries(data.byProject).forEach(([id, v]) => { out[id] = Number(v.leftToInvoice) || 0; });
    } catch (err) {
      console.error('Left to invoice fetch failed:', err.message);
    }
  }));
  return out;
}

// The job page's money strip on a do and charge job: fills #job-left-to-invoice. project.html
// calls it on every draw, so a new invoice shows straight away.
function fillJobLeftToInvoice(projectId) {
  const el = document.getElementById('job-left-to-invoice');
  if (!el) return;
  fetchLeftToInvoice([projectId]).then((left) => {
    if (el.isConnected) el.textContent = left && left[projectId] != null ? money(left[projectId]) : '-';
  });
}
