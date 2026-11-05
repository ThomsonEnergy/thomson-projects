// Settings > Billable Rates > Commercial agreements (items 46 and 48, spec D1a): the levels a client or
// a job can be charged at, each a percent off the Schedule of Rates (10 = 10% off, an efficiency
// agreement; -15 = 15% on top, a surcharge level). Standard (0% off) is always there and is the
// default. Under the list, the wording of the agreement letter the client is sent
// (company_settings.commercial_agreement_terms, printed by rates.html?agreement=...). Pricing roles
// only (the panel itself is pricing-only). Writes rate_cards and company_settings. Loaded by
// settings.html, called from loadRateTiers() there as loadRateCardsPanel(); the add button is wired here.

const rateCardOff = (percent) => Math.round((100 - (Number(percent) || 100)) * 10) / 10;
const rateCardPercentFromOff = (off) => Math.round((100 - off) * 10) / 10;

async function loadRateCardsPanel() {
  const listEl = document.getElementById('rate-cards-list');
  if (!listEl) return;
  const [{ data, error }, { data: settings }] = await Promise.all([
    supabaseClient.from('rate_cards').select('*').order('sort_order').order('name'),
    supabaseClient.from('company_settings').select('commercial_agreement_terms').eq('id', 1).maybeSingle(),
  ]);
  if (error) { listEl.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
  const cards = data || [];
  listEl.innerHTML = `
    <table>
      <thead><tr><th>Agreement</th><th class="num">% off the Schedule of Rates</th><th>Example ($120/hr tier)</th><th>Default</th><th></th></tr></thead>
      <tbody>
        ${cards.map(c => `
          <tr>
            <td><input class="rc-name" data-id="${c.id}" value="${escapeHtml(c.name)}" /></td>
            <td class="num"><input class="rc-off" data-id="${c.id}" type="number" step="0.5" min="-400" max="99" value="${escapeHtml(rateCardOff(c.percent))}" style="text-align:right; width:90px;" /></td>
            <td class="subtitle">${money(Math.round(120 * (Number(c.percent) || 100)) / 100)}/hr${rateCardOff(c.percent) > 0 ? ' after the agreement line' : ''}</td>
            <td><input type="radio" name="rc-default" class="rc-default" data-id="${c.id}" ${c.is_default ? 'checked' : ''} style="width:auto;" title="New clients start on this" /></td>
            <td>${c.is_default ? '' : `<button type="button" class="secondary rc-delete" data-id="${c.id}" style="font-size:12px; padding:6px 10px;">Delete</button>`}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="subtitle" style="font-size:12px; margin:6px 0 0;">A positive number is an efficiency agreement: do and charge invoices show the full Schedule of Rates, then one line taking that much off labour. A negative number is a surcharge level, folded into every rate. One agreement per builder when the number differs, named after them.</p>
    <h3 style="margin-top:18px;">Agreement letter</h3>
    <p class="subtitle" style="font-size:12px; margin:0 0 6px;">Sent from the Clients page as a PDF with the Schedule of Rates. [Client], [Percent] and [Date] are filled in. Each blank line starts a new paragraph.</p>
    <textarea id="rc-terms" style="min-height:260px; font-size:13px;">${escapeHtml(settings?.commercial_agreement_terms || '')}</textarea>
    <button type="button" id="rc-terms-save" class="secondary" style="margin-top:6px;">Save letter wording</button>`;
  listEl.querySelectorAll('.rc-name, .rc-off').forEach(input => input.addEventListener('change', async () => {
    const id = input.dataset.id;
    const name = listEl.querySelector(`.rc-name[data-id="${id}"]`).value.trim();
    const off = parseFloat(listEl.querySelector(`.rc-off[data-id="${id}"]`).value);
    const percent = rateCardPercentFromOff(off);
    if (!name || !(percent > 0)) { alert('Give the agreement a name and a percent off under 100 (0 = the Schedule of Rates as they are).'); return; }
    const { error: e } = await supabaseClient.from('rate_cards').update({ name, percent }).eq('id', id);
    if (e) alert('Could not save: ' + e.message); else { showToast('Saved'); loadRateCardsPanel(); }
  }));
  listEl.querySelectorAll('.rc-default').forEach(radio => radio.addEventListener('change', async () => {
    const { error: e } = await supabaseClient.rpc('rate_card_set_default', { p_id: radio.dataset.id });  // one step, one default
    if (e) alert('Could not save: ' + e.message); else showToast('Default saved. New clients start on it.');
    loadRateCardsPanel();
  }));
  listEl.querySelectorAll('.rc-delete').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this agreement? Clients and jobs on it go back to the default.')) return;
    const { error: e } = await supabaseClient.from('rate_cards').delete().eq('id', btn.dataset.id);
    if (e) { alert(e.message); return; }
    loadRateCardsPanel();
  }));
  listEl.querySelector('#rc-terms-save').addEventListener('click', async () => {
    const text = listEl.querySelector('#rc-terms').value.trim();
    if (!text) { alert('The letter needs some wording.'); return; }
    const { error: e } = await supabaseClient.from('company_settings').update({ commercial_agreement_terms: text }).eq('id', 1);
    if (e) alert('Could not save: ' + e.message); else showToast('Letter wording saved');
  });
}

(function wireAddRateCard() {
  const btn = document.getElementById('add-rate-card-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const msg = document.getElementById('rate-cards-msg');
    const name = document.getElementById('new-rate-card-name').value.trim();
    const off = parseFloat(document.getElementById('new-rate-card-percent').value);
    const percent = Number.isFinite(off) ? rateCardPercentFromOff(off) : NaN;
    if (!name || !(percent > 0)) { msg.innerHTML = '<div class="error-box">Enter a name and a percent off (10 = 10% off labour; -15 = 15% on top).</div>'; return; }
    const { data: last } = await supabaseClient.from('rate_cards').select('sort_order').order('sort_order', { ascending: false }).limit(1);
    const { error } = await supabaseClient.from('rate_cards').insert({ name, percent, sort_order: (last?.[0]?.sort_order || 0) + 1 });
    if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
    document.getElementById('new-rate-card-name').value = '';
    document.getElementById('new-rate-card-percent').value = '';
    msg.innerHTML = '';
    loadRateCardsPanel();
  });
})();
