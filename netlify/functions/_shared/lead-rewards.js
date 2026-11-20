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

// One AUTHORISED credit note for the reward. An earlier try that made it and died before saving its id is
// found by its reference (one reward per job, so "Lead reward J7020" is one note), never made twice.
async function raiseNote(admin, reward, account) {
  const { data: client } = await admin.from('clients').select('id, name, email, xero_contact_id').eq('id', reward.referrer_client_id).maybeSingle();
  if (!client) throw new Error('The referrer was not found.');
  const contactId = await getOrCreateContact({ name: client.name, email: client.email }, client);
  if (!client.xero_contact_id) await admin.from('clients').update({ xero_contact_id: contactId }).eq('id', client.id);
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
  const { data: inv } = await admin.from('invoices').select('id, invoice_number, xero_invoice_id').eq('id', reward.applied_invoice_id).maybeSingle();
  if (!inv || !inv.xero_invoice_id) return 'waiting';
  const amount = r2(reward.amount);
  const note = await readNote(reward);
  if (!note || GONE.includes(note.Status) || r2(note.RemainingCredit) < amount - 0.004) {
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
  // the invoice can sit on another Xero contact for the same client (contacts are found by name): the note follows it
  if (x.Contact && note.Contact && x.Contact.ContactID && x.Contact.ContactID !== note.Contact.ContactID) {
    await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(note.CreditNoteID)}`, { method: 'POST', body: { CreditNotes: [{ CreditNoteID: note.CreditNoteID, Contact: { ContactID: x.Contact.ContactID } }] } });
  }
  await xeroRequest('accounting', `CreditNotes/${encodeURIComponent(reward.xero_credit_note_id)}/Allocations`, {
    method: 'PUT', body: { Amount: amount, Invoice: { InvoiceID: inv.xero_invoice_id }, Date: sydneyToday() },
  });
  await save(admin, reward.id, { xero_allocated_invoice_id: inv.xero_invoice_id, xero_error: null, xero_tried_at: new Date().toISOString() });
  await logInvoiceEvent(admin, { invoiceId: inv.id, kind: 'credit_note_pushed', actorLabel: 'the lead reward', detail: `Lead reward ${noteName(reward)}: ${moneyText(amount)} taken off the invoice in Xero` });
  return 'allocated';
}

// Put a waiting credit on the referrer's oldest unpaid invoice it fits. For an invoice already in Xero,
// Xero's own amount due is checked first (a part payment only Xero knows about). Returns the invoice or null.
async function placeOnInvoice(admin, reward) {
  const { data: candidates, error } = await admin.rpc('lead_reward_candidates', { p_reward: reward.id });
  if (error) throw error;
  for (const c of candidates || []) {
    if (c.xero_invoice_id) {
      const res = await xeroRequest('accounting', `Invoices/${encodeURIComponent(c.xero_invoice_id)}`);
      const x = res && res.Invoices && res.Invoices[0];
      if (!x || x.Status !== 'AUTHORISED' || r2(x.AmountDue) - r2(reward.amount) < 0.01) continue;
    }
    const { data: went, error: applyErr } = await admin.rpc('lead_reward_apply', { p_reward: reward.id, p_invoice: c.invoice_id });
    if (applyErr) throw applyErr;
    if (went) {
      await regenerateInvoicePdf(c.invoice_id); // the PDF they may already hold shows the old balance
      return { id: c.invoice_id, number: c.invoice_number };
    }
  }
  return null;
}

// One email to the referrer when the reward is theirs: what for, and where it went.
async function tellReferrer(admin, reward) {
  const { data: client } = await admin.from('clients').select('name, email, referral_token').eq('id', reward.referrer_client_id).maybeSingle();
  if (client && client.email) {
    let invoice = null;
    if (reward.applied_invoice_id) {
      const { data: inv } = await admin.from('invoices').select('invoice_number, invoice_token, balance_due').eq('id', reward.applied_invoice_id).maybeSingle();
      invoice = inv ? { number: inv.invoice_number, token: inv.invoice_token, balance: inv.balance_due } : null;
    }
    await sendRewardEarned(admin, { to: client.email, name: client.name, amount: reward.amount, person: reward.leads && reward.leads.name, invoice, referralToken: client.referral_token });
  }
  await save(admin, reward.id, { told_at: new Date().toISOString() }); // no email on the client: nothing to send, and not asked again
}

async function runLeadRewards(admin, { limit = 20, force = false } = {}) {
  const account = await rewardAccount(admin);
  const out = { on: !!account, raised: 0, placed: 0, allocated: 0, steppedOff: 0, closed: 0, told: 0, failed: 0, errors: [] };
  if (!account) return out;
  const now = Date.now();
  const resting = (r) => !force && r.xero_error && r.xero_tried_at && now - new Date(r.xero_tried_at).getTime() < RETRY_AFTER_MS;
  const attempt = async (reward, work) => {
    if (resting(reward)) return;
    try { await work(); } catch (err) {
      out.failed += 1;
      out.errors.push(`${jobOf(reward)}: ${err.message}`);
      await save(admin, reward.id, { xero_error: String(err.message).slice(0, 500), xero_tried_at: new Date().toISOString() });
    }
  };
  const tally = (result) => {
    if (result === 'allocated') out.allocated += 1;
    else if (result === 'stepped_off') out.steppedOff += 1;
    else if (['cancelled', 'paid', 'credited'].includes(result)) out.closed += 1;
  };

  // 1. Xero still holds an allocation for a reward that stepped off its invoice here
  const { data: held } = await admin.from('lead_rewards').select(`${FIELDS}, invoices(xero_invoice_id)`).not('xero_allocated_invoice_id', 'is', null).limit(limit);
  for (const r of held || []) {
    if (r.invoices && r.invoices.xero_invoice_id === r.xero_allocated_invoice_id) continue;
    await attempt(r, async () => { if (await unallocate(admin, r)) out.steppedOff += 1; });
  }

  // 2. owed: raise the note, then put it on the oldest unpaid invoice it fits
  const { data: owed } = await admin.from('lead_rewards').select(FIELDS).eq('status', 'due').is('applied_invoice_id', null).is('xero_allocated_invoice_id', null).order('due_at').limit(limit);
  for (let r of owed || []) {
    await attempt(r, async () => {
      if (!r.xero_credit_note_id) { r = await raiseNote(admin, r, account); out.raised += 1; }
      else if (!r.xero_checked_at || now - new Date(r.xero_checked_at).getTime() > CHECK_EVERY_MS) {
        const state = await noteIsWhole(admin, r);
        if (!state.whole) { out.closed += 1; return; }
      }
      if (await placeOnInvoice(admin, r)) out.placed += 1;
    });
  }

  // 3. on an invoice here, not yet allocated in Xero (the invoice was just pushed, or an earlier try failed)
  const { data: toAllocate } = await admin.from('lead_rewards').select(FIELDS).eq('status', 'settled').eq('settled_how', 'credited')
    .not('applied_invoice_id', 'is', null).not('xero_credit_note_id', 'is', null).is('xero_allocated_invoice_id', null).limit(limit);
  for (const r of toAllocate || []) await attempt(r, async () => tally(await allocate(admin, r)));

  // 4. tell the referrer once, when the note exists (so the email can say where the credit went)
  const since = new Date(now - TELL_WITHIN_MS).toISOString();
  const { data: toTell } = await admin.from('lead_rewards').select(FIELDS).is('told_at', null).not('xero_credit_note_id', 'is', null).in('status', ['due', 'settled']).gte('due_at', since).limit(limit);
  for (const r of toTell || []) {
    if (r.status === 'settled' && (r.settled_how !== 'credited' || !r.applied_invoice_id)) continue; // closed by hand in Xero: nothing to tell
    try { await tellReferrer(admin, r); out.told += 1; } catch (err) { console.error('lead reward email not sent:', err.message); }
  }
  return out;
}

// After Push to Xero. Never throws: the push itself has already worked.
async function allocateForInvoice(admin, invoiceId) {
  try {
    const { data: rewards } = await admin.from('lead_rewards').select(FIELDS).eq('applied_invoice_id', invoiceId).not('xero_credit_note_id', 'is', null).is('xero_allocated_invoice_id', null);
    for (const r of rewards || []) {
      try { await allocate(admin, r); } catch (err) {
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
  const { data: reward } = await admin.from('lead_rewards').select(FIELDS).eq('id', rewardId).maybeSingle();
  if (!reward) throw new Error('Lead reward not found.');
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

module.exports = { runLeadRewards, allocateForInvoice, stepOff, cancelReward };
