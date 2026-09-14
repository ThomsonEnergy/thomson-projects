// POST /api/push-credit-note-to-xero
// Body: { creditNoteId }
// Finance/Admin only. Two separate Xero calls, both required - Xero's own
// rule, not ours: (1) create the credit note (Type ACCRECCREDIT, must be
// Status AUTHORISED before it can be allocated at all), then (2) allocate
// it against the invoice it's crediting. If creation succeeds but
// allocation fails, the credit note ID is saved right away so a retry
// doesn't create a duplicate in Xero - it'll just retry the allocation.

const { requireFinanceRole } = require('./_shared/require-finance-role');
const { xeroRequest } = require('./_shared/xero-client');
const { buildXeroCreditNotePayload } = require('./_shared/build-xero-credit-note-payload');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireFinanceRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  let creditNoteId;
  try {
    ({ creditNoteId } = JSON.parse(event.body || '{}'));
    if (!creditNoteId) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'creditNoteId is required' }) };
    }

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('credit_notes')
      .select('id, xero_credit_note_id')
      .eq('id', creditNoteId)
      .single();
    if (existingErr || !existing) throw new Error('Credit note not found');

    let xeroCreditNoteId = existing.xero_credit_note_id;
    let allocateAmount;

    if (!xeroCreditNoteId) {
      const { creditNote, invoice, contactId, reference, lineItems } = await buildXeroCreditNotePayload(supabaseAdmin, creditNoteId);

      const result = await xeroRequest('accounting', 'CreditNotes', {
        method: 'POST',
        body: {
          CreditNotes: [{
            Type: 'ACCRECCREDIT',
            Contact: { ContactID: contactId },
            LineItems: lineItems,
            Reference: reference,
            Status: 'AUTHORISED', // must be AUTHORISED before it can be allocated
          }],
        },
      });
      const xeroCreditNote = result.CreditNotes[0];
      xeroCreditNoteId = xeroCreditNote.CreditNoteID;
      allocateAmount = xeroCreditNote.Total;

      // Persisted immediately, before attempting the allocation below - if
      // allocation fails, we must not lose track of the credit note Xero
      // already created, or a retry would create a second, duplicate one.
      await supabaseAdmin.from('credit_notes').update({
        xero_credit_note_id: xeroCreditNoteId,
        xero_credit_note_number: xeroCreditNote.CreditNoteNumber,
        xero_credit_note_status: xeroCreditNote.Status,
        xero_credit_note_error: null,
      }).eq('id', creditNoteId);
    } else {
      // Already created in Xero (a previous attempt got this far but
      // allocation failed) - re-fetch its Total rather than re-deriving
      // amounts, so we allocate exactly what Xero itself calculated.
      const existingXeroNote = await xeroRequest('accounting', `CreditNotes/${xeroCreditNoteId}`);
      allocateAmount = existingXeroNote.CreditNotes[0].Total;
    }

    const { data: invoiceRow } = await supabaseAdmin.from('credit_notes').select('invoices(xero_invoice_id, invoice_number)').eq('id', creditNoteId).single();
    const xeroInvoiceId = invoiceRow?.invoices?.xero_invoice_id;
    if (!xeroInvoiceId) throw new Error("This invoice hasn't been pushed to Xero - can't allocate a credit note to it.");

    await xeroRequest('accounting', `CreditNotes/${xeroCreditNoteId}/Allocations`, {
      method: 'PUT',
      body: { Amount: allocateAmount, Invoice: { InvoiceID: xeroInvoiceId } },
    });

    return { statusCode: 200, body: JSON.stringify({ ok: true, xeroCreditNoteId }) };
  } catch (err) {
    console.error('push-credit-note-to-xero error:', err.message);
    if (creditNoteId) {
      await supabaseAdmin.from('credit_notes').update({ xero_credit_note_error: err.message }).eq('id', creditNoteId).then(() => {}, () => {});
    }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
