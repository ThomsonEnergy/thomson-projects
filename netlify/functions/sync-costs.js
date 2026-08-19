const { createClient } = require('@supabase/supabase-js');
const { getJobCosts } = require('./_servicem8');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event) => {
  try {
    // Optional: sync just one project (?projectId=...), or everything if not given.
    const projectId = event.queryStringParameters && event.queryStringParameters.projectId;

    let query = supabase.from('cost_centres').select('*').not('servicem8_job_uuid', 'is', null);
    if (projectId) query = query.eq('project_id', projectId);
    const { data: costCentres, error } = await query;
    if (error) throw error;

    const updates = [];
    for (const cc of costCentres) {
      const { materialCost, labourCost, invoicedAmount, jobStatus } = await getJobCosts(
        cc.servicem8_job_uuid
      );

      await supabase
        .from('cost_centres')
        .update({
          material_cost: materialCost,
          labour_cost: labourCost,
          invoiced_amount: invoicedAmount,
          servicem8_job_status: jobStatus,
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', cc.id);

      updates.push({ id: cc.id, materialCost, labourCost, invoicedAmount, jobStatus });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, updated: updates.length, updates }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
