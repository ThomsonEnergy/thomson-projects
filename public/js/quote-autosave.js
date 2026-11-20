// The quote steps save themselves (backlog item 99, owner 18 and 20 Nov 2026). Every box on the
// Quote tab's steps (Quote and client, Pre-quote information, Site visit, Pricing with its stage
// table, Scope of works) saves about a second after typing stops and when the box is left. Each step
// says Saving, Saved with the time, or Not saved with Try again, and warns before the page is
// left with something not yet saved. Undo puts one step back to a save point: a snapshot of
// every step, made by itself when the quote is opened and then changed, just before the AI
// writes the scope or suggests prebuilds, and just before an Undo (so an Undo can be undone).
// The newest 10 per quote are kept in quote_save_points.
//
// Who calls it: project.html, which loads this file when a quote's steps are on screen.
// wireQuoteSteps() ends with mountQuoteAutosave({ project, page }), where page is the handful of
// things only the page knows (which client is linked, the answers, the milestone rows, the
// supporting documents, the stage table). loadProject() awaits quoteAutosaveFlush() so nothing
// typed is lost when the page redraws, and the AI buttons await quoteAutosaveSavePoint(reason)
// before they write.
//
// Writes: projects (each step's own columns), clients (a new client, that client's details while
// this page stays open, payment terms), client_sites (through resolveClientSite),
// payment_milestones, quote_save_points, activity_log (what changed on the stages, once things
// go quiet). The stage table (stage names, descriptions, line items, prices) is money, so it is
// not written piece by piece: every save sends all the stages to the database function
// save_quote_stages, which saves all of them or none.

const QUOTE_AUTOSAVE_TYPING_MS = 1000; // after the last keystroke
const QUOTE_AUTOSAVE_LEFT_MS = 150;    // after a box is left, or a tick or pick changes
const QUOTE_AUTOSAVE_POLL_MS = 2000;   // catches boxes filled by code (the AI scope, Pylon, a removed row)
const QUOTE_AUTOSAVE_SETTLE_MS = 8000; // quiet time before the PDF and the ready check are redone
const QUOTE_AUTOSAVE_OPENING_MS = 1500; // boxes the page is still filling in just after it opens are not changes
const QUOTE_AUTOSAVE_LOG_MS = 45000;   // quiet time before stage changes go in the activity log, as one lot
const QUOTE_SAVE_POINTS_KEPT = 10;
const QUOTE_SAVE_POINT_WHY = {
  opened: 'when the quote was opened',
  ai_scope: 'before the AI wrote the scope',
  ai_prebuilds: 'before the AI suggested prebuilds',
  undo: 'before an Undo',
};

let quoteAutosaveLive = null;      // the quote steps now on screen
let quoteTypedEarly = false;       // something was typed before the steps were ready: save it all once
const quoteClientsMadeHere = {};   // quote id -> the client this page made for it

// Saves everything typed and waits for it. The page calls this before it reloads the quote, so a
// save that would redraw the quote (a new proposal type) leaves the redraw to the caller.
async function quoteAutosaveFlush() {
  if (quoteAutosaveLive) await quoteAutosaveLive.flush({ callerReloads: true });
}

// An id for a stage made on the page. The page gives a new stage its id, so a save that is sent
// twice (a dropped reply, Try again) updates the stage instead of adding a second one.
function quoteNewId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Saves everything typed, then keeps a save point of the quote as it is now.
async function quoteAutosaveSavePoint(reason) {
  if (quoteAutosaveLive) await quoteAutosaveLive.savePoint(reason);
}

window.addEventListener('beforeunload', (e) => {
  if (quoteAutosaveLive && quoteAutosaveLive.unsaved()) { e.preventDefault(); e.returnValue = ''; }
});
// A phone that switches app may never come back to this tab: save now. A client name or site address
// still being typed waits all the same, so half a name never becomes a client or a site.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && quoteAutosaveLive) quoteAutosaveLive.flush();
});
window.addEventListener('pagehide', () => { if (quoteAutosaveLive) quoteAutosaveLive.settleNow(); });
window.addEventListener('online', () => { if (quoteAutosaveLive) quoteAutosaveLive.retry(); });
document.addEventListener('input', (e) => {
  const inQuote = e.target && e.target.closest && e.target.closest('#panel-quote');
  if (inQuote && !(quoteAutosaveLive && quoteAutosaveLive.attached())) quoteTypedEarly = true;
}, true);

// The same value always gives the same text, whatever order its keys are in (a snapshot read
// back from the database has its keys in the database's order).
function quoteCanon(v) {
  if (v === undefined || v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return `[${v.map(quoteCanon).join(',')}]`;
  return `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${quoteCanon(v[k])}`).join(',')}}`;
}

// The payment stages replaced: the new rows go in first, then every other row of the quote
// comes out, so a dropped connection leaves the old stages, never none.
async function replaceQuoteMilestones(projectId, rows) {
  let keep = [];
  if (rows.length) {
    const { data, error } = await supabaseClient.from('payment_milestones')
      .insert(rows.map((m, i) => ({ label: m.label, percent: m.percent, sort_order: i, project_id: projectId }))).select('id');
    if (error) throw error;
    keep = (data || []).map(r => r.id);
  }
  let del = supabaseClient.from('payment_milestones').delete().eq('project_id', projectId);
  if (keep.length) del = del.not('id', 'in', `(${keep.join(',')})`);
  const { error: delErr } = await del;
  if (delErr) throw delErr;
}

// The five steps: what each one reads off the page, when it has to wait, how it saves, and how
// Undo puts a saved copy back into its boxes.
function quoteStepDefs(project, page) {
  const el = (id) => document.getElementById(id);
  const val = (id) => (el(id) ? el(id).value : '');
  const set = (id, v) => { if (el(id)) el(id).value = v ?? ''; };
  const short = (text, n) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}...` : t; };
  const tick = (n, title) => {
    const h = el(`qstep-${n}-head`);
    if (h) h.innerHTML = `${page.ticks()[n] ? '<span style="color:var(--green);">&#10003;</span> ' : ''}${n}. ${title}`;
    page.refreshBar();
  };
  const saveProject = async (fields) => {
    const { error } = await supabaseClient.from('projects').update(fields).eq('id', project.id);
    if (error) throw error;
    Object.assign(project, fields);
  };

  // A quote with a client name and no client linked gets a client made from that name (as the old
  // Save did), but never from half a name, and not straight after Clear or an Undo back to no client.
  let clientNameTyped = false; // typed in the name box while no client is linked
  let clientCleared = false;   // Clear was pressed: wait for a pick or a new name
  let unlinkedByUndo = false;  // Undo went back to no client linked: saved as that until a name is typed
  if (el('p-client')) el('p-client').addEventListener('input', () => { if (!page.clientId()) { clientNameTyped = true; clientCleared = false; unlinkedByUndo = false; } });
  if (el('clear-client-btn')) el('clear-client-btn').addEventListener('click', () => { clientNameTyped = false; clientCleared = true; unlinkedByUndo = false; });

  return [
    {
      key: 'client', label: 'Quote and client', card: el('qstep-client'), head: el('qstep-client') && el('qstep-client').querySelector('h2'),
      read: () => ({
        name: val('p-name').trim(), client_id: page.clientId() || null, client_name: val('p-client').trim(),
        client_email: val('p-email').trim(), client_phone: val('p-phone').trim(), client_address: val('p-address').trim(),
        payment_terms: val('p-payment-terms'), notes: val('p-notes').trim(),
      }),
      // Undo leaves payment terms alone: they are the client's, and may have been changed since on the Clients page
      undoView: ({ payment_terms, ...rest }) => rest,
      hold: (p, saved) => {
        if (!p.name || !p.client_name) return 'Not saved yet: needs a quote name and a client name';
        const at = (document.activeElement || {}).id;
        if (!p.client_id) {
          // Clear was pressed: the quote keeps its client until another is picked or a new name is typed
          if (clientCleared && !clientNameTyped) return 'Not saved yet: search for a client, or type a new client name';
          if (!unlinkedByUndo && at === 'p-client') return 'A new client is made when you leave the client name box';
        }
        if (at === 'p-address' && p.client_address !== (saved.client_address ?? '')) return 'The address saves when you leave its box';
        return null;
      },
      save: async (p) => {
        const picker = page.sitePicker();
        let clientId = p.client_id;
        let client = picker ? picker.client() : null;
        const details = { name: p.client_name, email: p.client_email || null, phone: p.client_phone || null, payment_terms: p.payment_terms, address: p.client_address || null };
        if (clientId && quoteClientsMadeHere[project.id] === clientId) {
          // The client this page made keeps taking what is typed here, the same as if it had all
          // been typed before one Save. Its office address follows the site until the page is left.
          const { data, error } = await supabaseClient.from('clients').update(details).eq('id', clientId).select().single();
          if (error) throw error;
          client = data;
          if (picker) await picker.setClient(client);
        } else if (clientId) {
          // an existing client: the name, email and phone typed here are this quote's only; payment terms are the client's
          if (p.payment_terms && p.payment_terms !== ((client || {}).payment_terms || 'cod')) {
            const { error } = await supabaseClient.from('clients').update({ payment_terms: p.payment_terms }).eq('id', clientId);
            if (error) throw error;
            if (client) client.payment_terms = p.payment_terms;
          }
        } else if (!unlinkedByUndo) {
          const { data, error } = await supabaseClient.from('clients').insert(details).select().single();
          if (error) throw error;
          client = data;
          clientId = data.id;
          quoteClientsMadeHere[project.id] = clientId;
          page.clientMade(client);
          if (picker) await picker.setClient(client);
        }
        const client_site_id = clientId ? await resolveClientSite(clientId, p.client_address, (client || {}).address || p.client_address) : null;
        await saveProject({
          name: p.name, client_id: clientId, client_name: p.client_name, client_email: p.client_email || null,
          client_phone: p.client_phone || null, client_address: p.client_address, client_site_id, notes: p.notes || null,
        });
        if (clientId) { clientNameTyped = false; clientCleared = false; }
        return { payload: { ...p, client_id: clientId } };
      },
      after: (p, before) => page.clientSaved(p.client_address !== before.client_address),
      apply: async (p) => {
        // back to before a client was linked: a client this page made for the quote stays with it, so no second one is made
        const wantId = p.client_id || quoteClientsMadeHere[project.id] || null;
        if (wantId !== (page.clientId() || null)) {
          let client = null;
          if (wantId) client = (await supabaseClient.from('clients').select('*').eq('id', wantId).maybeSingle()).data;
          const terms = val('p-payment-terms');
          page.linkClient(client); // fills the boxes from the client; the saved copy then goes over the top
          set('client-search-input', client ? client.name : '');
          if (!client) set('p-payment-terms', terms);
        }
        clientNameTyped = false;
        clientCleared = false;
        unlinkedByUndo = !page.clientId();
        set('p-name', p.name); set('p-client', p.client_name); set('p-email', p.client_email); set('p-phone', p.client_phone);
        set('p-address', p.client_address); set('p-notes', p.notes);
        if (page.sitePicker()) page.sitePicker().refresh();
      },
      preview: (p) => [p.name, p.client_name, short(p.client_address, 40), p.notes ? `notes: ${short(p.notes, 50)}` : ''].filter(Boolean).join(' / '),
    },
    {
      key: 'answers', label: 'Pre-quote information', card: el('qstep-1'), head: el('qstep-1-head'),
      read: () => ({ proposal_template: page.template(), template_answers: page.answers() }),
      // Undo puts the answers back, never the proposal type (a type change also swaps the photos, deposit and payment stages)
      undoView: (p) => p.template_answers || {},
      redraws: (p, saved) => p.proposal_template !== saved.proposal_template,
      save: async (p) => {
        const prevTemplate = project.proposal_template || 'new_build';
        const changedTemplate = p.proposal_template !== prevTemplate;
        const fields = { template_answers: p.template_answers, proposal_template: p.proposal_template };
        let newMilestones = null;
        if (changedTemplate) {
          // A new proposal type gets that type's photos (Settings > portfolio photos), its deposit and
          // payment stages where the quote still has the old type's defaults, and the estimate wording.
          const [{ data: settings }, { data: milestones, error: msReadErr }] = await Promise.all([
            supabaseClient.from('company_settings').select('portfolio_photos').eq('id', 1).single(),
            supabaseClient.from('payment_milestones').select('label, percent').eq('project_id', project.id).order('sort_order'),
          ]);
          if (msReadErr) throw msReadErr;
          const wantCategory = TEMPLATE_INFO[p.proposal_template].photoCategory;
          fields.cover_photos = ((settings && settings.portfolio_photos) || []).filter(ph => (ph.category || 'general') === wantCategory);
          const pay = paymentDefaultsOnTypeChange(prevTemplate, p.proposal_template, { deposit_percent: project.deposit_percent, milestones: milestones || [] });
          if ('deposit_percent' in pay) fields.deposit_percent = pay.deposit_percent;
          if (pay.milestones) newMilestones = pay.milestones;
          if (p.proposal_template === 'quick_estimate' && !(project.estimate_disclaimer_text || '').trim()) fields.estimate_disclaimer_text = page.defaultDisclaimer();
        }
        // the quote in memory only takes the new type once its payment stages are in too, so Try again redoes all of it
        const { error } = await supabaseClient.from('projects').update(fields).eq('id', project.id);
        if (error) throw error;
        if (newMilestones) await replaceQuoteMilestones(project.id, newMilestones);
        Object.assign(project, fields);
        page.answersSaved(p.template_answers);
        // a new type redraws the whole quote: its questions, deposit, payment stages and cards
        return changedTemplate ? { reload: true } : null;
      },
      after: () => tick(1, 'Pre-quote information'),
      apply: (p) => page.setAnswers(p.template_answers || {}),
      preview: (p) => { const n = Object.keys(p.template_answers || {}).length; return `${n} answer${n === 1 ? '' : 's'}`; },
    },
    {
      key: 'visit', label: 'Site visit', card: el('qstep-2'), head: el('qstep-2-head'),
      read: () => {
        const decision = (document.querySelector('input[name="qs2-decision"]:checked') || {}).value || null;
        return { site_visit_decision: decision, site_visit_reason: decision === 'not_needed' ? (val('qs2-reason').trim() || null) : null };
      },
      save: (p) => saveProject({ site_visit_decision: p.site_visit_decision, site_visit_reason: p.site_visit_reason, needs_site_visit: p.site_visit_decision === 'needed' }),
      after: () => { tick(2, 'Site visit'); page.visitSaved(); },
      apply: (p) => {
        document.querySelectorAll('input[name="qs2-decision"]').forEach(r => { r.checked = r.value === p.site_visit_decision; });
        set('qs2-reason', p.site_visit_reason);
        if (el('qs2-reason-wrap')) el('qs2-reason-wrap').style.display = p.site_visit_decision === 'not_needed' ? '' : 'none';
      },
      preview: (p) => (p.site_visit_decision === 'needed' ? 'Needs a site visit'
        : p.site_visit_decision === 'not_needed' ? `No site visit needed${p.site_visit_reason ? `: ${short(p.site_visit_reason, 60)}` : ''}` : 'Not decided'),
    },
    {
      // The Pricing card's own boxes: deposit, credits, Pylon, payment stages.
      key: 'pricing', label: 'Pricing boxes', card: el('qstep-3'), head: el('qstep-3-head'), foot: false,
      read: () => {
        const num = (id) => { const v = parseFloat(val(id)); return Number.isFinite(v) ? v : null; };
        return {
          deposit_percent: parseFloat(val('p-deposit')) || 0,
          show_investment_breakdown: !!(el('p-breakdown') && el('p-breakdown').checked),
          pylon_link: val('p-pylon-link').trim(), pylon_project_id: val('p-pylon-id').trim(),
          stc_quantity: num('q-stc-qty'), stc_system_kw: num('q-stc-kw'), stc_zone_rating: num('q-stc-zone') || 1.382,
          stc_install_year: parseInt(val('q-stc-year'), 10) || null,
          stc_price_per_certificate: num('q-stc-price'), stc_total: num('q-stc-total') || 0,
          stc_cost_centre_id: val('q-stc-stage') || null,
          bstc_quantity: num('q-bstc-qty'), bstc_price_per_certificate: num('q-bstc-price'), bstc_total: num('q-bstc-total') || 0,
          bstc_cost_centre_id: val('q-bstc-stage') || null,
          bstc_not_claimed: !!(el('q-bstc-none') && el('q-bstc-none').checked),
          milestones: page.milestones(),
        };
      },
      hold: (p) => (p.pylon_link && !page.pylonLinkOk(p.pylon_link) ? 'Not saved yet: the Pylon link must start with https://' : null),
      save: async (p, saved) => {
        const { milestones, ...fields } = p;
        await saveProject(fields);
        if (quoteCanon(milestones) !== quoteCanon(saved.milestones)) {
          await replaceQuoteMilestones(project.id, milestones);
          project.payment_milestones = milestones.map(m => ({ ...m }));
        }
      },
      apply: (p) => {
        set('p-deposit', p.deposit_percent);
        if (el('p-breakdown')) el('p-breakdown').checked = !!p.show_investment_breakdown;
        set('p-pylon-link', p.pylon_link); set('p-pylon-id', p.pylon_project_id);
        set('q-stc-qty', p.stc_quantity); set('q-stc-kw', p.stc_system_kw); set('q-stc-zone', p.stc_zone_rating);
        set('q-stc-year', p.stc_install_year); set('q-stc-price', p.stc_price_per_certificate); set('q-stc-total', p.stc_total || '');
        set('q-stc-stage', p.stc_cost_centre_id);
        set('q-bstc-qty', p.bstc_quantity); set('q-bstc-price', p.bstc_price_per_certificate); set('q-bstc-total', p.bstc_total || '');
        set('q-bstc-stage', p.bstc_cost_centre_id);
        if (el('q-bstc-none')) el('q-bstc-none').checked = !!p.bstc_not_claimed;
        page.setMilestones((p.milestones || []).map(m => ({ label: String(m.label || ''), percent: Number(m.percent) || 0 })));
      },
      preview: (p) => {
        const n = (p.milestones || []).length;
        return [`Deposit ${p.deposit_percent}%`, `${n} payment stage${n === 1 ? '' : 's'}`,
          p.stc_quantity ? `${p.stc_quantity} STCs` : '', p.bstc_quantity ? `${p.bstc_quantity} BSTCs` : ''].filter(Boolean).join(', ');
      },
    },
    {
      // The stage table: stage names, descriptions, line items, markup and prices. Money, so one
      // database function saves all the stages or none. A longer pause than text, so half a
      // typed price is saved less often.
      key: 'stages', label: 'Stages and prices', card: el('qstep-3'), head: el('qstage-head'), foot: 'Stages and prices', typingMs: 1500,
      read: () => page.stages(),
      hold: () => page.stagesProblem(),
      save: async (p) => {
        const { error } = await supabaseClient.rpc('save_quote_stages', { p_project_id: project.id, p_stages: p });
        if (error) throw error;
      },
      after: (saved) => {
        // the quote in memory follows what was saved, so the header totals, the step tick and the PDF check are right without a reload
        const was = Object.fromEntries((project.cost_centres || []).map(c => [c.id, c]));
        project.cost_centres = saved.map(({ lineItems, photoGroups, ...stage }) => ({
          ...(was[stage.id] || {}), ...stage, project_id: project.id,
          cost_centre_line_items: lineItems, cost_centre_photo_groups: photoGroups,
        }));
        page.stagesSaved();
        tick(3, 'Pricing');
      },
      apply: (p) => page.setStages(p),
      preview: (p) => {
        const total = p.reduce((sum, st) => sum + (Number(st.quoted_amount) || 0), 0);
        return `${p.length} stage${p.length === 1 ? '' : 's'}, ${money(total)} ex GST: ${short(p.map(st => st.name).join(', '), 70)}`;
      },
    },
    {
      key: 'scope', label: 'Scope of works', card: el('qstep-4'), head: el('qstep-4-head'),
      read: () => ({ sow_brief: val('p-brief').trim(), sow_text: val('p-sow'), terms_text: val('p-terms'), sow_documents: page.sowDocs().map(d => ({ ...d })) }),
      save: (p) => saveProject(p),
      after: (p) => {
        tick(4, 'Scope of works');
        const btn = el('generate-scope-btn');
        if (btn && !btn.disabled) btn.textContent = page.scopeButtonLabel(p.sow_text);
      },
      apply: (p) => {
        set('p-brief', p.sow_brief); set('p-sow', p.sow_text); set('p-terms', p.terms_text);
        page.setSowDocs(p.sow_documents || []);
      },
      preview: (p) => [short(p.sow_text, 90) || 'No scope written', p.sow_brief ? `AI notes: ${short(p.sow_brief, 50)}` : ''].filter(Boolean).join(' / '),
    },
  ];
}

function mountQuoteAutosave({ project, page }) {
  if (quoteAutosaveLive) quoteAutosaveLive.destroy();
  const steps = quoteStepDefs(project, page).filter(s => s.card);
  if (!steps.length) return null;
  const typedEarly = quoteTypedEarly;
  quoteTypedEarly = false;
  let dead = false;
  let settleTimer = null;
  let summaryDue = false;      // the scope changed: the installer summary is rewritten once the scope box is left
  const changed = new Set();   // steps saved since the PDF and ready check were last redone
  const read = (s) => { try { return s.read(); } catch (e) { console.error(`Quote autosave: could not read ${s.key}`, e); return s.saved; } };
  const dirty = (s) => quoteCanon(read(s)) !== s.savedJson;
  // The page was redrawn: these steps are off the page, and the boxes with their ids now belong to
  // the new steps (which may still be filling in). Nothing here reads or saves from then on.
  const gone = () => { if (!dead && !document.body.contains(steps[0].card)) api.destroy(); return dead; };

  // ----- save points -----
  let points = [];       // newest first: { id, taken_at, reason, snapshot }
  let pointsOk = true;   // false when the table cannot be read (the page is out before its migration): no Undo, saving still works
  const snapshotNow = () => JSON.parse(JSON.stringify(Object.fromEntries(steps.map(s => [s.key, s.saved]))));
  let pointQueue = supabaseClient.from('quote_save_points').select('id, taken_at, reason, snapshot')
    .eq('project_id', project.id).order('taken_at', { ascending: false }).limit(QUOTE_SAVE_POINTS_KEPT)
    .then(({ data, error }) => {
      if (error) { pointsOk = false; console.error('Quote save points could not be read:', error.message); }
      points = data || [];
      if (!dead) steps.forEach(paint);
    });
  // Gives back true when the point is kept (or there is nothing to keep), false when it should be tried again.
  function storePoint(pt) {
    pointQueue = pointQueue.then(async () => {
      if (!pointsOk || (points[0] && quoteCanon(points[0].snapshot) === quoteCanon(pt.snapshot))) return true;
      const { data, error } = await supabaseClient.from('quote_save_points')
        .insert({ project_id: project.id, taken_at: pt.taken_at, reason: pt.reason, snapshot: pt.snapshot })
        .select('id, taken_at, reason, snapshot').single();
      if (error) { console.error('Quote save point not kept:', error.message); return false; }
      points = [data, ...points].sort((a, b) => new Date(b.taken_at) - new Date(a.taken_at));
      const old = points.splice(QUOTE_SAVE_POINTS_KEPT);
      if (old.length) await supabaseClient.from('quote_save_points').delete().in('id', old.map(p => p.id));
      return true;
    }).catch(err => { console.error('Quote save point not kept:', err); return false; });
    return pointQueue;
  }
  // The quote as it was opened goes in the first time something saves. A failed try (no connection)
  // is made again at the next save; until it is in, Undo still has it from memory.
  async function keepOpened() {
    if (opened.stored || opened.storing) return;
    opened.storing = true;
    const kept = await storePoint(opened);
    opened.storing = false;
    if (kept) opened.stored = true;
  }

  // ----- each step's Saving / Saved line and Undo -----
  const timeOf = (d) => new Date(d).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  const whenOf = (iso) => {
    const d = new Date(iso);
    return d.toDateString() === new Date().toDateString() ? timeOf(d)
      : `${d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })}, ${timeOf(d)}`;
  };
  function stateHtml(s) {
    if (s.failed) return `<span style="color:var(--red);">Not saved: ${escapeHtml(s.failed.message)}</span> <button type="button" class="secondary qas-retry" style="font-size:12px; padding:6px 10px;">Try again</button>`;
    if (s.inFlight || (s.timer && s.typing && dirty(s))) return 'Saving...';
    if (s.held) return escapeHtml(s.held);
    if (s.savedAt) return `<span style="color:var(--green);">&#10003; Saved ${timeOf(s.savedAt)}</span>`;
    return '';
  }
  function paint(s) {
    if (dead || !s.states) return;
    const html = stateHtml(s);
    s.states.forEach(st => {
      const text = st === s.footEl && typeof s.foot === 'string' && html ? `${escapeHtml(s.foot)}: ${html}` : html;
      if (st.html !== text) { st.html = text; st.innerHTML = text; }
    });
    s.undoBtn.style.display = pointsOk ? '' : 'none';
    s.undoBtn.disabled = !undoChoices(s).length;
    s.undoBtn.title = s.undoBtn.disabled ? 'Nothing to go back to yet. A save point is made when the quote is opened and before the AI writes.' : `Put ${s.label} back to a save point`;
  }
  // The save points this step can go back to: newest first, only ones that differ from what is on screen.
  function undoChoices(s) {
    const view = s.undoView || ((p) => p);
    const seen = new Set([quoteCanon(view(read(s)))]);
    return (opened.stored ? points : [opened, ...points]).filter(pt => {
      const part = pt.snapshot && pt.snapshot[s.key];
      if (!part) return false;
      if (!pt.text) pt.text = {}; // worked out once per save point, this runs on every keystroke
      if (pt.text[s.key] === undefined) pt.text[s.key] = quoteCanon(view(part));
      const text = pt.text[s.key];
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } };
  const onDocClick = (e) => { if (menu && !menu.contains(e.target) && !e.target.closest('.qas-undo')) closeMenu(); };
  const onDocKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  function openMenu(s) {
    const wasOpenFor = menu && menu.dataset.step;
    closeMenu();
    if (wasOpenFor === s.key) return;
    const choices = undoChoices(s);
    if (!choices.length) return;
    menu = document.createElement('div');
    menu.dataset.step = s.key;
    menu.style.cssText = 'position:absolute; right:0; top:100%; z-index:20; margin-top:4px; width:min(380px, 86vw); max-height:320px; overflow-y:auto; background:var(--surface); border:1px solid var(--border); border-radius:8px; box-shadow:0 6px 20px rgba(0,0,0,0.3); padding:8px; text-align:left;';
    menu.innerHTML = `<p class="subtitle" style="margin:2px 4px 8px; font-size:12px;">Put ${escapeHtml(s.label)} back to how it was:</p>${choices.map((pt, i) => `
      <button type="button" class="secondary qas-point" data-i="${i}" style="display:block; width:100%; text-align:left; margin:0 0 6px; padding:8px 10px; font-size:12px; white-space:normal;">
        <strong>${escapeHtml(whenOf(pt.taken_at))}</strong>, ${escapeHtml(QUOTE_SAVE_POINT_WHY[pt.reason] || 'saved')}<br>
        <span style="color:var(--muted);">${escapeHtml(s.preview(pt.snapshot[s.key]))}</span>
      </button>`).join('')}`;
    s.bar.appendChild(menu);
    if (menu.getBoundingClientRect().left < 8) { menu.style.right = 'auto'; menu.style.left = '0'; }
    menu.querySelectorAll('.qas-point').forEach(btn => btn.addEventListener('click', () => undoTo(s, choices[Number(btn.dataset.i)])));
  }
  async function undoTo(s, pt) {
    closeMenu();
    s.undoBtn.disabled = true;
    try {
      await flush();
      await savePoint('undo'); // what is there now is kept, so this Undo can be undone
      await s.apply(JSON.parse(JSON.stringify(pt.snapshot[s.key])));
      await run(s, { force: true });
      if (!s.failed && !s.held) showToast(`${s.label} put back to ${whenOf(pt.taken_at)}.`);
    } catch (err) {
      showToast(`Could not undo: ${friendlyError(err)}`, { error: true });
    }
    paint(s);
  }

  // ----- saving -----
  function schedule(s, ms, typing) {
    if (dead) return;
    clearTimeout(s.timer);
    s.typing = !!typing;
    s.timer = setTimeout(() => { s.timer = null; s.typing = false; run(s); }, ms);
    paint(s);
  }
  function run(s, opts = {}) {
    if (gone()) return Promise.resolve();
    if (s.inFlight) { s.again = true; return s.promise; }
    const p = read(s);
    const json = quoteCanon(p);
    if (json === s.savedJson) { s.held = null; s.failed = null; paint(s); return Promise.resolve(); }
    if (s.failed && s.failed.json === json && !opts.force) return Promise.resolve(); // the same thing that just failed: wait for Try again or the connection
    let why = s.hold ? s.hold(p, s.saved) : null;
    // A save that redraws the whole quote (a new proposal type) would drop what another step has
    // typed and cannot save yet. What can save does so first: the redraw waits for it.
    if (typeof why !== 'string' && s.redraws && s.redraws(p, s.saved)) {
      const stuck = steps.find(o => o !== s && dirty(o) && (o.failed || (o.hold && typeof o.hold(read(o), o.saved) === 'string')));
      if (stuck) why = `Not saved yet: ${stuck.label} has to save first, a new proposal type redraws the quote`;
    }
    if (typeof why === 'string') { s.held = why; paint(s); return Promise.resolve(); }
    s.held = null;
    s.inFlight = true;
    paint(s);
    keepOpened(); // kept alongside, never holds the save up
    s.promise = (async () => {
      let reload = false;
      try {
        const before = s.saved;
        if (s === stagesStep && !loggedStages) loggedStages = Array.isArray(before) ? before : [];
        const result = (await s.save(p, before)) || {};
        s.saved = result.payload || p;
        s.savedJson = quoteCanon(s.saved);
        s.savedAt = new Date();
        s.failed = null;
        changed.add(s.key);
        if (s.key === 'scope') summaryDue = true;
        if (s === stagesStep) logSoon();
        if (s.after) s.after(s.saved, before);
        reload = !!result.reload;
        settleSoon();
      } catch (err) {
        const message = friendlyError(err);
        if (!s.failed) showToast(`${s.label} not saved: ${message}`, { error: true });
        s.failed = { message, json };
      } finally {
        s.inFlight = false;
        paint(s);
      }
      // Not awaited: the reload itself waits for every step to finish saving, this one included.
      // A caller that is about to reload the quote anyway does it once, itself.
      if (reload) { if (!opts.callerReloads) setTimeout(() => { if (!dead) page.reload(); }, 0); return; }
      if (s.again && !dead) { s.again = false; await run(s); }
    })();
    return s.promise;
  }
  // Saves what can be saved, and waits for it.
  async function flush(opts = {}) {
    if (gone()) return;
    steps.forEach(s => { clearTimeout(s.timer); s.timer = null; s.typing = false; });
    await Promise.all(steps.map(s => s.promise));
    await Promise.all(steps.map(s => run(s, { force: true, callerReloads: !!opts.callerReloads })));
    await Promise.all(steps.map(s => s.promise));
  }
  async function savePoint(reason) {
    if (gone()) return;
    await flush();
    const now = snapshotNow();
    // nothing has changed since the quote was opened: this point says it all, with a better reason
    if (!opened.stored && opened.snapshot && quoteCanon(opened.snapshot) === quoteCanon(now)) opened.stored = true;
    else await keepOpened();
    await storePoint({ taken_at: new Date().toISOString(), reason, snapshot: now });
    if (!dead) steps.forEach(paint);
  }

  // ----- after things go quiet: the installer summary, the PDF, the ready check -----
  const inScopeBox = () => (document.activeElement || {}).id === 'p-sow';
  function settleSoon() { clearTimeout(settleTimer); settleTimer = setTimeout(settle, QUOTE_AUTOSAVE_SETTLE_MS); }
  async function settle() {
    clearTimeout(settleTimer);
    settleTimer = null;
    // The installer summary is an AI rewrite: once, when the scope box has been left, not on every pause in it.
    if (summaryDue && !inScopeBox()) {
      summaryDue = false;
      if ((project.sow_text || '').trim()) {
        try { await requestInstallerSummary(project.id, { onlyIfStale: true }); } catch (e) { console.error('Installer summary refresh failed:', e); }
      }
    }
    if (!changed.size) return;
    const did = new Set(changed);
    changed.clear();
    if (['client', 'answers', 'pricing', 'stages', 'scope'].some(k => did.has(k)) && (project.cost_centres || []).some(c => Number(c.quoted_amount) > 0)) autoGenerateQuotePdf(project);
    if (dead) return;
    if (did.has('stages')) page.stagesSettled();
    page.readyCheck();
  }

  // ----- the activity log hears about stage changes as one lot, once they have been quiet a while -----
  const stagesStep = steps.find(s => s.key === 'stages');
  let loggedStages = null; // the stages as the log last heard them (set at the first stage save)
  let logTimer = null;
  function logSoon() { clearTimeout(logTimer); logTimer = setTimeout(logStages, QUOTE_AUTOSAVE_LOG_MS); }
  async function logStages() {
    clearTimeout(logTimer);
    logTimer = null;
    const now = stagesStep && stagesStep.saved;
    if (!Array.isArray(now) || !loggedStages || quoteCanon(now) === quoteCanon(loggedStages)) return;
    const before = loggedStages;
    loggedStages = now;
    const known = new Set(before.map(st => st.id));
    try {
      // logStageChanges reads a stage with no id as added
      await logStageChanges(project.id, before, now.map(st => (known.has(st.id) ? st : { ...st, id: null })));
      await logActivity('project', project.id, 'stage_updated', 'Quote pricing updated');
    } catch (e) { console.error('Stage changes not logged:', e); }
  }

  // ----- wire each step -----
  steps.forEach(s => {
    s.saved = typedEarly ? {} : read(s);
    s.savedJson = typedEarly ? '' : quoteCanon(s.saved);
    let head = s.head && s.head.parentElement;
    if (s.head && head === s.card) { // a heading that sits straight in its card gets a row of its own
      head = document.createElement('div');
      head.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;';
      s.head.insertAdjacentElement('beforebegin', head);
      head.appendChild(s.head);
    }
    s.bar = document.createElement('span');
    s.bar.style.cssText = 'position:relative; display:inline-flex; align-items:center; gap:8px; font-size:12px; color:var(--muted);';
    s.bar.innerHTML = '<span class="qas-state" role="status" aria-live="polite"></span><button type="button" class="secondary qas-undo" style="font-size:12px; padding:6px 10px;" disabled>Undo</button>';
    (head || s.card).appendChild(s.bar);
    s.states = [s.bar.querySelector('.qas-state')];
    if (s.foot !== false) {
      // the same line again where the Save button used to be, in reach of the boxes at the bottom of a long
      // card (named when two steps share the card)
      s.footEl = document.createElement('div');
      s.footEl.className = 'qas-state';
      s.footEl.style.cssText = 'margin-top:10px; font-size:12px; color:var(--muted); min-height:18px;';
      s.card.appendChild(s.footEl);
      s.states.push(s.footEl);
    }
    s.undoBtn = s.bar.querySelector('.qas-undo');
    s.undoBtn.addEventListener('click', () => openMenu(s));
    s.states.forEach(st => st.addEventListener('click', (e) => { if (e.target.closest('.qas-retry')) run(s, { force: true }); }));
    s.card.addEventListener('input', () => { s.touched = true; schedule(s, s.typingMs || QUOTE_AUTOSAVE_TYPING_MS, true); });
    ['change', 'focusout', 'click'].forEach(ev => s.card.addEventListener(ev, (e) => {
      if (e.target.closest('.qas-undo, .qas-point, .qas-retry')) return;
      s.touched = true;
      schedule(s, QUOTE_AUTOSAVE_LEFT_MS, s.typing);
      if (s.key === 'scope' && ev === 'focusout' && summaryDue) settleSoon();
    }));
  });
  // the quote as it was opened: kept as a save point the first time something saves
  const opened = typedEarly ? { stored: true } : { taken_at: new Date().toISOString(), reason: 'opened', snapshot: snapshotNow(), stored: false };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);

  // Boxes the page is still filling in just after it opens (stage rows that finish drawing, a tick
  // the page sets itself) are part of the quote as opened, not a change to save.
  const openingTimer = setTimeout(() => {
    if (gone() || typedEarly) return;
    steps.forEach(s => { if (!s.touched && !s.inFlight && !s.timer) { s.saved = read(s); s.savedJson = quoteCanon(s.saved); } });
    if (!opened.stored && !opened.storing) opened.snapshot = snapshotNow();
    steps.forEach(paint);
  }, QUOTE_AUTOSAVE_OPENING_MS);

  const poll = setInterval(() => {
    if (gone()) return;
    steps.forEach(s => { if (!s.timer && !s.inFlight) run(s); });
  }, QUOTE_AUTOSAVE_POLL_MS);

  const api = {
    flush,
    savePoint,
    attached: () => !dead && document.body.contains(steps[0].card),
    unsaved: () => !gone() && steps.some(s => s.inFlight || dirty(s)),
    retry: () => steps.forEach(s => { if (s.failed) run(s, { force: true }); }),
    settleNow: () => { if (settleTimer) settle(); if (logTimer) logStages(); },
    destroy() {
      if (dead) return;
      if (settleTimer) settle(); // the PDF still follows what was saved
      if (logTimer) logStages();
      dead = true;
      steps.forEach(s => clearTimeout(s.timer));
      clearTimeout(openingTimer);
      clearInterval(poll);
      closeMenu();
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      if (quoteAutosaveLive === api) quoteAutosaveLive = null;
    },
  };
  quoteAutosaveLive = api;
  steps.forEach(paint);
  return api;
}
