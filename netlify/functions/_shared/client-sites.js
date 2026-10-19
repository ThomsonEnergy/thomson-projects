// Server-side twin of resolveClientSite() in public/js/supabase-client.js. A client has one
// office / billing address (clients.address) and any number of job sites (client_sites).
// Returns the client_sites id for a job address: null for the office address, the existing
// site when there is one, otherwise a new site row.
async function resolveClientSite(supabaseAdmin, clientId, address, officeAddress) {
  const norm = (v) => String(v || '').trim().toLowerCase();
  address = String(address || '').trim();
  if (!clientId || !address) return null;
  if (officeAddress === undefined) {
    const { data: c } = await supabaseAdmin.from('clients').select('address').eq('id', clientId).maybeSingle();
    officeAddress = c ? c.address : null;
  }
  if (norm(address) === norm(officeAddress)) return null;
  const { data: sites } = await supabaseAdmin.from('client_sites').select('id, address').eq('client_id', clientId);
  const found = (sites || []).find((s) => norm(s.address) === norm(address));
  if (found) return found.id;
  const { data, error } = await supabaseAdmin.from('client_sites').insert({ client_id: clientId, address }).select('id').single();
  if (error) {
    // Two imports saving the same new site at once: the unique index keeps one row, use it.
    const { data: again } = await supabaseAdmin.from('client_sites').select('id, address').eq('client_id', clientId);
    const hit = (again || []).find((s) => norm(s.address) === norm(address));
    return hit ? hit.id : null;
  }
  return data.id;
}

module.exports = { resolveClientSite };
