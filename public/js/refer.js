// The referral link page (backlog item 74b, step 3a): refer.html?r=<token>. No login: the token in
// the link is the client's, and the server (refer.js function) only ever makes a lead in their name
// or a draft quote for them. Their own job ("Me") or someone else ("Quick" or "Full"); the type's
// questions use the quote's own question ids (and option lists from template-questions.js), so
// Create quote from the lead carries the answers. Photos are made smaller on the phone first.
// refer.html?s=<token> is a staff member's personal link (item 74b 7a): one form the customer fills in
// about their own job, ending with "How did you first hear about Thomson Energy?". The lead is that
// staff member's; the server decides whether it is a new customer or one we already had.

(function () {
  const root = document.getElementById('rf-root');
  const params = new URLSearchParams(location.search);
  const staffToken = params.get('s') || '';
  const token = staffToken || params.get('r') || '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const tomorrow = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const S = { info: null, who: null, kind: 'quick' };

  async function call(body) {
    const res = await fetch('/.netlify/functions/refer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [staffToken ? 's' : 'r']: token, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || 'Something went wrong. Please try again, or call us.');
    return data;
  }

  // the plain questions per job type; select options come from the quote's own question when it exists
  const quoteQ = (id) => {
    if (typeof TEMPLATE_QUESTIONS === 'undefined') return null;
    const all = [...(typeof SOLAR_QUESTIONS !== 'undefined' ? SOLAR_QUESTIONS : []), ...(typeof BATTERY_QUESTIONS !== 'undefined' ? BATTERY_QUESTIONS : []), ...Object.values(TEMPLATE_QUESTIONS).flat()];
    return all.find((q) => q && q.id === id) || null;
  };
  const sel = (id, label) => ({ id, label, type: 'select', options: ((quoteQ(id) || {}).options || []).concat('Not sure') });
  const text = (id, label, placeholder) => ({ id, label, type: 'text', placeholder });
  const QUESTIONS = {
    'Solar': [sel('roof_type', 'Roof'), sel('phases', 'Power supply'), { id: 'with_battery', label: 'Battery as well?', type: 'select', options: ['Yes', 'No', 'Not sure'] }, text('existing_pv', 'Any solar there now?', 'e.g. 5 kW from 2015, or none')],
    'Battery': [text('backup_needs', 'What should stay on in a blackout?', 'e.g. fridge, lights, pump'), text('existing_pv', 'Solar there now?', 'e.g. 6.6 kW, or none'), sel('phases', 'Power supply')],
    'Switchboard upgrade': [text('board_age', 'How old is the switchboard?', 'e.g. ceramic fuses, about 1970'), text('board_reason', 'Why now?', 'e.g. adding solar, tripping, selling the house')],
    'Fault find': [text('fault', 'What is happening?', 'e.g. kitchen circuit keeps tripping'), sel('urgency', 'How urgent?')],
    'Renovation': [text('reno_scope', 'What is being done?', 'e.g. new kitchen and laundry'), text('reno_when', 'When?', 'e.g. builder starts in March')],
    'Service work': [text('fault', 'What do they need?', 'e.g. new power points, outdoor lights'), sel('urgency', 'How urgent?')],
    'Other': [],
  };

  function showError(msg) { root.innerHTML = `<div class="rf-card"><p>${esc(msg)}</p><p class="rf-muted">Call Thomson Energy on <a href="tel:0455415464">0455 415 464</a>.</p></div>`; }

  async function start() {
    try { S.info = await call({ action: 'info' }); } catch (e) { showError(e.message); return; }
    window.ADDRESS_BOX_KEY = S.info.mapsKey || '';   // the address box offers Google's addresses (item 103)
    if (staffToken) drawStaffForm(); else drawWho();
  }

  // A staff member's link: the customer's own job, and how they heard of us. Nothing is ticked in
  // advance on that question, so the answer is theirs.
  function drawStaffForm() {
    const i = S.info;
    root.innerHTML = `
      <h1 style="font-size:20px; margin:12px 0 4px;">Get a quote from Thomson Energy</h1>
      <p class="rf-muted" style="margin:0 0 6px;">Sent to you by ${esc(i.staff)}. It takes about a minute.</p>
      <div class="rf-card">
        <label style="margin-top:0;">What kind of job?</label>
        <select id="rf-type">${i.types.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
        <div id="rf-qs"></div>
        <label>What do you need?</label>
        <textarea id="rf-need" rows="3" maxlength="3000" placeholder="A line or two is plenty"></textarea>
        <label>Photos (optional, up to 5)</label><input type="file" id="rf-files" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" />
      </div>
      <div class="rf-card">
        <strong>Your details</strong>
        <label>Name</label><input id="rf-name" autocomplete="name" />
        <label>Phone</label><input id="rf-phone" type="tel" autocomplete="tel" />
        <label>Email (optional)</label><input id="rf-email" type="email" autocomplete="email" />
        <label>Site address</label><input id="rf-address" autocomplete="street-address" />
        <label>How did you first hear about Thomson Energy?</label>
        <select id="rf-heard">
          <option value=""></option>
          <option value="owner">${esc(i.staff)} told me about you</option>
          ${i.team.length ? '<option value="staff">Someone else at Thomson Energy</option>' : ''}
          ${i.heard.map((h) => `<option>${esc(h)}</option>`).join('')}
        </select>
        <div id="rf-heard-who" style="display:none;"><label>Who was it?</label><select id="rf-heard-staff"><option value=""></option>${i.team.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></div>
      </div>
      <div id="rf-msg"></div>
      <button type="button" class="big" id="rf-send">Send</button>`;
    const typeSel = root.querySelector('#rf-type');
    const drawQs = () => { root.querySelector('#rf-qs').innerHTML = (QUESTIONS[typeSel.value] || []).map((q) => questionHtml({ ...q, label: q.label.replace('do they', 'do you') })).join(''); };
    typeSel.addEventListener('change', drawQs);
    drawQs();
    root.querySelector('#rf-heard').addEventListener('change', (e) => { root.querySelector('#rf-heard-who').style.display = e.target.value === 'staff' ? '' : 'none'; });
    wireAddressBox(root.querySelector('#rf-address'));
    root.querySelector('#rf-send').addEventListener('click', send);
  }

  function drawWho() {
    const r = S.info.rewards;
    root.innerHTML = `
      <h1 style="font-size:20px; margin:12px 0 4px;">Send us a job</h1>
      <p class="rf-muted" style="margin:0 0 6px;">From ${esc(S.info.client)}. It takes under a minute.</p>
      <div class="rf-card">
        <strong>Who is it for?</strong>
        <button type="button" class="rf-choice" data-who="me">Me<small>A job for ${esc(S.info.client)}: we quote it for you.</small></button>
        <button type="button" class="rf-choice" data-who="other">Someone else<small>Pass on a friend, a neighbour or a business contact.${r ? ` You get ${esc(r.how)} when we win it.` : ''}</small></button>
      </div>`;
    root.querySelectorAll('[data-who]').forEach((b) => b.addEventListener('click', () => { S.who = b.dataset.who; drawForm(); }));
  }

  function questionHtml(q) {
    if (q.type === 'select') return `<label>${esc(q.label)}</label><select data-q="${esc(q.id)}"><option value=""></option>${q.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`;
    return `<label>${esc(q.label)}</label><input data-q="${esc(q.id)}" placeholder="${esc(q.placeholder || '')}" />`;
  }

  function drawForm() {
    const r = S.info.rewards;
    const other = S.who === 'other';
    root.innerHTML = `
      <p style="margin:12px 0 0;"><a href="#" id="rf-back">&larr; Back</a></p>
      <div class="rf-card">
        ${other ? `
          <strong>How much do you know?</strong>
          <button type="button" class="rf-choice ${S.kind === 'quick' ? 'on' : ''}" data-kind="quick">Quick<small>Who they are, their number and what they need. 30 seconds.${r ? ` ${esc(r.quick)}.` : ''}</small></button>
          <button type="button" class="rf-choice ${S.kind === 'full' ? 'on' : ''}" data-kind="full">Full<small>Plus a few questions and photos (roof, switchboard or the fault).${r ? ` ${esc(r.full)}.` : ''}</small></button>` : ''}
        <label>What kind of job?</label>
        <select id="rf-type">${S.info.types.map((t) => `<option>${esc(t)}</option>`).join('')}</select>
        <div id="rf-qs"></div>
        <label>What do they need?</label>
        <textarea id="rf-need" rows="3" maxlength="3000" placeholder="A line or two is plenty"></textarea>
      </div>
      <div class="rf-card">
        ${other ? `
          <strong>Their details</strong>
          <label>Name</label><input id="rf-name" autocomplete="off" />
          <label>Phone</label><input id="rf-phone" type="tel" autocomplete="off" />
          <label>Email (optional)</label><input id="rf-email" type="email" autocomplete="off" />
          <label>Site address${S.kind === 'quick' ? ' (or the suburb)' : ''}</label><input id="rf-address" autocomplete="off" />` : `
          <strong>Your job</strong>
          <label>Site address</label><input id="rf-address" autocomplete="street-address" />
          <label>Quote needed by</label><input id="rf-due" type="date" min="${esc(tomorrow)}" />`}
        <div id="rf-photos"></div>
        ${other ? '<label class="tick"><input type="checkbox" id="rf-told" /> <span>I have told this person Thomson Energy will contact them.</span></label>' : ''}
      </div>
      <div id="rf-msg"></div>
      <button type="button" class="big" id="rf-send">Send</button>`;
    root.querySelector('#rf-back').addEventListener('click', (e) => { e.preventDefault(); drawWho(); });
    root.querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => { S.kind = b.dataset.kind; keep(drawForm); }));
    const typeSel = root.querySelector('#rf-type');
    const drawQs = () => {
      const full = !other || S.kind === 'full';
      root.querySelector('#rf-qs').innerHTML = full ? (QUESTIONS[typeSel.value] || []).map(questionHtml).join('') : '';
      root.querySelector('#rf-photos').innerHTML = full ? '<label>Photos (optional, up to 5)</label><input type="file" id="rf-files" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" />' : '';
    };
    typeSel.addEventListener('change', drawQs);
    drawQs();
    // a Quick referral may only know the suburb, so that box stays plain typing
    if (!(other && S.kind === 'quick')) wireAddressBox(root.querySelector('#rf-address'));
    root.querySelector('#rf-send').addEventListener('click', send);
  }

  // redraw keeping what was typed
  function keep(fn) {
    const vals = {};
    root.querySelectorAll('input:not([type=file]):not([type=checkbox]), select, textarea').forEach((el) => { if (el.id) vals[el.id] = el.value; });
    fn();
    Object.entries(vals).forEach(([id, v]) => { const el = document.getElementById(id); if (el) el.value = v; });
    const typeSel = document.getElementById('rf-type');
    if (typeSel) typeSel.dispatchEvent(new Event('change'));
  }

  async function shrink(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 900 * 1024) return file;
    try {
      const img = await createImageBitmap(file);
      const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const blob = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.8));
      return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }
  const toB64 = (blob) => new Promise((ok, fail) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = fail; r.readAsDataURL(blob); });

  async function send(e) {
    const msg = root.querySelector('#rf-msg');
    const v = (id) => { const el = root.querySelector('#' + id); return el ? el.value : ''; };
    e.target.disabled = true;
    msg.innerHTML = '<p class="rf-muted">Sending...</p>';
    try {
      const input = root.querySelector('#rf-files');
      const list = input ? [...(input.files || [])] : [];
      if (list.length > 5) throw new Error('Up to 5 photos, please.');
      const files = [];
      let total = 0;
      for (const f of list) {
        const small = await shrink(f);
        total += small.size;
        if (total > 4 * 1024 * 1024) throw new Error('The photos come to more than 4 MB. Send fewer, or smaller ones.');
        files.push({ name: f.name, type: small.type || f.type, data: await toB64(small) });
      }
      const answers = {};
      root.querySelectorAll('[data-q]').forEach((el) => { if (el.value) answers[el.dataset.q] = el.value; });
      const told = root.querySelector('#rf-told');
      if (staffToken && !v('rf-heard')) throw new Error('Tell us how you first heard about Thomson Energy, please.');
      const out = await call({
        action: 'submit', heard: v('rf-heard'), heardStaffId: v('rf-heard-staff'), who: S.who, kind: S.kind, type: v('rf-type'), need: v('rf-need'), answers, files, dueDate: v('rf-due'),
        person: { name: v('rf-name'), phone: v('rf-phone'), email: v('rf-email'), address: v('rf-address'), addressParts: await addressBoxParts(root.querySelector('#rf-address')) }, told: told ? told.checked : false,
      });
      if (staffToken) { root.innerHTML = '<div class="rf-card" style="margin-top:20px;"><h1 style="font-size:20px; margin:0 0 6px;">Thank you</h1><p>We have your details and will be in touch soon.</p><p class="rf-muted">Thomson Energy, <a href="tel:0455415464">0455 415 464</a></p></div>'; return; }
      root.innerHTML = `<div class="rf-card" style="margin-top:20px;"><h1 style="font-size:20px; margin:0 0 6px;">Thank you</h1><p>${out.kind === 'quote' ? `We have your job${out.ref ? ` (${esc(out.ref)})` : ''} and will be in touch. You can follow it in your portal.` : 'We have their details and will be in touch with them soon.'}</p><button type="button" class="secondary" id="rf-again">Send another</button></div>`;
      root.querySelector('#rf-again').addEventListener('click', drawWho);
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  }

  if (!token) showError('This link is missing its code. Please use the link we sent you.');
  else start();
})();
