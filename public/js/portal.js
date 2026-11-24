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
    if (res.status === 403 && data.mustChange) { showSetPassword(); throw new Error('password'); }
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Something went wrong. Please try again.');
    return data;
  }

  // ----- login -----
  function showLogin(message) {
    who.innerHTML = '';
    main.innerHTML = `
      <div class="pl-login">
        <h1 style="font-size:22px; margin:0 0 6px;">Your jobs</h1>
        <p class="subtitle">See your quotes, jobs, bookings, photos and invoices with Thomson Energy.</p>
        ${message ? `<div class="success-box">${esc(message)}</div>` : ''}
        <form id="pl-login-form" style="margin-top:14px;">
          <label>Email</label>
          <input type="email" id="pl-email" autocomplete="username" autocapitalize="off" required placeholder="you@example.com" />
          <label>Password</label>
          <input type="password" id="pl-password" autocomplete="current-password" required />
          <button type="submit" id="pl-go">Log in</button>
        </form>
        <p class="pl-muted" style="margin-top:14px;">First time here, or forgotten your password? <a href="#" id="pl-code-link">Email me a code instead</a></p>
        <div id="pl-msg" style="margin-top:10px;"></div>
      </div>`;
    const emailEl = document.getElementById('pl-email');
    document.getElementById('pl-code-link').addEventListener('click', (e) => { e.preventDefault(); sendCode(emailEl.value.trim()); });
    document.getElementById('pl-login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('pl-go');
      const msg = document.getElementById('pl-msg');
      btn.disabled = true; btn.textContent = 'Checking...';
      try {
        const r = await call('portal-login', { action: 'password', email: emailEl.value.trim(), password: document.getElementById('pl-password').value, device: navigator.userAgent.slice(0, 200) });
        setToken(r.token);
        if (r.mustChange) showSetPassword(); else route();
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Log in';
      }
    });
  }

  async function sendCode(emailIn) {
    let email = emailIn;
    if (!email) { email = prompt('Your email address:') || ''; email = email.trim(); }
    if (!email) return;
    const msg = document.getElementById('pl-msg');
    if (msg) msg.innerHTML = `<p class="pl-muted">Sending...</p>`;
    try {
      const r = await call('portal-login', { action: 'send', email });
      if (r.staff) { if (msg) msg.innerHTML = `<div class="error-box">${esc(r.message)}</div>`; return; }
      showCode(email, r.message, r.minutes);
    } catch (err) {
      if (msg) msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  }

  function showCode(email, message, minutes) {
    main.innerHTML = `
      <div class="pl-login">
        <h1 style="font-size:22px; margin:0 0 6px;">Check your email</h1>
        <p class="subtitle">${esc(message || '')} It works for ${esc(minutes || 10)} minutes.</p>
        <form id="pl-code-form" class="pl-code" style="margin-top:14px;">
          <label>6 digit code</label>
          <input type="text" id="pl-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required />
          <button type="submit" id="pl-verify">Log in</button>
        </form>
        <p class="pl-muted" style="margin-top:14px;"><a href="#" id="pl-again">Back to the login page</a></p>
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
        showSetPassword();
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Log in';
      }
    });
  }

  // After a temporary password or a code: choose your own password before anything else shows.
  function showSetPassword() {
    main.innerHTML = `
      <div class="pl-login">
        <h1 style="font-size:22px; margin:0 0 6px;">Choose your password</h1>
        <p class="subtitle">At least 8 characters. You will use it with your email next time.</p>
        <form id="pl-set-form" style="margin-top:14px;">
          <label>New password</label>
          <input type="password" id="pl-new1" autocomplete="new-password" minlength="8" required />
          <label>Type it again</label>
          <input type="password" id="pl-new2" autocomplete="new-password" minlength="8" required />
          <button type="submit" id="pl-set">Save and continue</button>
        </form>
        <div id="pl-msg" style="margin-top:10px;"></div>
      </div>`;
    document.getElementById('pl-new1').focus();
    document.getElementById('pl-set-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const msg = document.getElementById('pl-msg');
      const a = document.getElementById('pl-new1').value, b = document.getElementById('pl-new2').value;
      if (a !== b) { msg.innerHTML = `<div class="error-box">The two passwords are not the same.</div>`; return; }
      const btn = document.getElementById('pl-set');
      btn.disabled = true; btn.textContent = 'Saving...';
      try {
        await call('portal-login', { action: 'set_password', password: a });
        history.replaceState(null, '', '/portal.html');
        route();
      } catch (err) {
        msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
        btn.disabled = false; btn.textContent = 'Save and continue';
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
  const rowHtml = (r) => `
    <a class="pl-row ${r.open ? '' : 'done'}" href="/portal.html?job=${esc(r.id)}">
      <div class="ref">${esc(r.ref)}</div>
      <div class="name">${esc(r.name)}</div>
      ${r.site ? `<div class="site">${esc(r.site)}</div>` : ''}
      <div class="status"><span class="pl-status ${esc(r.tone)}">${esc(r.status)}</span></div>
    </a>`;
  const listHtml = (rows, { empty }) => {
    const open = rows.filter((r) => r.open);
    const done = rows.filter((r) => !r.open);
    return `
      ${open.length ? open.map(rowHtml).join('') : `<p class="pl-muted">${esc(empty)}</p>`}
      ${done.length ? `<details><summary class="pl-muted" style="cursor:pointer; margin:8px 0;">Show finished (${done.length})</summary>${done.map(rowHtml).join('')}</details>` : ''}`;
  };

  // ----- the dates chart (item 92): only the dates we told the client -----
  const dayMs = 86400000;
  const ymdNum = (ymd) => Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / dayMs;
  const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const shortDay = (n) => new Date(n * dayMs).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  // rows: [{ label, sub, bars: [{ kind, start, end, startText, endText, label }], booked: [ymd] }]
  function planChart(rows) {
    const all = rows.flatMap((r) => r.bars);
    const today = ymdNum(todayYmd());
    let from = Math.min(...all.map((b) => ymdNum(b.start)), today);
    let to = Math.max(...all.map((b) => ymdNum(b.end)), today) + 1;
    from -= (new Date(from * dayMs).getUTCDay() + 6) % 7; // back to a Monday
    if (to - from < 28) to = from + 28;
    const pct = (n) => `${((n - from) / (to - from)) * 100}%`;
    const width = (a, b) => `${((b - a) / (to - from)) * 100}%`;
    const weeks = [];
    for (let w = from; w < to; w += 7) weeks.push(`<span class="pc-wk" style="left:${pct(w)};">${esc(shortDay(w))}</span>`);
    const todayLine = today >= from && today < to ? `<i class="pc-today" style="left:${pct(today + 0.5)};" title="Today"></i>` : '';
    const lane = (r) => `
      <div class="pc-row">
        ${r.label ? `<div class="pc-label">${r.label}</div>` : ''}
        <div class="pc-lane">${todayLine}${r.bars.map((b) => `
          <div class="pc-bar ${b.kind === 'variation' ? 'var' : ''}" style="left:${pct(ymdNum(b.start))}; width:${width(ymdNum(b.start), ymdNum(b.end) + 1)};" title="${esc(b.label)}: ${esc(b.startText)} to ${esc(b.endText)}">${(r.booked || []).filter((d) => d >= b.start && d <= b.end).map((d) => `<i style="left:${((ymdNum(d) - ymdNum(b.start)) / (ymdNum(b.end) + 1 - ymdNum(b.start))) * 100}%; width:${100 / (ymdNum(b.end) + 1 - ymdNum(b.start))}%;"></i>`).join('')}</div>`).join('')}
        </div>
        ${r.sub ? `<div class="pc-sub">${r.sub}</div>` : ''}
      </div>`;
    return `<div class="pc"><div class="pc-weeks">${weeks.join('')}</div>${rows.map(lane).join('')}
      <div class="pc-key"><span><i class="pc-sw"></i>Planned work</span>${all.some((b) => b.kind === 'variation') ? '<span><i class="pc-sw var"></i>Variation</span>' : ''}${rows.some((r) => (r.booked || []).length) ? '<span><i class="pc-sw booked"></i>Booked days</span>' : ''}<span><i class="pc-sw today"></i>Today</span></div></div>`;
  }
  const barsText = (pl) => pl.bars.map((b) => `${esc(b.label)}: ${esc(b.startText)}${b.start === b.end ? '' : ` to ${esc(b.endText)}`}`).join('<br>');

  async function showOverview() {
    main.innerHTML = `<p class="subtitle">Loading your jobs...</p>`;
    const d = await call('portal-read', { action: 'overview' });
    window.ADDRESS_BOX_KEY = d.company.mapsKey || '';   // the Request work address box offers Google's addresses
    header(d.email);
    const names = d.clients.map((c) => c.name);
    // whole screen (owner's rule): three columns that scroll on their own on a laptop, one on a phone
    main.innerHTML = `<div class="pl-cols"><div class="pl-col">
      ${names.length ? `<p class="pl-muted" style="margin:4px 0 0;">${esc(names.join(', '))}</p>` : ''}
      ${d.needsYou.length ? `
        <h2 class="pl-h">Needs you</h2>
        <div class="pl-card">${d.needsYou.map((n) => `
          <div class="pl-need"><span>${esc(n.text)}</span>${n.url ? openLink(n.url, n.action, n.kind, n.projectId, n.detail) : ''}</div>`).join('')}</div>` : ''}
      ${d.plan && d.plan.length ? card('Your dates', planChart(d.plan.map((j) => ({ label: `<a href="/portal.html?job=${esc(j.id)}"><strong>${esc(j.ref)}</strong> ${esc(j.name)}</a>`, bars: j.bars, booked: j.booked, sub: `${esc(j.startText)}${j.start === j.end ? '' : ` to ${esc(j.endText)}`}` })))) : ''}
      ${d.request ? '<p style="margin:12px 0 0;"><button type="button" id="pl-req-open">Request work</button></p><div id="pl-req"></div>' : ''}
      ${d.people && d.people.length ? `<h2 class="pl-h">People</h2><div class="pl-card" id="pl-people">${peopleHtml(d.people)}</div>` : ''}
      <p class="pl-muted" style="margin-top:16px;">Need something? Call ${esc(d.company.name)} on <a href="tel:${esc(d.company.phone)}">${esc(d.company.phone)}</a>.</p>
      </div><div class="pl-col">
      <h2 class="pl-h">Jobs</h2>
      ${listHtml(d.jobs, { empty: 'No jobs on the go.' })}
      </div><div class="pl-col">
      <h2 class="pl-h">Quotes</h2>
      ${listHtml(d.quotes, { empty: 'No quotes on the go.' })}
      ${(d.equipment || []).length ? `<h2 class="pl-h">Your equipment</h2>${d.equipment.map(equipmentHtml).join('')}` : ''}
      ${(d.referrals || []).length ? `<h3 class="pl-muted" style="margin:12px 0 4px; font-size:13px;">Jobs you sent us</h3>${d.referrals.map((r) => `<div class="pl-row ${r.open ? '' : 'done'}" style="cursor:default;">${r.ref ? `<div class="ref">${esc(r.ref)}</div>` : ''}<div class="name" style="font-size:15px;">${esc(r.name)}</div><div class="site">${esc(r.when)}</div><div class="status"><span class="pl-status">${esc(r.status)}</span></div></div>`).join('')}` : ''}
      ${(d.rewards || []).length ? `<div class="pl-card" style="margin-top:10px;"><strong>Your rewards</strong>${d.rewards.map((t) => `<div class="pl-muted" style="margin-top:2px;">${esc(t)}</div>`).join('')}</div>` : ''}
      ${d.referLink ? `<p style="margin:10px 0 0;"><a class="secondary pl-btn" href="${esc(d.referLink)}" target="_blank" rel="noopener">Send us a job (your referral link)</a></p><p class="pl-muted" style="margin:4px 0 0;">Save it to your phone's home screen, or pass it to your team.</p>` : ''}
      </div></div>`;
    const reqBtn = document.getElementById('pl-req-open');
    if (reqBtn) reqBtn.addEventListener('click', () => { reqBtn.style.display = 'none'; requestForm(d.request); });
    if (d.people && d.people.length) wirePeople(d.people);
  }

  // ----- files: photos are made smaller on the phone first; at most 5, each under 4 MB -----
  const fileToB64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(blob); });
  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 900 * 1024) return file;
    try {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
      return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }
  async function readFiles(input) {
    if ((input.files || []).length > 5) throw new Error('Up to 5 files, please.');
    const list = [...(input.files || [])];
    const out = [];
    let total = 0;
    for (const f of list) {
      const small = await shrink(f);
      total += small.size;
      if (total > 4 * 1024 * 1024) throw new Error('The files come to more than 4 MB. Send fewer, or smaller ones.');
      out.push({ name: f.name, type: small.type || f.type, data: await fileToB64(small) });
    }
    return out;
  }
  const fileField = (id) => `<label class="pl-muted" style="display:block; margin-top:8px;">Photos or plans (optional, up to 5, 4 MB in all)</label><input type="file" id="${id}" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" style="width:100%;" />`;

  // ----- request work (item 74 point 9) -----
  function requestForm(opts) {
    const box = document.getElementById('pl-req');
    const clients = opts.clients || [];
    const tomorrow = (() => { const d = new Date(todayYmd() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
    const siteOptions = (c) => `${(c.sites || []).map((x) => `<option value="${esc(x.id)}">${esc(x.label ? `${x.label}: ${x.address}` : x.address)}</option>`).join('')}<option value="">A new address...</option>`;
    box.innerHTML = `
      <div class="pl-card">
        <strong>Request work</strong>
        <p class="pl-muted" style="margin:2px 0 8px;">Tell us what you need. It goes straight to our office.</p>
        ${clients.length > 1 ? `<label class="pl-muted">For</label><select id="rq-client" style="width:100%; font-size:16px;">${clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select>` : ''}
        <label class="pl-muted" style="display:block; margin-top:8px;">Site</label><select id="rq-site" style="width:100%; font-size:16px;"></select>
        <input id="rq-address" placeholder="Street, suburb, postcode" style="width:100%; font-size:16px; margin-top:6px; display:none;" />
        <label class="pl-muted" style="display:block; margin-top:8px;">What do you need?</label>
        <textarea id="rq-need" rows="4" maxlength="4000" style="width:100%; font-size:16px;" placeholder="e.g. 6 new downlights in the kitchen and a dedicated circuit for the oven"></textarea>
        ${fileField('rq-files')}
        <div id="rq-kinds" style="margin-top:10px;"></div>
        <div id="rq-msg"></div>
        <div style="display:flex; gap:8px; margin-top:10px;"><button type="button" id="rq-send">Send request</button><button type="button" class="secondary" id="rq-cancel">Cancel</button></div>
      </div>`;
    const clientSel = box.querySelector('#rq-client');
    const current = () => clients.find((c) => c.id === (clientSel ? clientSel.value : clients[0].id)) || clients[0];
    const drawClient = () => {
      const c = current();
      const site = box.querySelector('#rq-site');
      site.innerHTML = siteOptions(c);
      box.querySelector('#rq-address').style.display = site.value ? 'none' : 'block';
      box.querySelector('#rq-kinds').innerHTML = `
        <label style="display:flex; gap:8px; align-items:flex-start; font-weight:400;"><input type="radio" name="rq-kind" value="quote" checked style="width:auto; margin-top:3px;" /> <span><strong>Quote it</strong><br><span class="pl-muted">Needed by</span> <input type="date" id="rq-due" min="${esc(tomorrow)}" style="font-size:16px;" /></span></label>
        ${c.bookIn ? `<label style="display:flex; gap:8px; align-items:flex-start; font-weight:400; margin-top:8px;"><input type="radio" name="rq-kind" value="book" style="width:auto; margin-top:3px;" /> <span><strong>Book it in</strong> (charged at your rates)<br><span class="pl-muted">Days that suit you</span><br><input type="date" class="rq-day" min="${esc(tomorrow)}" style="font-size:16px;" /> <input type="date" class="rq-day" min="${esc(tomorrow)}" style="font-size:16px;" /> <input type="date" class="rq-day" min="${esc(tomorrow)}" style="font-size:16px;" /></span></label>` : ''}
        ${opts.service ? `<label style="display:flex; gap:8px; align-items:flex-start; font-weight:400; margin-top:8px;"><input type="radio" name="rq-kind" value="service" style="width:auto; margin-top:3px;" /> <span><strong>Disconnect and reconnect</strong><br><span class="pl-muted">Solar panels or air conditioning off for roof work and back on after, at our <a href="${esc(opts.service.pricesUrl)}" target="_blank" rel="noopener">price list</a>. No quote needed.</span></span></label>
        <div id="rq-service" style="display:none; margin:6px 0 0 26px;">${opts.service.questions.map(serviceQuestion).join('')}</div>` : ''}`;
      // the booking questions show only for a disconnect and reconnect, where they replace "What do you need?"
      box.querySelectorAll('input[name="rq-kind"]').forEach((r) => r.addEventListener('change', () => {
        const svc = box.querySelector('#rq-service');
        if (svc) svc.style.display = r.value === 'service' && r.checked ? 'block' : 'none';
      }));
    };
    // one booking question (company_settings.service_booking_questions, item 109) as a form field
    function serviceQuestion(q) {
      const at = `data-q="${esc(q.key)}" style="width:100%; font-size:16px;"`;
      const field = q.type === 'choice' ? `<select ${at}><option value=""></option>${(q.options || []).map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
        : q.type === 'longtext' ? `<textarea ${at} rows="2" maxlength="2000"></textarea>`
        : `<input ${at} type="${q.type === 'number' ? 'number' : q.type === 'date' ? 'date' : 'text'}" ${q.type === 'number' ? 'min="0" inputmode="numeric"' : ''} ${q.type === 'date' ? `min="${esc(tomorrow)}"` : ''} />`;
      return `<label class="pl-muted" style="display:block; margin-top:6px;">${esc(q.label)}</label>${field}`;
    }
    if (clientSel) clientSel.addEventListener('change', drawClient);
    box.querySelector('#rq-site').addEventListener('change', (e) => { box.querySelector('#rq-address').style.display = e.target.value ? 'none' : 'block'; });
    drawClient();
    wireAddressBox(box.querySelector('#rq-address'));
    box.querySelector('#rq-cancel').addEventListener('click', () => showOverview());
    box.querySelector('#rq-send').addEventListener('click', async (e) => {
      const msg = box.querySelector('#rq-msg');
      const kind = (box.querySelector('input[name="rq-kind"]:checked') || {}).value || 'quote';
      e.target.disabled = true;
      msg.innerHTML = '<p class="pl-muted">Sending...</p>';
      try {
        const files = await readFiles(box.querySelector('#rq-files'));
        const out = await call('portal-write', {
          action: 'request', clientId: current().id, siteId: box.querySelector('#rq-site').value || null, address: box.querySelector('#rq-address').value,
          addressParts: box.querySelector('#rq-site').value ? null : await addressBoxParts(box.querySelector('#rq-address')),
          need: box.querySelector('#rq-need').value, kind, dueDate: (box.querySelector('#rq-due') || {}).value || '',
          dates: [...box.querySelectorAll('.rq-day')].map((x) => x.value).filter(Boolean), files,
          booking: Object.fromEntries([...box.querySelectorAll('[data-q]')].map((x) => [x.dataset.q, x.value])),
        });
        window.history.pushState({}, '', `/portal.html?job=${encodeURIComponent(out.id)}`);
        showJob(out.id);
      } catch (err) { msg.innerHTML = `<p class="pl-muted" style="color:#c0272d;">${esc(err.message)}</p>`; e.target.disabled = false; }
    });
  }

  // ----- Your equipment: what we have installed for them, one line each, opening to the detail -----
  // (serial numbers are there for a warranty claim; our own notes never come to the portal)
  function equipmentHtml(a) {
    const warranty = a.warrantyEnds ? `Warranty ${a.inWarranty ? 'to' : 'ended'} ${esc(a.warrantyEnds)}` : '';
    const line = [a.installed ? `Installed ${esc(a.installed)}` : '', warranty].filter(Boolean).join(' · ');
    return `<details class="pl-card" style="margin:0 0 8px;">
      <summary style="cursor:pointer;"><strong>${a.quantity > 1 ? `${a.quantity} x ` : ''}${esc(a.name)}</strong>${line ? `<br><span class="pl-muted">${line}</span>` : ''}</summary>
      ${a.site ? `<p class="pl-muted" style="margin:8px 0 0;">At ${esc(a.site)}</p>` : ''}
      ${a.nextService ? `<p class="pl-muted" style="margin:4px 0 0;">Next service due ${esc(a.nextService)}</p>` : ''}
      ${a.serials.length ? `<p class="pl-muted" style="margin:4px 0 0;">Serial number${a.serials.length === 1 ? '' : 's'}: ${a.serials.map(esc).join(', ')}</p>` : ''}
    </details>`;
  }

  // ----- the People card: the main email gives others at the company a login (item 74 point 1) -----
  function peopleHtml(groups) {
    return groups.map((g) => `
      ${groups.length > 1 ? `<h3>${esc(g.clientName)}</h3>` : ''}
      <div class="pl-muted">${esc(g.main)} (you, the main email)</div>
      ${g.people.map((x) => `<div class="pl-need"><span>${esc(x.name ? `${x.name}, ${x.email}` : x.email)}</span><button type="button" class="secondary pl-btn pl-person-x" data-client="${esc(g.clientId)}" data-id="${esc(x.id)}">Remove</button></div>`).join('')}
      <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:8px;">
        <input class="pl-person-name" data-client="${esc(g.clientId)}" placeholder="Name" style="flex:1; min-width:120px; font-size:16px;" />
        <input class="pl-person-email" data-client="${esc(g.clientId)}" type="email" placeholder="Email" style="flex:2; min-width:180px; font-size:16px;" />
        <button type="button" class="pl-person-add" data-client="${esc(g.clientId)}">Give a login</button>
      </div>`).join('') + '<p class="pl-muted" style="margin:8px 0 0;">They get an email with a login and see the same jobs, quotes and invoices you do.</p><div id="pl-people-msg"></div>';
  }
  function wirePeople() {
    const card = document.getElementById('pl-people');
    const msg = () => document.getElementById('pl-people-msg');
    const redraw = (people) => { card.innerHTML = peopleHtml(people); wirePeople(); };
    card.querySelectorAll('.pl-person-add').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.client;
      b.disabled = true;
      try {
        const out = await call('portal-write', { action: 'add_person', clientId: id, name: card.querySelector(`.pl-person-name[data-client="${id}"]`).value, email: card.querySelector(`.pl-person-email[data-client="${id}"]`).value });
        redraw(out.people);
      } catch (err) { msg().innerHTML = `<p class="pl-muted" style="color:#c0272d;">${esc(err.message)}</p>`; b.disabled = false; }
    }));
    card.querySelectorAll('.pl-person-x').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Take this person\'s login away?')) return;
      b.disabled = true;
      try { const out = await call('portal-write', { action: 'remove_person', clientId: b.dataset.client, contactId: b.dataset.id }); redraw(out.people); } catch (err) { msg().innerHTML = `<p class="pl-muted" style="color:#c0272d;">${esc(err.message)}</p>`; b.disabled = false; }
    }));
  }

  // ----- one job -----
  const factHtml = (k, v) => v ? `<div class="pl-fact"><span class="k">${esc(k)}</span><span>${v}</span></div>` : '';
  const listNames = (a) => a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
  const phoneLink = (c) => c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : '';
  const openLink = (url, label, kind, projectId, detail) => `<a class="secondary pl-btn" href="${esc(url)}" target="_blank" rel="noopener"${kind ? ` data-open="${esc(kind)}" data-project="${esc(projectId || '')}" data-detail="${esc(detail || '')}"` : ''}>${esc(label)}</a>`;
  // the page tells the server what was opened (the usage log the office reads); never blocks the click
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-open]');
    if (!a) return;
    call('portal-read', { action: 'event', kind: a.dataset.open, projectId: a.dataset.project, detail: a.dataset.detail }).catch(() => {});
  });
  const table = (headers, rows) => `<table class="pl-table"><thead><tr>${headers.map((h) => `<th${/^\$/.test(h) ? ' class="n"' : ''}>${esc(h.replace(/^\$/, ''))}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const card = (title, body) => `<h2 class="pl-h">${esc(title)}</h2><div class="pl-card">${body}</div>`;
  const bookingLine = (b) => `${esc(b.day)}${b.start ? `, ${esc(b.start)}${b.end ? ` to ${esc(b.end)}` : ''}` : ''}${b.who.length ? `, ${esc(listNames(b.who))}` : ''}`;

  // ----- ask for a date (point 9a): books nothing, the office books it and emails them -----
  const tomorrow = () => { const d = new Date(todayYmd() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
  const askTimes = () => { const out = []; for (let m = 7 * 60; m <= 16 * 60; m += 30) out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`); return out; };
  const timeLabel = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
  function askHtml(d) {
    if (!d.open) return '';
    if (d.ask) return `<div class="pl-need" id="pl-ask" style="border-bottom:1px solid var(--border); margin-bottom:6px;"><span>You asked for <strong>${esc(d.ask.day)}${d.ask.time ? `, ${esc(d.ask.time)}` : ', any time'}</strong>. We will confirm by email.${d.ask.note ? `<br><span class="pl-muted">${esc(d.ask.note)}</span>` : ''}</span><span style="white-space:nowrap;"><button type="button" class="secondary pl-btn" id="pl-ask-change">Change</button> <button type="button" class="secondary pl-btn" id="pl-ask-withdraw">Withdraw</button></span></div>`;
    return `<div id="pl-ask" style="margin-bottom:8px;"><button type="button" class="secondary pl-btn" id="pl-ask-open">Ask for a date</button></div>`;
  }
  function askForm(d) {
    const box = document.getElementById('pl-ask');
    const a = d.ask || {};
    const at = a.timeValue || '';
    box.innerHTML = `
      <div class="pl-card" style="margin:0 0 8px;">
        <strong>Ask for a date</strong>
        <p class="pl-muted" style="margin:2px 0 8px;">We will check who is free and confirm by email. Nothing is booked until we do.</p>
        <label class="pl-muted">Day</label><input type="date" id="pl-ask-date" min="${esc(tomorrow())}" value="${esc(a.date || '')}" style="width:100%; font-size:16px;" />
        <label class="pl-muted" style="display:block; margin-top:8px;">Start</label>
        <select id="pl-ask-time" style="width:100%; font-size:16px;"><option value="">Any time</option>${askTimes().map((t) => `<option value="${t}" ${t === at ? 'selected' : ''}>${timeLabel(t)}</option>`).join('')}</select>
        <label class="pl-muted" style="display:block; margin-top:8px;">Anything we should know (optional)</label>
        <textarea id="pl-ask-note" rows="3" maxlength="500" style="width:100%; font-size:16px;">${esc(a.note || '')}</textarea>
        <div id="pl-ask-msg"></div>
        <div style="display:flex; gap:8px; margin-top:8px;"><button type="button" id="pl-ask-send">Send</button><button type="button" class="secondary" id="pl-ask-cancel">Cancel</button></div>
      </div>`;
    box.querySelector('#pl-ask-cancel').addEventListener('click', () => showJob(d.id));
    box.querySelector('#pl-ask-send').addEventListener('click', async (e) => {
      const date = box.querySelector('#pl-ask-date').value;
      const msg = box.querySelector('#pl-ask-msg');
      if (!date || date < tomorrow()) { msg.innerHTML = '<p class="pl-muted" style="color:#c0272d;">Pick a day from tomorrow on.</p>'; return; }
      e.target.disabled = true;
      try {
        await call('portal-write', { action: 'ask_date', projectId: d.id, date, time: box.querySelector('#pl-ask-time').value, note: box.querySelector('#pl-ask-note').value });
        showJob(d.id);
      } catch (err) { msg.innerHTML = `<p class="pl-muted" style="color:#c0272d;">${esc(err.message)}</p>`; e.target.disabled = false; }
    });
  }
  function wireAsk(d) {
    const open = document.getElementById('pl-ask-open');
    if (open) open.addEventListener('click', () => askForm(d));
    const change = document.getElementById('pl-ask-change');
    if (change) change.addEventListener('click', () => askForm(d));
    const withdraw = document.getElementById('pl-ask-withdraw');
    if (withdraw) withdraw.addEventListener('click', async () => {
      if (!confirm('Withdraw your ask for this date?')) return;
      withdraw.disabled = true;
      try { await call('portal-write', { action: 'withdraw_ask', projectId: d.id }); showJob(d.id); } catch (err) { alert(err.message); withdraw.disabled = false; }
    });
  }

  async function showJob(id) {
    main.innerHTML = `<p class="subtitle">Loading...</p>`;
    const { job: d, email } = await call('portal-read', { action: 'job', projectId: id });
    header(email);
    const contact = d.manager ? `${esc(d.manager)} at ${esc(d.company.name)}${d.company.phone ? `, ${phoneLink(d.company)}` : ''}` : (d.company.phone ? `${esc(d.company.name)}, ${phoneLink(d.company)}` : '');
    const pictures = d.photos.filter((p) => !p.video);
    // invoices ServiceM8 sent before the job moved to TEops: the PDFs, listed under the Invoices card
    const earlierInvoices = d.earlierInvoices || [];
    const photoTile = (p) => `<div>${p.video
      ? `<video src="${esc(p.url)}" controls playsinline preload="metadata" style="width:100%; height:120px; object-fit:cover; border-radius:8px; background:#000;"></video>`
      : `<img src="${esc(p.thumb || p.url)}" data-i="${pictures.indexOf(p)}" loading="lazy" alt="" />`}<div class="cap">${esc(p.caption || p.when)}</div></div>`;
    main.innerHTML = `<div class="pl-cols"><div class="pl-col">
      <a class="pl-back" href="/portal.html">&larr; All your jobs</a>
      <div class="pl-card">
        <div class="ref" style="font-size:13px; color:var(--muted); font-weight:700;">${esc(d.ref)}</div>
        <h1 style="font-size:20px; margin:2px 0 8px;">${esc(d.name)}</h1>
        <div style="margin-bottom:8px;"><span class="pl-status ${esc(d.tone)}">${esc(d.status)}</span></div>
        ${factHtml('Site', esc(d.site))}
        ${factHtml('Your contact', contact)}
        ${d.quoteUrl ? `<p style="margin:10px 0 0;">${openLink(d.quoteUrl, 'Open your quote', 'opened_quote', d.id, d.ref)}</p>` : ''}
      </div>
      ${d.onSite.length ? `<div class="pl-card"><strong>On site now</strong><br>${d.onSite.map((o) => `${esc(o.who)} since ${esc(o.since)}`).join('<br>')}</div>` : ''}
      ${d.kind === 'job' ? card('Bookings', `${askHtml(d)}
          ${d.bookings.length ? d.bookings.map((b) => `<div style="margin:4px 0;">${bookingLine(b)}</div>`).join('') : `<span class="pl-muted">Nothing booked yet. We will let you know when it is.</span>`}
          ${d.pastBookings.length ? `<details style="margin-top:8px;"><summary class="pl-muted" style="cursor:pointer;">Earlier visits (${d.pastBookings.length})</summary>${d.pastBookings.map((b) => `<div style="margin:4px 0;" class="pl-muted">${bookingLine(b)}</div>`).join('')}</details>` : ''}`) : ''}
      ${d.kind === 'job' && d.plan ? card('Dates', d.plan.pending ? '<span class="pl-muted">Dates to be confirmed. We will email you the dates.</span>' : `${planChart([{ bars: d.plan.bars, booked: d.plan.booked }])}<div class="pl-muted" style="margin-top:6px;">${barsText(d.plan)}</div>`) : ''}
      ${d.request && d.request.canAdd ? `<div class="pl-card"><strong>Your request</strong>${d.request.dueDate ? `<br><span class="pl-muted">We are working to ${esc(d.request.dueDate)}${d.request.moved ? `. We moved it: ${esc(d.request.moved)}` : ''}.</span>` : ''}
        <textarea id="pl-more-note" rows="2" maxlength="4000" placeholder="Anything to add?" style="width:100%; font-size:16px; margin-top:8px;"></textarea>${fileField('pl-more-files')}
        <div id="pl-more-msg"></div><button type="button" id="pl-more-send" style="margin-top:8px;">Add to my request</button></div>` : ''}
      </div><div class="pl-col pl-col-msgs">
      ${d.variations.length ? card('Variations', d.variations.map((v) => `
          <div class="pl-need"><span>${v.number != null ? `Variation ${esc(v.number)}: ` : ''}${esc(v.description || '')} <span class="pl-status ${v.url ? 'warn' : ''}">${esc(v.status)}</span></span>${v.url ? openLink(v.url, 'Sign', 'opened_variation', d.id, v.number != null ? `Variation ${v.number}` : '') : ''}</div>`).join('')) : ''}
      ${d.messages ? card('Messages', `${(d.messages || []).length ? `<div id="pl-msgs" style="max-height:340px; overflow-y:auto;">${d.messages.map((m) => `<div style="display:flex; ${m.mine ? 'justify-content:flex-end;' : ''} margin:6px 0;"><div style="max-width:85%; padding:8px 12px; border-radius:10px; background:${m.mine ? '#e6e3f7' : 'var(--surface-2)'};"><div class="pl-muted" style="font-size:11px;">${esc(m.mine ? 'You' : m.who)}, ${esc(m.when)}</div><div style="white-space:pre-wrap;">${esc(m.body)}</div></div></div>`).join('')}</div>` : '<p class="pl-muted" style="margin:0 0 6px;">Questions about this job? Write to us here.</p>'}
        <textarea id="pl-msg-body" rows="2" maxlength="4000" placeholder="Write a message..." style="width:100%; font-size:16px; margin-top:6px;"></textarea>
        <div id="pl-msg-err"></div><button type="button" id="pl-msg-send" style="margin-top:6px;">Send</button>`) : ''}
      </div><div class="pl-col">
      ${d.hasWork ? `<h2 class="pl-h">Work so far</h2><div class="pl-card" id="pl-work"></div>` : ''}
      ${d.money ? card('Invoices', (d.invoices.length ? table(['Invoice', 'Status', 'Due', '$Balance', ''], d.invoices.map((i) => `
            <tr><td><strong>${esc(i.number)}</strong>${i.description ? `<br><span class="pl-muted">${esc(i.description)}</span>` : ''}</td>
            <td><span class="pl-status ${i.status === 'overdue' ? 'warn' : ''}">${esc(i.label)}</span></td>
            <td>${esc(i.due)}</td><td class="n">${i.status === 'paid' ? '' : esc(money(i.balance))}</td>
            <td><a href="${esc(i.url)}" target="_blank" rel="noopener" data-open="opened_invoice" data-project="${esc(d.id)}" data-detail="${esc(i.number)}">${i.status === 'paid' ? 'View' : 'View and pay'}</a></td></tr>`)) : (earlierInvoices.length ? '' : `<span class="pl-muted">No invoices yet.</span>`))
        + earlierInvoices.map((f) => `<div class="pl-need"><span>${esc(f.name)}<br><span class="pl-muted">${esc(f.when)}</span></span><a href="${esc(f.url)}" target="_blank" rel="noopener" data-open="opened_invoice" data-project="${esc(d.id)}" data-detail="${esc(f.name)}">Open</a></div>`).join('')) : ''}
      ${card('Photos', d.photos.length ? `<div class="pl-grid">${d.photos.map(photoTile).join('')}</div>` : `<span class="pl-muted">No photos shared yet.</span>`)}
      ${card('Documents', `
        ${d.documents.length ? d.documents.map((f) => `<div class="pl-need"><span>${esc(f.name)}<br><span class="pl-muted">${esc(f.when)}</span></span><a href="${esc(f.url)}" target="_blank" rel="noopener" data-open="opened_document" data-project="${esc(d.id)}" data-detail="${esc(f.name)}">Open</a></div>`).join('') : `<span class="pl-muted">No documents shared yet.</span>`}
        ${d.ratesUrl ? `<div class="pl-need" style="border-top:1px solid var(--border);"><span>Schedule of Rates${d.agreement ? `<br><span class="pl-muted">Your commercial agreement: ${esc(d.agreement.percentOff)}% off labour</span>` : ''}</span><a href="${esc(d.ratesUrl)}" target="_blank" rel="noopener" data-open="opened_rates" data-project="${esc(d.id)}">Open</a></div>` : ''}`)}
      </div></div>`;
    main.querySelectorAll('.pl-grid img').forEach((img) => img.addEventListener('click', () => lightbox(pictures, Number(img.dataset.i))));
    wireAsk(d);
    const msgs = document.getElementById('pl-msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    const sendBtn = document.getElementById('pl-msg-send');
    if (sendBtn) sendBtn.addEventListener('click', async (e) => {
      const text = document.getElementById('pl-msg-body').value.trim();
      if (!text) return;
      e.target.disabled = true;
      try { await call('portal-write', { action: 'message', projectId: d.id, body: text }); showJob(d.id); } catch (err) { document.getElementById('pl-msg-err').innerHTML = `<p class="pl-muted" style="color:#c0272d;">${esc(err.message)}</p>`; e.target.disabled = false; }
    });
    const more = document.getElementById('pl-more-send');
    if (more) more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        const files = await readFiles(document.getElementById('pl-more-files'));
        await call('portal-write', { action: 'add_more', projectId: d.id, note: document.getElementById('pl-more-note').value, files });
        showJob(d.id);
      } catch (err) { document.getElementById('pl-more-msg').innerHTML = `<p class="pl-muted" style="color:#c0272d;">${esc(err.message)}</p>`; more.disabled = false; }
    });
    if (d.hasWork) showWork(d.work);
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

  function showWork(work) {
    const el = document.getElementById('pl-work');
    const inv = (x) => x.invoiced ? `<span class="pl-muted">${esc(x.invoiceNumber || 'Invoiced')}</span>` : 'Not yet';
    el.innerHTML = `
      <div class="pl-big">${esc(money(work.notInvoiced))}</div>
      <div class="pl-muted">About this much not yet invoiced (labour ${esc(money(work.labourOpen))}, materials ${esc(money(work.materialsOpen))}${work.priceListOpen ? `, price list ${esc(money(work.priceListOpen))}` : ''}, ex GST).${work.agreement ? ` Your commercial agreement (${esc(work.agreement.percentOff)}% off labour) comes off on the invoice.` : ''}</div>
      ${work.note ? `<p class="pl-muted">${esc(work.note)}</p>` : ''}
      <h3>Labour</h3>
      ${work.labour.length ? `${table(['Day', 'Who', 'Hours', '$Amount', 'Invoiced'], work.labour.map((l) => `
        <tr><td>${esc(l.day)}<br><span class="pl-muted">${esc(l.start)} to ${esc(l.end)}</span></td><td>${esc(l.who)}</td><td>${esc(l.bands || `${l.hours} h`)}</td><td class="n">${esc(money(l.amount))}</td><td>${inv(l)}</td></tr>`))}
        <p class="pl-muted" style="margin:6px 0 0;">Hours at the Schedule of Rates: ${esc(work.rules.standardHours)} standard, after hours and weekends at the schedule's rates, minimum ${esc(work.rules.minimumHours)} hours a day per person on the invoice.</p>` : `<span class="pl-muted">No hours logged yet.</span>`}
      <h3>Materials used</h3>
      ${work.materials.length ? table(['Item', 'Qty', 'From', '$Amount', 'Invoiced'], work.materials.map((m) => `
        <tr><td>${esc(m.description)}</td><td>${esc(m.quantity)}</td><td>${esc(m.from)}</td><td class="n">${esc(money(m.amount))}</td><td>${inv(m)}</td></tr>`)) : `<span class="pl-muted">No materials yet.</span>`}
      <h3>Orders</h3>
      ${work.purchaseOrders.length ? work.purchaseOrders.map((po) => `
        <details style="margin:6px 0;"><summary style="cursor:pointer;"><strong>PO ${esc(po.number)}</strong> ${esc(po.supplier)}: ${esc(po.state)} <span class="pl-muted">(${esc(money(po.total))})</span></summary>
          <table class="pl-table" style="margin-top:6px;"><tbody>${po.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${esc(l.quantity)}</td><td>${l.received ? 'Picked up' : l.backordered ? `Back order${l.eta ? `, due ${esc(l.eta)}` : ''}` : 'Ordered'}</td><td class="n">${esc(money(l.amount))}</td></tr>`).join('')}</tbody></table>
        </details>`).join('') : `<span class="pl-muted">No orders on this job.</span>`}`;
  }

  async function route() {
    if (!token()) { showLogin(); return; }
    try {
      if (params.get('job')) await showJob(params.get('job'));
      else await showOverview();
    } catch (err) {
      if (err.message === 'login' || err.message === 'password') return; // the login or password screen is already up
      main.innerHTML = `<a class="pl-back" href="/portal.html">&larr; All your jobs</a><div class="error-box">${esc(err.message)}</div>`;
    }
  }
  route();
})();
