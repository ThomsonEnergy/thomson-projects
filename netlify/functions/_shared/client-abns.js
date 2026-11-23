// The background ABN search for clients (backlog item 110 point 8). Looks up, in the ABN register,
// every client with no ABN that is a company or plainly a business by its name (never a homeowner),
// and keeps what it found for a person to review on the Clients page: nothing is saved onto a
// client until someone presses Apply. A client is searched once per name; "None of these" is
// remembered. Called by client-cleanup-background.js (the search) and client-cleanup.js (the list,
// Apply, None of these). Reads clients and invoices; writes client_abn_suggestions, and on Apply
// clients.abn and clients.client_type.
//
//   looksLikeBusiness(client)                -> boolean
//   searchClientAbns(admin, { budgetMs })    -> { searched, found, exact, left }
//   listAbns(admin)                          -> [{ clientId, name, clientType, exact, results, typeChange, typeHeld }]
//   applyAbns(admin, userId, items)          -> { applied, typeChanged }
//   noAbn(admin, userId, clientId)

const { searchNames } = require('./abr');

const PER_RUN = 300;
const BUSINESS_WORDS = /\b(pty|ltd|limited|p\/l|inc|incorporated|co|company|group|holdings|trust|trustee|atf|enterprises|industries|services|solutions|systems|consulting|consultants|management|properties|property|developments|constructions?|builders?|building|homes|roofing|plumbing|electrical|electrics|solar|energy|air|airconditioning|mechanical|engineering|landscaping|landscapes|painting|carpentry|joinery|kitchens|bathrooms|tiling|concreting|earthmoving|excavations?|fencing|glass|steel|metal|timber|hardware|supplies|wholesale|transport|logistics|motors|automotive|farms?|pastoral|council|school|college|university|church|club|association|society|foundation|strata|body corporate|owners corporation|realty|real estate|rentals|hire|cafe|restaurant|hotel|motel|pharmacy|medical|dental|clinic|studio|design|fitness|gym|bakery|brewing|winery|and sons|& sons|bros|brothers|partners|partnership|australia|aust|nsw|qld)\b/i;
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(pty|ltd|limited|the|trust|p\/l)\b/g, '').replace(/[^a-z0-9]/g, '');
const isPerson = (type) => /individual|sole trader/i.test(String(type || ''));

function looksLikeBusiness(c) {
  const name = String((c && c.name) || '').trim();
  if (name.length < 3) return false;
  return c.client_type === 'company' || BUSINESS_WORDS.test(name) || /&/.test(name);
}

// Searches until the list or the time runs out; the next run carries on where this one stopped.
async function searchClientAbns(admin, { budgetMs = 10 * 60 * 1000 } = {}) {
  const started = Date.now();
  const [{ data: clients, error }, { data: done, error: doneErr }] = await Promise.all([
    admin.from('clients').select('id, name, client_type, abn').limit(10000),
    admin.from('client_abn_suggestions').select('client_id, searched_name'),
  ]);
  if (error) throw error;
  if (doneErr) throw doneErr;
  const searched = new Map((done || []).map((d) => [d.client_id, d.searched_name]));
  const todo = (clients || []).filter((c) => !String(c.abn || '').trim() && looksLikeBusiness(c) && searched.get(c.id) !== c.name);
  let count = 0, found = 0, exactCount = 0, failures = 0;
  for (const c of todo.slice(0, PER_RUN)) {
    if (Date.now() - started > budgetMs) break;
    let results;
    try { ({ results } = await searchNames(c.name, 10, { details: 3 })); }
    catch (err) {
      // the register being down is not "no match": leave the client for the next run
      failures += 1;
      if (failures >= 5) throw new Error(`The ABN register could not be reached (${String(err.message).slice(0, 100)}).`);
      continue;
    }
    const want = norm(c.name);
    const matches = results.filter((r) => r.active && (norm(r.name) === want || norm(r.entityName) === want));
    const exact = new Set(matches.map((r) => r.abn)).size === 1;
    // the exact one first, then the register's own order
    const ordered = exact ? [matches[0], ...results.filter((r) => r !== matches[0])] : results;
    const { error: upErr } = await admin.from('client_abn_suggestions').upsert({
      client_id: c.id, searched_name: c.name, results: ordered.slice(0, 10), exact, status: ordered.length ? 'open' : 'none', searched_at: new Date().toISOString(), decided_by: null,
    }, { onConflict: 'client_id' });
    if (upErr) throw upErr;
    count += 1;
    if (ordered.length) found += 1;
    if (exact) exactCount += 1;
  }
  return { searched: count, found, exact: exactCount, left: Math.max(0, todo.length - count) };
}

// A client labelled Individual whose ABN belongs to a company (anything but a sole trader) becomes
// Company when the ABN is applied (owner, 24 Nov 2026). Held back while the client has an unpaid
// invoice with an STC credit on it: the GST on that credit follows the client type, so the balance
// of an invoice already sent would move.
async function heldClients(admin, clientIds) {
  if (!clientIds.length) return new Set();
  const { data: projects, error } = await admin.from('projects').select('client_id, invoices(id, paid_at, stc_amount, bstc_amount)').in('client_id', clientIds);
  if (error) throw error;
  return new Set((projects || []).filter((p) => (p.invoices || []).some((i) => !i.paid_at && ((Number(i.stc_amount) || 0) > 0 || (Number(i.bstc_amount) || 0) > 0))).map((p) => p.client_id));
}
const wouldBecomeCompany = (client, result) => client.client_type === 'individual' && !!result && !!result.entityType && !isPerson(result.entityType);

async function listAbns(admin) {
  const { data: rows, error } = await admin.from('client_abn_suggestions').select('client_id, searched_name, results, exact, searched_at, clients(id, name, client_type, abn)').eq('status', 'open');
  if (error) throw error;
  const open = (rows || []).filter((r) => r.clients && !String(r.clients.abn || '').trim() && r.clients.name === r.searched_name);
  const held = await heldClients(admin, open.map((r) => r.client_id));
  return open.sort((x, y) => (y.exact - x.exact) || String(x.clients.name).localeCompare(String(y.clients.name))).map((r) => ({
    clientId: r.client_id, name: r.clients.name, clientType: r.clients.client_type, exact: !!r.exact, typeHeld: held.has(r.client_id),
    results: (r.results || []).map((x) => ({ ...x, becomesCompany: wouldBecomeCompany(r.clients, x) })),
  }));
}

// items: [{ clientId, abn }]. The ABN must be one the register gave for that client: never a typed one.
async function applyAbns(admin, userId, items) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.clientId && i.abn).slice(0, 500);
  if (!list.length) return { applied: 0, typeChanged: 0 };
  const ids = list.map((i) => i.clientId);
  const [{ data: rows, error }, held] = await Promise.all([
    admin.from('client_abn_suggestions').select('client_id, results, clients(id, name, client_type, abn)').in('client_id', ids).eq('status', 'open'),
    heldClients(admin, ids),
  ]);
  if (error) throw error;
  let applied = 0, typeChanged = 0;
  for (const item of list) {
    const row = (rows || []).find((r) => r.client_id === item.clientId);
    const result = row && (row.results || []).find((x) => String(x.abn) === String(item.abn));
    if (!row || !row.clients || !result) continue;
    const toCompany = wouldBecomeCompany(row.clients, result) && !held.has(item.clientId);
    const { error: upErr } = await admin.from('clients').update({ abn: String(result.abn), ...(toCompany ? { client_type: 'company' } : {}) }).eq('id', item.clientId);
    if (upErr) throw upErr;
    await admin.from('client_abn_suggestions').update({ status: 'applied', decided_by: userId }).eq('client_id', item.clientId);
    await admin.from('activity_log').insert({ entity_type: 'client', entity_id: item.clientId, action: 'abn_applied', changed_by: userId,
      description: `ABN ${result.abn} set from the ABN register (${result.entityName || result.name})${toCompany ? '; client type changed from Individual to Company' : ''}` });
    applied += 1;
    if (toCompany) typeChanged += 1;
  }
  return { applied, typeChanged };
}

async function noAbn(admin, userId, clientId) {
  const { error } = await admin.from('client_abn_suggestions').update({ status: 'none', decided_by: userId }).eq('client_id', clientId);
  if (error) throw error;
  return { ok: true };
}

module.exports = { looksLikeBusiness, searchClientAbns, listAbns, applyAbns, noAbn };
