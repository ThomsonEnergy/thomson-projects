// Quote step 3, a quote from a referred lead (item 74b): "Referred by ABC Homes: $200 credit if won".
// The amount follows the quote as it is priced (lead_reward_amount over quote_client_total, the same
// figures the reward is fixed with at approval), so the quoter can allow for it in the price. Nothing
// hidden goes on the quote (owner, 18 Nov 2026). Loaded by project.html. Reads clients, leads and two
// database functions; writes nothing.

async function initReferralChip(project) {
  const el = document.getElementById('referral-chip');
  if (!el || !project.referrer_client_id || project.job_number) return;
  const esc = (s) => escapeHtml(s);
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
    const how = client.lead_reward_kind === 'credit' ? 'credit' : 'payment';
    const money = (n) => `$${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
    el.innerHTML = `<div style="padding:8px 12px; margin-bottom:10px; border:1px solid var(--amber); border-radius:8px; background:var(--amber-dim); font-size:14px;">
      <strong>Referred by ${esc(client.name)}</strong> (${esc(kind)} referral):
      ${off ? 'no reward (their reward is off, or the person was already a client).' : Number(amount) > 0 ? `<strong>${money(amount)} ${how} if won</strong>, at today's price of ${money(total)} inc GST. Allow for it in the price.` : `nothing at today's price of ${money(total)} (under the minimum job).`}
    </div>`;
  } catch (err) {
    el.innerHTML = '';
    console.error('referral chip', err);
  }
}
