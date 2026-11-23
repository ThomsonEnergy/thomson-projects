// The client duplicate scan (backlog item 110). Rules first put likely pairs side by side (same
// ABN, email, phone or name, or one name inside the other); the AI then reads each pair with its
// facts and says whether they are one customer and which record to keep. It only recommends:
// nothing merges until an Admin presses Merge on the Clients page (client_merge, in the database).
// With no AI key, or when the AI fails, the pairs are still listed as "unsure" with the rule's pick.
// Called by client-cleanup-background.js (the scan) and client-cleanup.js (the list, Not the same).
// Reads clients, projects, invoices, client_contacts, client_sites; writes client_merge_suggestions.
//
//   candidatePairs(clients)                 -> [{ a, b, why }]   (a.id < b.id)
//   cleanVerdict(raw, pair, facts)          -> { verdict, keepId, confidence, reason }
//   scanDuplicates(admin)                   -> { pairs, same, usage, aiNote }
//   listDuplicates(admin)                   -> [{ id, why, verdict, reason, confidence, keepId, a, b }]
//   dismissDuplicate(admin, id, userId)

const { callClaude } = require('./price-list-ai');
const { CLIENT_DUPLICATES_PROMPT } = require('../../../agents/prompts/client-duplicates.js');

const MAX_PAIRS = 240;      // per scan: the strongest rules first
const PER_CALL = 30;        // pairs per AI call
const digits = (s) => String(s || '').replace(/\D/g, '');
const normEmail = (s) => String(s || '').trim().toLowerCase();
const normPhone = (s) => { const d = digits(s); return d.length >= 8 ? d.slice(-9) : ''; };
const normName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/\b(pty|ltd|limited|p\/l|the|trust|atf|t\/a|trading as)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Likely pairs, strongest reason first; a pair is listed once, under its strongest reason.
function candidatePairs(clients) {
  const pairs = new Map();
  const add = (x, y, why, rank) => {
    if (x.id === y.id) return;
    const [a, b] = x.id < y.id ? [x, y] : [y, x];
    const key = `${a.id}|${b.id}`;
    const had = pairs.get(key);
    if (!had) pairs.set(key, { a, b, why: [why], rank });
    else if (!had.why.includes(why)) { had.why.push(why); had.rank = Math.min(had.rank, rank); }
  };
  const group = (keyOf, why, rank, maxGroup) => {
    const by = new Map();
    clients.forEach((c) => { const k = keyOf(c); if (k) (by.get(k) || by.set(k, []).get(k)).push(c); });
    by.forEach((list) => {
      // a detail shared by a crowd (a builder's email on twenty records) is not a duplicate signal
      if (list.length < 2 || list.length > maxGroup) return;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) add(list[i], list[j], why, rank);
    });
  };
  group((c) => (digits(c.abn).length === 11 ? digits(c.abn) : ''), 'same ABN', 1, 6);
  group((c) => normName(c.name), 'same name', 2, 6);
  group((c) => normEmail(c.email), 'same email', 3, 4);
  group((c) => normPhone(c.phone), 'same phone', 4, 4);
  // one name inside the other ("Ocean Blue" and "Ocean Blue Metal Roofing"): two words or more, to keep it meaningful
  const named = clients.map((c) => ({ c, n: normName(c.name) })).filter((x) => x.n.split(' ').length >= 2 && x.n.length >= 8);
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const x = named[i], y = named[j];
      if (x.n !== y.n && (x.n.startsWith(`${y.n} `) || y.n.startsWith(`${x.n} `))) add(x.c, y.c, 'one name inside the other', 5);
    }
  }
  return [...pairs.values()].sort((p, q) => p.rank - q.rank || q.why.length - p.why.length).slice(0, MAX_PAIRS).map((p) => ({ a: p.a, b: p.b, why: p.why.join(', ') }));
}

// What each client has on it: the facts the AI and the rule pick both go by.
async function clientFacts(admin, ids) {
  const facts = Object.fromEntries(ids.map((id) => [id, { jobs: 0, quotes: 0, invoices: 0, sites: 0, contacts: 0, lastUsed: null }]));
  if (!ids.length) return facts;
  const chunks = [];
  for (let i = 0; i < ids.length; i += 200) chunks.push(ids.slice(i, i + 200));
  for (const part of chunks) {
    const [projects, sites, contacts] = await Promise.all([
      admin.from('projects').select('id, client_id, job_number, created_at, invoices(id)').in('client_id', part),
      admin.from('client_sites').select('client_id').in('client_id', part),
      admin.from('client_contacts').select('client_id').in('client_id', part),
    ]);
    for (const r of [projects, sites, contacts]) if (r.error) throw r.error;
    (projects.data || []).forEach((p) => {
      const f = facts[p.client_id];
      if (!f) return;
      if (p.job_number) f.jobs += 1; else f.quotes += 1;
      f.invoices += (p.invoices || []).length;
      if (!f.lastUsed || p.created_at > f.lastUsed) f.lastUsed = p.created_at;
    });
    (sites.data || []).forEach((s) => { if (facts[s.client_id]) facts[s.client_id].sites += 1; });
    (contacts.data || []).forEach((c) => { if (facts[c.client_id]) facts[c.client_id].contacts += 1; });
  }
  return facts;
}

// The rule's own pick of which record to keep: the one with the work on it, then the most recent,
// then the fuller record, then the older one.
function rulePick(pair, facts) {
  const score = (c) => {
    const f = facts[c.id] || {};
    return [(f.jobs || 0) + (f.invoices || 0), f.lastUsed || '', (f.quotes || 0) + (f.sites || 0) + (f.contacts || 0) + (c.abn ? 1 : 0) + (c.address ? 1 : 0), c.created_at ? -new Date(c.created_at).getTime() : 0];
  };
  const x = score(pair.a), y = score(pair.b);
  for (let i = 0; i < x.length; i++) { if (x[i] > y[i]) return pair.a.id; if (x[i] < y[i]) return pair.b.id; }
  return pair.a.id;
}

// Whatever the AI answered, only this leaves here: a verdict off the list is "unsure", "keep" is
// one of the two records (the rule's pick when the AI gave none), different ABNs are never "same".
function cleanVerdict(raw, pair, facts) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let verdict = ['same', 'apart', 'unsure'].includes(r.verdict) ? r.verdict : 'unsure';
  const abnA = digits(pair.a.abn), abnB = digits(pair.b.abn);
  if (verdict === 'same' && abnA.length === 11 && abnB.length === 11 && abnA !== abnB) verdict = 'apart';
  const keepId = r.keep === 'A' ? pair.a.id : r.keep === 'B' ? pair.b.id : rulePick(pair, facts);
  const confidence = Math.min(1, Math.max(0, Number(r.confidence) || 0));
  const reason = String(r.reason || '').replace(/\s+/g, ' ').replace(/—/g, ',').trim().slice(0, 300);
  return { verdict, keepId: verdict === 'apart' ? null : keepId, confidence: verdict === 'unsure' ? Math.min(confidence, 0.5) : confidence, reason };
}

const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
function describe(c, f) {
  return [
    `name "${short(c.name, 80)}"`, c.client_type, c.email ? `email ${short(c.email, 80)}` : 'no email', c.phone ? `phone ${short(c.phone, 30)}` : 'no phone',
    c.abn ? `ABN ${digits(c.abn)}` : 'no ABN', c.address ? `address ${short(c.address, 100)}` : 'no address',
    `${f.jobs} jobs, ${f.quotes} quotes, ${f.invoices} invoices, ${f.sites} sites, ${f.contacts} contacts`,
    f.lastUsed ? `last used ${String(f.lastUsed).slice(0, 10)}` : 'never used', c.created_at ? `added ${String(c.created_at).slice(0, 10)}` : '',
  ].filter(Boolean).join('; ');
}

async function askAi(pairs, facts) {
  const text = pairs.map((p, i) => `Pair ${i + 1} (paired because: ${p.why})\n  A: ${describe(p.a, facts[p.a.id])}\n  B: ${describe(p.b, facts[p.b.id])}`).join('\n\n');
  const r = await callClaude([{ type: 'text', text: CLIENT_DUPLICATES_PROMPT.replace('{{pairs}}', text) }], 6000);
  if (r.truncated) throw new Error('The AI answer came back cut off.');
  const list = JSON.parse(r.raw.slice(r.raw.indexOf('['), r.raw.lastIndexOf(']') + 1));
  if (!Array.isArray(list)) throw new Error('The AI answer was not a list.');
  return { answers: pairs.map((_, i) => list.find((x) => Number(x && x.pair) === i + 1) || null), usage: r.usage };
}

async function scanDuplicates(admin) {
  const [{ data: clients, error }, { data: old, error: oldErr }] = await Promise.all([
    admin.from('clients').select('id, name, email, phone, abn, address, client_type, created_at').limit(10000),
    admin.from('client_merge_suggestions').select('id, client_a, client_b, status'),
  ]);
  if (error) throw error;
  if (oldErr) throw oldErr;
  const dismissed = new Set((old || []).filter((s) => s.status === 'dismissed').map((s) => `${s.client_a}|${s.client_b}`));
  const pairs = candidatePairs(clients || []).filter((p) => !dismissed.has(`${p.a.id}|${p.b.id}`));
  const facts = await clientFacts(admin, [...new Set(pairs.flatMap((p) => [p.a.id, p.b.id]))]);

  const usage = { input_tokens: 0, output_tokens: 0 };
  let aiNote = null;
  const rows = [];
  for (let i = 0; i < pairs.length; i += PER_CALL) {
    const batch = pairs.slice(i, i + PER_CALL);
    let answers = batch.map(() => null);
    if (!aiNote) {
      try {
        const out = await askAi(batch, facts);
        answers = out.answers;
        usage.input_tokens += out.usage.input_tokens || 0;
        usage.output_tokens += out.usage.output_tokens || 0;
      } catch (err) {
        // the rest of the scan carries on by rule alone: a list to review beats no list
        aiNote = `The AI could not be asked (${String(err.message).slice(0, 120)}), so these are the rules' pairs only.`;
      }
    }
    batch.forEach((p, j) => {
      const v = cleanVerdict(answers[j], p, facts);
      rows.push({
        client_a: p.a.id, client_b: p.b.id, why_paired: p.why, verdict: v.verdict, keep_client_id: v.keepId, confidence: v.confidence,
        reason: v.reason || (answers[j] ? '' : 'Not read by the AI. Paired by rule; check before merging.'), status: 'open', scanned_at: new Date().toISOString(),
      });
    });
  }
  if (rows.length) {
    const { error: upErr } = await admin.from('client_merge_suggestions').upsert(rows, { onConflict: 'client_a,client_b' });
    if (upErr) throw upErr;
  }
  // an open suggestion the rules no longer make (a detail was fixed) is cleared
  const now = new Set(rows.map((r) => `${r.client_a}|${r.client_b}`));
  const stale = (old || []).filter((s) => s.status === 'open' && !now.has(`${s.client_a}|${s.client_b}`)).map((s) => s.id);
  if (stale.length) await admin.from('client_merge_suggestions').delete().in('id', stale);
  return { pairs: rows.length, same: rows.filter((r) => r.verdict === 'same').length, usage, aiNote };
}

async function listDuplicates(admin) {
  const { data: rows, error } = await admin.from('client_merge_suggestions').select('id, client_a, client_b, why_paired, verdict, keep_client_id, reason, confidence, scanned_at').eq('status', 'open');
  if (error) throw error;
  const ids = [...new Set((rows || []).flatMap((r) => [r.client_a, r.client_b]))];
  const { data: clients, error: cErr } = ids.length ? await admin.from('clients').select('id, name, email, phone, abn, address, client_type').in('id', ids) : { data: [] };
  if (cErr) throw cErr;
  const byId = Object.fromEntries((clients || []).map((c) => [c.id, c]));
  const facts = await clientFacts(admin, ids);
  const order = { same: 0, unsure: 1, apart: 2 };
  return (rows || []).filter((r) => byId[r.client_a] && byId[r.client_b])
    .sort((x, y) => order[x.verdict] - order[y.verdict] || y.confidence - x.confidence)
    .map((r) => ({
      id: r.id, why: r.why_paired, verdict: r.verdict, reason: r.reason, confidence: Number(r.confidence) || 0, keepId: r.keep_client_id, scannedAt: r.scanned_at,
      a: { ...byId[r.client_a], facts: facts[r.client_a] }, b: { ...byId[r.client_b], facts: facts[r.client_b] },
    }));
}

async function dismissDuplicate(admin, id, userId) {
  const { error } = await admin.from('client_merge_suggestions').update({ status: 'dismissed', dismissed_by: userId }).eq('id', id);
  if (error) throw error;
  return { ok: true };
}

module.exports = { candidatePairs, cleanVerdict, scanDuplicates, listDuplicates, dismissDuplicate };
