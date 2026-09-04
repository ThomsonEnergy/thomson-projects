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
    // GET TrackingCategories/{id} (single-resource) 404s "resource cannot
    // be found" for this Custom Connection even for a category ID
    // confirmed to exist via the plain list endpoint - fetching the full
    // list and finding it by ID here sidesteps that entirely, reusing the
    // exact call lookup-xero-ids.js already relies on successfully.
    const all = await xeroRequest('accounting', 'TrackingCategories');
    const category = (all.TrackingCategories || []).find(c => c.TrackingCategoryID === categoryId);
    if (!category) {
      console.error(`Tracking category ${categoryId} not found in Xero's TrackingCategories list.`);
      return null;
    }
    const existing = (category.Options || []).find(o => o.Name === optionName);
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
