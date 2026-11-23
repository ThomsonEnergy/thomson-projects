// The disconnect and reconnect price list, on the Prebuilds page (backlog item 109). Every prebuild
// in the "Disconnect and reconnect" category is a row: tick Shown to put it on the price list, the
// booking and the crew's sheet, and give it a fixed price each (ex GST), an optional minimum
// quantity charged, the share of the price that is the disconnect visit (the rest is the
// reconnect, for the job's two cost centres), and whether it starts from one of the roofer's booking
// answers. Each change saves itself. Jobs already counted keep the price they were counted at.
// Reads prebuilds; writes service_price_items (pricing roles, RLS). The link comes from service-job.js.
// Needs supabase-client.js (supabaseClient, escapeHtml, showToast, friendlyError).
//
// mountServicePrices(el) -> { refresh }   call refresh() after a prebuild is added or changed

const SERVICE_PRICE_CATEGORY = 'Disconnect and reconnect';

function mountServicePrices(el) {
  let rows = [];

  async function refresh() {
    const [{ data: prebuilds, error }, { data: prices, error: priceErr }] = await Promise.all([
      supabaseClient.from('prebuilds').select('id, name, subcategory').eq('category', SERVICE_PRICE_CATEGORY).order('subcategory').order('name'),
      supabaseClient.from('service_price_items').select('*'),
    ]);
    if (error || priceErr) { el.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error || priceErr))}</div>`; return; }
    const byId = new Map((prices || []).map((p) => [p.prebuild_id, p]));
    rows = (prebuilds || []).map((pb, i) => ({
      prebuild_id: pb.id, name: pb.name, group: pb.subcategory || '',
      shown: false, unit_price: 0, unit_label: 'each', min_quantity: null, disconnect_share: 0, fills_from: null, sort_order: i + 1,
      ...(byId.get(pb.id) || {}),
    })).sort((a, b) => a.sort_order - b.sort_order);
    render();
  }

  function render() {
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <h2 style="margin:0;">Disconnect and reconnect price list</h2>
        <button type="button" class="secondary" id="sp-link" style="font-size:13px;">Copy the price list link</button>
      </div>
      <p class="subtitle" style="margin:4px 0 8px;">Prebuilds in the "${SERVICE_PRICE_CATEGORY}" category. Tick Shown to put one on the price list, the booking and the crew's sheet. Prices are each, before GST.</p>
      ${rows.length ? `
      <div style="overflow-x:auto;"><table style="font-size:13px;">
        <thead><tr><th>Shown</th><th>Prebuild</th><th class="num">Price each</th><th>Per</th><th class="num" title="Charged at least this many">Minimum</th><th class="num" title="Share of the price that is the disconnect visit; the rest is the reconnect">Disconnect %</th><th title="Starts at one of the roofer's booking answers">Starts from</th></tr></thead>
        <tbody>${rows.map((r, i) => `
          <tr data-i="${i}">
            <td><input type="checkbox" data-k="shown" ${r.shown ? 'checked' : ''} style="width:auto;" /></td>
            <td>${escapeHtml(r.name)}${r.group ? ` <span class="subtitle">${escapeHtml(r.group)}</span>` : ''}</td>
            <td class="num"><input type="number" min="0" step="0.01" data-k="unit_price" value="${Number(r.unit_price) || 0}" style="width:84px; padding:4px 6px;" /></td>
            <td><input data-k="unit_label" value="${escapeHtml(r.unit_label || 'each')}" maxlength="20" style="width:70px; padding:4px 6px;" /></td>
            <td class="num"><input type="number" min="0" step="1" data-k="min_quantity" value="${r.min_quantity == null ? '' : Number(r.min_quantity)}" style="width:64px; padding:4px 6px;" /></td>
            <td class="num"><input type="number" min="0" max="100" step="1" data-k="disconnect_share" value="${Number(r.disconnect_share) || 0}" style="width:64px; padding:4px 6px;" /></td>
            <td><select data-k="fills_from" style="padding:4px 6px;"><option value="">Nothing</option><option value="panel_count" ${r.fills_from === 'panel_count' ? 'selected' : ''}>Panel count</option><option value="roof_change" ${r.fills_from === 'roof_change' ? 'selected' : ''}>Roof type change</option></select></td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<p class="subtitle">No prebuilds in this category yet. Add one in the editor with the category "${SERVICE_PRICE_CATEGORY}".</p>`}`;

    el.querySelector('#sp-link').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        const res = await fetch('/.netlify/functions/service-job', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ action: 'price-list-link' }) });
        const out = await res.json();
        if (!res.ok || !out.ok) throw new Error(out.error || 'Could not get the link');
        await navigator.clipboard.writeText(out.url);
        showToast('Price list link copied. Paste it into an email.');
      } catch (err) { showToast(friendlyError(err), { error: true }); }
      e.target.disabled = false;
    });

    el.querySelectorAll('tr[data-i] [data-k]').forEach((input) => input.addEventListener('change', async () => {
      const r = rows[Number(input.closest('tr').dataset.i)];
      const k = input.dataset.k;
      const num = (v, max) => Math.min(max, Math.max(0, parseFloat(v) || 0));
      if (k === 'shown') r.shown = input.checked;
      else if (k === 'unit_price') r.unit_price = num(input.value, 1000000);
      else if (k === 'unit_label') r.unit_label = input.value.trim() || 'each';
      else if (k === 'min_quantity') r.min_quantity = input.value === '' || num(input.value, 100000) === 0 ? null : num(input.value, 100000);
      else if (k === 'disconnect_share') r.disconnect_share = num(input.value, 100);
      else if (k === 'fills_from') r.fills_from = input.value || null;
      const { data: { user } } = await supabaseClient.auth.getUser();
      const { error } = await supabaseClient.from('service_price_items').upsert({
        prebuild_id: r.prebuild_id, shown: r.shown, unit_price: r.unit_price, unit_label: r.unit_label, min_quantity: r.min_quantity,
        disconnect_share: r.disconnect_share, fills_from: r.fills_from, sort_order: r.sort_order, updated_at: new Date().toISOString(), updated_by: user ? user.id : null,
      }, { onConflict: 'prebuild_id' });
      if (error) { showToast(friendlyError(error), { error: true }); return; }
      showToast(`${r.name}: saved`);
    }));
  }

  refresh();
  return { refresh };
}
