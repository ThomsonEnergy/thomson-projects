const { createClient } = require('@supabase/supabase-js');
const { findOrCreateCompany, createJob } = require('./_servicem8');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // server-side only, never expose this key to the browser
);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { projectId } = JSON.parse(event.body);
    if (!projectId) return { statusCode: 400, body: 'projectId is required' };

    const { data: project, error: projectErr } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();
    if (projectErr) throw projectErr;

    const { data: costCentres, error: ccErr } = await supabase
      .from('cost_centres')
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order');
    if (ccErr) throw ccErr;

    const companyUuid = await findOrCreateCompany({
      name: project.client_name,
      email: project.client_email,
      address: project.client_address,
    });

    const results = [];
    for (const cc of costCentres) {
      if (cc.servicem8_job_uuid) {
        results.push({ costCentreId: cc.id, skipped: true });
        continue;
      }
      const jobUuid = await createJob({
        projectName: project.name,
        costCentreName: cc.name,
        description: cc.description,
        companyUuid,
        quotedAmount: cc.quoted_amount,
      });

      await supabase
        .from('cost_centres')
        .update({ servicem8_job_uuid: jobUuid, servicem8_job_status: 'created' })
        .eq('id', cc.id);

      results.push({ costCentreId: cc.id, jobUuid });
    }

    await supabase.from('projects').update({ status: 'in_progress' }).eq('id', projectId);

    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
