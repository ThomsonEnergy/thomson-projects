// Shared by push-invoice-to-xero.js (creates a new Xero DRAFT invoice) and
// update-invoice-in-xero.js (re-sends the same InvoiceID to update its
// line items after an edit here) - everything about turning one of our
// invoice rows into a Xero Invoices payload lives in exactly one place,
// so an edit can never post differently than the original push did.

const { xeroRequest } = require('./xero-client');
const { getOrCreateTrackingOptionId } = require('./xero-tracking');

async function getOrCreateContact({ name, email }, storeOn) {
  if (storeOn.xero_contact_id) return storeOn.xero_contact_id;

  const searchName = (name || '').replace(/"/g, '\\"');
  const found = await xeroRequest('accounting', `Contacts?where=Name=="${encodeURIComponent(searchName)}"`);
  if (found.Contacts && found.Contacts.length) {
    return found.Contacts[0].ContactID;
  }

  const created = await xeroRequest('accounting', 'Contacts', {
    method: 'POST',
    body: { Contacts: [{ Name: name, EmailAddress: email || undefined }] },
  });
  return created.Contacts[0].ContactID;
}

// Fetches invoice `invoiceId`, resolves its Xero contact and tracking
// option, and builds { invoice, contactId, reference, lineItems,
// jobNumber } - the caller decides what Status/InvoiceID to send and
// performs the actual Invoices POST.
async function buildXeroInvoicePayload(supabaseAdmin, invoiceId) {
  const { data: invoice, error: invErr } = await supabaseAdmin
    .from('invoices')
    .select('*, cost_centres(*, projects(*, clients(client_type, xero_contact_id))), clients(name, email, client_type, xero_contact_id), invoice_claims(*, cost_centres(name, sort_order))')
    .eq('id', invoiceId)
    .single();
  if (invErr || !invoice) throw new Error('Invoice not found');

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

  // Everything below is branched: job-linked claims get a job-tagged
  // reference and tracking; standalone invoices just get a plain
  // description and no tracking, since there's no job to tag them to.
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
    throw new Error('Labour and Materials mappings must be set up in Settings > Xero Mapping before pushing invoices.');
  }

  const contactId = await getOrCreateContact({ name: contactName, email: contactEmail }, { xero_contact_id: existingXeroContactId });
  if (!existingXeroContactId && contactStoreId) {
    await supabaseAdmin.from(contactStoreTable).update({ xero_contact_id: contactId }).eq('id', contactStoreId);
  }

  const trackingOptionId = jobNumber ? await getOrCreateTrackingOptionId(supabaseAdmin, `Job ${jobNumber}`) : null;
  const { data: settings } = await supabaseAdmin.from('company_settings').select('xero_tracking_category_id').eq('id', 1).single();
  const trackingBlock = (trackingOptionId && settings?.xero_tracking_category_id)
    ? [{ TrackingCategoryID: settings.xero_tracking_category_id, TrackingOptionID: trackingOptionId }]
    : undefined;

  let reference, lineItems;
  if (isMultiStage) {
    const claims = (invoice.invoice_claims || []).slice().sort((a, b) => (a.cost_centres?.sort_order || 0) - (b.cost_centres?.sort_order || 0));
    reference = `Job ${jobNumber} - ${invoice.description || 'Sales Invoice'}`;
    lineItems = [];
    claims.forEach(c => {
      const stageName = c.cost_centres?.name || 'Stage';
      lineItems.push({
        Description: `${stageName} - Labour`,
        Quantity: 1,
        UnitAmount: Number(c.labour_amount) || 0,
        AccountCode: labourMap.xero_account_code,
        TaxType: labourMap.xero_tax_type,
        Tracking: trackingBlock,
      });
      if (Number(c.material_amount) > 0) {
        lineItems.push({
          Description: `${stageName} - Materials`,
          Quantity: 1,
          UnitAmount: Number(c.material_amount),
          AccountCode: materialsMap.xero_account_code,
          TaxType: materialsMap.xero_tax_type,
          Tracking: trackingBlock,
        });
      }
      if (Number(c.stc_amount) > 0) {
        if (!stcMap) throw new Error(`No Xero mapping found for STC credits (${clientType}) - set it up in Settings > Xero Mapping first.`);
        lineItems.push({
          Description: `${stageName} - STC Credit`,
          Quantity: 1,
          UnitAmount: -Number(c.stc_amount),
          AccountCode: stcMap.xero_account_code,
          TaxType: stcMap.xero_tax_type,
          Tracking: trackingBlock,
        });
      }
    });
  } else {
    if (!isStandalone) {
      reference = `Job ${jobNumber} - ${invoice.description || 'Sales Invoice'}`;
    } else {
      reference = invoice.description || 'Invoice';
    }

    const lineDescription = isStandalone ? (invoice.description || 'Invoice') : centre.name;
    lineItems = [
      {
        Description: `${lineDescription} - Labour`,
        Quantity: 1,
        UnitAmount: Number(invoice.labour_amount) || 0,
        AccountCode: labourMap.xero_account_code,
        TaxType: labourMap.xero_tax_type,
        Tracking: trackingBlock,
      },
    ];
    if (Number(invoice.material_amount) > 0) {
      lineItems.push({
        Description: `${lineDescription} - Materials`,
        Quantity: 1,
        UnitAmount: Number(invoice.material_amount),
        AccountCode: materialsMap.xero_account_code,
        TaxType: materialsMap.xero_tax_type,
        Tracking: trackingBlock,
      });
    }
    if (Number(invoice.stc_amount) > 0) {
      if (!stcMap) {
        throw new Error(`No Xero mapping found for STC credits (${clientType}) - set it up in Settings > Xero Mapping first.`);
      }
      lineItems.push({
        Description: 'STC Credit',
        Quantity: 1,
        UnitAmount: -Number(invoice.stc_amount),
        AccountCode: stcMap.xero_account_code,
        TaxType: stcMap.xero_tax_type,
        Tracking: trackingBlock,
      });
    }
  }

  // Xero's Invoices endpoint takes plain YYYY-MM-DD strings for Date/DueDate.
  const date = invoice.sent_at ? new Date(invoice.sent_at).toISOString().slice(0, 10) : undefined;
  const dueDate = invoice.due_date || undefined;

  return { invoice, contactId, reference, lineItems, jobNumber, date, dueDate };
}

module.exports = { buildXeroInvoicePayload };
