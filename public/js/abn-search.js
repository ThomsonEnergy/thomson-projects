// The ABN register search on the Clients page (moved out of supabase-client.js, 24 Nov 2026, so
// every other page stops carrying it): wireAbnNameSearch is the search-as-you-type dropdown under a
// name box, searchAbnByName the lookup behind it. The search of every client at once runs on the
// server (item 110, client-cleanup-background.js). Reads through abn-lookup.js; writes nothing.
// Needs supabase-client.js (supabaseClient, escapeHtml).

// Proxies abn-lookup.js (which itself proxies abr.business.gov.au - needs
// an ABR GUID set under Settings > API Keys, free from
// abr.business.gov.au/Tools/WebServices). Returns [] rather than
// throwing on any failure (missing GUID, rate limit, bad name) - this is
// always a convenience lookup, never something that should block a save
// or crash a bulk run partway through.
async function searchAbnByName(name) {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch(`/.netlify/functions/abn-lookup?name=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    return (json.ok && json.results) || [];
  } catch (err) {
    return [];
  }
}

// Wires a business-name search-as-you-type dropdown onto a text input.
// Picking a result gives the ABR's own registered entity name and ABN,
// instead of typing a company name and hoping it's spelled/legally
// correct. Each result says whether the ABN is active, what kind of name matched, and for the first
// five who is behind it (the legal entity, company or sole trader, GST), since two businesses can
// share a business name. Cancelled ABNs come last, greyed.
function wireAbnNameSearch(inputEl, resultsEl, onSelect) {
  let searchTimeout = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = inputEl.value.trim();
    if (q.length < 3) { resultsEl.style.display = 'none'; return; }
    searchTimeout = setTimeout(async () => {
      const results = await searchAbnByName(q);
      if (!results.length) { resultsEl.style.display = 'none'; return; }
      try {
        resultsEl.innerHTML = results.map(r => `
          <div class="abn-search-result" data-name="${escapeHtml(r.name)}" data-abn="${escapeHtml(r.abn || '')}" style="padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);${r.status === 'Cancelled' ? ' opacity:0.55;' : ''}">
            <div style="font-weight:600;">${escapeHtml(r.name)}</div>
            <div style="color:var(--muted); font-size:12px;">${r.abn ? 'ABN ' + escapeHtml(r.abn) : 'No ABN on file'}${r.status ? ' &middot; ' + escapeHtml(r.status) : ''}${r.nameType ? ' &middot; ' + escapeHtml(r.nameType) : ''}${r.state || r.postcode ? ' &middot; ' + escapeHtml([r.state, r.postcode].filter(Boolean).join(' ')) : ''}</div>
            ${r.entityName ? `<div style="font-size:12px;">${escapeHtml(r.entityType || 'Entity')}: ${escapeHtml(r.entityName)} &middot; ${r.gstRegistered ? 'GST registered' : 'Not registered for GST'}${r.activeFrom ? ' &middot; since ' + escapeHtml(new Date(r.activeFrom).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })) : ''}</div>` : ''}
          </div>`).join('');
        resultsEl.querySelectorAll('.abn-search-result').forEach(row => {
          row.addEventListener('click', () => {
            onSelect({ name: row.dataset.name, abn: row.dataset.abn });
            resultsEl.style.display = 'none';
          });
        });
        resultsEl.style.display = 'block';
      } catch (err) {
        resultsEl.style.display = 'none';
      }
    }, 300);
  });
  document.addEventListener('click', (e) => {
    if (e.target !== inputEl && !resultsEl.contains(e.target)) resultsEl.style.display = 'none';
  });
}
