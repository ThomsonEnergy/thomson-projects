// Finds (or creates) a Tracking Option under the company's configured
// Xero tracking category (Settings > Xero connection > Xero Tracking
// Category ID), by exact name. Shared by invoices (one option per job,
// "Job 7009") and timesheets (the same job options, plus a fixed
// "Office / General" one for non-job time) - using the identical option
// for both means a job's revenue and labour cost tag to the same Xero
// tracking value, so Xero's own reports can actually job-cost it.

const { xeroRequest } = require('./xero-client');

async function getOrCreateTrackingOptionId(supabaseAdmin, optionName) {
  if (!optionName) return null;
  const { data: settings } = await supabaseAdmin.from('company_settings').select('xero_tracking_category_id').eq('id', 1).single();
  const categoryId = settings?.xero_tracking_category_id;
  if (!categoryId) return null;

  try {
    const category = await xeroRequest('accounting', `TrackingCategories/${categoryId}`);
    const existing = (category.TrackingCategories?.[0]?.Options || []).find(o => o.Name === optionName);
    if (existing) return existing.TrackingOptionID;

    const createdOption = await xeroRequest('accounting', `TrackingCategories/${categoryId}/Options`, {
      method: 'POST',
      body: { Name: optionName },
    });
    return createdOption.Options?.[0]?.TrackingOptionID || null;
  } catch (err) {
    console.error(`Tracking option lookup/create failed for "${optionName}":`, err.message);
    return null;
  }
}

module.exports = { getOrCreateTrackingOptionId };
