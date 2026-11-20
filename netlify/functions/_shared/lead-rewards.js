// Lead rewards as Xero credit notes (backlog item 74b, step 3b part 2; credits only, owner 20 Nov 2026).
// One place for how a reward reaches Xero and an invoice. The database owns the money rules
// (lead_reward_apply, lead_reward_release, lead_reward_settle: all or nothing, limits checked there);
// this file talks to Xero and keeps the two matching.
//
// A reward that is owed (the referred job's deposit is paid) becomes one AUTHORISED sales credit note on
// the referrer, to the account on the Settings > Xero Mapping row "Lead rewards" (nothing happens until
// that row has an account). It is then taken off one invoice billed to the referrer and allocated to it
// in Xero. No invoice total and no job stage changes.
//
//   runLeadRewards(admin, { limit, force })  the worker's pass (lead-rewards-background.js, and Retry on
//       the Clients page): undo allocations of rewards that stepped off, raise notes, put waiting credits
//       on the oldest unpaid invoice they fit, allocate, tell the referrer once. Never throws for one
//       reward: its error is kept on the row (xero_error) and tried again later.
//   creditNewInvoice(admin, invoiceId)       a new invoice: the waiting credits of the client it is billed to
//       come off it (each note read from Xero first)
//   allocateForInvoice(admin, invoiceId)     after Push to Xero: the rewards on that invoice are allocated
//   stepOff(admin, invoiceId, why, { less }) a credit note, a new bill-to or an edit: the rewards on the
//       invoice go back to owed and their Xero allocation is removed. With less (a credit about to be
//       raised) only when the invoice could no longer carry them. Returns how many stepped off.
//   cancelReward(admin, { rewardId, reason, actorId })  Cancel on the Clients page: voids the note in
//       Xero, then closes the reward. Throws with the reason when it cannot.
// Reads lead_rewards, invoices, clients, xero_account_mapping. Writes lead_rewards (the xero_* columns
// and told_at), clients.xero_contact_id, invoice_events; everything else through the database functions.

const { xeroRequest } = require('./xero-client');
const { getOrCreateContact } = require('./build-xero-invoice-payload');
const { logInvoiceEvent, moneyText } = require('./invoice-events');
const { regenerateInvoicePdf } = require('./regenerate-invoice-pdf');
const { sendRewardEarned } = require('./portal-mail');

const FIELDS = 'id, referrer_client_id, project_id, amount, status, settled_how, due_at, applied_invoice_id, xero_credit_note_id, xero_credit_note_number, xero_allocated_invoice_id, xero_error, xero_tried_at, xero_checked_at, told_at, projects(job_number), leads(name)';
const RETRY_AFTER_MS = 60 * 60 * 1000; // a reward Xero refused is tried again after an hour, or at once from Retry
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000; // a waiting note is read once a day, in case it was used by hand in Xero
const TELL_WITHIN_MS = 14 * 24 * 60 * 60 * 1000;
const CLAIM_MS = 2 * 60 * 1000; // two passes at once (the worker and Try Xero again): the second leaves a reward the first is on
const GONE = ['VOIDED', 'DELETED'];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
const jobOf = (reward) => (reward.projects && reward.projects.job_number ? `J${reward.projects.job_number}` : 'a job');
const noteName = (reward) => reward.xero_credit_note_number || 'the credit note';
// Xero's dates arrive as "/Date(1763596800000+0000)/"
const xeroDay = (d) => { const m = /\/Date\((\d+)/.exec(String(d || '')); return m ? new Date(Number(m[1])).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Sydney' }) : ''; };

// The account and tax type the notes post to, or null while the owner has not picked an account.
async function rewardAccount(admin) {
  const { data } = await admin.from('xero_account_mapping').select('xero_account_code, xero_tax_type').eq('category', 'lead_reward').maybeSingle();
  const code = String((data && data.xero_account_code) || '').trim();
  return code ? { AccountCode: code, TaxType: data.xero_tax_type || 'EXEMPTEXPENSES' } : null;
}

async function readNote(reward) {
  const res = await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(reward.xero_credit_note_id)}`);
  return (res && res.CreditNotes && res.CreditNotes[0]) || null;
}

const save = (admin, id, change) => admin.from('lead_rewards').update(change).eq('id', id);

// Take a reward for this pass. One conditional update, so of two passes running at once only one gets
// it: no second credit note, no second allocation. The stamp is also when it was last looked at.
async function claim(admin, reward) {
  const { data, error } = await admin.from('lead_rewards').update({ xero_tried_at: new Date().toISOString() }).eq('id', reward.id)
    .or(`xero_tried_at.is.null,xero_tried_at.lt.${new Date(Date.now() - CLAIM_MS).toISOString()}`).select('id');
  if (error) throw error;
  return !!(data && data.length);
}

// One AUTHORISED credit note for the reward. An earlier try that made it and died before saving its id is
// found by its reference (one reward per job, so "Lead reward J7020" is one note), never made twice.
async function raiseNote(admin, reward, account, { onContactId = null } = {}) {
  let contactId = onContactId; // given when the note must sit on the contact an invoice is on
  if (!contactId) {
    const { data: client } = await admin.from('clients').select('id, name, email, xero_contact_id').eq('id', reward.referrer_client_id).maybeSingle();
    if (!client) throw new Error('The referrer was not found.');
    contactId = await getOrCreateContact({ name: client.name, email: client.email }, client);
    if (!client.xero_contact_id) await admin.from('clients').update({ xero_contact_id: contactId }).eq('id', client.id);
  }
  const reference = `Lead reward ${reward.projects && reward.projects.job_number ? `J${reward.projects.job_number}` : reward.id.slice(0, 8)}`;
  const where = `Type=="ACCRECCREDIT" AND Contact.ContactID==Guid("${contactId}") AND Status=="AUTHORISED"`;
  const open = await xeroRequest('accounting', `CreditNotes?where=${encodeURIComponent(where)}`);
  let note = ((open && open.CreditNotes) || []).find((n) => n.Reference === reference);
  if (!note) {
    const person = reward.leads && reward.leads.name ? ` (referred ${String(reward.leads.name).slice(0, 80)})` : '';
    const made = await xeroRequest('accounting', 'CreditNotes', {
      method: 'POST',
      body: { CreditNotes: [{
        Type: 'ACCRECCREDIT', Contact: { ContactID: contactId }, Date: sydneyToday(), Reference: reference,
        LineAmountTypes: 'Inclusive', // the note always totals the reward, whatever tax type the owner picks
        LineItems: [{ Description: `Lead reward: ${jobOf(reward)}${person}`, Quantity: 1, UnitAmount: r2(reward.amount), ...account }],
        Status: 'AUTHORISED', // must be AUTHORISED before it can be allocated
      }] },
    });
    note = made.CreditNotes[0];
  }
  const change = { xero_credit_note_id: note.CreditNoteID, xero_credit_note_number: note.CreditNoteNumber || null, xero_error: null, xero_tried_at: new Date().toISOString(), xero_checked_at: new Date().toISOString() };
  await save(admin, reward.id, change);
  await admin.from('activity_log').insert({ entity_type: 'client', entity_id: reward.referrer_client_id, action: 'lead_reward_note', description: `Lead reward ${moneyText(reward.amount)} for ${jobOf(reward)}: credit note ${note.CreditNoteNumber || ''} raised in Xero` });
  return { ...reward, ...change };
}

// A note used or voided by hand in Xero closes the reward by what Xero shows, so it can never also come
// off an invoice here. Returns 'cancelled', 'paid' or 'credited'.
async function closeByXero(admin, reward, note) {
  const settle = (action, reference, invoiceId = null) => admin.rpc('lead_reward_settle', { p_id: reward.id, p_action: action, p_reference: reference, p_actor: null, p_invoice: invoiceId });
  if (!note || GONE.includes(note.Status)) {
    const { error } = await settle('cancel', `${noteName(reward)} was voided in Xero`);
    if (error) throw error;
    return 'cancelled';
  }
  const left = r2(note.RemainingCredit);
  const tail = left > 0.004 ? `, ${moneyText(left)} still on the note: finish it in Xero` : '';
  const allocations = note.Allocations || [];
  if (allocations.length) {
    const xeroInvoiceId = allocations[0].Invoice && allocations[0].Invoice.InvoiceID;
    const { data: ours } = xeroInvoiceId ? await admin.from('invoices').select('id, invoice_number, paid_at').eq('xero_invoice_id', xeroInvoiceId).maybeSingle() : { data: null };
    const number = (ours && ours.invoice_number) || (allocations[0].Invoice && allocations[0].Invoice.InvoiceNumber) || 'an invoice';
    const { error } = await settle('credited', `${number}, allocated in Xero by hand${tail}`, ours && !ours.paid_at && left <= 0.004 ? ours.id : null);
    if (error) throw error;
    if (ours && !ours.paid_at && left <= 0.004) await save(admin, reward.id, { xero_allocated_invoice_id: xeroInvoiceId });
    return 'credited';
  }
  const payments = note.Payments || [];
  const { error } = await settle('paid', `Refunded in Xero${payments[0] && xeroDay(payments[0].Date) ? ` ${xeroDay(payments[0].Date)}` : ''}${tail}`);
  if (error) throw error;
  return 'paid';
}

// Is the note still whole in Xero? False (and the reward closed) when it was used or voided there by hand.
async function noteIsWhole(admin, reward) {
  const note = await readNote(reward);
  await save(admin, reward.id, { xero_checked_at: new Date().toISOString() });
  if (note && !GONE.includes(note.Status) && r2(note.RemainingCredit) >= r2(reward.amount) - 0.004) return { whole: true, note };
  return { whole: false, note, closed: await closeByXero(admin, reward, note) };
}

// Remove the allocation Xero still holds for a reward that is no longer on that invoice.
async function unallocate(admin, reward) {
  if (!reward.xero_allocated_invoice_id || !reward.xero_credit_note_id) return false;
  const note = await readNote(reward);
  const held = ((note && note.Allocations) || []).find((a) => a.Invoice && a.Invoice.InvoiceID === reward.xero_allocated_invoice_id);
  if (held) {
    if (!held.AllocationID) throw new Error(`Remove the allocation of ${noteName(reward)} in Xero by hand (Xero gave no id for it).`);
    await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(reward.xero_credit_note_id)}/Allocations/${encodeURIComponent(held.AllocationID)}`, { method: 'DELETE' });
  }
  await save(admin, reward.id, { xero_allocated_invoice_id: null, xero_error: null });
  return true;
}

// Allocate a reward to the invoice it sits on. 'waiting' while the invoice is not in Xero yet.
async function allocate(admin, reward) {
  const { data: inv } = await admin.from('invoices').select('id, invoice_number, xero_invoice_id, paid_at').eq('id', reward.applied_invoice_id).maybeSingle();
  if (!inv || !inv.xero_invoice_id) return 'waiting';
  const amount = r2(reward.amount);
  let note = await readNote(reward);
  if (!note || GONE.includes(note.Status) || r2(note.RemainingCredit) < amount - 0.004) {
    // already paid at the lower figure: stepping the reward off would only hide that Xero is short, so it is flagged
    if (inv.paid_at) throw new Error(`${noteName(reward)} was used in Xero by hand after it came off ${inv.invoice_number}, which is now paid: that invoice is ${moneyText(amount)} short in Xero. Put the allocation right in Xero.`);
    await admin.rpc('lead_reward_release', { p_invoice: inv.id, p_why: 'its credit note was used in Xero by hand' });
    await regenerateInvoicePdf(inv.id);
    return closeByXero(admin, { ...reward, status: 'due' }, note);
  }
  const res = await xeroRequest('accounting', `Invoices/${encodeURIComponent(inv.xero_invoice_id)}`);
  const x = res && res.Invoices && res.Invoices[0];
  if (!x || x.Status !== 'AUTHORISED' || r2(x.AmountDue) < amount - 0.004) {
    // paid or part paid in Xero since: the credit goes on their next invoice instead
    await admin.rpc('lead_reward_release', { p_invoice: inv.id, p_why: 'Xero shows less owing on it than the credit' });
    await regenerateInvoicePdf(inv.id);
    return 'stepped_off';
  }
  // The invoice can sit on another Xero contact for the same client (contacts are found by name), and Xero
  // only allocates within one contact: the note follows the invoice. If Xero will not move it, it is voided
  // and raised again on the invoice's contact (it is unused, so nothing is lost).
  if (x.Contact && note.Contact && x.Contact.ContactID && x.Contact.ContactID !== note.Contact.ContactID) {
    try {
      await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(note.CreditNoteID)}`, { method: 'POST', body: { CreditNotes: [{ CreditNoteID: note.CreditNoteID, Contact: { ContactID: x.Contact.ContactID } }] } });
    } catch (moveErr) {
      const account = await rewardAccount(admin);
      if (!account) throw moveErr;
      await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(note.CreditNoteID)}`, { method: 'POST', body: { CreditNotes: [{ CreditNoteID: note.CreditNoteID, Status: 'VOIDED' }] } });
      const again = await raiseNote(admin, reward, account, { onContactId: x.Contact.ContactID });
      note = { CreditNoteID: again.xero_credit_note_id };
      reward = again;
    }
  }
  await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(note.CreditNoteID)}/Allocations`, {
    method: 'PUT', body: { Amount: amount, Invoice: { InvoiceID: inv.xero_invoice_id }, Date: sydneyToday() },
  });
  await save(admin, reward.id, { xero_allocated_invoice_id: inv.xero_invoice_id, xero_error: null, xero_tried_at: new Date().toISOString() });
  await logInvoiceEvent(admin, { invoiceId: inv.id, kind: 'credit_note_pushed', actorLabel: 'the lead reward', detail: `Lead reward ${noteName(reward)}: ${moneyText(amount)} taken off the invoice in Xero` });
  return 'allocated';
}

// Put a waiting credit on the referrer's oldest unpaid invoice it fits. For an invoice already in Xero,
// Xero's own amount due is checked first (a part payment only Xero knows about). The note is read from
// Xero before it goes on (unless it was read a moment ago): one used or voided there by hand must never
// also come off an invoice here. Returns { invoice }, { closed } (closed by what Xero shows) or null.
async function placeOnInvoice(admin, reward, { noteJustRead = false } = {}) {
  const { data: candidates, error } = await admin.rpc('lead_reward_candidates', { p_reward: reward.id });
  if (error) throw error;
  let noteRead = noteJustRead;
  for (const c of candidates || []) {
    if (c.xero_invoice_id) {
      const res = await xeroRequest('accounting', `Invoices/${encodeURIComponent(c.xero_invoice_id)}`);
      const x = res && res.Invoices && res.Invoices[0];
      if (!x || x.Status !== 'AUTHORISED' || r2(x.AmountDue) - r2(reward.amount) < 0.01) continue;
    }
    if (!noteRead) {
      const state = await noteIsWhole(admin, reward);
      if (!state.whole) return { closed: state.closed };
      noteRead = true;
    }
    const { data: went, error: applyErr } = await admin.rpc('lead_reward_apply', { p_reward: reward.id, p_invoice: c.invoice_id });
    if (applyErr) throw applyErr;
    if (went) {
      await regenerateInvoicePdf(c.invoice_id); // the PDF they may already hold shows the old balance
      return { invoice: { id: c.invoice_id, number: c.invoice_number } };
    }
  }
  return null;
}

// A new invoice: each waiting credit of the client it is billed to that fits comes off it, oldest first
// (lead_reward_apply checks every limit). Each note is read from Xero first, for the same reason as above;
// when Xero cannot be reached the credit is left for the worker, which places it within 15 minutes.
// Called by create-invoice.js and create-job-from-quote.js (the deposit). Never throws.
async function creditNewInvoice(admin, invoiceId) {
  try {
    const { data: clientId, error } = await admin.rpc('invoice_bill_to_client', { p_invoice: invoiceId });
    if (error) throw error;
    if (!clientId) return 0;
    const { data: waiting } = await admin.from('lead_rewards').select(FIELDS).eq('referrer_client_id', clientId).eq('status', 'due')
      .not('xero_credit_note_id', 'is', null).is('applied_invoice_id', null).is('xero_allocated_invoice_id', null).order('due_at');
    let went = 0;
    for (const r of waiting || []) {
      try {
        const state = await noteIsWhole(admin, r);
        if (!state.whole) continue;
        const { data: on, error: applyErr } = await admin.rpc('lead_reward_apply', { p_reward: r.id, p_invoice: invoiceId });
        if (applyErr) throw applyErr;
        if (on) went += 1;
      } catch (err) {
        console.error('lead reward not put on the new invoice:', err.message);
      }
    }
    return went;
  } catch (err) {
    console.error('creditNewInvoice:', err.message);
    return 0;
  }
}

// One email to the referrer when the reward is theirs: what for, and where it went.
async function tellReferrer(admin, reward) {
  // told_at is taken first in one conditional update, so two passes at once send one email
  const { data: mine } = await admin.from('lead_rewards').update({ told_at: new Date().toISOString() }).eq('id', reward.id).is('told_at', null).select('id');
  if (!mine || !mine.length) return false;
  const { data: client } = await admin.from('clients').select('name, email, referral_token').eq('id', reward.referrer_client_id).maybeSingle();
  if (!client || !client.email) return false; // no email on the client: nothing to send, and not asked again
  try {
    let invoice = null;
    if (reward.applied_invoice_id) {
      const { data: inv } = await admin.from('invoices').select('invoice_number, invoice_token, balance_due').eq('id', reward.applied_invoice_id).maybeSingle();
      invoice = inv ? { number: inv.invoice_number, token: inv.invoice_token, balance: inv.balance_due } : null;
    }
    await sendRewardEarned(admin, { to: client.email, name: client.name, amount: reward.amount, person: reward.leads && reward.leads.name, invoice, referralToken: client.referral_token });
    return true;
  } catch (err) {
    await save(admin, reward.id, { told_at: null }); // not sent: the next pass tries again
    throw err;
  }
}

async function runLeadRewards(admin, { limit = 20, force = false } = {}) {
  const account = await rewardAccount(admin);
  const out = { on: !!account, raised: 0, placed: 0, allocated: 0, steppedOff: 0, closed: 0, told: 0, failed: 0, errors: [] };
  if (!account) return out;
  const now = Date.now();
  const mine = new Set(); // rewards this pass has claimed: later steps of the same pass carry on with them
  const attempt = async (reward, work) => {
    try {
      if (!mine.has(reward.id)) { if (!(await claim(admin, reward))) return; mine.add(reward.id); }
      await work();
      if (reward.xero_error) await save(admin, reward.id, { xero_error: null }); // it went this time
    } catch (err) {
      out.failed += 1;
      out.errors.push(`${jobOf(reward)}: ${err.message}`);
      await save(admin, reward.id, { xero_error: String(err.message).slice(0, 500), xero_tried_at: new Date().toISOString() });
    }
  };
  const count = (placed) => { if (placed && placed.invoice) out.placed += 1; else if (placed && placed.closed) out.closed += 1; };
  const tally = (result) => {
    if (result === 'allocated') out.allocated += 1;
    else if (result === 'stepped_off') out.steppedOff += 1;
    else if (['cancelled', 'paid', 'credited'].includes(result)) out.closed += 1;
  };

  // Each list below holds only rewards with something to do, least recently looked at first, and leaves
  // out one Xero refused in the last hour (unless forced). So a reward that cannot move yet (a credit
  // waiting with nothing owing, one Xero keeps refusing) never crowds the others out of the limit.
  const cutoff = new Date(now - RETRY_AFTER_MS).toISOString();
  const ready = (q) => (force ? q : q.or(`xero_error.is.null,xero_tried_at.lt.${cutoff}`)).order('xero_tried_at', { ascending: true, nullsFirst: true }).limit(limit);

  // 1. stepped off an invoice here, but Xero still holds the allocation (lead_reward_apply will not put
  //    it on another invoice until that is gone)
  const { data: held } = await ready(admin.from('lead_rewards').select(FIELDS).eq('status', 'due').not('xero_allocated_invoice_id', 'is', null));
  const handled = new Set(); // dealt with in this pass: step 3 does not look at them again
  for (const r of held || []) {
    await attempt(r, async () => {
      if (!(await unallocate(admin, r))) return;
      out.steppedOff += 1;
      handled.add(r.id);
      count(await placeOnInvoice(admin, { ...r, xero_allocated_invoice_id: null })); // straight onto their next invoice
    });
  }

  // 2. owed with no credit note yet: raise it, then put it on the oldest unpaid invoice it fits
  const { data: fresh } = await ready(admin.from('lead_rewards').select(FIELDS).eq('status', 'due').is('xero_credit_note_id', null));
  for (const r of fresh || []) {
    await attempt(r, async () => {
      const raised = await raiseNote(admin, r, account);
      handled.add(r.id);
      out.raised += 1;
      count(await placeOnInvoice(admin, raised, { noteJustRead: true }));
    });
  }

  // 3. a credit waiting: an invoice it fits may have appeared since (edited up, now billed to them, a
  //    step off elsewhere); once a day the note is read in case it was used by hand in Xero
  const { data: waiting } = await ready(admin.from('lead_rewards').select(FIELDS).eq('status', 'due').not('xero_credit_note_id', 'is', null).is('applied_invoice_id', null).is('xero_allocated_invoice_id', null));
  for (const r of waiting || []) {
    if (handled.has(r.id)) continue;
    await attempt(r, async () => {
      let noteJustRead = false;
      if (!r.xero_checked_at || now - new Date(r.xero_checked_at).getTime() > CHECK_EVERY_MS) {
        const state = await noteIsWhole(admin, r);
        if (!state.whole) { out.closed += 1; return; }
        noteJustRead = true;
      }
      count(await placeOnInvoice(admin, r, { noteJustRead }));
    });
  }

  // 4. on an invoice that is in Xero, the note not yet allocated to it (just pushed, or an earlier try failed)
  const { data: toAllocate } = await ready(admin.from('lead_rewards').select(`${FIELDS}, invoices!inner(xero_invoice_id)`).eq('status', 'settled').eq('settled_how', 'credited')
    .not('xero_credit_note_id', 'is', null).is('xero_allocated_invoice_id', null).not('invoices.xero_invoice_id', 'is', null));
  for (const r of toAllocate || []) await attempt(r, async () => tally(await allocate(admin, r)));

  // 5. tell the referrer once, when the note exists (so the email can say where the credit went)
  const since = new Date(now - TELL_WITHIN_MS).toISOString();
  const { data: toTell } = await admin.from('lead_rewards').select(FIELDS).is('told_at', null).not('xero_credit_note_id', 'is', null).in('status', ['due', 'settled']).gte('due_at', since).order('due_at').limit(limit);
  for (const r of toTell || []) {
    if (r.status === 'settled' && (r.settled_how !== 'credited' || !r.applied_invoice_id)) {
      await save(admin, r.id, { told_at: new Date().toISOString() }); // closed by hand in Xero: nothing to tell, and not looked at again
      continue;
    }
    try { if (await tellReferrer(admin, r)) out.told += 1; } catch (err) { console.error('lead reward email not sent:', err.message); }
  }
  return out;
}

// After Push to Xero. Never throws: the push itself has already worked.
async function allocateForInvoice(admin, invoiceId) {
  try {
    const { data: rewards } = await admin.from('lead_rewards').select(FIELDS).eq('applied_invoice_id', invoiceId).not('xero_credit_note_id', 'is', null).is('xero_allocated_invoice_id', null);
    for (const r of rewards || []) {
      try { if (await claim(admin, r)) await allocate(admin, r); } catch (err) { // not claimed: the worker is on it this minute
        console.error('lead reward not allocated:', err.message);
        await save(admin, r.id, { xero_error: String(err.message).slice(0, 500), xero_tried_at: new Date().toISOString() });
      }
    }
  } catch (err) { console.error('allocateForInvoice:', err.message); }
}

// The rewards on an invoice go back to owed. Never throws; the worker finishes whatever Xero did not take.
async function stepOff(admin, invoiceId, why, { less = null } = {}) {
  try {
    const { data: rewards } = await admin.from('lead_rewards').select(FIELDS).eq('applied_invoice_id', invoiceId);
    if (!rewards || !rewards.length) return 0;
    const { data: n, error } = less === null
      ? await admin.rpc('lead_reward_release', { p_invoice: invoiceId, p_why: why })
      : await admin.rpc('lead_reward_release_if_short', { p_invoice: invoiceId, p_less: less, p_why: why });
    if (error) throw error;
    if (!n) return 0;
    for (const r of rewards) {
      try { await unallocate(admin, r); } catch (err) { await save(admin, r.id, { xero_error: String(err.message).slice(0, 500), xero_tried_at: new Date().toISOString() }); }
    }
    return n;
  } catch (err) {
    console.error('lead reward step off failed:', err.message);
    return 0;
  }
}

async function cancelReward(admin, { rewardId, reason, actorId }) {
  const why = String(reason || '').trim();
  if (!why) throw new Error('Say why it is cancelled.');
  const { data: seen } = await admin.from('lead_rewards').select('id').eq('id', rewardId).maybeSingle();
  if (!seen) throw new Error('Lead reward not found.');
  // claimed first, then read: the worker cannot raise or place it while it is being cancelled
  if (!(await claim(admin, seen))) throw new Error('This reward is being worked on right now. Try again in a couple of minutes.');
  const { data: reward } = await admin.from('lead_rewards').select(FIELDS).eq('id', rewardId).maybeSingle();
  if (!['earned', 'due'].includes(reward.status)) throw new Error(reward.status === 'settled' ? 'This reward has been used, so it cannot be cancelled.' : 'This reward is already cancelled.');
  if (reward.xero_credit_note_id) {
    await unallocate(admin, reward); // an allocation left over from an invoice it stepped off
    const note = await readNote(reward);
    if (note && !GONE.includes(note.Status)) {
      if ((note.Allocations || []).length || (note.Payments || []).length) throw new Error(`${noteName(reward)} has been used in Xero, so it cannot be cancelled here.`);
      await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(reward.xero_credit_note_id)}`, { method: 'POST', body: { CreditNotes: [{ CreditNoteID: reward.xero_credit_note_id, Status: 'VOIDED' }] } });
    }
  }
  const { error } = await admin.rpc('lead_reward_settle', { p_id: rewardId, p_action: 'cancel', p_reference: reward.xero_credit_note_id ? `${why} (${noteName(reward)} voided in Xero)` : why, p_actor: actorId || null, p_invoice: null });
  if (error) throw error;
  return { ok: true };
}

module.exports = { runLeadRewards, creditNewInvoice, allocateForInvoice, stepOff, cancelReward };
