// Home > My link (backlog item 74b, point 7a): a staff member's personal link to send to people they
// bring in. The form it opens (refer.html?s=<token>) makes a lead that is theirs. The card shows the
// link with Copy and Send, what has come of it (leads, quoted, won) and any link bonus.
// Who calls it: home.html (the card with id my-link-card); it starts itself once the person is known.
// Reads my_staff_link(), staff_lead_stats(), staff_bonuses (their own rows), company_settings and
// projects; writes nothing (my_staff_link() makes their link the first time).

async function loadMyLink() {
  const el = document.getElementById('my-link-card');
  if (!el) return;
  const me = await getMyProfile();
  if (!me) return;
  const { data: token, error } = await supabaseClient.rpc('my_staff_link');
  if (error || !token) return;
  const url = `${location.origin}/refer.html?s=${token}`;
  const [{ data: stats }, { data: bonuses }, { data: settings }] = await Promise.all([
    supabaseClient.rpc('staff_lead_stats', { p_profile: me.id }),
    supabaseClient.from('staff_bonuses').select('id, project_id, amount, status').eq('profile_id', me.id).neq('status', 'cancelled').order('earned_at', { ascending: false }).limit(10),
    supabaseClient.from('company_settings').select('staff_link_amount, lead_reward_min_job').eq('id', 1).maybeSingle(),
  ]);
  const s = (stats && stats[0]) || { sent: 0, quoted: 0, won: 0 };
  const jobIds = [...new Set((bonuses || []).map((b) => b.project_id).filter(Boolean))];
  const { data: jobs } = jobIds.length ? await supabaseClient.from('projects').select('id, job_number').in('id', jobIds) : { data: [] };
  const jobNo = (id) => { const j = (jobs || []).find((x) => x.id === id); return j ? `J${j.job_number}` : 'a job'; };
  const whole = (n) => `$${Number(n || 0).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
  const word = { earned: 'waiting on the deposit', due: 'owed, goes in your pay', paid: 'paid' };
  const terms = settings && Number(settings.staff_link_amount) > 0
    ? `${whole(settings.staff_link_amount)} when we win a job of ${whole(settings.lead_reward_min_job)} or more from a new customer you bring in.`
    : 'For new customers you bring in.';
  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <h2 style="margin:0;">My link</h2>
      <div style="display:flex; gap:8px;">
        <button type="button" class="secondary" id="ml-copy" style="font-size:12px; padding:6px 12px;">Copy</button>
        <button type="button" id="ml-send" style="font-size:12px; padding:6px 12px;">Send</button>
      </div>
    </div>
    <p class="subtitle" style="margin:6px 0 0; font-size:13px;">${escapeHtml(terms)}</p>
    <p style="margin:6px 0 0; font-size:13px;">From your link: <strong>${Number(s.sent)}</strong> ${Number(s.sent) === 1 ? 'lead' : 'leads'}, <strong>${Number(s.quoted)}</strong> quoted, <strong>${Number(s.won)}</strong> won.</p>
    ${(bonuses || []).map((b) => `<p style="margin:4px 0 0; font-size:13px;">Link bonus ${whole(b.amount)} for ${escapeHtml(jobNo(b.project_id))}: ${escapeHtml(word[b.status] || b.status)}.</p>`).join('')}
    <input id="ml-url" readonly value="${escapeHtml(url)}" style="display:none; margin-top:8px; font-size:12px;" />`;
  el.style.display = '';
  // if the phone will not copy or share by itself, the link is shown to copy by hand
  const showUrl = () => { const box = el.querySelector('#ml-url'); box.style.display = ''; box.focus(); box.select(); };
  el.querySelector('#ml-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(url); showToast('Link copied.'); } catch { showUrl(); }
  });
  el.querySelector('#ml-send').addEventListener('click', async () => {
    const text = 'Get a quote from Thomson Energy:';
    if (navigator.share) { try { await navigator.share({ text, url }); } catch { /* closed without sending */ } return; }
    window.location.href = `sms:?&body=${encodeURIComponent(`${text} ${url}`)}`;
  });
}

document.addEventListener('DOMContentLoaded', () => { loadMyLink().catch((err) => console.error('my link', err)); });
