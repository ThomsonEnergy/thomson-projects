// The client portal page (backlog item 74): login by email code, then the lists (needs you,
// jobs, quotes), one job (?job=<id>) and the work so far on a do and charge job. Everything
// comes from portal-login.js and portal-read.js with the device's token (kept in localStorage
// for 30 days); the page holds no Supabase client and no staff code. Every string from the
// server goes through esc() before it lands in HTML.

(function () {
  const TOKEN_KEY = 'te_portal_token';
  const main = document.getElementById('pl-main');
  const who = document.getElementById('pl-who');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
  const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* private window */ } };
  const params = new URLSearchParams(location.search);

  async function call(fn, body) {
    const res = await fetch(`/.netlify/functions/${fn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token() ? { Authorization: `Bearer ${token()}` } : {}) },
      body: JSON.stringify(body || {}),
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 401) { setToken(''); showLogin(); throw new Error('login'); }
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ----- login -----
  function showLogin(message) {
    who.innerHTML = '';
    main.innerHTML = `
      <div class="pl-login">
        <h1 style="font-size:22px; margin:0 0 6px;">Your jobs</h1>
        <p class="subtitle">See your quotes, jobs and bookings. Type the email we have for you and we will send a code.</p>
        ${message ? `<div class="success-box">${esc(message)}</div>` : ''}
        <form id="pl-email-form" style="margin-top:14px;">
          <label>Email</label>
          <input type="email" id="pl-email" autocomplete="email" autocapitalize="off" required placeholder="you@example.com" />
          <button type="submit" id="pl-send">Send me a code</button>
        </form>
        <div id="pl-msg" style="margin-top:10px;"></div>
      </div>`;
    document.getElementById('pl-email-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('pl-email').value.trim();
      const btn = document.getElementById('pl-send');
      const msg = document.getElementById('pl-msg');
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        const r = await call('portal-login', { action: 'send', email });
        if (r.staff) { msg.innerHTML = `<div class="error-box">${esc(r.message)}</div>`; btn.disabled = false; btn.textContent = 'Send me a code'; return; }
        showCode(email, r.message);
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Send me a code';
      }
    });
  }

  function showCode(email, message) {
    main.innerHTML = `
      <div class="pl-login">
        <h1 style="font-size:22px; margin:0 0 6px;">Check your email</h1>
        <p class="subtitle">${esc(message || '')} It works for 10 minutes.</p>
        <form id="pl-code-form" class="pl-code" style="margin-top:14px;">
          <label>6 digit code</label>
          <input type="text" id="pl-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required />
          <button type="submit" id="pl-verify">Log in</button>
        </form>
        <p class="pl-muted" style="margin-top:14px;"><a href="#" id="pl-again">Use a different email</a></p>
        <div id="pl-msg" style="margin-top:10px;"></div>
      </div>`;
    document.getElementById('pl-code').focus();
    document.getElementById('pl-again').addEventListener('click', (e) => { e.preventDefault(); showLogin(); });
    document.getElementById('pl-code-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('pl-verify');
      const msg = document.getElementById('pl-msg');
      btn.disabled = true; btn.textContent = 'Checking...';
      try {
        const r = await call('portal-login', { action: 'verify', email, code: document.getElementById('pl-code').value, device: navigator.userAgent.slice(0, 200) });
        setToken(r.token);
        route();
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Log in';
      }
    });
  }

  async function logout(everywhere) {
    try { await call('portal-login', { action: everywhere ? 'logout_all' : 'logout' }); } catch { /* already out */ }
    setToken('');
    history.replaceState(null, '', '/portal.html');
    showLogin('You are logged out.');
  }

  function header(email) {
    who.innerHTML = `${esc(email)}<br><button type="button" class="secondary" id="pl-out">Log out</button><button type="button" class="secondary" id="pl-out-all" title="Log out on every device">Everywhere</button>`;
    document.getElementById('pl-out').addEventListener('click', () => logout(false));
    document.getElementById('pl-out-all').addEventListener('click', () => { if (confirm('Log out on every device you have used?')) logout(true); });
  }

  // ----- the lists -----
  const statusCls = (s) => /on site now/i.test(s) ? 'live' : /waiting on you|overdue|deposit to pay/i.test(s) ? 'warn' : '';
  const rowHtml = (r) => `
    <a class="pl-row ${r.open ? '' : 'done'}" href="/portal.html?job=${esc(r.id)}">
      <div class="ref">${esc(r.ref)}</div>
      <div class="name">${esc(r.name)}</div>
      ${r.site ? `<div class="site">${esc(r.site)}</div>` : ''}
      <div class="status"><span class="pl-status ${statusCls(r.status)}">${esc(r.status)}</span></div>
    </a>`;
  const listHtml = (rows, { empty, showDone }) => {
    const open = rows.filter((r) => r.open);
    const done = rows.filter((r) => !r.open);
    return `
      ${open.length ? open.map(rowHtml).join('') : `<p class="pl-muted">${esc(empty)}</p>`}
      ${done.length ? `<details ${showDone ? 'open' : ''}><summary class="pl-muted" style="cursor:pointer; margin:8px 0;">Show finished (${done.length})</summary>${done.map(rowHtml).join('')}</details>` : ''}`;
  };

  async function showOverview() {
    main.innerHTML = `<p class="subtitle">Loading your jobs...</p>`;
    const d = await call('portal-read', { action: 'overview' });
    header(d.email);
    const names = d.clients.map((c) => c.name);
    main.innerHTML = `
      ${names.length ? `<p class="pl-muted" style="margin:4px 0 0;">${esc(names.join(', '))}</p>` : ''}
      ${d.needsYou.length ? `
        <h2 class="pl-h">Needs you</h2>
        <div class="pl-card">${d.needsYou.map((n) => `
          <div class="pl-need"><span>${esc(n.text)}</span>${n.url ? `<a class="secondary" style="padding:6px 12px; font-size:13px; text-decoration:none;" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.action)}</a>` : ''}</div>`).join('')}</div>` : ''}
      <h2 class="pl-h">Jobs</h2>
      ${listHtml(d.jobs, { empty: 'No jobs on the go.' })}
      <h2 class="pl-h">Quotes</h2>
      ${listHtml(d.quotes, { empty: 'No quotes on the go.' })}
      <p class="pl-muted" style="margin-top:24px;">Need something? Call ${esc(d.company.name)} on <a href="tel:${esc(d.company.phone)}">${esc(d.company.phone)}</a>.</p>`;
  }

  // ----- one job -----
  const factHtml = (k, v) => v ? `<div class="pl-fact"><span class="k">${esc(k)}</span><span>${v}</span></div>` : '';
  const listNames = (a) => a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;

  async function showJob(id) {
    main.innerHTML = `<p class="subtitle">Loading...</p>`;
    const { job, email } = await call('portal-read', { action: 'job', projectId: id });
    header(email);
    const d = job;
    const bookingLine = (b) => `${esc(b.day)}${b.start ? `, ${esc(b.start)}${b.end ? ` to ${esc(b.end)}` : ''}` : ''}${b.who.length ? `, ${esc(listNames(b.who))}` : ''}`;
    main.innerHTML = `
      <a class="pl-back" href="/portal.html">&larr; All your jobs</a>
      <div class="pl-card">
        <div class="ref" style="font-size:13px; color:var(--muted); font-weight:700;">${esc(d.ref)}</div>
        <h1 style="font-size:20px; margin:2px 0 8px;">${esc(d.name)}</h1>
        <div style="margin-bottom:8px;"><span class="pl-status ${statusCls(d.status)}">${esc(d.status)}</span></div>
        ${factHtml('Site', esc(d.site))}
        ${factHtml('Your contact', d.manager ? `${esc(d.manager)} at ${esc(d.company.name)}${d.company.phone ? `, <a href="tel:${esc(d.company.phone)}">${esc(d.company.phone)}</a>` : ''}` : (d.company.phone ? `${esc(d.company.name)}, <a href="tel:${esc(d.company.phone)}">${esc(d.company.phone)}</a>` : ''))}
        ${d.quoteUrl ? `<p style="margin:10px 0 0;"><a class="secondary" style="display:inline-block; padding:8px 14px; text-decoration:none;" href="${esc(d.quoteUrl)}" target="_blank" rel="noopener">Open your quote</a></p>` : ''}
      </div>

      ${d.onSite.length ? `<div class="pl-card"><strong>On site now</strong><br>${d.onSite.map((o) => `${esc(o.who)} since ${esc(o.since)}`).join('<br>')}</div>` : ''}

      ${d.kind === 'job' ? `
        <h2 class="pl-h">Bookings</h2>
        <div class="pl-card">
          ${d.bookings.length ? d.bookings.map((b) => `<div style="margin:4px 0;">${bookingLine(b)}</div>`).join('') : `<span class="pl-muted">Nothing booked yet. We will let you know when it is.</span>`}
          ${d.pastBookings.length ? `<details style="margin-top:8px;"><summary class="pl-muted" style="cursor:pointer;">Earlier visits (${d.pastBookings.length})</summary>${d.pastBookings.map((b) => `<div style="margin:4px 0;" class="pl-muted">${bookingLine(b)}</div>`).join('')}</details>` : ''}
        </div>` : ''}

      ${d.variations.length ? `
        <h2 class="pl-h">Variations</h2>
        <div class="pl-card">${d.variations.map((v) => `
          <div class="pl-need"><span>${v.number != null ? `Variation ${esc(v.number)}: ` : ''}${esc(v.description || '')} <span class="pl-status ${v.url ? 'warn' : ''}">${esc(v.status)}</span></span>${v.url ? `<a class="secondary" style="padding:6px 12px; font-size:13px; text-decoration:none;" href="${esc(v.url)}" target="_blank" rel="noopener">Sign</a>` : ''}</div>`).join('')}</div>` : ''}

      ${d.money && d.direct && d.kind === 'job' ? `
        <h2 class="pl-h">Work so far</h2>
        <div class="pl-card" id="pl-work"><p class="subtitle">Loading...</p></div>` : ''}

      ${d.money ? `
        <h2 class="pl-h">Invoices</h2>
        <div class="pl-card">
          ${d.invoices.length ? `<table class="pl-table"><thead><tr><th>Invoice</th><th>Status</th><th>Due</th><th class="n">Balance</th><th></th></tr></thead><tbody>${d.invoices.map((i) => `
            <tr><td><strong>${esc(i.number)}</strong>${i.description ? `<br><span class="pl-muted">${esc(i.description)}</span>` : ''}</td>
            <td><span class="pl-status ${i.status === 'overdue' ? 'warn' : ''}">${esc(i.label)}</span></td>
            <td>${esc(i.due)}</td><td class="n">${i.status === 'paid' ? '' : esc(money(i.balance))}</td>
            <td><a href="${esc(i.url)}" target="_blank" rel="noopener">${i.status === 'paid' ? 'View' : 'View and pay'}</a></td></tr>`).join('')}</tbody></table>` : `<span class="pl-muted">No invoices yet.</span>`}
        </div>` : ''}

      <h2 class="pl-h">Photos</h2>
      <div class="pl-card">
        ${d.photos.length ? `<div class="pl-grid">${d.photos.map((p, i) => `<div><img src="${esc(p.url)}" data-i="${i}" loading="lazy" alt="" /><div class="cap">${esc(p.caption || p.when)}</div></div>`).join('')}</div>` : `<span class="pl-muted">No photos shared yet.</span>`}
      </div>

      <h2 class="pl-h">Documents</h2>
      <div class="pl-card">
        ${d.documents.length ? d.documents.map((f) => `<div class="pl-need"><span>${esc(f.name)}<br><span class="pl-muted">${esc(f.when)}</span></span><a href="${esc(f.url)}" target="_blank" rel="noopener">Open</a></div>`).join('') : `<span class="pl-muted">No documents shared yet.</span>`}
        ${d.ratesUrl ? `<div class="pl-need" style="border-top:1px solid var(--border);"><span>Schedule of Rates${d.agreement ? `<br><span class="pl-muted">Your commercial agreement: ${esc(d.agreement.percentOff)}% off labour</span>` : ''}</span><a href="${esc(d.ratesUrl)}" target="_blank" rel="noopener">Open</a></div>` : ''}
      </div>`;
    main.querySelectorAll('.pl-grid img').forEach((img) => img.addEventListener('click', () => lightbox(d.photos, Number(img.dataset.i))));
    if (d.money && d.direct && d.kind === 'job') showWork(id);
  }

  function lightbox(photos, i) {
    const box = document.createElement('div');
    box.className = 'pl-lightbox';
    const render = () => { box.innerHTML = `<img src="${esc(photos[i].url)}" alt="" />`; };
    render();
    box.addEventListener('click', (e) => {
      if (e.target.tagName === 'IMG' && photos.length > 1) { i = (i + 1) % photos.length; render(); return; }
      box.remove();
    });
    document.body.appendChild(box);
  }

  async function showWork(id) {
    const el = document.getElementById('pl-work');
    try {
      const { work } = await call('portal-read', { action: 'work', projectId: id });
      const inv = (x) => x.invoiced ? `<span class="pl-muted">${esc(x.invoiceNumber || 'Invoiced')}</span>` : 'Not yet';
      el.innerHTML = `
        <div class="pl-big">${esc(money(work.notInvoiced))}</div>
        <div class="pl-muted">About this much not yet invoiced (labour ${esc(money(work.labourOpen))}, materials ${esc(money(work.materialsOpen))}, ex GST).${work.agreement ? ` Your commercial agreement (${esc(work.agreement.percentOff)}% off labour) comes off on the invoice.` : ''}</div>
        ${work.note ? `<p class="pl-muted">${esc(work.note)}</p>` : ''}
        <h3 style="font-size:14px; margin:14px 0 4px;">Labour</h3>
        ${work.labour.length ? `<table class="pl-table"><thead><tr><th>Day</th><th>Who</th><th>Hours</th><th class="n">Amount</th><th>Invoiced</th></tr></thead><tbody>${work.labour.map((l) => `
          <tr><td>${esc(l.day)}<br><span class="pl-muted">${esc(l.start)} to ${esc(l.end)}</span></td><td>${esc(l.who)}</td><td>${esc(l.bands || `${l.hours} h`)}</td><td class="n">${esc(money(l.amount))}</td><td>${inv(l)}</td></tr>`).join('')}</tbody></table>
          <p class="pl-muted" style="margin:6px 0 0;">Hours at the Schedule of Rates: ${esc(work.rules.standardHours)} standard, after hours and weekends at the schedule's rates, minimum ${esc(work.rules.minimumHours)} hours a day per person on the invoice.</p>` : `<span class="pl-muted">No hours logged yet.</span>`}
        <h3 style="font-size:14px; margin:14px 0 4px;">Materials used</h3>
        ${work.materials.length ? `<table class="pl-table"><thead><tr><th>Item</th><th>Qty</th><th>From</th><th class="n">Amount</th><th>Invoiced</th></tr></thead><tbody>${work.materials.map((m) => `
          <tr><td>${esc(m.description)}</td><td>${esc(m.quantity)}</td><td>${esc(m.from)}</td><td class="n">${esc(money(m.amount))}</td><td>${inv(m)}</td></tr>`).join('')}</tbody></table>` : `<span class="pl-muted">No materials yet.</span>`}
        <h3 style="font-size:14px; margin:14px 0 4px;">Orders</h3>
        ${work.purchaseOrders.length ? work.purchaseOrders.map((po) => `
          <details style="margin:6px 0;"><summary style="cursor:pointer;"><strong>PO ${esc(po.number)}</strong> ${esc(po.supplier)}: ${esc(po.state)} <span class="pl-muted">(${esc(money(po.total))})</span></summary>
            <table class="pl-table" style="margin-top:6px;"><tbody>${po.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.quantity)}</td><td>${l.received ? 'Picked up' : l.backordered ? `Back order${l.eta ? `, due ${esc(l.eta)}` : ''}` : 'Ordered'}</td><td class="n">${esc(money(l.amount))}</td></tr>`).join('')}</tbody></table>
          </details>`).join('') : `<span class="pl-muted">No orders on this job.</span>`}`;
    } catch (err) {
      if (err.message === 'login') return;
      el.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  }

  async function route() {
    if (!token()) { showLogin(); return; }
    try {
      if (params.get('job')) await showJob(params.get('job'));
      else await showOverview();
    } catch (err) {
      if (err.message === 'login') return;
      main.innerHTML = `<a class="pl-back" href="/portal.html">&larr; All your jobs</a><div class="error-box">${esc(err.message)}</div>`;
    }
  }
  route();
})();
