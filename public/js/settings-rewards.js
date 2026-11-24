// Settings > Company Details > Lead rewards (backlog item 74b): what a client earns for a job they
// send us through their referral link. A full referral (the questions and photos) earns by the tier
// of the quote; a quick one (a name and a number) a flat amount; nothing on a job under the
// minimum. Which clients get rewards, and whether as a credit or a payment, is set per client on
// the Clients page. A reward is a credit off our work, taken off an invoice by itself (item 74b step 3b).
// Also the staff side (item 74b 7a): the link bonus a staff member earns for a new customer from
// their own link, how far back "Already ours" looks, and the choices on "How did you first hear
// about Thomson Energy?".
// Who calls it: settings.html, loadSettings(), as loadRewardsCard(settingsRow). Writes
// company_settings.lead_reward_tiers, lead_reward_quick_amount, lead_reward_min_job,
// staff_link_amount, already_ours_days and heard_from_options.

function loadRewardsCard(settings) {
  const card = document.getElementById('rewards-card');
  if (!card) return;
  const tiers = ((settings && settings.lead_reward_tiers) || []).slice().sort((a, b) => a.from - b.from);
  const row = (t) => `<div class="rw-tier" style="display:flex; gap:8px; align-items:center; margin:4px 0;"><span class="subtitle">Jobs from $</span><input type="number" class="rw-from" min="0" step="100" value="${Number(t.from)}" style="width:110px;" /><span class="subtitle">earn $</span><input type="number" class="rw-amount" min="0" step="5" value="${Number(t.amount)}" style="width:90px;" /><button type="button" class="secondary rw-x" style="font-size:12px; padding:4px 10px;">Remove</button></div>`;
  card.innerHTML = `
    <h2>Lead rewards</h2>
    <p class="subtitle" style="margin:0 0 8px;">What a client earns when we win a job they sent through their referral link. Turn rewards on per client on the Clients page. A reward is a credit off their next invoice with us, never a payout. The quote total counted is what the client pays, inc GST, after STC and BSTC credits.</p>
    <label>Full referral (questions and photos), by the quote total</label>
    <div id="rw-tiers">${tiers.map(row).join('')}</div>
    <button type="button" class="secondary" id="rw-add" style="font-size:12px; padding:6px 12px;">Add a tier</button>
    <div class="grid cols-2" style="margin-top:10px;">
      <div><label>Quick referral (a name and a number), flat $</label><input type="number" id="rw-quick" min="0" step="5" value="${Number(settings.lead_reward_quick_amount || 0)}" /></div>
      <div><label>Nothing on a job under $</label><input type="number" id="rw-min" min="0" step="100" value="${Number(settings.lead_reward_min_job || 0)}" /></div>
    </div>
    <h2 style="margin-top:16px;">Staff link bonus</h2>
    <p class="subtitle" style="margin:0 0 8px;">What a staff member earns when we win a job from a new customer who came through their own link (Home, My link). The same minimum job applies. Nothing when the customer was already ours: a client, someone who contacted us in the days below, or someone who says they heard of us another way. Changing an amount? Update the Lead Bonus Scheme under Onboarding Documents and press Publish new version, so everyone signs the new figure.</p>
    <div class="grid cols-2">
      <div><label>Link bonus, flat $</label><input type="number" id="rw-staff" min="0" step="5" value="${Number(settings.staff_link_amount || 0)}" /></div>
      <div><label>Already ours looks back (days)</label><input type="number" id="rw-days" min="1" step="1" value="${Number(settings.already_ours_days || 90)}" /></div>
    </div>
    <label>"How did you first hear about us?" choices, one per line (the staff member's own name and "Someone else at Thomson Energy" are always offered)</label>
    <textarea id="rw-heard" rows="6">${escapeHtml((settings.heard_from_options || []).join('\n'))}</textarea>
    <div style="margin-top:12px;"><button type="button" id="rw-save">Save lead rewards</button></div>
    <div id="rw-msg"></div>`;
  const wireRemove = () => card.querySelectorAll('.rw-x').forEach((b) => { b.onclick = () => b.closest('.rw-tier').remove(); });
  wireRemove();
  card.querySelector('#rw-add').addEventListener('click', () => { card.querySelector('#rw-tiers').insertAdjacentHTML('beforeend', row({ from: 0, amount: 0 })); wireRemove(); });
  card.querySelector('#rw-save').addEventListener('click', async (e) => {
    const msg = card.querySelector('#rw-msg');
    const list = [...card.querySelectorAll('.rw-tier')].map((r) => ({ from: Math.max(0, Number(r.querySelector('.rw-from').value) || 0), amount: Math.max(0, Number(r.querySelector('.rw-amount').value) || 0) })).sort((a, b) => a.from - b.from);
    if (new Set(list.map((t) => t.from)).size !== list.length) { msg.innerHTML = '<div class="error-box">Two tiers start at the same amount.</div>'; return; }
    e.target.disabled = true;
    const { error } = await supabaseClient.from('company_settings').update({
      lead_reward_tiers: list,
      lead_reward_quick_amount: Math.max(0, Number(card.querySelector('#rw-quick').value) || 0),
      lead_reward_min_job: Math.max(0, Number(card.querySelector('#rw-min').value) || 0),
      staff_link_amount: Math.max(0, Number(card.querySelector('#rw-staff').value) || 0),
      already_ours_days: Math.max(1, Math.round(Number(card.querySelector('#rw-days').value) || 90)),
      heard_from_options: [...new Set(card.querySelector('#rw-heard').value.split('\n').map((x) => x.trim().slice(0, 80)).filter(Boolean))],
    }).eq('id', 1);
    e.target.disabled = false;
    msg.innerHTML = error ? `<div class="error-box">${escapeHtml(friendlyError(error))}</div>` : '<div class="success-box">Saved.</div>';
  });
}
