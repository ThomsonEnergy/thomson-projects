// Shared by accept-quote.js (client approves online) and
// manually-approve-quote.js (staff records a verbal/email/phone
// approval) - both need to do exactly the same thing: freeze the quote
// as an approved historical record, and spin up a brand new project row
// as the actual job, with its own copy of every stage/line item/photo
// group.
//
// The new row is inserted the same way a Direct Job is (pipeline_stage:
// 'job_booked', job_number left unset) so the same database trigger that
// already assigns a job number to a fresh Direct Job does it here too -
// nothing new to draw or risk double-assigning.
//
// Deposit invoicing is ported from the old accept-quote.js (back when
// approving just flipped job_number on the same row) - same proportional-
// across-stages distribution, just raised against the new job's own
// fresh cost_centres instead of the quote's.

const crypto = require('crypto');

function splitLabourMaterial(centre, amount) {
  const labourCost = Number(centre.estimated_labour_cost) || 0;
  const materialCost = Number(centre.estimated_material_cost) || 0;
  const costTotal = labourCost + materialCost;
  const labourShare = costTotal > 0 ? labourCost / costTotal : 1;
  const labourAmount = Math.round(amount * labourShare * 100) / 100;
  const materialAmount = Math.round((amount - labourAmount) * 100) / 100;
  return { labourAmount, materialAmount };
}

async function raiseDepositInvoice(supabaseAdmin, job, centres) {
  const depositPercent = Number(job.deposit_percent) || 0;
  const totalQuoted = centres.reduce((s, c) => s + (Number(c.quoted_amount) || 0), 0);
  if (!(depositPercent > 0) || !(totalQuoted > 0)) return null;
  if (job.proposal_template === 'quick_estimate' || job.proposal_template === 'time_and_materials') return null;

  const depositTotal = Math.round(totalQuoted * (depositPercent / 100) * 100) / 100;
  const claimRows = centres
    .map(c => {
      const share = Number(c.quoted_amount) / totalQuoted;
      const amount = Math.round(depositTotal * share * 100) / 100;
      const { labourAmount, materialAmount } = splitLabourMaterial(c, amount);
      return { cost_centre_id: c.id, labour_amount: labourAmount, material_amount: materialAmount, stc_amount: 0, claim_percent: depositPercent };
    })
    .filter(c => c.labour_amount + c.material_amount > 0);
  if (!claimRows.length) return null;

  const totalLabour = claimRows.reduce((s, c) => s + c.labour_amount, 0);
  const totalMaterial = claimRows.reduce((s, c) => s + c.material_amount, 0);

  const { data: drawnNumber, error: numErr } = await supabaseAdmin.rpc('get_next_number_serverside', { counter_name: 'invoice' });
  if (numErr) throw numErr;
  const { data: companySettings } = await supabaseAdmin.from('company_settings').select('invoice_number_prefix').eq('id', 1).single();
  const invoiceNumberStr = `${companySettings?.invoice_number_prefix || 'SI'}${drawnNumber}`;
  const invoiceToken = crypto.randomUUID();

  const { data: insertedInvoice, error: insErr } = await supabaseAdmin
    .from('invoices')
    .insert({
      project_id: job.id,
      cost_centre_id: null,
      client_id: null,
      description: 'Deposit',
      invoice_number: invoiceNumberStr,
      invoice_token: invoiceToken,
      labour_amount: totalLabour,
      material_amount: totalMaterial,
      stc_amount: 0,
      claim_percent: depositPercent,
    })
    .select('id')
    .single();
  if (insErr) throw insErr;

  const { error: claimsErr } = await supabaseAdmin
    .from('invoice_claims')
    .insert(claimRows.map(c => ({ ...c, invoice_id: insertedInvoice.id })));
  if (claimsErr) throw claimsErr;

  await Promise.all(claimRows.map(c => {
    const centre = centres.find(cc => cc.id === c.cost_centre_id);
    const before = Number(centre?.invoiced_amount) || 0;
    return supabaseAdmin.from('cost_centres').update({ invoiced_amount: before + c.labour_amount + c.material_amount }).eq('id', c.cost_centre_id);
  }));

  return invoiceToken;
}

async function createJobFromQuote(supabaseAdmin, { quoteId, approvedBy = null, approvalNote = null }) {
  // Idempotent: if a job has already been created from this quote (a
  // re-click, or the page reloading before a redirect landed), hand back
  // the existing one rather than creating a second.
  const { data: existingJob } = await supabaseAdmin
    .from('projects')
    .select('id, job_number')
    .eq('source_quote_id', quoteId)
    .maybeSingle();
  if (existingJob) {
    const { data: existingInvoice } = await supabaseAdmin
      .from('invoices')
      .select('invoice_token')
      .eq('project_id', existingJob.id)
      .eq('description', 'Deposit')
      .maybeSingle();
    return { jobId: existingJob.id, jobNumber: existingJob.job_number, invoiceToken: existingInvoice?.invoice_token || null };
  }

  const { data: quote, error: quoteErr } = await supabaseAdmin
    .from('projects')
    .select('*, cost_centres(*, cost_centre_line_items(*), cost_centre_photo_groups(*))')
    .eq('id', quoteId)
    .single();
  if (quoteErr || !quote) throw new Error('Quote not found');

  // pipeline_stage: 'archived' takes the frozen quote off the active Job
  // Pipeline board (dashboard.html) and out of any "active projects" view
  // that filters on pipeline_stage - it's a historical record now, not
  // something anyone needs to action. quotes.html doesn't filter on
  // pipeline_stage (only job_number/status), so this doesn't affect its
  // own Approved tab.
  await supabaseAdmin
    .from('projects')
    .update({
      status: 'approved', pipeline_stage: 'archived',
      approved_at: new Date().toISOString(), approved_by: approvedBy, approval_note: approvalNote,
    })
    .eq('id', quoteId);

  const { data: job, error: jobErr } = await supabaseAdmin
    .from('projects')
    .insert({
      name: quote.name,
      client_id: quote.client_id,
      client_name: quote.client_name,
      client_email: quote.client_email,
      client_phone: quote.client_phone,
      client_address: quote.client_address,
      sow_text: quote.sow_text,
      proposal_subtitle: quote.proposal_subtitle,
      terms_text: quote.terms_text,
      deposit_percent: quote.deposit_percent,
      pylon_link: quote.pylon_link,
      pylon_project_id: quote.pylon_project_id,
      pylon_data: quote.pylon_data,
      reference_photos: quote.reference_photos,
      cover_photos: quote.cover_photos,
      proposal_template: quote.proposal_template,
      estimate_disclaimer_text: quote.estimate_disclaimer_text,
      project_manager_contact_id: quote.project_manager_contact_id,
      site_contact_id: quote.site_contact_id,
      job_contact_id: quote.job_contact_id,
      sales_contact_id: quote.sales_contact_id,
      accounts_contact_id: quote.accounts_contact_id,
      source_quote_id: quote.id,
      pipeline_stage: 'job_booked',
      status: 'in_progress',
    })
    .select()
    .single();
  if (jobErr) throw jobErr;

  const stages = (quote.cost_centres || []).slice().sort((a, b) => a.sort_order - b.sort_order);
  const { data: newStages, error: stagesErr } = await supabaseAdmin
    .from('cost_centres')
    .insert(stages.map(s => ({
      project_id: job.id,
      name: s.name,
      description: s.description,
      sort_order: s.sort_order,
      markup_percent: s.markup_percent,
      estimated_labour_cost: s.estimated_labour_cost,
      estimated_material_cost: s.estimated_material_cost,
      quoted_amount: s.quoted_amount,
      stc_total: s.stc_total,
      stc_system_kw: s.stc_system_kw,
      stc_zone_rating: s.stc_zone_rating,
      stc_install_year: s.stc_install_year,
      stc_price_per_certificate: s.stc_price_per_certificate,
    })))
    .select();
  if (stagesErr) throw stagesErr;

  const allLineItems = [];
  const allPhotoGroups = [];
  stages.forEach((s, i) => {
    (s.cost_centre_line_items || []).forEach(li => {
      allLineItems.push({
        cost_centre_id: newStages[i].id,
        description: li.description,
        item_type: li.item_type,
        quantity: li.quantity,
        unit_cost: li.unit_cost,
        rate_tier_id: li.rate_tier_id,
        sort_order: li.sort_order,
      });
    });
    (s.cost_centre_photo_groups || []).forEach(pg => {
      allPhotoGroups.push({
        cost_centre_id: newStages[i].id,
        description: pg.description,
        photos: pg.photos,
        sort_order: pg.sort_order,
      });
    });
  });
  if (allLineItems.length) {
    const { error: liErr } = await supabaseAdmin.from('cost_centre_line_items').insert(allLineItems);
    if (liErr) throw liErr;
  }
  if (allPhotoGroups.length) {
    const { error: pgErr } = await supabaseAdmin.from('cost_centre_photo_groups').insert(allPhotoGroups);
    if (pgErr) throw pgErr;
  }

  const invoiceToken = await raiseDepositInvoice(supabaseAdmin, job, newStages);

  return { jobId: job.id, jobNumber: job.job_number, invoiceToken };
}

module.exports = { createJobFromQuote };
