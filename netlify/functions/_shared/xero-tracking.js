// Finds (or creates) a Tracking Option under the company's configured
// Xero tracking category (Settings > Xero connection > Xero Tracking
// Category ID), by exact name. Used by push-timesheets-to-xero.js for its
// 3 fixed options - Billable (Jobs) / Non-billable (Office) / Training
// (TAFE) - deliberately NOT one option per job number, since Xero caps a
// Tracking Category at 100 options and this company's job numbering would
// blow through that; per-job cost/revenue detail already lives properly
// in Thomson Projects' own job costing.

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
