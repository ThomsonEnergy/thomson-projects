// Left to invoice on do and charge jobs (backlog item 85): the work done and not yet on an invoice,
// at the price the next invoice would carry. Asked of jobs-left-to-invoice.js (pricing roles only,
// maths in _shared/job-actuals.js). Used by the Jobs list (projects.html) and the job page's money
// strip (project.html). A quoted job's figure is signed minus invoiced: the page has that already.
// Reads only.

// { [projectId]: dollars } for the do and charge jobs among projectIds. null when the person is not
// a pricing role (the figure is not theirs to see); a job missing from the answer could not be read.
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
