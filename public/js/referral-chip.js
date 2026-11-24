// Quote step 3, a quote from a referred lead (item 74b): "Referred by ABC Homes: $200 credit to them if won".
// The amount follows the quote as it is priced (lead_reward_amount over quote_client_total, the same
// figures the reward is fixed with at approval), so the quoter can allow for it in the price. Nothing
// hidden goes on the quote (owner, 18 Nov 2026). A quote from a staff member's personal link (item
// 74b 7a) says so the same way: "From Nathan's link: $50 link bonus to Nathan if won", or why not.
// Loaded by project.html. Reads clients, leads, profiles, company_settings and two database
// functions; writes nothing.

async function initReferralChip(project) {
  const el = document.getElementById('referral-chip');
  if (!el || project.job_number) return;
  const esc = (s) => escapeHtml(s);
  const box = (html) => `<div style="padding:8px 12px; margin-bottom:10px; border:1px solid var(--amber); border-radius:8px; background:var(--amber-dim); font-size:14px;">${html}</div>`;
  if (!project.referrer_client_id) {
    if (!project.lead_id) return;
    try {
      const { data: lead } = await supabaseClient.from('leads').select('referrer_profile_id, already_client, already_reason').eq('id', project.lead_id).maybeSingle();
      if (!lead || !lead.referrer_profile_id) return;
      const [{ data: who }, { data: total }, { data: s }] = await Promise.all([
        supabaseClient.from('profiles').select('full_name').eq('id', lead.referrer_profile_id).maybeSingle(),
        supabaseClient.rpc('quote_client_total', { p_quote: project.id }),
        supabaseClient.from('company_settings').select('staff_link_amount, lead_reward_min_job').eq('id', 1).maybeSingle(),
      ]);
      const first = String((who && who.full_name) || 'A staff member').split(' ')[0];
      const whole = (n) => `$${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
      const min = Number((s && s.lead_reward_min_job) || 0);
      el.innerHTML = box(`<strong>From ${esc(first)}'s link</strong>:
        ${lead.already_client ? `no link bonus, already ours (${esc(lead.already_reason || 'matched someone we already had')}).`
          : Number(total || 0) >= min ? `<strong>${whole(s && s.staff_link_amount)} link bonus to ${esc(first)} if won</strong>. Allow for it in the price.`
          : `no link bonus at today's price of ${whole(total)} (under ${whole(min)}).`}`);
    } catch (err) { el.innerHTML = ''; console.error('staff link chip', err); }
    return;
  }
  try {
    const [{ data: client }, { data: lead }, { data: total }] = await Promise.all([
      supabaseClient.from('clients').select('name, lead_reward_kind').eq('id', project.referrer_client_id).maybeSingle(),
      project.lead_id ? supabaseClient.from('leads').select('referral_kind, already_client').eq('id', project.lead_id).maybeSingle() : Promise.resolve({ data: null }),
      supabaseClient.rpc('quote_client_total', { p_quote: project.id }),
    ]);
    if (!client) return;
    const kind = (lead && lead.referral_kind) || 'full';
    const { data: amount } = await supabaseClient.rpc('lead_reward_amount', { p_total: total || 0, p_referral_kind: kind });
    const off = client.lead_reward_kind === 'off' || (lead && lead.already_client);
    const money = (n) => `$${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
    el.innerHTML = box(`<strong>Referred by ${esc(client.name)}</strong> (${esc(kind)} referral):
      ${off ? 'no reward (their reward is off, or the person was already a client).' : Number(amount) > 0 ? `<strong>${money(amount)} credit to them if won</strong>, at today's price of ${money(total)} inc GST. Allow for it in the price.` : `nothing at today's price of ${money(total)} (under the minimum job).`}`);
  } catch (err) {
    el.innerHTML = '';
    console.error('referral chip', err);
  }
}
