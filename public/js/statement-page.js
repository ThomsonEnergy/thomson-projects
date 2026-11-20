// The client's statement page (statement.html?token=, owner 15 Nov 2026). Reads
// get_client_statement_by_token: every unpaid invoice across the client's jobs, oldest due first.
// Each invoice number links to its own invoice page, where Pay online pays that one invoice; the
// statement itself is paid by bank transfer (BSB and account below). ?print=1 lays it out for the
// PDF (generate-client-document-pdf, client_statement), which waits for data-print-ready.
// Needs supabase-client.js (supabaseClient, money, shareOrigin, smallLogoUrl).

(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const isPrint = params.get('print') === '1';
  if (isPrint) document.documentElement.classList.add('as-paper');

  const ACCOUNTS_EMAIL = 'admin@thomsonenergy.com.au';
  const PAGE_H = 1123, FOOT_RESERVE = 60;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const keyDate = (k) => new Date(String(k).slice(0, 10) + 'T00:00:00');
  const dateText = (d) => d.toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const daysBetween = (a, b) => Math.round((keyDate(b) - keyDate(a)) / 86400000);

  async function load() {
    const content = document.getElementById('content');
    const { data, error } = await supabaseClient.rpc('get_client_statement_by_token', { p_token: token });
    if (error || !data) {
      content.innerHTML = '<div class="error-box">This statement link isn\'t valid. Please check the link or contact us.</div>';
      return;
    }
    const s = data.company || {};
    s.logo_url = await smallLogoUrl(s.logo_url);
    const client = data.client || {};
    const asAt = data.as_at;
    const rows = (data.invoices || []).map((r) => {
      // no due date means due on receipt: counted from the invoice date
      const due = r.due_date || (r.sent_at ? new Date(r.sent_at).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) : null);
      const late = due && due < asAt ? daysBetween(due, asAt) : 0;
      return { ...r, late, balance: Number(r.balance) || 0, interest: Number(r.interest_accrued) || 0, url: shareOrigin() + '/invoice.html?token=' + encodeURIComponent(r.invoice_token) };
    });
    const total = Math.round(rows.reduce((t, r) => t + r.balance, 0) * 100) / 100;
    const interest = Math.round(rows.reduce((t, r) => t + r.interest, 0) * 100) / 100;
    const bucket = (lo, hi) => rows.filter((r) => r.late >= lo && r.late <= hi).reduce((t, r) => t + r.balance, 0);
    const aging = [['Not yet due', bucket(0, 0)], ['1 to 30 days', bucket(1, 30)], ['31 to 60 days', bucket(31, 60)], ['Over 60 days', bucket(61, Infinity)], ['Total owing', total]];
    const overdue = total - aging[0][1];
    const invNo = (n) => String(n).replace(/^INV-?/i, '');

    // ---- the letterhead, repeated on every sheet ----
    const link = (href, text) => `<a href="${esc(href)}" style="color:inherit; text-decoration:none;">${esc(text)}</a>`;
    const addressParts = String(s.address || '').split(/,\s*|\n/).filter(Boolean).slice(0, 3);
    const contactLines = [
      link('mailto:' + ACCOUNTS_EMAIL, ACCOUNTS_EMAIL),
      s.phone ? `Tel. ${link('tel:' + String(s.phone).replace(/[^+\d]/g, ''), s.phone)}` : '',
      addressParts.length ? addressParts.map(esc).join('<br>') : '',
      s.abn ? esc(`ABN ${s.abn}`) : '',
    ].filter(Boolean);
    const sheetHtml = (first) => `
      <section class="st-sheet">
        <div class="st-head">
          <div>
            ${s.logo_url ? `<img class="st-logo" src="${s.logo_url}" alt="${esc(s.company_name || '')}" />` : `<div style="font-size:26px; font-weight:700;">${esc(s.company_name || '')}</div>`}
            ${s.website ? (() => { const u = /^https?:/i.test(s.website) ? s.website : 'https://' + s.website; return `<div class="st-web">${link(u, u)}</div>`; })() : ''}
          </div>
          <div class="st-contact">${contactLines.join('<br>')}</div>
        </div>
        <div class="st-meta-row">
          <div class="st-bill">${first ? `${esc(client.name || '')}${client.address ? '<br>' + esc(client.address).replace(/,\s*/g, '<br>') : ''}` : ''}</div>
          <div class="st-right">
            <div class="st-strip">
              <div><div class="k">Statement date</div><div class="v">${dateText(keyDate(asAt))}</div></div>
              <div class="amt"><div class="k">Total owing</div><div class="v">${money(total)}</div></div>
              <div><div class="k">Overdue</div><div class="v">${money(overdue)}</div></div>
            </div>
            <div class="st-title">STATEMENT</div>
          </div>
        </div>
        <div class="st-body"></div>
        <div class="st-foot"></div>
      </section>`;

    const rowCells = (r) => [
      `<a href="${esc(r.url)}">${esc(invNo(r.invoice_number))}</a>${r.is_deposit ? '<div class="sub">Deposit</div>' : ''}${r.is_interest ? '<div class="sub">Late payment interest</div>' : ''}`,
      r.job_number ? `J${esc(r.job_number)}${r.job_name ? `<div class="sub">${esc(r.job_name)}</div>` : ''}` : (r.job_name ? esc(r.job_name) : ''),
      r.sent_at ? dateText(new Date(r.sent_at)) : '',
      r.due_date ? dateText(keyDate(r.due_date)) : 'On receipt',
      r.late ? `<span class="late">Overdue ${r.late} day${r.late === 1 ? '' : 's'}</span>` : 'Not yet due',
      money(r.balance),
    ];
    const head = ['Invoice', 'Job', 'Date', 'Due', 'Status', 'Owing'];
    const widths = ['13%', '33%', '12%', '12%', '16%', '14%'];
    const numCol = 5;

    const interestNote = interest > 0
      ? `Interest at ${esc(s.late_interest_rate_pct || 21)}% per annum is accruing on overdue invoices: ${money(interest)} to ${dateText(keyDate(asAt))}, not included in the total above. It is invoiced separately; paying an invoice online by card includes its interest to that day.`
      : '';
    // lead reward credit not yet on an invoice (item 74b part 2): it comes off their next invoice, so it is not in the total
    const waitingCredit = (Array.isArray(data.credits_waiting) ? data.credits_waiting : []).reduce((t, c) => t + (Number(c.amount) || 0), 0);
    const creditNote = waitingCredit > 0 ? `You have ${money(waitingCredit)} of lead reward credit waiting. It comes off your next invoice with us by itself.` : '';
    const bankRows = [
      s.bank_name ? ['Bank', s.bank_name] : null,
      s.bank_account_name ? ['Acc. Name', s.bank_account_name] : null,
      s.bank_bsb ? ['BSB', s.bank_bsb] : null,
      s.bank_account_number ? ['Acc. No.', s.bank_account_number] : null,
      ['Reference', 'The invoice numbers you are paying'],
    ].filter(Boolean);
    const noBank = !s.bank_name && !s.bank_account_number && !s.payment_details_text;
    const finalHtml = `
      <div class="st-final">
        <div class="st-aging">${aging.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${money(v)}</div></div>`).join('')}</div>
        ${interestNote ? `<p class="st-note">${interestNote}</p>` : ''}
        ${creditNote ? `<p class="st-note">${creditNote}</p>` : ''}
        <div class="st-howto">
          <h4>How To Pay</h4>
          ${rows.length ? `
          <div class="st-howto-cols">
            <div>
              <h5>Direct Deposit (the total owing, or any of the invoices)</h5>
              ${bankRows.map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
              ${s.payment_details_text ? `<div style="margin-top:4px; white-space:pre-wrap;">${esc(s.payment_details_text)}</div>` : ''}
              ${noBank ? '<div>Contact us for payment details.</div>' : ''}
            </div>
            <div>
              <h5>Credit Card (MasterCard or Visa)</h5>
              <div>Click an invoice number above to open that invoice and pay it online,</div>
              <div>or call ${esc(s.phone || 'us')} to pay over the phone.</div>
            </div>
          </div>` : '<p style="margin:12px 0 0; font-size:13px;">Nothing is owing. Thank you.</p>'}
        </div>
      </div>`;

    // Phone: a plain summary card above the sheet (the CSS shows it only under 840px; never in the PDF).
    const summaryHtml = isPrint ? '' : `
      <div class="doc-sum">
        <div class="ds-kicker">Statement for ${esc(client.name || '')} as at ${dateText(keyDate(asAt))}</div>
        <div class="ds-amount">${money(total)}</div>
        ${overdue > 0 ? `<div class="ds-late">${money(overdue)} overdue</div>` : ''}
        ${creditNote ? `<div>${creditNote}</div>` : ''}
        ${rows.length ? `
        <h3>Invoices (tap one to open or pay it)</h3>
        ${rows.map((r) => `<div class="ds-row"><span class="k"><a href="${esc(r.url)}">${esc(invNo(r.invoice_number))}</a>${r.job_number ? ` J${esc(r.job_number)}` : ''}${r.late ? ` <span class="ds-late">overdue</span>` : ''}</span><span class="v">${money(r.balance)}</span></div>`).join('')}
        <h3>Pay by bank transfer</h3>
        ${bankRows.map(([k, v]) => `<div class="ds-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('')}
        ${noBank ? '<div>Contact us for payment details.</div>' : ''}
        ${s.phone ? `<div style="margin-top:8px;">Card over the phone: <a href="${esc('tel:' + String(s.phone).replace(/[^+\d]/g, ''))}">${esc(s.phone)}</a></div>` : ''}` : '<p>Nothing is owing. Thank you.</p>'}
        <p class="ds-note">The full statement is below. Use Print / Save as PDF for a copy.</p>
      </div>`;

    // ---- build the sheets, carrying rows onto a new sheet whenever one fills up ----
    content.innerHTML = summaryHtml + '<div class="st-sheets" id="st-sheets"></div>';
    const host = document.getElementById('st-sheets');
    const sheets = [];
    const addSheet = () => {
      const wrap = document.createElement('div');
      wrap.innerHTML = sheetHtml(sheets.length === 0).trim();
      const el = wrap.firstElementChild;
      host.appendChild(el); sheets.push(el);
      return el;
    };
    const bottomOf = (sheet, el) => el.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top;
    const limit = PAGE_H - FOOT_RESERVE;
    const makeTable = () => {
      const box = document.createElement('div'); box.className = 'st-sec';
      box.innerHTML = `<h3>Unpaid invoices</h3><table><colgroup>${widths.map((w) => `<col style="width:${w}">`).join('')}</colgroup><thead><tr>${head.map((h, i) => `<th class="${i === numCol ? 'num' : ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody></tbody></table>`;
      return box;
    };
    let sheet = addSheet();
    if (rows.length) {
      let box = makeTable(); sheet.querySelector('.st-body').appendChild(box);
      let tbody = box.querySelector('tbody');
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        tr.innerHTML = rowCells(r).map((cell, i) => `<td class="${i === numCol ? 'num' : ''}">${cell}</td>`).join('');
        tbody.appendChild(tr);
        if (bottomOf(sheet, box) > limit && tbody.children.length > 1) {
          tbody.removeChild(tr);
          sheet = addSheet();
          box = makeTable(); sheet.querySelector('.st-body').appendChild(box);
          tbody = box.querySelector('tbody'); tbody.appendChild(tr);
        }
      });
    }
    const finalWrap = document.createElement('div'); finalWrap.innerHTML = finalHtml.trim();
    const finalEl = finalWrap.firstElementChild;
    sheet.querySelector('.st-body').appendChild(finalEl);
    if (bottomOf(sheet, finalEl) > PAGE_H - 30) {
      finalEl.remove();
      sheet = addSheet(); sheet.querySelector('.st-body').appendChild(finalEl);
    }
    sheets.forEach((el, i) => { el.querySelector('.st-foot').textContent = `Page ${i + 1}/${sheets.length}`; });

    // a phone is narrower than a sheet: shrink the sheets to fit rather than reflowing them
    if (!isPrint && window.innerWidth < 840) host.style.zoom = String(Math.max(0.3, (window.innerWidth - 16) / 794));
  }

  load().then(async () => {
    // wait for the logo and fonts before the PDF renderer is told the page is ready
    const images = [...document.querySelectorAll('img')];
    await Promise.all(images.map((img) => img.complete ? Promise.resolve() : new Promise((res) => { img.onload = img.onerror = res; })));
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    document.body.dataset.printReady = 'true';
  });
})();
