// Scheduled function (see netlify.toml): just after midnight Sydney time.
// Quotes and fixed-price variations are valid until a date set when they are sent
// (migration 20261030000000). This run:
//   1. reminds whoever made one, 3 days before it runs out, to follow up (or extend it);
//   2. declines anything still sent past its date, as Expired, unless auto decline is
//      off in Settings or on that quote / variation. The creator is told.
// Sales, Admin and Finance can extend the date, even after it has expired.

const { getAdminClient } = require('./_shared/require-admin');
const { runAgent } = require('./_shared/agent-log');

const sydneyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }); // YYYY-MM-DD
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDate = (ymd) => new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

exports.handler = () => runAgent('sweep-quote-expiry', async () => {
  const supabaseAdmin = getAdminClient();
  const today = sydneyToday();
  const soon = addDays(today, 3);
  const { data: settings } = await supabaseAdmin.from('company_settings').select('auto_decline_expired').eq('id', 1).maybeSingle();
  const autoDecline = settings ? settings.auto_decline_expired !== false : true;
  const notify = (user, kind, title, body, link, dedupe) => user
    ? supabaseAdmin.rpc('create_notification', { p_user: user, p_kind: kind, p_title: title, p_body: body, p_link: link, p_actor: null, p_dedupe: dedupe })
    : Promise.resolve();

  // ----- 1. reminders -----
  const [{ data: soonQuotes }, { data: soonVars }] = await Promise.all([
    supabaseAdmin.from('projects').select('id, name, quote_number, created_by, valid_until, no_auto_decline')
      .is('job_number', null).eq('status', 'sent').eq('valid_until', soon),
    supabaseAdmin.from('job_variation_entries').select('id, project_id, variation_number, description, created_by, valid_until, no_auto_decline')
      .eq('variation_type', 'fixed').eq('approval_status', 'sent').eq('valid_until', soon),
  ]);
  const willDecline = (row) => autoDecline && !row.no_auto_decline;
  for (const q of soonQuotes || []) {
    const label = q.quote_number ? `Q${q.quote_number}` : q.name;
    await notify(q.created_by, 'quote', `Quote ${label} runs out in 3 days`,
      `Valid until ${longDate(q.valid_until)}. Follow up with the client${willDecline(q) ? ' or extend it, otherwise it is declined as expired' : ''}.`,
      `/project.html?id=${q.id}&extend=quote`, `quote-expiry-reminder-${q.id}-${q.valid_until}`);
  }
  for (const v of soonVars || []) {
    await notify(v.created_by, 'variation', `Variation ${v.variation_number || ''} runs out in 3 days`.replace('  ', ' '),
      `${v.description}: valid until ${longDate(v.valid_until)}. Follow up with the client${willDecline(v) ? ' or extend it, otherwise it is declined as expired' : ''}.`,
      `/project.html?id=${v.project_id}&extend=${v.id}`, `variation-expiry-reminder-${v.id}-${v.valid_until}`);
  }

  // ----- 2. expire -----
  const expired = [];
  if (autoDecline) {
    const now = new Date().toISOString();
    const { data: oldQuotes } = await supabaseAdmin.from('projects').select('id, name, quote_number, created_by, valid_until')
      .is('job_number', null).eq('status', 'sent').eq('no_auto_decline', false).lt('valid_until', today);
    for (const q of oldQuotes || []) {
      const reason = `Expired: not accepted by ${longDate(q.valid_until)}`;
      const { data: done } = await supabaseAdmin.from('projects').update({
        status: 'declined', pipeline_stage: 'archived', declined_at: now, declined_by: null, decline_reason: reason, expired: true,
      }).eq('id', q.id).eq('status', 'sent').select('id');
      if (!done || !done.length) continue;
      const label = q.quote_number ? `Q${q.quote_number}` : q.name;
      expired.push(label);
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: q.id, action: 'quote_expired', description: `Quote ${label} declined: ${reason}`, changed_by: null });
      await notify(q.created_by, 'quote', `Quote ${label} expired`, `${reason}. Extend it from the quote to reopen it.`, `/project.html?id=${q.id}&extend=quote`, `quote-expired-${q.id}-${q.valid_until}`);
    }
    const { data: oldVars } = await supabaseAdmin.from('job_variation_entries').select('id, project_id, variation_number, description, created_by, valid_until')
      .eq('variation_type', 'fixed').eq('approval_status', 'sent').eq('no_auto_decline', false).lt('valid_until', today);
    for (const v of oldVars || []) {
      const reason = `Expired: not accepted by ${longDate(v.valid_until)}`;
      const { data: done } = await supabaseAdmin.from('job_variation_entries').update({
        approval_status: 'declined', declined_at: now, declined_by: null, decline_reason: reason, expired: true,
      }).eq('id', v.id).eq('approval_status', 'sent').select('id');
      if (!done || !done.length) continue;
      const label = `Variation ${v.variation_number || ''}`.trim();
      expired.push(label);
      await supabaseAdmin.from('activity_log').insert({ entity_type: 'project', entity_id: v.project_id, action: 'variation_expired', description: `${label} declined: ${reason}`, changed_by: null });
      await notify(v.created_by, 'variation', `${label} expired`, `${v.description}. ${reason}. Extend it from the Variations tab to reopen it.`, `/project.html?id=${v.project_id}&extend=${v.id}`, `variation-expired-${v.id}-${v.valid_until}`);
    }
  }

  const reminders = (soonQuotes || []).length + (soonVars || []).length;
  console.log(`sweep-quote-expiry: ${reminders} reminder(s), ${expired.length} expired. ${expired.join(', ')}`);
  return {
    quiet: !expired.length && !reminders,
    summary: `${expired.length} quote${expired.length === 1 ? '' : 's'} / variation${expired.length === 1 ? '' : 's'} expired, ${reminders} reminder${reminders === 1 ? '' : 's'} sent${autoDecline ? '' : ' (auto decline is off)'}`,
    details: expired.join(', '),
    response: { statusCode: 200, body: JSON.stringify({ ok: true, expired, reminders }) },
  };
});
