// Settings > Billable Rates > Charge rate levels (item 46, spec D1): the list of levels a client or a
// job can be charged at, each a percent of the Billable Rates. Standard 100% is always there and is
// the default; the owner adds Commercial 115%, Mates rates 85% and so on. Pricing roles only (the
// panel itself is pricing-only). Writes rate_cards. Loaded by settings.html, called from
// loadRateTiers() there as loadRateCards(); the add button is wired here.

async function loadRateCardsPanel() {
  const listEl = document.getElementById('rate-cards-list');
  if (!listEl) return;
  const { data, error } = await supabaseClient.from('rate_cards').select('*').order('sort_order').order('name');
  if (error) { listEl.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
  const cards = data || [];
  listEl.innerHTML = `
    <table>
      <thead><tr><th>Level</th><th class="num">% of Billable Rates</th><th>Example ($120/hr tier)</th><th>Default</th><th></th></tr></thead>
      <tbody>
        ${cards.map(c => `
          <tr>
            <td><input class="rc-name" data-id="${c.id}" value="${escapeHtml(c.name)}" /></td>
            <td class="num"><input class="rc-percent" data-id="${c.id}" type="number" step="1" min="1" max="500" value="${escapeHtml(c.percent)}" style="text-align:right; width:90px;" /></td>
            <td class="subtitle">${money(Math.round(120 * (Number(c.percent) || 100)) / 100)}/hr</td>
            <td><input type="radio" name="rc-default" class="rc-default" data-id="${c.id}" ${c.is_default ? 'checked' : ''} style="width:auto;" /></td>
            <td>${c.is_default ? '' : `<button type="button" class="secondary rc-delete" data-id="${c.id}" style="font-size:12px; padding:6px 10px;">Delete</button>`}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  listEl.querySelectorAll('.rc-name, .rc-percent').forEach(input => input.addEventListener('change', async () => {
    const id = input.dataset.id;
    const name = listEl.querySelector(`.rc-name[data-id="${id}"]`).value.trim();
    const percent = parseFloat(listEl.querySelector(`.rc-percent[data-id="${id}"]`).value);
    if (!name || !(percent > 0)) { alert('Give the level a name and a percent above 0.'); return; }
    const { error: e } = await supabaseClient.from('rate_cards').update({ name, percent }).eq('id', id);
    if (e) alert('Could not save: ' + e.message); else { showToast('Saved'); loadRateCardsPanel(); }
  }));
  listEl.querySelectorAll('.rc-default').forEach(radio => radio.addEventListener('change', async () => {
    // one default at a time (unique index): clear the old one first
    const { error: e1 } = await supabaseClient.from('rate_cards').update({ is_default: false }).eq('is_default', true);
    const { error: e2 } = e1 ? { error: e1 } : await supabaseClient.from('rate_cards').update({ is_default: true }).eq('id', radio.dataset.id);
    if (e2) alert('Could not save: ' + e2.message); else showToast('Default level saved. New clients and jobs take it.');
    loadRateCardsPanel();
  }));
  listEl.querySelectorAll('.rc-delete').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this level? Clients and jobs on it go back to the default level.')) return;
    const { error: e } = await supabaseClient.from('rate_cards').delete().eq('id', btn.dataset.id);
    if (e) { alert(e.message); return; }
    loadRateCardsPanel();
  }));
}

(function wireAddRateCard() {
  const btn = document.getElementById('add-rate-card-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const msg = document.getElementById('rate-cards-msg');
    const name = document.getElementById('new-rate-card-name').value.trim();
    const percent = parseFloat(document.getElementById('new-rate-card-percent').value);
    if (!name || !(percent > 0)) { msg.innerHTML = '<div class="error-box">Enter a name and a percent (100 = the Billable Rates as they are).</div>'; return; }
    const { data: last } = await supabaseClient.from('rate_cards').select('sort_order').order('sort_order', { ascending: false }).limit(1);
    const { error } = await supabaseClient.from('rate_cards').insert({ name, percent, sort_order: (last?.[0]?.sort_order || 0) + 1 });
    if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
    document.getElementById('new-rate-card-name').value = '';
    document.getElementById('new-rate-card-percent').value = '';
    msg.innerHTML = '';
    loadRateCardsPanel();
  });
})();
