// Shared by push-credit-note-to-xero.js - builds a Xero CreditNotes
// (ACCRECCREDIT) payload from a credit_notes row. Mirrors the exact same
// per-stage Labour/Materials/STC line construction (same signs, same
// account mapping lookup) that build-xero-invoice-payload.js uses for the
// invoice being credited - a credit note built the same way a matching
// invoice was, using the same amounts, produces a Xero Total that exactly
// cancels the portion of the invoice being credited when allocated.
//
// Credit Notes is a genuinely different Xero resource from Invoices (not
// a status flag) - create and allocate are two separate API calls
// (Xero's own rule, not ours): POST CreditNotes to create it, then a
// separate PUT CreditNotes/{id}/Allocations to apply it against the
// invoice. Both must be done for the credit to actually reduce what's
// owed on the invoice in Xero, not just this call.

const { getOrCreateContact } = require('./build-xero-invoice-payload');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// What a credit note takes off the invoice, GST included, the way Xero totals it and
// get_invoice_balance_due applies it: labour and materials plus GST, less each certificate credit
// taken back (plus GST for a company client, GST-free for an individual, each credit rounded on its
// own, bug review M25). Negative means the note would raise what the client owes (bug review M24).
function creditNoteTotalIncGst(claims, clientType) {
  const sum = (key) => (claims || []).reduce((s, c) => s + (Number(c[key]) || 0), 0);
  const work = r2(sum('labour_amount') + sum('material_amount'));
  const creditIncGst = (n) => (clientType === 'company' ? r2(n * 1.1) : r2(n));
  return r2(work + r2(work * 0.1) - creditIncGst(sum('stc_amount')) - creditIncGst(sum('bstc_amount')));
}

async function buildXeroCreditNotePayload(supabaseAdmin, creditNoteId) {
  const { data: creditNote, error: cnErr } = await supabaseAdmin
    .from('credit_notes')
    .select('*, credit_note_claims(*, cost_centres(name, sort_order)), invoices(*, cost_centres(*, projects(*, clients(client_type, xero_contact_id))), clients:client_id(name, email, client_type, xero_contact_id), bill_to:bill_to_client_id(id, name, email, client_type, xero_contact_id), project_id)')
    .eq('id', creditNoteId)
    .single();
  if (cnErr || !creditNote) throw new Error('Credit note not found');

  const invoice = creditNote.invoices;
  if (!invoice) throw new Error('The invoice this credit note belongs to could not be found');
  if (!invoice.xero_invoice_id) throw new Error("This invoice hasn't been pushed to Xero yet - push it first before issuing a credit note against it.");

  const isMultiStage = !!invoice.project_id;
  const centre = invoice.cost_centres; // only set for a legacy single-stage job claim
  const isStandalone = !isMultiStage && !centre;

  let project = null;
  if (isMultiStage) {
    const { data: proj } = await supabaseAdmin.from('projects').select('*, clients(client_type, xero_contact_id)').eq('id', invoice.project_id).single();
    project = proj;
  } else if (centre) {
    project = centre.projects;
  }

  let contactName, contactEmail, clientType, jobNumber, contactStoreTable, contactStoreId, existingXeroContactId;
  if (isStandalone) {
    const client = invoice.clients;
    contactName = client?.name;
    contactEmail = client?.email;
    clientType = client?.client_type || 'individual';
    jobNumber = null;
    contactStoreTable = 'clients';
    contactStoreId = invoice.client_id;
    existingXeroContactId = client?.xero_contact_id;
  } else {
    contactName = project.client_name;
    contactEmail = project.client_email;
    clientType = project.clients?.client_type || 'individual';
    jobNumber = project.job_number;
    contactStoreTable = 'projects';
    contactStoreId = project.id;
    existingXeroContactId = project.xero_contact_id;
  }

  // Same override as build-xero-invoice-payload.js, and for the same
  // reason: a credit note against a warranty job must go to whoever the
  // original invoice actually billed (e.g. the equipment manufacturer),
  // not the property owner the job itself is tagged against - otherwise
  // it'd land on the wrong Xero contact and never actually offset the
  // invoice it's meant to credit.
  if (invoice.bill_to) {
    contactName = invoice.bill_to.name;
    contactEmail = invoice.bill_to.email;
    clientType = invoice.bill_to.client_type || 'individual';
    contactStoreTable = 'clients';
    contactStoreId = invoice.bill_to.id;
    existingXeroContactId = invoice.bill_to.xero_contact_id;
  }

  const { data: mappings } = await supabaseAdmin.from('xero_account_mapping').select('*');
  const labourMap = mappings.find(m => m.category === 'labour');
  const materialsMap = mappings.find(m => m.category === 'materials');
  const stcMap = mappings.find(m => m.category === (clientType === 'company' ? 'stc_credits_company' : 'stc_credits_individual'));
  if (!labourMap || !materialsMap) {
    throw new Error('Labour and Materials mappings must be set up in Settings > Xero Mapping before pushing credit notes.');
  }

  const contactId = await getOrCreateContact({ name: contactName, email: contactEmail }, { xero_contact_id: existingXeroContactId });
  if (!existingXeroContactId && contactStoreId) {
    await supabaseAdmin.from(contactStoreTable).update({ xero_contact_id: contactId }).eq('id', contactStoreId);
  }

  const claims = (creditNote.credit_note_claims || []).slice().sort((a, b) => (a.cost_centres?.sort_order || 0) - (b.cost_centres?.sort_order || 0));
  const reference = isStandalone
    ? `Credit note for ${invoice.invoice_number}`
    : `Job ${jobNumber} - Credit note for ${invoice.invoice_number}`;

  const lineItems = [];
  claims.forEach(c => {
    const stageName = c.cost_centres?.name || (isStandalone ? (invoice.description || 'Invoice') : 'Stage');
    if (Number(c.labour_amount) > 0) {
      lineItems.push({
        Description: `${stageName} - Labour credit (${invoice.invoice_number})`,
        Quantity: 1,
        UnitAmount: Number(c.labour_amount),
        AccountCode: labourMap.xero_account_code,
        TaxType: labourMap.xero_tax_type,
      });
    }
    if (Number(c.material_amount) > 0) {
      lineItems.push({
        Description: `${stageName} - Materials credit (${invoice.invoice_number})`,
        Quantity: 1,
        UnitAmount: Number(c.material_amount),
        AccountCode: materialsMap.xero_account_code,
        TaxType: materialsMap.xero_tax_type,
      });
    }
    if (Number(c.stc_amount) > 0) {
      if (!stcMap) throw new Error(`No Xero mapping found for STC credits (${clientType}) - set it up in Settings > Xero Mapping first.`);
      lineItems.push({
        Description: `${stageName} - STC credit reversal (${invoice.invoice_number})`,
        Quantity: 1,
        UnitAmount: -Number(c.stc_amount),
        AccountCode: stcMap.xero_account_code,
        TaxType: stcMap.xero_tax_type,
      });
    }
    if (Number(c.bstc_amount) > 0) {
      if (!stcMap) throw new Error(`No Xero mapping found for STC credits (${clientType}) - set it up in Settings > Xero Mapping first.`);
      lineItems.push({
        Description: `${stageName} - BSTC credit reversal (${invoice.invoice_number})`,
        Quantity: 1,
        UnitAmount: -Number(c.bstc_amount),
        AccountCode: stcMap.xero_account_code,
        TaxType: stcMap.xero_tax_type,
      });
    }
  });
  if (!lineItems.length) throw new Error('This credit note has no amounts on it');
  // Xero refuses a credit note whose total is negative, and such a note would raise what the client owes
  // here: taking back an STC credit is a new invoice, not a credit note (bug review M24).
  if (creditNoteTotalIncGst(claims, clientType) < 0) {
    throw new Error('This credit note has a negative total (the STC or BSTC credit taken back is more than the work credited), which Xero refuses. Taking back an STC credit is a new invoice, not a credit note.');
  }

  return { creditNote, invoice, contactId, reference, lineItems };
}

module.exports = { buildXeroCreditNotePayload, creditNoteTotalIncGst };
