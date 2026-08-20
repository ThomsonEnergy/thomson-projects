// POST /api/push-invoice-to-xero
// Body: { invoiceId }
// Pricing roles only. Copies an already-created, already-sent invoice
// (see create-invoice.js) across to Xero as a DRAFT, for the bookkeeper's
// records - the client never sees Xero, they already have the invoice
// link from the app. Labour and Materials always post; an STC Credit
// line is added when this claim applies one, coded to GST-free or
// GST-on-income depending on the client's type.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');

async function getOrCreateContact(supabaseAdmin, project) {
  if (project.xero_contact_id) return project.xero_contact_id;

  const searchName = (project.client_name || '').replace(/"/g, '\\"');
  const found = await xeroRequest('accounting', `Contacts?where=Name=="${encodeURIComponent(searchName)}"`);
  if (found.Contacts && found.Contacts.length) {
    const contactId = found.Contacts[0].ContactID;
    await supabaseAdmin.from('projects').update({ xero_contact_id: contactId }).eq('id', project.id);
    return contactId;
  }

  const created = await xeroRequest('accounting', 'Contacts', {
    method: 'POST',
    body: { Contacts: [{ Name: project.client_name, EmailAddress: project.client_email || undefined }] },
  });
  const contactId = created.Contacts[0].ContactID;
  await supabaseAdmin.from('projects').update({ xero_contact_id: contactId }).eq('id', project.id);
  return contactId;
}

async function getOrCreateTrackingOptionId(supabaseAdmin, jobNumber) {
  const { data: settings } = await supabaseAdmin.from('company_settings').select('xero_tracking_category_id').eq('id', 1).single();
  const categoryId = settings?.xero_tracking_category_id;
  if (!categoryId) return null;

  try {
    const optionName = `Job ${jobNumber}`;
    const category = await xeroRequest('accounting', `TrackingCategories/${categoryId}`);
    const existing = (category.TrackingCategories?.[0]?.Options || []).find(o => o.Name === optionName);
    if (existing) return existing.TrackingOptionID;

    const createdOption = await xeroRequest('accounting', `TrackingCategories/${categoryId}/Options`, {
      method: 'POST',
      body: { Name: optionName },
    });
    return createdOption.Options?.[0]?.TrackingOptionID || null;
  } catch (err) {
    console.error('Tracking option lookup/create failed, pushing without tracking:', err.message);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requirePricingRole(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  }
  const { supabaseAdmin } = auth;

  try {
    const { invoiceId } = JSON.parse(event.body || '{}');
    if (!invoiceId) {
      return { statusCode: 400, body: JSON.stringify({ error: 'invoiceId is required' }) };
    }

    const { data: invoice, error: invErr } = await supabaseAdmin
      .from('invoices')
      .select('*, cost_centres(*, projects(*, clients(client_type)))')
      .eq('id', invoiceId)
      .single();
    if (invErr || !invoice) throw new Error('Invoice not found');
    if (invoice.xero_invoice_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has already been pushed to Xero.' }) };
    }

    const centre = invoice.cost_centres;
    const project = centre.projects;
    const clientType = project.clients?.client_type || 'individual';

    const { data: allCentres } = await supabaseAdmin
      .from('cost_centres')
      .select('id, sort_order')
      .eq('project_id', project.id)
      .order('sort_order');
    const stageIndex = allCentres.findIndex(c => c.id === centre.id);
    const totalStages = allCentres.length;

    const { data: mappings } = await supabaseAdmin.from('xero_account_mapping').select('*');
    const labourMap = mappings.find(m => m.category === 'labour');
    const materialsMap = mappings.find(m => m.category === 'materials');
    const stcMap = mappings.find(m => m.category === (clientType === 'company' ? 'stc_credits_company' : 'stc_credits_individual'));
    if (!labourMap || !materialsMap) {
      throw new Error('Labour and Materials mappings must be set up in Settings > Xero Mapping before pushing invoices.');
    }

    const contactId = await getOrCreateContact(supabaseAdmin, project);
    const trackingOptionId = await getOrCreateTrackingOptionId(supabaseAdmin, project.job_number);
    const { data: settings } = await supabaseAdmin.from('company_settings').select('xero_tracking_category_id').eq('id', 1).single();

    const trackingBlock = (trackingOptionId && settings?.xero_tracking_category_id)
      ? [{ TrackingCategoryID: settings.xero_tracking_category_id, TrackingOptionID: trackingOptionId }]
      : undefined;

    const lineItems = [
      {
        Description: `${centre.name} - Labour`,
        Quantity: 1,
        UnitAmount: Number(invoice.labour_amount) || 0,
        AccountCode: labourMap.xero_account_code,
        TaxType: labourMap.xero_tax_type,
        Tracking: trackingBlock,
      },
    ];
    if (Number(invoice.material_amount) > 0) {
      lineItems.push({
        Description: `${centre.name} - Materials`,
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

    const result = await xeroRequest('accounting', 'Invoices', {
      method: 'POST',
      body: {
        Invoices: [{
          Type: 'ACCREC',
          Contact: { ContactID: contactId },
          LineItems: lineItems,
          Reference: `Job ${project.job_number} - Sales Invoice ${stageIndex + 1} of ${totalStages} (${centre.name})`,
          InvoiceNumber: invoice.invoice_number,
          Status: 'DRAFT',
        }],
      },
    });

    const xeroInvoice = result.Invoices[0];
    await supabaseAdmin
      .from('invoices')
      .update({
        xero_invoice_id: xeroInvoice.InvoiceID,
        xero_invoice_status: xeroInvoice.Status,
      })
      .eq('id', invoiceId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, invoiceId: xeroInvoice.InvoiceID, invoiceNumber: invoice.invoice_number }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
