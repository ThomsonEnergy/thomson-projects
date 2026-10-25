// POST /api/create-credit-note
// Body: { invoiceId, reason, refund, refundReference, claims: [{ costCentreId, labourAmount, materialAmount, stcAmount }] }
// Records a credit note against an already-raised invoice - reduces what's
// still owed on it (account credit, the default) or, if refund is true,
// just notes that money was actually sent back to the client outside
// Xero/this app (refundReference is a staff-entered note of how, not
// something this function executes). Finance/Admin only - see
// require-finance-role.js.
//
// Only creates the LOCAL record and takes the credit off
// cost_centres.invoiced_amount in one database step (add_invoiced_amount,
// the call create-invoice.js uses, since that figure aggregates every
// invoice/credit on the stage, never gets overwritten outright). The note,
// its claims and the stage amounts land all or nothing (bug review M16).
// Pushing to Xero is a separate step (push-credit-note-to-xero.js), same
// two-step pattern invoices already use (create, then a distinct "Push to
// Xero" action).

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { creditNoteTotalIncGst } = require('./_shared/build-xero-credit-note-payload');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireFinanceRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin, user } = auth;

  // If anything after the credit note row fails, take back what was done so far (no credit note with no
  // amounts, which the Xero push rejects, and no stage amount changed for a note that is not there). Bug review M16.
  const undo = { creditNoteId: null, added: [] };
  try {
    const { invoiceId, reason, refund, refundReference, claims } = JSON.parse(event.body || '{}');
    if (!invoiceId || !Array.isArray(claims) || !claims.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invoiceId and at least one claim are required' }) };
    }

    const claimRows = claims
      .map(c => ({
        cost_centre_id: c.costCentreId,
        labour_amount: Number(c.labourAmount) || 0,
        material_amount: Number(c.materialAmount) || 0,
        stc_amount: Number(c.stcAmount) || 0,
        bstc_amount: Number(c.bstcAmount) || 0,
      }))
      .filter(c => c.cost_centre_id && (c.labour_amount + c.material_amount + c.stc_amount + c.bstc_amount) > 0);
    if (!claimRows.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'At least one stage needs a non-zero credit amount' }) };
    }
    // No negative parts: Xero only takes positive lines, so a negative one would make the app and Xero disagree.
    if (claimRows.some(c => c.labour_amount < 0 || c.material_amount < 0 || c.stc_amount < 0 || c.bstc_amount < 0)) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Credit amounts can not be negative.' }) };
    }

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('id, project_id, cost_centre_id, invoice_claims(*)')
      .eq('id', invoiceId)
      .single();
    if (invErr || !invoice) throw new Error('Invoice not found');

    // Server-side guard so a credit note can never claim more than was
    // actually invoiced on that stage via THIS invoice, even if the UI
    // already constrains it - sums this invoice's own claim (or, for a
    // legacy single-stage invoice, its own labour/material/stc fields)
    // against however much has already been credited against it before.
    const originalByCentre = {};
    if (invoice.invoice_claims && invoice.invoice_claims.length) {
      invoice.invoice_claims.forEach(ic => {
        originalByCentre[ic.cost_centre_id] = {
          labour: Number(ic.labour_amount) || 0, material: Number(ic.material_amount) || 0, stc: Number(ic.stc_amount) || 0, bstc: Number(ic.bstc_amount) || 0,
        };
      });
    } else if (invoice.cost_centre_id) {
      const { data: legacyInv } = await supabaseAdmin.from('invoices').select('labour_amount, material_amount, stc_amount, bstc_amount').eq('id', invoiceId).single();
      originalByCentre[invoice.cost_centre_id] = {
        labour: Number(legacyInv.labour_amount) || 0, material: Number(legacyInv.material_amount) || 0, stc: Number(legacyInv.stc_amount) || 0, bstc: Number(legacyInv.bstc_amount) || 0,
      };
    }

    const { data: priorCredits } = await supabaseAdmin
      .from('credit_note_claims')
      .select('cost_centre_id, labour_amount, material_amount, stc_amount, bstc_amount, credit_notes!inner(invoice_id)')
      .eq('credit_notes.invoice_id', invoiceId);
    const alreadyCreditedByCentre = {};
    (priorCredits || []).forEach(pc => {
      const cur = alreadyCreditedByCentre[pc.cost_centre_id] || { labour: 0, material: 0, stc: 0, bstc: 0 };
      cur.labour += Number(pc.labour_amount) || 0;
      cur.material += Number(pc.material_amount) || 0;
      cur.stc += Number(pc.stc_amount) || 0;
      cur.bstc += Number(pc.bstc_amount) || 0;
      alreadyCreditedByCentre[pc.cost_centre_id] = cur;
    });

    for (const c of claimRows) {
      const original = originalByCentre[c.cost_centre_id];
      if (!original) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'This invoice has no claim against that stage' }) };
      }
      const already = alreadyCreditedByCentre[c.cost_centre_id] || { labour: 0, material: 0, stc: 0, bstc: 0 };
      if (already.labour + c.labour_amount > original.labour + 0.01
        || already.material + c.material_amount > original.material + 0.01
        || already.stc + c.stc_amount > original.stc + 0.01
        || already.bstc + c.bstc_amount > (original.bstc || 0) + 0.01) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'That credit amount exceeds what this invoice actually claimed on that stage (after any earlier credit notes).' }) };
      }
    }

    // A credit note only ever lowers what the client owes. One that mostly takes back an STC or BSTC credit
    // would raise it (and Xero refuses a credit note with a negative total), so the app and Xero would
    // disagree until fixed by hand: that is a new invoice, not a credit note. Bug review M24. The total is
    // GST-inclusive, the way Xero and get_invoice_balance_due see it (a certificate credit carries GST for a
    // company client, the client the invoice is billed to).
    const { data: clientType, error: typeErr } = await supabaseAdmin.rpc('invoice_client_type', { p_invoice_id: invoiceId });
    if (typeErr) throw typeErr;
    if (creditNoteTotalIncGst(claimRows, clientType) < 0) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'This credit note would be negative: the STC or BSTC credit taken back is more than the work credited. Taking back an STC credit is a new invoice, not a credit note.' }) };
    }

    const { data: insertedCreditNote, error: cnErr } = await supabaseAdmin
      .from('credit_notes')
      .insert({
        invoice_id: invoiceId,
        reason: reason || null,
        refund: !!refund,
        refund_reference: refund ? (refundReference || null) : null,
        created_by: user.id,
      })
      .select('id')
      .single();
    if (cnErr) throw cnErr;
    undo.creditNoteId = insertedCreditNote.id;

    const { error: claimsErr } = await supabaseAdmin
      .from('credit_note_claims')
      .insert(claimRows.map(c => ({ ...c, credit_note_id: insertedCreditNote.id })));
    if (claimsErr) throw claimsErr;

    // Taken off each stage in one database step, so a credit note raised beside a progress claim can not
    // lose either side's change.
    for (const c of claimRows) {
      const amount = Math.round((c.labour_amount + c.material_amount) * 100) / 100;
      if (!amount) continue;
      const { error: addErr } = await supabaseAdmin.rpc('add_invoiced_amount', { p_centre_id: c.cost_centre_id, p_amount: -amount });
      if (addErr) throw addErr;
      undo.added.push({ centreId: c.cost_centre_id, amount });
    }
    undo.creditNoteId = null; // done: nothing to take back from here on

    return { statusCode: 200, body: JSON.stringify({ ok: true, creditNoteId: insertedCreditNote.id }) };
  } catch (err) {
    console.error('create-credit-note error:', err.message);
    if (undo.creditNoteId) {
      try {
        for (const a of undo.added) await supabaseAdmin.rpc('add_invoiced_amount', { p_centre_id: a.centreId, p_amount: a.amount });
        await supabaseAdmin.from('credit_note_claims').delete().eq('credit_note_id', undo.creditNoteId);
        await supabaseAdmin.from('credit_notes').delete().eq('id', undo.creditNoteId);
      } catch (undoErr) {
        console.error('create-credit-note: could not take back the part-made credit note', undo.creditNoteId, undoErr.message);
      }
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
