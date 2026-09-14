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

async function buildXeroCreditNotePayload(supabaseAdmin, creditNoteId) {
  const { data: creditNote, error: cnErr } = await supabaseAdmin
    .from('credit_notes')
    .select('*, credit_note_claims(*, cost_centres(name, sort_order)), invoices(*, cost_centres(*, projects(*, clients(client_type, xero_contact_id))), clients(name, email, client_type, xero_contact_id), project_id)')
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
  });
  if (!lineItems.length) throw new Error('This credit note has no amounts on it');

  return { creditNote, invoice, contactId, reference, lineItems };
}

module.exports = { buildXeroCreditNotePayload };
