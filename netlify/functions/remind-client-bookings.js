// 7am Sydney, every day (netlify.toml runs it at 20:05 and 21:05 UTC; only the 7am one works):
// a phone notification to whoever made a booking that starts within 3 days while the client has
// not been told (schedule_assignments.client_informed_at is null). One per job per day. Bookings
// with no maker go to the ops managers. Staff bookings with no job (admin, training) are skipped.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent, managerIds } = require('./_shared/agent-log');
const E = require('./_shared/schedule-emails');

function sydneyHour() {
  return Number(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
}

exports.handler = async (event) => {
  const force = event && event.queryStringParameters && event.queryStringParameters.force === '1' && process.env.CONTEXT !== 'production';
  if (sydneyHour() !== 7 && !force) return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'not 7am in Sydney' }) };
  return runAgent('remind-client-bookings', async () => {
    const admin = getAdminClient();
    const today = E.sydneyToday();
    const until = E.addDays(today, 3);
    const { data: rows, error } = await admin.from('schedule_assignments')
      .select('id, project_id, assignment_date, start_time, end_time, created_by, projects(id, name, job_number, quote_number, client_name)')
      .not('project_id', 'is', null).in('block_type', ['job', 'site_visit']).is('client_informed_at', null)
      .gte('assignment_date', today).lte('assignment_date', until).order('assignment_date');
    if (error) throw error;
    const byProject = new Map();
    for (const r of rows || []) {
      if (!r.projects) continue;
      const g = byProject.get(r.project_id) || { project: r.projects, rows: [], makers: new Set() };
      g.rows.push(r);
      if (r.created_by) g.makers.add(r.created_by);
      byProject.set(r.project_id, g);
    }
    const managers = byProject.size ? await managerIds(admin) : [];
    const makerIds = [...new Set([...byProject.values()].flatMap((g) => [...g.makers]))];
    const { data: activeMakers } = makerIds.length ? await admin.from('profiles').select('id').in('id', makerIds).eq('active', true) : { data: [] };
    const active = new Set((activeMakers || []).map((p) => p.id));
    let sent = 0;
    const lines = [];
    for (const [projectId, g] of byProject) {
      const when = E.whenLines(g.rows).join('; ');
      const title = `Client not told yet: ${E.jobTitle(g.project)}`;
      const body = `Booked ${when}. Email the booking to ${g.project.client_name || 'the client'} from the job's Schedule tab, or mark it as told.`;
      const makers = [...g.makers].filter((id) => active.has(id)); // someone who has left reminds nobody: the managers hear instead
      const people = makers.length ? makers : managers;
      for (const uid of people) {
        await admin.rpc('create_notification', { p_user: uid, p_kind: 'booking_reminder', p_title: title, p_body: body, p_link: `/project.html?id=${projectId}&tab=schedule`, p_actor: null, p_dedupe: `book-remind:${projectId}:${today}` });
        sent += 1;
      }
      lines.push(`${E.jobTitle(g.project)}: ${when}`);
    }
    const summary = `${byProject.size} job(s) booked in the next 3 days with the client not told, ${sent} reminder(s) sent.`;
    console.log(`remind-client-bookings: ${summary}`);
    return { summary, details: lines.join('; ') || null, quiet: !byProject.size };
  });
};
