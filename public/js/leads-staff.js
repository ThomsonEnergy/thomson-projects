// Leads page: who a lead came from, and the link bonuses (backlog item 74b, point 7a).
// A lead from a staff member's personal link is theirs ("from Nathan Smith"). The database marks it
// Already ours when the person is a customer, contacted us before, or says they heard of us some
// other way (staff_lead_check): no link bonus, the KPIs still count. An admin can clear a wrong match
// with a reason, and cancel a bonus that should not have been recorded.
// Who calls it: leads.html. Reads leads, staff_bonuses, profiles, projects; writes through the
// database functions lead_clear_already_ours() and staff_bonus_cancel() only.

// After the source on a lead: who sent it, quick or full for a client's referral, and the no-reward badge.
function leadFromHtml(lead) {
  const by = lead.details && lead.details.referred_by ? ` from ${escapeHtml(lead.details.referred_by)}` : '';
  const kind = lead.referral_kind ? ` (${escapeHtml(lead.referral_kind)})` : '';
  const badge = !lead.already_client ? '' : ` &middot; <span class="badge draft">${lead.referrer_profile_id ? 'Already ours: no bonus' : 'already a client, no reward'}</span>`;
  return by + kind + badge;
}

// In the lead's detail: how they heard of us, why it is Already ours, and Not already ours (admin).
async function wireLeadFrom(lead, overlay, onChange) {
  const el = overlay.querySelector('#ld-from');
  if (!el || !(lead.heard_from || lead.referrer_profile_id)) return;
  const me = await getMyProfile();
  let heard = lead.heard_from || '';
  if (lead.heard_from_profile_id) {
    const { data: who } = await supabaseClient.from('profiles').select('full_name').eq('id', lead.heard_from_profile_id).maybeSingle();
    heard = who && who.full_name ? `${who.full_name} told them about us` : heard;
  }
  const first = String((lead.details && lead.details.referred_by) || 'their').split(' ')[0];
  const cleared = !lead.already_client && /^cleared: /.test(lead.already_reason || '');
  el.innerHTML = `
    <div class="card" style="margin-top:14px;">
      ${heard ? `<p style="margin:0;"><strong>How they heard of us:</strong> ${escapeHtml(heard)}</p>` : ''}
      ${lead.already_client ? `<p style="margin:6px 0 0;"><strong>Already ours:</strong> ${escapeHtml(lead.already_reason || 'matched someone we already had')}. No link bonus; it still counts on ${escapeHtml(first)}'s KPIs.</p>
        ${me && me.role === 'admin' ? '<button type="button" class="secondary" id="ld-not-ours" style="font-size:12px; padding:6px 10px; margin-top:8px;">Not already ours</button><div id="ld-from-msg"></div>' : ''}`
      : lead.referrer_profile_id ? `<p class="subtitle" style="margin:6px 0 0;">${cleared ? `Match ${escapeHtml(lead.already_reason)}. ` : 'A new customer. '}${escapeHtml(first)} earns the link bonus if we win it.</p>` : ''}
    </div>`;
  const btn = el.querySelector('#ld-not-ours');
  if (btn) btn.addEventListener('click', async () => {
    const reason = prompt(`Why is this not already ours? (${first} then earns the link bonus if we win it)`);
    if (reason === null) return;
    btn.disabled = true;
    const { error } = await supabaseClient.rpc('lead_clear_already_ours', { p_lead: lead.id, p_reason: reason });
    if (error) { el.querySelector('#ld-from-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; btn.disabled = false; return; }
    lead.already_client = false;
    lead.already_reason = `cleared: ${reason}`;
    showToast('Cleared.');
    wireLeadFrom(lead, overlay, onChange);
    if (onChange) onChange();
  });
}

// The card of link bonuses: who, which job, how much, where it is up to, and Cancel (admin).
// Admin and Finance see every bonus (the table's own rule); the card stays hidden when there are none.
async function loadLinkBonuses() {
  const el = document.getElementById('link-bonuses');
  if (!el) return;
  const [{ data: rows }, me] = await Promise.all([
    supabaseClient.from('staff_bonuses').select('id, profile_id, project_id, amount, quote_total, status, earned_at, cancelled_reason').order('earned_at', { ascending: false }).limit(50),
    getMyProfile(),
  ]);
  if (!rows || !rows.length) { el.innerHTML = ''; return; }
  const ids = (list) => [...new Set(list.filter(Boolean))];
  const [{ data: people }, { data: jobs }] = await Promise.all([
    supabaseClient.from('profiles').select('id, full_name').in('id', ids(rows.map((r) => r.profile_id))),
    supabaseClient.from('projects').select('id, job_number, name').in('id', ids(rows.map((r) => r.project_id))),
  ]);
  const nameOf = (id) => ((people || []).find((p) => p.id === id) || {}).full_name || 'Someone';
  const jobOf = (id) => (jobs || []).find((j) => j.id === id);
  const word = (r) => ({
    earned: '<span class="badge draft">Won, waiting on the deposit</span>',
    due: '<span class="badge sent">Owed: add it to their pay</span>',
    paid: '<span class="badge accepted">Paid</span>',
    cancelled: `<span class="badge draft">Cancelled${r.cancelled_reason ? `: ${escapeHtml(r.cancelled_reason)}` : ''}</span>`,
  }[r.status] || '');
  const admin = me && me.role === 'admin';
  el.innerHTML = `
    <div class="card">
      <h2>Link bonuses</h2>
      <p class="subtitle" style="margin-bottom:8px;">Jobs won from a staff member's own link. Owed once the deposit is paid.</p>
      ${rows.map((r) => {
        const j = jobOf(r.project_id);
        return `<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:4px 0; border-bottom:1px solid var(--border); font-size:13px;">
          <span><strong>${escapeHtml(nameOf(r.profile_id))}</strong> ${money(r.amount)} for ${j ? `<a class="link-quiet" href="/project.html?id=${j.id}">J${escapeHtml(j.job_number)}</a> ${escapeHtml(j.name || '')}` : 'a job'} ${word(r)}</span>
          ${admin && ['earned', 'due'].includes(r.status) ? `<button type="button" class="secondary lb-cancel" data-id="${r.id}" style="font-size:12px; padding:4px 10px;">Cancel</button>` : ''}
        </div>`;
      }).join('')}
      <div id="lb-msg"></div>
    </div>`;
  el.querySelectorAll('.lb-cancel').forEach((b) => b.addEventListener('click', async () => {
    const reason = prompt('Why is it cancelled? (they are told)');
    if (reason === null) return;
    b.disabled = true;
    const { error } = await supabaseClient.rpc('staff_bonus_cancel', { p_id: b.dataset.id, p_reason: reason });
    if (error) { el.querySelector('#lb-msg').innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; b.disabled = false; return; }
    showToast('Cancelled.');
    loadLinkBonuses();
  }));
}
