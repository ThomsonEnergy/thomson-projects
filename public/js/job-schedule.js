// The job page's Schedule tab (docs/PROJECT_SPEC.md A34): bookings by day with "Client informed"
// badges, Move and Cancel per day, Email client booking, Ask client to pick a time, the time
// options sent and every schedule email. Loaded by project.html; needs supabase-client.js
// (supabaseClient, escapeHtml, projectRef, requiredTasksBlockingSchedule) and the page's own
// openScheduleStaffPanel(project) for Book people. Writes go through
// /.netlify/functions/schedule-client (Admin, Finance, Sales), reads straight from the tables.
(function () {
  const SYD = 'Australia/Sydney';
  const today = () => new Date().toLocaleDateString('en-CA', { timeZone: SYD });
  const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-AU', { timeZone: SYD, day: 'numeric', month: 'short' });
  const hhmm = (t) => String(t || '').slice(0, 5);
  const fmt12 = (t) => {
    const [h, m] = hhmm(t).split(':').map(Number);
    if (Number.isNaN(h)) return hhmm(t);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`;
  };
  const toSec = (t) => (String(t).length === 5 ? t + ':00' : String(t));
  const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const isWeekend = (ymd) => [0, 6].includes(new Date(ymd + 'T00:00:00Z').getUTCDay());
  const optionDates = (start, days, weekdaysOnly) => { const out = []; let d = start; while (out.length < Math.max(1, days)) { if (!(weekdaysOnly && isWeekend(d))) out.push(d); d = addDays(d, 1); } return out; };
  const optionLabel = (start, days, weekdaysOnly) => { const ds = optionDates(start, days, weekdaysOnly); return ds.length > 1 ? `${fmtDay(ds[0])} to ${fmtDay(ds[ds.length - 1])}` : fmtDay(ds[0]); };
  const KIND_LABEL = { booking_confirmed: 'Booking confirmed', booking_moved: 'Booking moved', booking_cancelled: 'Booking cancelled', time_offer: 'Time options sent', time_offer_picked: 'Client picked a time' };
  const esc = (s) => escapeHtml(s);
  const S = { project: null, canEdit: false, rows: [], offers: [], emails: [], recipient: null, staff: null, loaded: false };

  async function call(body) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch('/.netlify/functions/schedule-client', {
      method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: S.project.id, ...body }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
    return data;
  }
  const errBox = (el, msg) => { el.innerHTML = `<div class="error-box">${esc(msg)}</div>`; };

  // ---------- the tab ----------
  function initJobSchedule(project, pricingVisible) {
    const tab = document.querySelector('#job-tabs .settings-tab[data-panel="schedule"]');
    if (!tab) return;
    S.project = project; S.canEdit = !!pricingVisible; S.loaded = false;
    S.recipient = null; S.rows = []; S.offers = []; S.emails = []; // the page re-renders after Details edits: read everything again
    const load = () => { if (!S.loaded) { S.loaded = true; loadJobSchedule(project); } };
    tab.addEventListener('click', load);
    const wire = (id, fn) => { const b = document.getElementById(id); if (b) b.addEventListener('click', fn); };
    wire('job-sched-book-btn', () => openScheduleStaffPanel(project));
    wire('job-sched-email-btn', () => openEmailBookingOverlay(project));
    wire('job-sched-ask-btn', () => openAskClientOverlay(project));
    if (new URLSearchParams(window.location.search).get('tab') === 'schedule') tab.click();
  }

  async function loadJobSchedule(project) {
    S.project = project;
    const daysEl = document.getElementById('job-sched-days');
    if (!daysEl) return;
    const [{ data: rows, error }, { data: offers }, { data: emails }] = await Promise.all([
      supabaseClient.from('schedule_assignments').select('id, staff_id, assignment_date, start_time, end_time, block_type, note, client_informed_at, time_offer_id, profiles(full_name)')
        .eq('project_id', project.id).order('assignment_date').order('start_time'),
      supabaseClient.from('schedule_time_offers').select('id, project_id, staff_ids, start_time, end_time, days, weekdays_only, option_dates, message, to_email, to_name, status, picked_date, picked_at, client_message, email_id, created_by, created_at, viewed_at, sender:profiles!schedule_time_offers_created_by_fkey(full_name)').eq('project_id', project.id).order('created_at', { ascending: false }),
      supabaseClient.from('schedule_emails').select('*, sender:profiles!schedule_emails_sent_by_fkey(full_name)').eq('project_id', project.id).order('sent_at', { ascending: false }),
    ]);
    if (error) { errBox(daysEl, error.message); return; }
    S.rows = rows || []; S.offers = offers || []; S.emails = emails || [];
    renderDays(); renderOffers(); renderEmails();
    const recEl = document.getElementById('job-sched-client');
    if (!S.canEdit) { if (recEl) recEl.textContent = ''; return; }
    if (recEl && !S.recipient) {
      try { S.recipient = await call({ action: 'recipient' }); } catch (e) { S.recipient = { to: '', source: 'none' }; }
    }
    if (recEl) {
      recEl.innerHTML = S.recipient && S.recipient.to
        ? `Client emails go to <b>${esc(S.recipient.to)}</b> (${esc(S.recipient.source)}${S.recipient.name ? ', ' + esc(S.recipient.name) : ''}).`
        : '<span style="color:var(--red);">No client email on this job: add one under Details (or a job contact) before emailing.</span>';
    }
  }

  function dayGroups(rows) {
    const map = new Map();
    for (const r of rows) { if (!map.has(r.assignment_date)) map.set(r.assignment_date, []); map.get(r.assignment_date).push(r); }
    return [...map.entries()].map(([date, list]) => ({ date, rows: list })).sort((a, b) => a.date.localeCompare(b.date));
  }
  const badgeFor = (dayRows, isPast) => {
    const informed = dayRows.filter((r) => r.client_informed_at);
    if (informed.length === dayRows.length) return `<span class="badge accepted" title="Every booking that day">Client informed ${esc(fmtDate(informed[0].client_informed_at))}</span>`;
    if (informed.length) return `<span class="badge" style="background:rgba(245,158,11,0.14); color:#b45309; border:1px solid rgba(245,158,11,0.5);">Client told of ${informed.length} of ${dayRows.length}</span>`;
    return isPast ? '' : `<span class="badge" style="background:rgba(245,158,11,0.14); color:#b45309; border:1px solid rgba(245,158,11,0.5);">Client not informed</span>`;
  };

  function renderDays() {
    const el = document.getElementById('job-sched-days');
    const t = today();
    const groups = dayGroups(S.rows);
    const upcoming = groups.filter((g) => g.date >= t);
    const past = groups.filter((g) => g.date < t);
    const dayHtml = (g, isPast) => {
      const times = [...new Set(g.rows.map((r) => `${hhmm(r.start_time)}-${hhmm(r.end_time)}`))];
      const sameTimes = times.length === 1;
      const kind = g.rows.some((r) => r.block_type === 'site_visit') ? ' <span class="subtitle" style="font-size:12px;">(site visit)</span>' : '';
      return `<div class="sched-day" data-date="${g.date}" style="padding:10px 0; border-bottom:1px solid var(--border); ${isPast ? 'opacity:0.65;' : ''}">
        <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
          <div><strong>${esc(fmtDay(g.date))}</strong>${sameTimes ? ` <span class="subtitle">${esc(fmt12(g.rows[0].start_time))} to ${esc(fmt12(g.rows[0].end_time))}</span>` : ''}${kind} ${badgeFor(g.rows, isPast)}</div>
          ${S.canEdit && !isPast ? `<div style="display:flex; gap:6px; flex-wrap:wrap;">
            ${g.rows.some((r) => !r.client_informed_at) ? `<button type="button" class="secondary js-sched-told" style="font-size:12px; padding:5px 10px;">Mark as told</button>` : ''}
            <button type="button" class="secondary js-sched-move" style="font-size:12px; padding:5px 10px;">Move</button>
            <button type="button" class="secondary js-sched-cancel" style="font-size:12px; padding:5px 10px;">Cancel</button>
          </div>` : ''}
        </div>
        <div style="margin-top:4px; font-size:13px; display:flex; gap:6px 14px; flex-wrap:wrap;">
          ${g.rows.map((r) => `<span>${esc((r.profiles && r.profiles.full_name) || 'Someone')}${sameTimes ? '' : ` <span class="subtitle">${esc(fmt12(r.start_time))} to ${esc(fmt12(r.end_time))}</span>`}${r.note ? ` <span class="subtitle">(${esc(r.note)})</span>` : ''}${S.canEdit && !isPast ? ` <button type="button" class="js-sched-remove" data-id="${r.id}" title="Remove this person" style="all:unset; cursor:pointer; color:var(--muted); padding:0 4px;">&times;</button>` : ''}</span>`).join('')}
        </div>
      </div>`;
    };
    el.innerHTML = (upcoming.length ? upcoming.map((g) => dayHtml(g, false)).join('') : '<p class="subtitle">Nothing booked yet.</p>')
      + (past.length ? `<details style="margin-top:10px;"><summary style="cursor:pointer; font-size:13px;" class="subtitle">${past.length} past day${past.length === 1 ? '' : 's'}</summary>${past.map((g) => dayHtml(g, true)).join('')}</details>` : '');
    el.querySelectorAll('.sched-day').forEach((dayEl) => {
      const g = groups.find((x) => x.date === dayEl.dataset.date);
      const q = (c) => dayEl.querySelector(c);
      if (q('.js-sched-move')) q('.js-sched-move').addEventListener('click', () => openMoveOverlay(g));
      if (q('.js-sched-cancel')) q('.js-sched-cancel').addEventListener('click', () => openCancelOverlay(g));
      if (q('.js-sched-told')) q('.js-sched-told').addEventListener('click', () => markTold(g));
      dayEl.querySelectorAll('.js-sched-remove').forEach((b) => b.addEventListener('click', async () => {
        const r = g.rows.find((x) => x.id === b.dataset.id);
        // the client was told about this person's day, or they are the only one booked: that is a cancel, with the client email offered
        if (r.client_informed_at || g.rows.length === 1) { openCancelOverlay({ date: g.date, rows: [r] }); return; }
        if (!confirm(`Remove ${(r.profiles && r.profiles.full_name) || 'this person'} from ${fmtDay(g.date)}?`)) return;
        const { error } = await supabaseClient.from('schedule_assignments').delete().eq('id', r.id);
        if (error) { alert(error.message); return; }
        await logActivity('project', S.project.id, 'booking_cancelled', `${(r.profiles && r.profiles.full_name) || 'Someone'} removed from ${fmtDay(g.date)}`);
        loadJobSchedule(S.project);
      }));
    });
  }

  function renderOffers() {
    const el = document.getElementById('job-sched-offers');
    if (!el) return;
    if (!S.offers.length) { el.innerHTML = '<p class="subtitle">None sent yet. "Ask client to pick a time" offers a few dates and the client picks one on a private link.</p>'; return; }
    const badge = (o) => ({
      open: '<span class="badge sent">Waiting on the client</span>',
      picked: `<span class="badge accepted">Picked ${esc(o.picked_date ? fmtDay(o.picked_date) : '')}</span>`,
      declined: '<span class="badge declined">None suited</span>',
      withdrawn: '<span class="badge draft">Withdrawn</span>',
    }[o.status] || '');
    el.innerHTML = S.offers.map((o) => `<div data-offer="${o.id}" style="padding:10px 0; border-bottom:1px solid var(--border);">
      <div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center;">
        <div>${badge(o)} <span style="font-size:13px;">${esc(fmt12(o.start_time))} to ${esc(fmt12(o.end_time))}${o.days > 1 ? `, ${o.days} days` : ''}</span></div>
        ${S.canEdit && o.status === 'open' ? `<div style="display:flex; gap:6px;"><button type="button" class="secondary js-offer-copy" style="font-size:12px; padding:5px 10px;">Copy link</button><button type="button" class="secondary js-offer-withdraw" style="font-size:12px; padding:5px 10px;">Withdraw</button></div>` : ''}
      </div>
      <div style="font-size:13px; margin-top:4px;">${(o.option_dates || []).map((d) => `<span style="display:inline-block; margin:2px 8px 2px 0; ${o.picked_date === d ? 'font-weight:600; color:var(--green);' : ''}">${esc(optionLabel(d, o.days, o.weekdays_only))}</span>`).join('')}</div>
      <p class="subtitle" style="margin:4px 0 0; font-size:12px;">Sent ${esc(fmtDate(o.created_at))} to ${esc(o.to_email)}${o.sender && o.sender.full_name ? ' by ' + esc(o.sender.full_name) : ''}${o.viewed_at ? ', opened ' + esc(fmtDate(o.viewed_at)) : ', not opened yet'}.${o.client_message ? ` Client: "${esc(o.client_message)}"` : ''}</p>
    </div>`).join('');
    el.querySelectorAll('[data-offer]').forEach((box) => {
      const o = S.offers.find((x) => x.id === box.dataset.offer);
      const copy = box.querySelector('.js-offer-copy');
      if (copy) copy.addEventListener('click', async () => {
        // the token is never in the tab's data: pricing roles fetch it when they copy the link
        const { data: tok, error: tokErr } = await supabaseClient.rpc('schedule_offer_token', { p_offer_id: o.id });
        if (tokErr || !tok) { alert('Only Admin, Finance or Sales can copy this link.'); return; }
        const url = `${shareOrigin()}/pick-time.html?token=${tok}`;
        try { await navigator.clipboard.writeText(url); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy link'; }, 2000); } catch (e) { prompt('Copy this link', url); }
      });
      const wd = box.querySelector('.js-offer-withdraw');
      if (wd) wd.addEventListener('click', async () => {
        if (!confirm('Withdraw these options? The link stops working and the client is not told.')) return;
        try { await call({ action: 'withdraw_offer', offerId: o.id }); loadJobSchedule(S.project); } catch (err) { alert(err.message); }
      });
    });
  }

  function renderEmails() {
    const el = document.getElementById('job-sched-emails');
    if (!el) return;
    if (!S.emails.length) { el.innerHTML = '<p class="subtitle">No booking emails sent yet.</p>'; return; }
    el.innerHTML = S.emails.map((e) => `<div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px;">
      <span><b>${esc(KIND_LABEL[e.kind] || e.kind)}</b> to ${esc(e.to_email)}${e.sender && e.sender.full_name ? ' by ' + esc(e.sender.full_name) : ''} <span class="subtitle">${esc(new Date(e.sent_at).toLocaleString('en-AU', { timeZone: SYD, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</span></span>
      ${e.thread_id ? `<a class="link-quiet" href="/inbox.html?thread=${esc(e.thread_id)}" style="font-size:12px;">Open email</a>` : ''}
    </div>`).join('');
  }

  // ---------- overlays ----------
  function overlay(html, z = 150) {
    const o = document.createElement('div');
    o.style.cssText = `position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:${z}; padding:16px; overflow-y:auto;`;
    o.innerHTML = `<div class="card" style="max-width:600px; width:100%; max-height:92vh; overflow-y:auto;">${html}</div>`;
    document.body.appendChild(o);
    return o;
  }
  const emailFields = (to, subject, body, toNote) => `
    <label>To</label><input class="js-to" type="email" value="${esc(to || '')}" placeholder="client@example.com" />
    ${toNote ? `<p class="subtitle" style="margin:2px 0 0; font-size:12px;">${esc(toNote)}</p>` : ''}
    <label>Subject</label><input class="js-subject" value="${esc(subject || '')}" />
    <label>Message <span class="subtitle" style="font-weight:400;">(your name and signature are added on sending)</span></label>
    <textarea class="js-body" rows="12" style="font-size:13px;" placeholder="${esc(body || 'The email is written from the booking details once they are filled in.')}"></textarea>
    <div style="display:flex; justify-content:flex-end;"><button type="button" class="js-refresh" style="all:unset; cursor:pointer; font-size:12px; color:var(--link); text-decoration:underline;">Rewrite from the booking details</button></div>`;
  const toNoteFor = () => (S.recipient && S.recipient.to ? `${S.recipient.source === 'job contact' ? 'The job contact' : 'The client email on the job'}${S.recipient.name ? ' (' + S.recipient.name + ')' : ''}.` : 'No client email on this job yet, type one in.');

  // Keeps a drafted email fresh while the booking details change, unless the person edited it
  // (typing, or Polish and Fix spelling from writing-help.js: any input event counts). Only the
  // latest draft asked for is written, and nothing can be sent until a draft has landed.
  function draftKeeper(ov, getDraftBody) {
    const bodyEl = ov.querySelector('.js-body');
    const subjEl = ov.querySelector('.js-subject');
    const msgEl = ov.querySelector('.js-msg');
    let edited = false, subjectEdited = false, ready = false, seq = 0;
    bodyEl.addEventListener('input', () => { edited = true; ready = !!bodyEl.value.trim(); });
    subjEl.addEventListener('input', () => { subjectEdited = true; });
    const refresh = async (force) => {
      if (edited && !force) return;
      const mine = ++seq;
      try {
        const d = await call({ action: 'draft', ...getDraftBody() });
        if (mine !== seq) return; // a later draft is on its way
        bodyEl.value = d.body;
        if (!subjectEdited || force) subjEl.value = d.subject;
        edited = false; subjectEdited = subjectEdited && !force; ready = true;
        const toEl = ov.querySelector('.js-to');
        if (toEl && !toEl.value) toEl.value = d.to || '';
        if (msgEl) msgEl.innerHTML = '';
      } catch (err) {
        if (mine !== seq) return;
        ready = false;
        if (msgEl) errBox(msgEl, `Could not write the email: ${err.message}. Press "Rewrite from the booking details" to try again.`);
      }
    };
    refresh.isReady = () => ready && !!bodyEl.value.trim();
    ov.querySelector('.js-refresh').addEventListener('click', () => refresh(true));
    return refresh;
  }
  const notReady = (msg) => errBox(msg, 'The email has not been written yet. Press "Rewrite from the booking details", or type it.');
  const readEmail = (ov) => ({ to: ov.querySelector('.js-to').value.trim(), subject: ov.querySelector('.js-subject').value.trim(), body: ov.querySelector('.js-body').value });

  // Email client booking: pick the days, check the text, send. `preselect` are booking ids just made.
  async function openEmailBookingOverlay(project, preselect) {
    S.project = project;
    if (!S.rows.length || preselect) {
      const { data } = await supabaseClient.from('schedule_assignments').select('id, staff_id, assignment_date, start_time, end_time, block_type, note, client_informed_at, time_offer_id, profiles(full_name)').eq('project_id', project.id).order('assignment_date').order('start_time');
      S.rows = data || [];
    }
    if (!S.recipient) { try { S.recipient = await call({ action: 'recipient' }); } catch (e) { S.recipient = { to: '', source: 'none' }; } }
    const t = today();
    const groups = dayGroups(S.rows).filter((g) => g.date >= t);
    if (!groups.length) { alert('Nothing is booked from today on. Book people first.'); return; }
    const pre = new Set(preselect || []);
    const tick = (g) => (pre.size ? g.rows.some((r) => pre.has(r.id)) : g.rows.some((r) => !r.client_informed_at)) || (!pre.size && !groups.some((x) => x.rows.some((r) => !r.client_informed_at)));
    const ov = overlay(`<h2>Email the booking to the client</h2>
      <p class="subtitle" style="margin-bottom:10px;">Goes from sales@ in your name with your signature, and is kept on the job. Those days are then marked "Client informed".</p>
      <p class="subtitle" style="margin:0 0 4px; font-weight:600;">Days to include</p>
      ${groups.map((g) => `<label style="display:flex; align-items:center; gap:8px; margin:0 0 4px; font-weight:400; font-size:13px;"><input type="checkbox" class="js-day" value="${g.date}" ${tick(g) ? 'checked' : ''} style="width:auto;" /> ${esc(fmtDay(g.date))}, ${esc(fmt12(g.rows[0].start_time))} to ${esc(fmt12(g.rows[0].end_time))}: ${esc(g.rows.map((r) => (r.profiles && r.profiles.full_name) || 'Someone').join(', '))}${g.rows.every((r) => r.client_informed_at) ? ' <span class="badge accepted" style="font-size:9px;">informed</span>' : ''}</label>`).join('')}
      ${emailFields(S.recipient.to, '', 'Tick the days and the email is written from them.', toNoteFor())}
      <div class="js-msg"></div>
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" class="js-send">Send</button><button type="button" class="secondary js-close">Cancel</button></div>`);
    const ids = () => groups.filter((g) => ov.querySelector(`.js-day[value="${g.date}"]`).checked).flatMap((g) => g.rows.map((r) => r.id));
    const refresh = draftKeeper(ov, () => ({ kind: 'booking_confirmed', assignmentIds: ids() }));
    ov.querySelectorAll('.js-day').forEach((c) => c.addEventListener('change', () => { if (ids().length) refresh(false); }));
    if (ids().length) refresh(true);
    ov.querySelector('.js-close').addEventListener('click', () => ov.remove());
    ov.querySelector('.js-send').addEventListener('click', async () => {
      const msg = ov.querySelector('.js-msg');
      const btn = ov.querySelector('.js-send');
      const picked = ids();
      if (!picked.length) { errBox(msg, 'Tick at least one day.'); return; }
      if (!refresh.isReady()) { notReady(msg); return; }
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        await call({ action: 'email_booking', assignmentIds: picked, ...readEmail(ov) });
        ov.remove();
        loadJobSchedule(project);
      } catch (err) { errBox(msg, err.message); btn.disabled = false; btn.textContent = 'Send'; }
    });
  }

  async function markTold(g) {
    const ids = g.rows.filter((r) => !r.client_informed_at).map((r) => r.id);
    const how = prompt(`Mark ${fmtDay(g.date)} as told to the client without an email. How? Type "phone" or "in person".`, 'phone');
    if (how === null) return;
    try { await call({ action: 'mark_informed', assignmentIds: ids, how: /person/i.test(how) ? 'in_person' : 'phone' }); loadJobSchedule(S.project); } catch (err) { alert(err.message); }
  }

  function openMoveOverlay(g) {
    const informed = g.rows.some((r) => r.client_informed_at);
    const ov = overlay(`<h2>Move ${esc(fmtDay(g.date))}</h2>
      <p class="subtitle" style="margin-bottom:10px;">${esc(g.rows.map((r) => (r.profiles && r.profiles.full_name) || 'Someone').join(', '))}. Everyone booked that day moves together; the staff get a phone notification.</p>
      <div class="grid cols-3">
        <div><label style="margin-top:0;">New date</label><input type="date" class="js-date" value="${g.date}" min="${today()}" /></div>
        <div><label style="margin-top:0;">Start</label><input type="time" class="js-start" value="${hhmm(g.rows[0].start_time)}" /></div>
        <div><label style="margin-top:0;">Finish</label><input type="time" class="js-end" value="${hhmm(g.rows[0].end_time)}" /></div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:10px;"><input type="checkbox" class="js-email" ${informed ? 'checked' : ''} style="width:auto;" /> Email the client the new time${informed ? ' (they were told the old one)' : ' (they have not been told about this day, so it reads as a first confirmation)'}</label>
      <div class="js-email-box">${emailFields(S.recipient ? S.recipient.to : '', '', 'Pick the new day and the email is written from it.', toNoteFor())}</div>
      <p class="subtitle js-no-email" style="display:none; font-size:12px;">Without an email the day shows as "Client not informed" until you email or mark it as told.</p>
      <div class="js-msg"></div>
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" class="js-go">Move</button><button type="button" class="secondary js-close">Keep as is</button></div>`);
    const ids = g.rows.map((r) => r.id);
    const move = () => ({ date: ov.querySelector('.js-date').value, start: ov.querySelector('.js-start').value, end: ov.querySelector('.js-end').value });
    const refresh = draftKeeper(ov, () => ({ kind: informed ? 'booking_moved' : 'booking_confirmed', assignmentIds: ids, move: move() }));
    const emailBox = ov.querySelector('.js-email-box');
    const emailTick = ov.querySelector('.js-email');
    const syncEmail = () => { emailBox.style.display = emailTick.checked ? '' : 'none'; ov.querySelector('.js-no-email').style.display = emailTick.checked ? 'none' : ''; if (emailTick.checked) refresh(false); };
    emailTick.addEventListener('change', syncEmail);
    ['.js-date', '.js-start', '.js-end'].forEach((c) => ov.querySelector(c).addEventListener('change', () => { if (emailTick.checked) refresh(false); }));
    syncEmail();
    ov.querySelector('.js-close').addEventListener('click', () => ov.remove());
    ov.querySelector('.js-go').addEventListener('click', async () => {
      const msg = ov.querySelector('.js-msg');
      const btn = ov.querySelector('.js-go');
      const m = move();
      if (!m.date || !m.start || !m.end || m.end <= m.start) { errBox(msg, 'Pick the day and a finish after the start.'); return; }
      if (emailTick.checked && !refresh.isReady()) { notReady(msg); return; }
      btn.disabled = true; btn.textContent = 'Moving...';
      try {
        await call({ action: 'move', assignmentIds: ids, ...m, email: emailTick.checked, ...(emailTick.checked ? readEmail(ov) : {}) });
        ov.remove(); loadJobSchedule(S.project);
      } catch (err) { errBox(msg, err.message); btn.disabled = false; btn.textContent = 'Move'; }
    });
  }

  // ----- the time options form, shared by Cancel (offer new times) and Ask client -----
  async function staffList() {
    if (!S.staff) { const { data } = await supabaseClient.from('profiles').select('id, full_name').eq('active', true).order('full_name'); S.staff = data || []; }
    return S.staff;
  }
  function offerFormHtml(staff, pre) {
    const t = today();
    const dates = (pre.optionDates && pre.optionDates.length ? pre.optionDates : [addDays(t, 1), addDays(t, 2), addDays(t, 3)]);
    return `<p class="subtitle" style="margin:10px 0 4px; font-weight:600;">Who would do the work</p>
      <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:4px 12px; margin-bottom:8px;">
        ${staff.map((p) => `<label style="display:flex; align-items:center; gap:6px; margin:0; font-weight:400;"><input type="checkbox" class="js-staff" value="${p.id}" ${(pre.staffIds || []).includes(p.id) ? 'checked' : ''} style="width:auto;" /> ${esc(p.full_name || 'Unnamed')}</label>`).join('')}
      </div>
      <div class="grid cols-3">
        <div><label style="margin-top:0;">Start</label><input type="time" class="js-ostart" value="${esc(pre.start || '07:00')}" /></div>
        <div><label style="margin-top:0;">Finish</label><input type="time" class="js-oend" value="${esc(pre.end || '15:30')}" /></div>
        <div><label style="margin-top:0;">Days each</label><input type="number" class="js-odays" min="1" max="10" value="${pre.days || 1}" /></div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-weight:400;"><input type="checkbox" class="js-oweekdays" ${pre.weekdaysOnly === false ? '' : 'checked'} style="width:auto;" /> Weekdays only</label>
      <p class="subtitle" style="margin:10px 0 4px; font-weight:600;">Dates to offer (2 to 6)</p>
      <div class="js-odates">${dates.map((d) => optionRowHtml(d)).join('')}</div>
      <button type="button" class="secondary js-oadd" style="font-size:12px; padding:5px 10px; margin-top:4px;">+ Add a date</button>
      <p class="subtitle js-oavail" style="margin:6px 0 0; font-size:12px;"></p>`;
  }
  const optionRowHtml = (d) => `<div class="js-orow" style="display:flex; gap:8px; align-items:center; margin:0 0 4px; flex-wrap:wrap;"><input type="date" class="js-odate" value="${esc(d)}" min="${today()}" style="width:auto;" /><span class="js-ostatus subtitle" style="font-size:12px;"></span><button type="button" class="js-oremove" title="Remove" style="all:unset; cursor:pointer; color:var(--muted); padding:0 4px;">&times;</button></div>`;
  function readOfferForm(ov) {
    return {
      staffIds: [...ov.querySelectorAll('.js-staff:checked')].map((c) => c.value),
      start: ov.querySelector('.js-ostart').value, end: ov.querySelector('.js-oend').value,
      days: Math.max(1, Math.min(10, parseInt(ov.querySelector('.js-odays').value, 10) || 1)),
      weekdaysOnly: ov.querySelector('.js-oweekdays').checked,
      optionDates: [...ov.querySelectorAll('.js-odate')].map((i) => i.value).filter(Boolean),
    };
  }
  // greys out an option when someone chosen is already booked, or on approved leave, on one of its
  // days (the same rule as time_offer_person_busy in the database). excludeIds: bookings about to go.
  async function checkOfferAvailability(ov, excludeIds) {
    const o = readOfferForm(ov);
    const rows = [...ov.querySelectorAll('.js-orow')];
    const note = ov.querySelector('.js-oavail');
    if (!o.staffIds.length || !o.optionDates.length || !o.start || !o.end) { note.textContent = ''; rows.forEach((r) => { r.querySelector('.js-ostatus').textContent = ''; }); return { clashes: 0 }; }
    const spans = o.optionDates.map((d) => optionDates(d, o.days, o.weekdaysOnly));
    const all = spans.flat();
    const from = all.reduce((a, b) => (a < b ? a : b));
    const to = all.reduce((a, b) => (a > b ? a : b));
    const [{ data: existingAll }, { data: leave }] = await Promise.all([
      supabaseClient.from('schedule_assignments').select('id, staff_id, assignment_date, start_time, end_time, profiles(full_name), projects(name, job_number)').in('staff_id', o.staffIds).gte('assignment_date', from).lte('assignment_date', to),
      supabaseClient.from('leave_requests').select('staff_id, start_date, end_date, profiles!leave_requests_staff_id_fkey(full_name)').in('staff_id', o.staffIds).eq('status', 'approved').lte('start_date', to).gte('end_date', from),
    ]);
    const existing = (existingAll || []).filter((e) => !(excludeIds && excludeIds.has(e.id)));
    let clashes = 0;
    rows.forEach((row) => {
      const d = row.querySelector('.js-odate').value;
      const st = row.querySelector('.js-ostatus');
      if (!d) { st.textContent = ''; return; }
      const ds = optionDates(d, o.days, o.weekdaysOnly);
      const hits = existing.filter((e) => ds.includes(e.assignment_date) && toSec(e.start_time) < toSec(o.end) && toSec(o.start) < toSec(e.end_time));
      const away = (leave || []).filter((l) => ds.some((day) => l.start_date <= day && l.end_date >= day));
      if (hits.length || away.length) {
        clashes += 1;
        row.style.opacity = '0.6';
        const why = hits.length
          ? `${(hits[0].profiles && hits[0].profiles.full_name) || 'Someone'} is booked ${hhmm(hits[0].start_time)} to ${hhmm(hits[0].end_time)} on ${fmtDay(hits[0].assignment_date)}${hits[0].projects ? ' (' + (hits[0].projects.job_number ? 'J' + hits[0].projects.job_number + ' ' : '') + (hits[0].projects.name || '') + ')' : ''}`
          : `${(away[0].profiles && away[0].profiles.full_name) || 'Someone'} is on leave ${fmtDay(away[0].start_date)}${away[0].end_date !== away[0].start_date ? ' to ' + fmtDay(away[0].end_date) : ''}`;
        st.innerHTML = `<span style="color:var(--red);">${esc(why)}</span>`;
      } else {
        row.style.opacity = '';
        st.innerHTML = `<span style="color:var(--green);">free${o.days > 1 ? ', ' + esc(optionLabel(d, o.days, o.weekdaysOnly)) : ''}</span>`;
      }
    });
    note.textContent = clashes ? 'Change or remove the dates in red before sending.' : '';
    return { clashes };
  }
  function wireOfferForm(ov, onChange) {
    const box = ov.querySelector('.js-odates');
    const rewire = () => {
      box.querySelectorAll('.js-oremove').forEach((b) => { b.onclick = () => { if (box.querySelectorAll('.js-orow').length > 1) { b.closest('.js-orow').remove(); onChange(); } }; });
      box.querySelectorAll('.js-odate').forEach((i) => { i.onchange = onChange; });
    };
    ov.querySelector('.js-oadd').addEventListener('click', () => {
      if (box.querySelectorAll('.js-orow').length >= 6) return;
      const last = [...box.querySelectorAll('.js-odate')].map((i) => i.value).filter(Boolean).sort().pop() || today();
      box.insertAdjacentHTML('beforeend', optionRowHtml(addDays(last, 1)));
      rewire(); onChange();
    });
    ['.js-ostart', '.js-oend', '.js-odays', '.js-oweekdays'].forEach((c) => ov.querySelector(c).addEventListener('change', onChange));
    ov.querySelectorAll('.js-staff').forEach((c) => c.addEventListener('change', onChange));
    rewire();
  }
  function offerProblems(o) {
    if (!o.staffIds.length) return 'Pick at least one person.';
    if (!o.start || !o.end || o.end <= o.start) return 'Finish time must be after the start.';
    const ds = [...new Set(o.optionDates)];
    if (ds.length < 2) return 'Offer at least 2 dates.';
    if (ds.length > 6) return 'Offer 6 dates at most.';
    if (ds.some((d) => d < today())) return 'A date is in the past.';
    return null;
  }

  async function openAskClientOverlay(project, pre) {
    S.project = project;
    if (!S.recipient) { try { S.recipient = await call({ action: 'recipient' }); } catch (e) { S.recipient = { to: '', source: 'none' }; } }
    if (project.job_number) {
      const blocking = await requiredTasksBlockingSchedule(project.id);
      if (blocking.length) { alert(`This job can't be booked yet - required task${blocking.length > 1 ? 's' : ''} not done: ${blocking.join('; ')}`); return; }
    }
    const staff = await staffList();
    const ov = overlay(`<h2>Ask the client to pick a time</h2>
      <p class="subtitle" style="margin-bottom:6px;">The client gets an email with a private link, picks one of the dates, and everyone is booked for it on the spot (already marked client informed). You get a phone notification either way.</p>
      ${offerFormHtml(staff, pre || {})}
      ${emailFields(S.recipient.to, '', 'Pick the people and dates and the email is written from them.', toNoteFor())}
      <div class="js-msg"></div>
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" class="js-send">Send the options</button><button type="button" class="secondary js-close">Cancel</button></div>`);
    const refresh = draftKeeper(ov, () => ({ kind: 'time_offer', offer: readOfferForm(ov) }));
    let timer = null;
    const onChange = () => { clearTimeout(timer); timer = setTimeout(async () => { await checkOfferAvailability(ov); if (!offerProblems(readOfferForm(ov))) refresh(false); }, 300); };
    wireOfferForm(ov, onChange);
    onChange();
    ov.querySelector('.js-close').addEventListener('click', () => ov.remove());
    ov.querySelector('.js-send').addEventListener('click', async () => {
      const msg = ov.querySelector('.js-msg');
      const btn = ov.querySelector('.js-send');
      const o = readOfferForm(ov);
      const problem = offerProblems(o);
      if (problem) { errBox(msg, problem); return; }
      const { clashes } = await checkOfferAvailability(ov);
      if (clashes) { errBox(msg, 'One of the dates clashes with a booking or leave. Change or remove it.'); return; }
      if (!refresh.isReady()) { notReady(msg); return; }
      btn.disabled = true; btn.textContent = 'Sending...';
      try {
        await call({ action: 'offer', offer: o, ...readEmail(ov), toName: S.recipient.name || '' });
        ov.remove(); loadJobSchedule(project);
      } catch (err) { errBox(msg, err.message); btn.disabled = false; btn.textContent = 'Send the options'; }
    });
  }

  async function openCancelOverlay(g) {
    const informed = g.rows.some((r) => r.client_informed_at);
    const staff = await staffList();
    const ov = overlay(`<h2>Cancel ${esc(fmtDay(g.date))}</h2>
      <p class="subtitle" style="margin-bottom:10px;">${esc(g.rows.map((r) => (r.profiles && r.profiles.full_name) || 'Someone').join(', '))} come off the schedule for that day; they get a phone notification.</p>
      <label style="display:flex; align-items:center; gap:8px; font-weight:400;"><input type="checkbox" class="js-email" ${informed ? 'checked' : ''} style="width:auto;" /> Email the client${informed ? ' (they were told this time)' : ''}</label>
      <div class="js-email-box">
        <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-top:6px;"><input type="checkbox" class="js-offer" style="width:auto;" /> Offer new times in the same email (the client picks one on a private link)</label>
        <div class="js-offer-box" style="display:none;">${offerFormHtml(staff, { staffIds: g.rows.map((r) => r.staff_id), start: hhmm(g.rows[0].start_time), end: hhmm(g.rows[0].end_time) })}</div>
        ${emailFields(S.recipient ? S.recipient.to : '', '', 'Tick "Email the client" and the email is written.', toNoteFor())}
      </div>
      <div class="js-msg"></div>
      <div style="margin-top:14px; display:flex; gap:8px;"><button type="button" class="danger js-go">Cancel the booking</button><button type="button" class="secondary js-close">Keep it</button></div>`);
    const ids = g.rows.map((r) => r.id);
    const going = new Set(ids);
    const emailTick = ov.querySelector('.js-email');
    const offerTick = ov.querySelector('.js-offer');
    const refresh = draftKeeper(ov, () => ({ kind: 'booking_cancelled', assignmentIds: ids, offer: offerTick.checked ? true : undefined }));
    const sync = () => {
      ov.querySelector('.js-email-box').style.display = emailTick.checked ? '' : 'none';
      ov.querySelector('.js-offer-box').style.display = offerTick.checked ? '' : 'none';
      if (emailTick.checked) refresh(true);
      if (offerTick.checked) checkOfferAvailability(ov, going);
    };
    emailTick.addEventListener('change', sync);
    offerTick.addEventListener('change', sync);
    let timer = null;
    wireOfferForm(ov, () => { clearTimeout(timer); timer = setTimeout(() => checkOfferAvailability(ov, going), 300); });
    sync();
    ov.querySelector('.js-close').addEventListener('click', () => ov.remove());
    ov.querySelector('.js-go').addEventListener('click', async () => {
      const msg = ov.querySelector('.js-msg');
      const btn = ov.querySelector('.js-go');
      let offer;
      if (emailTick.checked && offerTick.checked) {
        offer = readOfferForm(ov);
        const problem = offerProblems(offer);
        if (problem) { errBox(msg, problem); return; }
        const { clashes } = await checkOfferAvailability(ov, going);
        if (clashes) { errBox(msg, 'One of the dates clashes with a booking or leave. Change or remove it.'); return; }
      } else if (!emailTick.checked && !confirm(`Cancel ${fmtDay(g.date)} without telling the client?`)) return;
      if (emailTick.checked && !refresh.isReady()) { notReady(msg); return; }
      btn.disabled = true; btn.textContent = 'Cancelling...';
      try {
        await call({ action: 'cancel', assignmentIds: ids, email: emailTick.checked, ...(emailTick.checked ? readEmail(ov) : {}), offer, toName: S.recipient ? S.recipient.name : '' });
        ov.remove(); loadJobSchedule(S.project);
      } catch (err) { errBox(msg, err.message); btn.disabled = false; btn.textContent = 'Cancel the booking'; }
    });
  }

  window.initJobSchedule = initJobSchedule;
  window.loadJobSchedule = loadJobSchedule;
  window.openEmailBookingOverlay = openEmailBookingOverlay;
})();
