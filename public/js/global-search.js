// Search box in the top bar that looks across the whole database (jobs,
// quotes, clients, leads, suppliers, POs, invoices, stock, staff, vehicles,
// meetings, knowledge, customer equipment). Loaded once by renderMainNav() on any page with the
// top bar. Every query goes through the logged-in user's own Supabase
// session, so RLS still decides what each person can see - a table they
// can't read just comes back empty instead of breaking the rest.
//
// On a wide screen it's a text box; when the bar runs out of room
// (see fitTopbar() in supabase-client.js) it shrinks to an icon that opens
// the box across the full width of the bar.
(function () {
  if (window.__globalSearchLoaded) return;
  window.__globalSearchLoaded = true;

  const PER_GROUP = 5;

  // Strips characters that would break a PostgREST or() filter string
  const clean = (s) => s.replace(/[,()*%\\:"']/g, ' ').replace(/\s+/g, ' ').trim();
  const ilikeOr = (cols, q) => cols.map(c => `${c}.ilike.%${q}%`).join(',');
  const enc = encodeURIComponent;
  // Supabase returns { data: null, error } instead of throwing; throw so
  // runSearch can tell 'failed' from 'nothing found'.
  const must = ({ data, error }) => { if (error) throw error; return data || []; };

  // Each source is one table. run(q, num) returns rows already shaped as
  // { title, sub, href }. num is the bare number when the search looks like
  // a job/quote/PO number (e.g. "7004", "J7004", "Q1005"). pricingOnly
  // groups are left out for Staff, whose Leads and Clients pages are locked.
  const SOURCES = [
    {
      label: 'Jobs & quotes',
      run: async (q, num) => {
        const ors = [ilikeOr(['name', 'client_name', 'client_address'], q)];
        if (num) ors.push(`job_number.eq.${num}`, `quote_number.eq.${num}`, `sm8_job_number.eq.${num}`);
        const data = must(await supabaseClient.from('projects')
          .select('id, name, job_number, quote_number, client_name, client_address')
          .or(ors.join(',')).order('created_at', { ascending: false }).limit(PER_GROUP));
        return data.map(p => ({ title: projectRef(p), sub: [p.client_name, p.client_address].filter(Boolean).join(' · '), href: `/project.html?id=${p.id}` }));
      },
    },
    {
      label: 'Clients',
      pricingOnly: true,
      run: async (q) => {
        const data = must(await supabaseClient.from('clients')
          .select('id, name, email, phone, address')
          .or(ilikeOr(['name', 'email', 'phone', 'address'], q)).order('name').limit(PER_GROUP));
        return data.map(c => ({ title: c.name, sub: [c.phone, c.email, c.address].filter(Boolean).join(' · '), href: `/clients.html?id=${enc(c.id)}` }));
      },
    },
    {
      label: 'Leads',
      pricingOnly: true,
      run: async (q) => {
        const data = must(await supabaseClient.from('leads')
          .select('id, name, email, phone, address_formatted, suburb')
          .or(ilikeOr(['name', 'email', 'phone', 'address_formatted', 'suburb'], q))
          .order('created_at', { ascending: false }).limit(PER_GROUP));
        return data.map(l => ({ title: l.name || l.email || l.phone || 'Lead', sub: [l.phone, l.address_formatted || l.suburb].filter(Boolean).join(' · '), href: `/leads.html?id=${enc(l.id)}` }));
      },
    },
    {
      label: 'Suppliers',
      run: async (q) => {
        const data = must(await supabaseClient.from('suppliers')
          .select('id, name, contact_email, contact_phone')
          .or(ilikeOr(['name', 'contact_email'], q)).order('name').limit(PER_GROUP));
        return data.map(s => ({ title: s.name, sub: [s.contact_phone, s.contact_email].filter(Boolean).join(' · '), href: `/supplier-detail.html?id=${s.id}` }));
      },
    },
    {
      label: 'Purchase orders',
      run: async (q) => {
        const data = must(await supabaseClient.from('purchase_orders')
          .select('id, po_number, supplier_name, description')
          .or(ilikeOr(['po_number', 'supplier_name', 'description'], q))
          .order('created_at', { ascending: false }).limit(PER_GROUP));
        return data.map(po => ({ title: `${po.po_number || 'PO'} - ${po.supplier_name || ''}`, sub: po.description || '', href: `/purchase-orders.html?id=${enc(po.id)}` }));
      },
    },
    {
      label: 'Invoices',
      run: async (q) => {
        const data = must(await supabaseClient.from('invoices')
          .select('id, invoice_number, description, project_id, cost_centres(project_id), projects(name, job_number, quote_number)')
          .or(ilikeOr(['invoice_number', 'description'], q))
          .order('created_at', { ascending: false }).limit(PER_GROUP));
        return data.map(inv => {
          return { title: inv.invoice_number || 'Invoice', sub: inv.projects ? projectRef(inv.projects) : (inv.description || ''), href: `/invoices.html?id=${enc(inv.id)}` };
        });
      },
    },
    {
      label: 'Stock',
      run: async (q) => {
        const data = must(await supabaseClient.from('materials')
          .select('id, name, category, supplier')
          .or(ilikeOr(['name', 'category', 'supplier'], q)).order('name').limit(PER_GROUP));
        return data.map(m => ({ title: m.name, sub: [m.category, m.supplier].filter(Boolean).join(' · '), href: `/stock.html?q=${enc(m.name || '')}` }));
      },
    },
    {
      label: 'Staff',
      run: async (q) => {
        const data = must(await supabaseClient.from('profiles')
          .select('id, full_name').ilike('full_name', `%${q}%`).order('full_name').limit(PER_GROUP));
        return data.map(p => ({ title: p.full_name, sub: '', href: `/staff.html?id=${p.id}` }));
      },
    },
    {
      label: 'Vehicles',
      run: async (q) => {
        const data = must(await supabaseClient.from('fleet_vehicles')
          .select('id, rego, make, model').or(ilikeOr(['rego', 'make', 'model'], q)).limit(PER_GROUP));
        return data.map(v => ({ title: v.rego, sub: [v.make, v.model].filter(Boolean).join(' '), href: `/vehicle-stock.html?id=${v.id}` }));
      },
    },
    {
      label: 'Meetings',
      run: async (q) => {
        const data = must(await supabaseClient.from('meetings')
          .select('id, title, location').or(ilikeOr(['title', 'location'], q))
          .order('created_at', { ascending: false }).limit(PER_GROUP));
        return data.map(m => ({ title: m.title, sub: m.location || '', href: `/meetings.html?id=${m.id}` }));
      },
    },
    {
      label: 'Customer equipment',
      run: async (q) => {
        const data = must(await supabaseClient.from('customer_assets')
          .select('id, name, make, model, client_name, site_address, clients(name)')
          .or(ilikeOr(['name', 'make', 'model', 'serial_numbers', 'client_name', 'site_address'], q))
          .order('created_at', { ascending: false }).limit(PER_GROUP));
        return data.map(a => ({ title: [a.name, [a.make, a.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '), sub: [a.clients?.name || a.client_name, a.site_address].filter(Boolean).join(' · '), href: `/assets.html?id=${enc(a.id)}` }));
      },
    },
    {
      label: 'Knowledge',
      run: async (q) => {
        const data = must(await supabaseClient.from('knowledge_entries')
          .select('id, title, category').or(ilikeOr(['title', 'category'], q)).order('title').limit(PER_GROUP));
        return data.map(k => ({ title: k.title, sub: k.category || '', href: `/knowledge.html?q=${enc(k.title || '')}` }));
      },
    },
  ];

  const topbar = document.querySelector('.topbar');
  const right = topbar && topbar.querySelector('.topbar-right');
  if (!right) return;

  const box = document.createElement('div');
  box.className = 'gsearch';
  box.innerHTML = `
    <input type="search" id="gsearch-input" placeholder="Search everything..." autocomplete="off" aria-label="Search everything" />
    <button type="button" class="gsearch-close" id="gsearch-close" title="Close search">&times;</button>
    <button type="button" class="topbar-icon-link gsearch-icon" id="gsearch-icon" title="Search everything (Ctrl+K)">&#128269;</button>`;
  right.insertBefore(box, right.firstChild);

  const panel = document.createElement('div');
  panel.className = 'gsearch-panel';
  panel.id = 'gsearch-panel';
  topbar.appendChild(panel);

  const input = box.querySelector('#gsearch-input');
  let seq = 0, timer = null, activeIndex = -1;

  const openOverlay = () => { topbar.classList.add('gsearch-open'); input.focus(); if (input.value.trim()) showPanel(); };
  const closeAll = () => { topbar.classList.remove('gsearch-open'); panel.classList.remove('open'); activeIndex = -1; };
  const showPanel = () => panel.classList.add('open');
  const resultLinks = () => Array.from(panel.querySelectorAll('a.gsearch-result'));

  function setActive(i) {
    const links = resultLinks();
    if (!links.length) return;
    activeIndex = (i + links.length) % links.length;
    links.forEach((a, n) => a.classList.toggle('active', n === activeIndex));
    links[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  async function runSearch(raw) {
    const q = clean(raw);
    const mySeq = ++seq;
    if (q.length < 2) { panel.innerHTML = ''; panel.classList.remove('open'); return; }
    const numMatch = q.match(/^[jqJQ]?(\d+)$/);
    const num = numMatch ? numMatch[1] : null;
    panel.innerHTML = '<div class="gsearch-empty">Searching...</div>';
    showPanel();
    let pricing = false;
    try { pricing = isPricingRole(await getMyRole()); } catch (e) { /* treat as Staff */ }
    if (mySeq !== seq) return;
    const groups = await Promise.all(SOURCES.filter(s => pricing || !s.pricingOnly).map(s =>
      s.run(q, num).then(rows => ({ label: s.label, rows }), () => ({ label: s.label, rows: [], failed: true }))));
    if (mySeq !== seq) return; // a newer search has started since
    const filled = groups.filter(g => g.rows.length);
    activeIndex = -1;
    if (!filled.length && groups.every(g => g.failed)) {
      panel.innerHTML = '<div class="gsearch-empty">Search failed, check your signal.</div>';
      return;
    }
    panel.innerHTML = filled.length
      ? filled.map(g => `<div class="gsearch-group">${escapeHtml(g.label)}</div>` + g.rows.map(r =>
          `<a class="gsearch-result" href="${r.href}"><div class="gsearch-title">${escapeHtml(r.title || '')}</div>${r.sub ? `<div class="gsearch-sub">${escapeHtml(r.sub)}</div>` : ''}</a>`).join('')).join('')
      : `<div class="gsearch-empty">Nothing found for "${escapeHtml(q)}"</div>`;
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 250);
  });
  input.addEventListener('focus', () => { if (input.value.trim() && panel.innerHTML) showPanel(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(activeIndex + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(activeIndex - 1); }
    else if (e.key === 'Enter') {
      const links = resultLinks();
      const target = links[activeIndex] || links[0];
      if (target) window.location.href = target.href;
    } else if (e.key === 'Escape') { closeAll(); input.blur(); }
  });
  box.querySelector('#gsearch-icon').addEventListener('click', openOverlay);
  box.querySelector('#gsearch-close').addEventListener('click', closeAll);
  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && !panel.contains(e.target)) closeAll();
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (topbar.classList.contains('search-compact')) openOverlay(); else input.focus();
    }
  });

  // Results for clients, stock, POs and so on link to that page with ?q=,
  // which fills in the page's own search box. Those pages filter on the
  // input event once their data has loaded, so it's re-fired a couple of
  // times rather than each page needing to know about this.
  const PAGE_SEARCH_INPUTS = {
    '/clients.html': 'client-search', '/stock.html': 'stock-search', '/purchase-orders.html': 'po-search',
    '/knowledge.html': 'kb-search', '/projects.html': 'project-search', '/meetings.html': 'mt-search',
    '/assets.html': 'asset-search', '/suppliers.html': 'supplier-search', '/invoices.html': 'invoice-search',
  };
  const prefill = new URLSearchParams(window.location.search).get('q');
  const pageInput = prefill && document.getElementById(PAGE_SEARCH_INPUTS[window.location.pathname]);
  if (pageInput) {
    let touched = false;
    pageInput.addEventListener('keydown', () => { touched = true; }, { once: true });
    pageInput.value = prefill;
    [0, 800, 2000].forEach(ms => setTimeout(() => {
      if (!touched) pageInput.dispatchEvent(new Event('input', { bubbles: true }));
    }, ms));
  }

  if (window.__fitTopbar) window.__fitTopbar();
})();
