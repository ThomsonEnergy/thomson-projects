// Settings > Rebates (settings.html, pricing roles; item 113). settings.html downloads this file and
// calls loadRebatesPanel() once.
//
// The rebates Thomson can offer beside STCs, kept as data so a scheme that changes is one edit
// here: the name the client sees, the state it applies in, the quote types it fits, and either a
// fixed amount or certificates times a price. A quote of a matching type and state lists the
// switched-on ones on its credits card, ticked (js/hot-water-card.js), and each ticked one prints
// on the proposal on its own line and comes off the client's price with the STC credit.
//
// Reads and writes the rebates table. Needs supabase-client.js (supabaseClient, escapeHtml,
// friendlyError, showToast, loadJsOnce); it downloads template-questions.js for the type names.

const REBATE_STATES = ['', 'NSW', 'QLD', 'WA', 'VIC', 'ACT', 'SA', 'TAS', 'NT'];

async function loadRebatesPanel() {
  const el = document.getElementById('rebates-list');
  if (!el) return;
  await loadJsOnce('/js/template-questions.js?v=10', () => typeof TEMPLATE_INFO === 'object').catch(() => {});
  const types = typeof TEMPLATE_INFO === 'object' ? Object.keys(TEMPLATE_INFO).map(key => ({ key, label: TEMPLATE_INFO[key].label })) : [];
  const { data, error } = await supabaseClient.from('rebates').select('*').order('sort_order').order('created_at');
  if (error) { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`; return; }
  const rows = data || [];

  el.innerHTML = (rows.length ? rows.map(r => `
    <div class="rebate-row" data-id="${r.id}" style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
      <div class="grid cols-4">
        <div style="grid-column: span 2;"><label style="margin-top:0; font-size:12px;">Name (ours)</label><input data-f="name" value="${escapeHtml(r.name)}" /></div>
        <div style="grid-column: span 2;"><label style="margin-top:0; font-size:12px;">What the client sees on the proposal</label><input data-f="client_label" value="${escapeHtml(r.client_label)}" /></div>
      </div>
      <div class="grid cols-4" style="margin-top:6px;">
        <div><label style="margin-top:0; font-size:12px;">State</label><select data-f="state">${REBATE_STATES.map(s => `<option value="${s}" ${(r.state || '') === s ? 'selected' : ''}>${s || 'Any state'}</option>`).join('')}</select></div>
        <div><label style="margin-top:0; font-size:12px;">Worked out as</label><select data-f="kind"><option value="certificates" ${r.kind === 'certificates' ? 'selected' : ''}>Certificates x price</option><option value="fixed" ${r.kind === 'fixed' ? 'selected' : ''}>A fixed amount</option></select></div>
        <div class="rb-cert" ${r.kind === 'certificates' ? '' : 'style="display:none;"'}><label style="margin-top:0; font-size:12px;">Certificates (usual count)</label><input data-f="certificates" type="number" step="1" min="0" value="${escapeHtml(r.certificates)}" /></div>
        <div class="rb-cert" ${r.kind === 'certificates' ? '' : 'style="display:none;"'}><label style="margin-top:0; font-size:12px;">$ per certificate</label><input data-f="certificate_price" type="number" step="0.01" min="0" value="${escapeHtml(r.certificate_price)}" /></div>
        <div class="rb-fixed" ${r.kind === 'fixed' ? '' : 'style="display:none;"'}><label style="margin-top:0; font-size:12px;">Amount ($, ex GST)</label><input data-f="amount" type="number" step="0.01" min="0" value="${escapeHtml(r.amount)}" /></div>
      </div>
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:4px 14px; margin-top:8px;">
        <span class="subtitle" style="font-size:12px;">Offered on:</span>
        ${types.map(t => `<label style="display:flex; align-items:center; gap:5px; margin:0; font-weight:400; font-size:13px;"><input type="checkbox" class="rb-type" value="${t.key}" ${(r.proposal_types || []).includes(t.key) ? 'checked' : ''} style="width:auto;" /> ${escapeHtml(t.label)}</label>`).join('')}
        <span style="flex:1;"></span>
        <label style="display:flex; align-items:center; gap:5px; margin:0; font-weight:400;"><input type="checkbox" data-f="active" ${r.active ? 'checked' : ''} style="width:auto;" /> Switched on</label>
        <button type="button" class="secondary rb-remove" style="font-size:12px; padding:6px 10px; width:auto;">Remove</button>
      </div>
      <div class="rb-msg"></div>
    </div>`).join('') : '<p class="subtitle">No rebates yet.</p>')
    + '<button type="button" class="secondary" id="rebate-add" style="width:auto;">+ Add a rebate</button>';

  el.querySelectorAll('.rebate-row').forEach(row => {
    const id = row.dataset.id;
    const save = async () => {
      const f = (name) => row.querySelector(`[data-f="${name}"]`);
      const n = (name) => parseFloat(f(name).value) || 0;
      const kind = f('kind').value;
      row.querySelectorAll('.rb-cert').forEach(x => { x.style.display = kind === 'certificates' ? '' : 'none'; });
      row.querySelectorAll('.rb-fixed').forEach(x => { x.style.display = kind === 'fixed' ? '' : 'none'; });
      const fields = {
        name: f('name').value.trim() || 'Rebate', client_label: f('client_label').value.trim() || f('name').value.trim() || 'Rebate',
        state: f('state').value || null, kind, certificates: n('certificates'), certificate_price: n('certificate_price'), amount: n('amount'),
        proposal_types: [...row.querySelectorAll('.rb-type:checked')].map(c => c.value), active: f('active').checked,
      };
      const { error: err } = await supabaseClient.from('rebates').update(fields).eq('id', id);
      row.querySelector('.rb-msg').innerHTML = err ? `<div class="error-box">Not saved. ${escapeHtml(friendlyError(err))}</div>` : '<span class="subtitle" style="font-size:12px;">Saved</span>';
    };
    row.querySelectorAll('input, select').forEach(inp => inp.addEventListener('change', save));
    row.querySelector('.rb-remove').addEventListener('click', async () => {
      if (!confirm('Remove this rebate? Quotes that already have it ticked keep their figure.')) return;
      const { error: err } = await supabaseClient.from('rebates').delete().eq('id', id);
      if (err) { showToast(friendlyError(err), { error: true }); return; }
      loadRebatesPanel();
    });
  });
  el.querySelector('#rebate-add').addEventListener('click', async () => {
    const { error: err } = await supabaseClient.from('rebates').insert({ name: 'New rebate', client_label: 'Rebate', kind: 'fixed', active: false, sort_order: rows.length + 1 });
    if (err) { showToast(friendlyError(err), { error: true }); return; }
    loadRebatesPanel();
  });
}
