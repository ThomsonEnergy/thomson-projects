// POST /api/push-invoice-to-xero
// Body: { invoiceId }
// Pricing roles only. Copies an already-created, already-sent invoice
// across to Xero as a DRAFT, for the bookkeeper's records - the client
// never sees Xero, they already have the invoice link from the app.
// Handles standalone invoices, legacy single-stage job claims (cost_centre_id
// set directly on the invoice), and multi-stage job claims (project_id set,
// one row per claimed cost centre in invoice_claims) - one Xero line item
// per stage per category (Labour/Materials/STC) for the multi-stage case.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');

async function getOrCreateContact(supabaseAdmin, { name, email }, storeOn) {
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

async function getOrCreateTrackingOptionId(supabaseAdmin, jobNumber) {
  if (!jobNumber) return null;
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
      .select('*, cost_centres(*, projects(*, clients(client_type, xero_contact_id))), clients(name, email, client_type, xero_contact_id), invoice_claims(*, cost_centres(name, sort_order))')
      .eq('id', invoiceId)
      .single();
    if (invErr || !invoice) throw new Error('Invoice not found');
    if (invoice.xero_invoice_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'This invoice has already been pushed to Xero.' }) };
    }

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

    const contactId = await getOrCreateContact(supabaseAdmin, { name: contactName, email: contactEmail }, { xero_contact_id: existingXeroContactId });
    if (!existingXeroContactId && contactStoreId) {
      await supabaseAdmin.from(contactStoreTable).update({ xero_contact_id: contactId }).eq('id', contactStoreId);
    }

    const trackingOptionId = jobNumber ? await getOrCreateTrackingOptionId(supabaseAdmin, jobNumber) : null;
    const { data: settings } = await supabaseAdmin.from('company_settings').select('xero_tracking_category_id').eq('id', 1).single();
    const trackingBlock = (trackingOptionId && settings?.xero_tracking_category_id)
      ? [{ TrackingCategoryID: settings.xero_tracking_category_id, TrackingOptionID: trackingOptionId }]
      : undefined;

    let reference, lineItems;
    if (isMultiStage) {
      const claims = (invoice.invoice_claims || []).slice().sort((a, b) => (a.cost_centres?.sort_order || 0) - (b.cost_centres?.sort_order || 0));
      const stageNames = claims.map(c => c.cost_centres?.name).filter(Boolean);
      reference = `Job ${jobNumber} - Sales Invoice (${stageNames.join(', ')})`;
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
        const { data: allCentres } = await supabaseAdmin
          .from('cost_centres')
          .select('id, sort_order')
          .eq('project_id', project.id)
          .order('sort_order');
        const stageIndex = allCentres.findIndex(c => c.id === centre.id);
        reference = `Job ${jobNumber} - Sales Invoice ${stageIndex + 1} of ${allCentres.length} (${centre.name})`;
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

    const result = await xeroRequest('accounting', 'Invoices', {
      method: 'POST',
      body: {
        Invoices: [{
          Type: 'ACCREC',
          Contact: { ContactID: contactId },
          LineItems: lineItems,
          Reference: reference,
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
