// Shared by create-job-from-quote.js (when no deposit is required at
// all, so there's nothing for a payment webhook to advance later) and
// the payment webhooks (xero-webhook.js, airwallex-webhook.js, once a
// deposit invoice is marked paid) - both need to answer the same
// question: are there any job_tasks still marked
// required_before_scheduling and not completed? If so the job sits at
// 'awaiting_action'; if every mandatory task is already done it goes
// straight to 'ready_to_book'. Same condition schedule.html already
// enforces before allowing a job to be scheduled at all (see
// requiredTasksBlockingSchedule in supabase-client.js) - this just
// drives the pipeline stage off the identical rule instead of only
// blocking the Schedule click.
async function advanceToActionOrReady(supabaseAdmin, projectId) {
  const { data: outstanding } = await supabaseAdmin
    .from('job_tasks')
    .select('id')
    .eq('project_id', projectId)
    .eq('required_before_scheduling', true)
    .eq('completed', false);
  const stage = (outstanding || []).length ? 'awaiting_action' : 'ready_to_book';
  await supabaseAdmin.from('projects').update({ pipeline_stage: stage }).eq('id', projectId);
  return stage;
}

module.exports = { advanceToActionOrReady };
