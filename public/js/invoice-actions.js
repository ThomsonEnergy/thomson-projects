// The invoice panel and every action on an invoice after it is made (item 61): email to the
// client, send a reminder, push to Xero, edit (while not in Xero and not paid), issue a credit
// note (once in Xero, Finance and Admin), notes, PDF, and the history of who did what and when.
// One panel, two doors: the Invoices page (invoices.html, a row click) and the job's Invoices tab
// (project.html, the Open button), so the two can never disagree.
//   openInvoicePanel(invoiceId, { onChange })    the panel; onChange({ money }) runs when it closes after a
//                                                change (money: an amount or Xero state changed)
//   emailInvoiceToClient(invoiceId, project, { btn, msgEl, reminder, invoice, status, interestRate, onSent })  the
//                                                email window, filled in; invoice and status save a read when known;
//                                                a reminder quotes the interest accruing (item 66)
//   pushInvoiceToXero(invoiceId)                 resolves to the server's answer, throws on failure
//   openEditInvoicePanel(invoice, project, onDone)  the per-stage numbers (a quoted claim); a do-and-charge invoice
//                                                with line items opens the Invoice actual costs panel instead (item 64)
//   openIssueCreditNotePanel(invoice, project, onDone)
//   pushCreditNoteToXero(creditNoteId)           throws on failure
//   recordInvoiceEvent(invoiceId, kind, detail)  one history line written by the browser (edit, notes, sent
//                                                another way); the database trigger copies it to the job's Activity
// Writes invoices, invoice_claims, cost_centres.invoiced_amount (the edit panel, as before) and
// invoice_events. Loaded with js/invoice-status.js and js/email-compose.js by loadInvoiceActions
// (js/supabase-client.js: openModal, invoiceClaimRows, emailPostFn and the rest); loads
// js/invoice-notes.js when Notes is pressed.

const INVOICE_PANEL_PROJECT = 'projects(id, name, job_number, quote_number, client_name, client_email, client_id, clients(client_type))';
const INVOICE_PANEL_SELECT = `*, balance_due, interest_accrued, interest_days, interest_daily, interest_of:invoices!invoices_interest_of_invoice_id_fkey(invoice_number, id), cost_centres(name, project_id, ${INVOICE_PANEL_PROJECT}), ${INVOICE_PANEL_PROJECT}, invoice_claims(*, cost_centres(name, sort_order)), credit_notes(*), invoice_line_items(id), invoice_events(*, actor:profiles(full_name))`;
const INVOICE_BTN = 'font-size:12px; padding:6px 10px;';
const loadInvoiceNotes = () => loadJsOnce('/js/invoice-notes.js?v=4', () => typeof openInvoiceNotesPanel === 'function');

// One history line from the browser. The insert policy needs the actor to be the signed in person.
// Throws when it could not be written: for "Sent another way" the line is the action itself, so the
// person must hear about it; the edit panel catches it (its real change is already saved).
async function recordInvoiceEvent(invoiceId, kind, detail) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error('You are signed out. Sign in again.');
  const { error } = await supabaseClient.from('invoice_events').insert({ invoice_id: invoiceId, kind, detail: detail ? String(detail).slice(0, 500) : null, actor_id: session.user.id });
  if (error) throw new Error(`The history line was not saved: ${error.message}`);
}

// emailPostFn (js/email-compose.js) is the one authenticated POST helper both pages already load.
const pushInvoiceToXero = (invoiceId) => emailPostFn('push-invoice-to-xero', { invoiceId }, 'Could not push the invoice to Xero');
const pushCreditNoteToXero = (creditNoteId) => emailPostFn('push-credit-note-to-xero', { creditNoteId }, 'Could not push the credit note to Xero');

// A button that is working, and back again (the label it had is kept on the element).
function invoiceBusy(btn, text) { btn.dataset.label = btn.dataset.label || btn.textContent; btn.disabled = true; btn.textContent = text; }
function invoiceIdle(btn) { if (!btn.isConnected) return; btn.disabled = false; btn.textContent = btn.dataset.label || btn.textContent; }

function invoiceTimelineHtml(status) {
  if (!status.events.length) return '<p class="subtitle" style="margin:0;">No history recorded yet.</p>';
  return `<ol style="list-style:none; padding:0; margin:0;">${status.events.map(e => {
    const who = invoiceEventWho(e);
    return `
      <li style="display:flex; gap:12px; padding:7px 0; border-bottom:1px solid var(--border); align-items:flex-start;">
        <span class="subtitle" style="font-size:12px; margin:0; min-width:112px; white-space:nowrap;">${escapeHtml(invoiceShortDate(e.created_at))} ${escapeHtml(invoiceEventTime(e.created_at))}</span>
        <span style="flex:1;">
          <strong>${escapeHtml(invoiceEventLabel(e.kind))}</strong>${who ? ` <span class="subtitle" style="font-size:12px;">by ${escapeHtml(who)}</span>` : ''}
          ${e.detail ? `<div class="subtitle" style="font-size:12px; margin:2px 0 0;">${escapeHtml(e.detail)}</div>` : ''}
          ${e.email_thread_id ? `<a class="link-quiet" href="/inbox.html?thread=${escapeHtml(e.email_thread_id)}" style="font-size:12px;">Open the email</a>` : ''}
        </span>
      </li>`;
  }).join('')}</ol>`;
}

function invoiceCreditNotesHtml(inv, canIssueCreditNote) {
  const notes = inv.credit_notes || [];
  if (!notes.length) return '';
  return `
    <h3 style="font-size:14px; margin:18px 0 6px;">Credit notes</h3>
    ${notes.map(cn => `
      <p class="subtitle" style="font-size:12px; margin:4px 0;">
        ${escapeHtml(invoiceShortDate(cn.created_at))}${cn.reason ? `: ${escapeHtml(cn.reason)}` : ''}
        ${cn.refund ? `<span class="badge info" style="margin-left:4px;">Refunded${cn.refund_reference ? `: ${escapeHtml(cn.refund_reference)}` : ''}</span>` : '<span class="badge accepted" style="margin-left:4px;">Account credit</span>'}
        ${cn.xero_credit_note_id ? '<span style="margin-left:6px;">In Xero</span>' : (canIssueCreditNote ? `<button type="button" class="secondary ip-push-cn" data-id="${cn.id}" style="font-size:11px; padding:4px 8px; margin-left:6px;">Push to Xero</button>` : '')}
        ${cn.xero_credit_note_error ? `<span class="error-box" style="display:block; margin-top:4px;">${escapeHtml(cn.xero_credit_note_error)}</span>` : ''}
      </p>`).join('')}`;
}

// The panel. The invoice (with its balance, history and credit notes) is re-read after every action,
// so what it shows is always what is saved; the Xero mapping and the person's role are read once.
function openInvoicePanel(invoiceId, { onChange } = {}) {
  const overlay = openModal('<p class="subtitle" style="margin:0;">Loading...</p>', { maxWidth: 760 });
  const card = overlay.querySelector('.card');
  card.id = 'ip-card';
  let changed = null; // null: nothing changed; { money }: what did
  const close = () => { overlay.remove(); if (changed && onChange) onChange(changed); };
  // a tap (not a drag) on the dark area closes it, the same guard openModal uses
  let downOnBackdrop = false;
  overlay.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (downOnBackdrop && e.target === overlay) close(); });
  const fixed = Promise.all([supabaseClient.from('xero_account_mapping').select('*'), getMyRole(), supabaseClient.from('company_settings').select('late_interest_rate_pct').eq('id', 1).maybeSingle()]);

  async function render() {
    let inv, mappings, role, rate;
    try {
      const [{ data, error }, [mappingsRes, myRole, settingsRes]] = await Promise.all([supabaseClient.from('invoices').select(INVOICE_PANEL_SELECT).eq('id', invoiceId).single(), fixed]);
      if (error) throw error;
      inv = data; mappings = mappingsRes.data || []; role = myRole;
      rate = Number(settingsRes.data && settingsRes.data.late_interest_rate_pct);
      if (!(rate >= 0)) rate = 21;
    } catch (err) {
      card.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div><button type="button" class="secondary" id="ip-close" style="margin-top:10px;">Close</button>`;
      card.querySelector('#ip-close').addEventListener('click', close);
      return;
    }
    const project = inv.projects || (inv.cost_centres && inv.cost_centres.projects) || null;
    const status = invoiceStatus(inv);
    const canIssueCreditNote = isFinanceRole(role);
    const isInterestInvoice = !!inv.interest_of_invoice_id || Number(inv.interest_amount) > 0;
    const canEdit = !inv.xero_invoice_id && !inv.paid_at && !!project && !isInterestInvoice;
    const accrued = Number(inv.interest_accrued) || 0, interestDays = Number(inv.interest_days) || 0, daily = Number(inv.interest_daily) || 0;
    const clientType = (project && project.clients && project.clients.client_type) || 'individual';
    const why = [];
    if (!canEdit) why.push(isInterestInvoice ? 'Edit is off: an interest invoice is one fixed amount. Credit it instead.' : inv.xero_invoice_id ? 'Edit is off: this invoice is in Xero. Changes go through a credit note.' : inv.paid_at ? 'Edit is off: this invoice is paid.' : 'Edit is off: this invoice has no job.');
    if (inv.xero_invoice_id && !canIssueCreditNote) why.push('Issue credit note: Finance and Admin only.');
    if (inv.paid_at) why.push('Paid: no more emails or reminders from here.');
    if (status.noSendRecorded) why.push('No send is recorded for this invoice. If it went out another way, press Sent another way so the history is right.');

    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap; align-items:flex-start;">
        <div>
          <h2 style="margin:0;">${escapeHtml(inv.invoice_number)}${inv.description ? ` <span class="subtitle" style="font-size:14px;">${escapeHtml(inv.description)}</span>` : ''}</h2>
          <p class="subtitle" style="margin:4px 0 0; font-size:13px;">
            ${project ? `<a class="link-quiet" href="/project.html?id=${project.id}&tab=invoices">${escapeHtml(projectRef(project))}</a>` : 'No job'}${project && project.client_name ? ` &middot; ${escapeHtml(project.client_name)}` : ''}
            ${inv.interest_of ? ` &middot; Late payment interest on <a class="link-quiet" href="/invoices.html?id=${escapeHtml(inv.interest_of.id)}">${escapeHtml(inv.interest_of.invoice_number)}</a>, GST free` : ''}
          </p>
        </div>
        <button type="button" class="secondary" id="ip-close" style="${INVOICE_BTN}">Close</button>
      </div>
      <div style="display:flex; gap:14px; flex-wrap:wrap; margin:14px 0 6px; align-items:center;">
        ${invoiceStatusChipHtml(status)}
        <span class="badge draft">${inv.xero_invoice_id ? 'In Xero' : 'Not in Xero'}</span>
        ${status.credited ? '<span class="badge draft">Credit note</span>' : ''}
        <span><strong style="font-size:16px;">${money(inv.balance_due)}</strong> <span class="subtitle" style="font-size:12px;">${inv.paid_at ? 'paid' : status.key === 'credited' ? 'left to pay' : 'to pay'}, inc GST</span></span>
        <span class="subtitle" style="font-size:13px; margin:0;">Dated ${escapeHtml(invoiceShortDate(inv.sent_at))}${inv.due_date ? ` &middot; Due ${escapeHtml(invoiceShortDate(inv.due_date))}` : ''}</span>
      </div>
      <p class="subtitle" style="font-size:13px; margin:0 0 12px;"><strong style="color:var(--text);">Next:</strong> ${escapeHtml(status.next || 'Nothing to do')}${status.reminders.length ? ` &middot; Reminders: ${escapeHtml(status.reminders.map(r => invoiceShortDate(r.created_at)).join(', '))}` : ''}</p>
      ${!isInterestInvoice && inv.due_date && status.key !== 'credited' ? `
      <div style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin:0 0 12px;">
        <label style="display:flex; align-items:center; gap:8px; margin:0; font-weight:400; flex-wrap:wrap;">
          <input type="checkbox" id="ip-interest" ${inv.interest_enabled ? 'checked' : ''} style="width:auto;" />
          <strong>Charge interest</strong>
          <span class="subtitle" style="font-size:12px;">${rate}% pa from the day after the due date, on the balance owing, as in our terms. This invoice only.</span>
        </label>
        ${inv.interest_enabled ? `
        <p class="subtitle" style="font-size:13px; margin:8px 0 0;">${accrued > 0
          ? `Interest accrued: <strong style="color:var(--text);">${money(accrued)}</strong> ${inv.paid_at ? `to the payment date (${escapeHtml(invoiceShortDate(inv.paid_at))})` : 'to today'}: ${interestDays} day${interestDays === 1 ? '' : 's'} at ${money(daily)} a day${inv.interest_from ? `, counting from ${escapeHtml(invoiceShortDate(inv.interest_from))}` : ''}. Charging it makes a separate interest invoice, so this invoice and Xero stay as they are.`
          : (inv.paid_at ? 'Paid before any interest accrued.' : status.key === 'overdue' ? 'No interest accrued yet.' : 'Nothing accrues until the day after the due date.')}</p>
        ${accrued >= 0.01 ? `
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
          <button type="button" class="secondary" id="ip-interest-raise" style="${INVOICE_BTN}">Raise interest invoice for ${money(accrued)}</button>
          <button type="button" class="secondary" id="ip-interest-waive" style="${INVOICE_BTN}">Waive ${money(accrued)}${inv.paid_at ? '' : ' and turn off'}</button>
        </div>` : ''}` : ''}
      </div>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        ${!inv.paid_at ? `<button type="button" id="ip-email" style="${INVOICE_BTN}">${status.sentAt ? 'Email again' : 'Email to client'}</button>` : ''}
        ${!inv.paid_at && (status.sentAt || status.key === 'overdue') ? `<button type="button" class="secondary" id="ip-remind" style="${INVOICE_BTN}">Send reminder</button>` : ''}
        ${!inv.xero_invoice_id ? `<button type="button" class="secondary" id="ip-push" style="${INVOICE_BTN}">Push to Xero</button>` : ''}
        <button type="button" class="secondary" id="ip-edit" style="${INVOICE_BTN}" ${canEdit ? '' : 'disabled title="See the note below"'}>Edit</button>
        ${inv.xero_invoice_id && canIssueCreditNote ? `<button type="button" class="secondary" id="ip-credit" style="${INVOICE_BTN}">Issue credit note</button>` : ''}
        ${project ? `<button type="button" class="secondary" id="ip-notes" style="${INVOICE_BTN}">Notes</button>` : ''}
        ${inv.pdf_path ? `<button type="button" class="secondary" id="ip-pdf" style="${INVOICE_BTN}">View PDF</button>` : ''}
        <button type="button" class="secondary" id="ip-make-pdf" style="${INVOICE_BTN}">${inv.pdf_path ? 'Regenerate PDF' : 'Generate PDF'}</button>
        <a class="link-quiet" href="/invoice.html?token=${escapeHtml(inv.invoice_token)}" target="_blank" style="font-size:12px;">Client's invoice page</a>
        ${!inv.paid_at && !status.sentAt ? `<button type="button" class="secondary" id="ip-sent-elsewhere" style="${INVOICE_BTN}">Sent another way</button>` : ''}
      </div>
      ${why.length ? `<p class="subtitle" style="font-size:12px; margin:8px 0 0;">${why.map(escapeHtml).join('<br>')}</p>` : ''}
      ${inv.pdf_error ? `<div class="error-box" style="margin-top:8px; font-size:12px;">The PDF could not be made: ${escapeHtml(inv.pdf_error)}. Try Generate PDF again.</div>` : ''}
      <div id="ip-msg"></div>
      <h3 style="font-size:14px; margin:18px 0 6px;">History</h3>
      ${invoiceTimelineHtml(status)}
      ${invoiceCreditNotesHtml(inv, canIssueCreditNote)}
      <details style="margin-top:16px;">
        <summary class="subtitle" style="cursor:pointer; font-size:13px; margin:0;">How it posts to Xero</summary>
        <div style="margin-top:8px;">${xeroBreakdownHtml(inv, mappings, clientType)}</div>
      </details>`;

    const msg = card.querySelector('#ip-msg');
    const fail = (err) => { msg.innerHTML = `<div class="error-box" style="margin-top:8px;">${escapeHtml(friendlyError(err))}</div>`; };
    const on = (sel, fn) => { const el = card.querySelector(sel); if (el) el.addEventListener('click', fn); };
    const afterChange = (money) => { changed = { money: !!(money || (changed && changed.money)) }; render(); };
    // a server call from a button: working while it runs, back to itself on failure (the message stays)
    const call = (btn, text, fn, money) => async () => {
      invoiceBusy(btn, text);
      try { await fn(); afterChange(money); } catch (err) { fail(err); invoiceIdle(btn); }
    };

    on('#ip-close', close);
    on('#ip-email', (e) => emailInvoiceToClient(inv.id, project, { btn: e.currentTarget, msgEl: msg, invoice: inv, status, interestRate: rate, onSent: () => afterChange(false) }));
    on('#ip-remind', (e) => emailInvoiceToClient(inv.id, project, { btn: e.currentTarget, msgEl: msg, invoice: inv, status, interestRate: rate, reminder: true, onSent: () => afterChange(false) }));
    // Charge interest, this invoice only (item 66): the switch is saved on the invoice and in its history
    const setInterest = async (enabled, detail) => {
      const { error } = await supabaseClient.from('invoices').update({ interest_enabled: enabled }).eq('id', inv.id);
      if (error) throw new Error(`Could not save: ${error.message}`);
      await recordInvoiceEvent(inv.id, enabled ? 'interest_on' : 'interest_off', detail);
    };
    const interestTick = card.querySelector('#ip-interest');
    if (interestTick) interestTick.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      interestTick.disabled = true;
      try {
        await setInterest(enabled, enabled
          ? `${rate}% pa from ${invoiceShortDate(inv.interest_from || inv.due_date)}${inv.interest_from ? '' : ' (the day after the due date)'}`
          : (accrued > 0 ? `Interest waived: ${money(accrued)} for ${interestDays} day${interestDays === 1 ? '' : 's'}` : 'Turned off'));
        afterChange(false);
      } catch (err) { fail(err); interestTick.checked = !enabled; interestTick.disabled = false; }
    });
    const waiveBtn = card.querySelector('#ip-interest-waive');
    if (waiveBtn) waiveBtn.addEventListener('click', call(waiveBtn, 'Waiving...', () => setInterest(false, `Interest waived: ${money(accrued)} for ${interestDays} day${interestDays === 1 ? '' : 's'}`), false));
    const raiseBtn = card.querySelector('#ip-interest-raise');
    if (raiseBtn) raiseBtn.addEventListener('click', call(raiseBtn, 'Raising...', async () => {
      const d = await emailPostFn('raise-interest-invoice', { invoiceId: inv.id }, 'Could not raise the interest invoice');
      showToast(`${d.invoiceNumber} raised for ${money(d.amount)}: push it to Xero and email it from its own row`);
    }, true));
    const pushBtn = card.querySelector('#ip-push');
    if (pushBtn) pushBtn.addEventListener('click', call(pushBtn, 'Pushing...', async () => { const data = await pushInvoiceToXero(inv.id); showToast(`Pushed ${data.invoiceNumber} to Xero`); }, true));
    // A do-and-charge invoice (it has line items) reopens the Invoice actual costs panel with its lines (item 64);
    // a quoted claim keeps the per-stage numbers panel.
    on('#ip-edit', () => ((inv.invoice_line_items || []).length
      ? loadInvoiceActuals().then(() => openInvoiceActualCostsPanel(project, { invoice: inv, onDone: () => afterChange(true) })).catch(fail)
      : openEditInvoicePanel(inv, project, () => afterChange(true))));
    on('#ip-credit', () => openIssueCreditNotePanel(inv, project, () => afterChange(true)));
    on('#ip-notes', () => loadInvoiceNotes().then(() => openInvoiceNotesPanel(inv, project, () => afterChange(false))).catch(fail));
    on('#ip-pdf', () => openPdfViewer(inv.pdf_path, `Invoice ${inv.invoice_number}`, project ? { projectId: project.id, folder: 'Marked up' } : {}));
    const pdfBtn = card.querySelector('#ip-make-pdf');
    pdfBtn.addEventListener('click', call(pdfBtn, 'Generating...', () => generateClientPdf('invoice', inv.id), false));
    on('#ip-sent-elsewhere', async () => {
      const note = prompt('How was it sent? For example "posted 3 Nov" or "sent from Xero". This records it as sent.');
      if (note === null) return;
      try {
        await recordInvoiceEvent(inv.id, 'sent_elsewhere', note.trim() || null);
      } catch (err) { fail(err); return; }
      afterChange(false);
    });
    card.querySelectorAll('.ip-push-cn').forEach(btn => btn.addEventListener('click', call(btn, 'Pushing...', () => pushCreditNoteToXero(btn.dataset.id), true)));
  }

  render();
}

// The email window for an invoice, filled in: the PDF attached (made first when there is none), a
// button to view and pay online, and for a reminder the amount and due date in the words. The send
// is recorded in the invoice's history by send-gmail.js (invoiceEvent), so a failed send never shows
// as sent, and the database copies the line to the job's Activity tab.
async function emailInvoiceToClient(invoiceId, project, { btn, msgEl, reminder = false, invoice = null, status = null, interestRate = null, onSent } = {}) {
  if (btn) invoiceBusy(btn, 'Making the PDF...');
  if (msgEl) msgEl.innerHTML = '';
  try {
    const readInvoice = async () => {
      const { data, error } = await supabaseClient.from('invoices').select('invoice_number, invoice_token, pdf_path, bill_to_client_id, due_date, balance_due, interest_enabled, interest_accrued, interest_days, interest_daily').eq('id', invoiceId).single();
      if (error) throw error;
      return data;
    };
    let inv = invoice && invoice.pdf_path ? invoice : await readInvoice();
    if (!inv.pdf_path) {
      await generateClientPdf('invoice', invoiceId); // copes with autoGenerateInvoicePdf running at the same time
      inv = await readInvoice();
      if (!inv.pdf_path) throw new Error('The PDF is not ready yet. Try again in a moment.');
    }
    const n = inv.invoice_number;
    let to = (project && project.client_email) || '', name = (project && project.client_name) || '';
    if (inv.bill_to_client_id) { // a warranty job billed to the manufacturer
      const { data: billTo } = await supabaseClient.from('clients').select('name, email').eq('id', inv.bill_to_client_id).maybeSingle();
      if (billTo) { to = billTo.email || ''; name = billTo.name || ''; }
    }
    const first = name.trim().split(/\s+/)[0] || 'there';
    const ref = project ? projectRef(project) : `Invoice ${n}`;
    const jobName = project ? project.name : 'the work';
    const fileName = `${ref} - Invoice ${n}.pdf`;
    let subject = `Invoice ${n} - ${ref}`;
    let body = `Hi ${first},\n\nPlease find invoice ${n} for ${jobName} attached. You can also view and pay it online with the button below.\n\nThanks,`;
    if (reminder) {
      const overdue = status ? status.key === 'overdue' : (!!inv.due_date && inv.due_date < sydneyDateKey(new Date()));
      const amount = inv.balance_due != null ? ` (${money(inv.balance_due)} inc GST)` : '';
      const due = inv.due_date ? `${overdue ? 'was' : 'is'} due on ${invoiceShortDate(inv.due_date, { long: true })}` : 'is now due';
      subject = `Reminder: invoice ${n} - ${ref}`;
      // interest accruing (item 66): the figure to today, the daily figure and the total if paid today
      const accrued = inv.interest_enabled ? Number(inv.interest_accrued) || 0 : 0;
      const interestNote = accrued > 0
        ? `\n\nUnder our terms, interest accrues on overdue amounts at ${interestRate != null ? interestRate : 21}% per annum, calculated daily. On this invoice it is ${money(accrued)} to today (${Number(inv.interest_days) || 0} days) and ${money(Number(inv.interest_daily) || 0)} for each further day${inv.balance_due != null ? `, so ${money(Number(inv.balance_due) + accrued)} clears it if paid today` : ''}. The interest is invoiced separately.`
        : '';
      body = `Hi ${first},\n\nA friendly reminder that invoice ${n} for ${jobName}${amount} ${due}. You can view and pay it online with the button below, or by bank transfer using the details on the invoice.${interestNote}\n\nIf you have already paid, thank you, and please ignore this note.\n\nThanks,`;
    }
    openEmailComposer({
      title: reminder ? `Send a reminder for ${n}` : `Email invoice ${n}`,
      to,
      subject,
      body,
      projectId: project ? project.id : undefined, tagKind: 'client',
      quoteLink: { url: `${shareOrigin()}/invoice.html?token=${inv.invoice_token}`, label: 'Include a button to view and pay the invoice online', buttonText: 'View and pay your invoice', checked: true },
      attachOptions: [{ group: 'Invoice', label: fileName, bucket: 'project-documents', path: inv.pdf_path, name: fileName, checked: true }],
      invoiceEvent: { invoiceId, kind: reminder ? 'reminder' : 'emailed' },
      onSent: async () => {
        if (btn) { btn.textContent = reminder ? 'Reminder sent' : 'Emailed'; btn.disabled = true; }
        if (onSent) await onSent();
      },
    });
  } catch (err) {
    const text = friendlyError(err, 'Could not set up the email.');
    if (msgEl) msgEl.innerHTML = `<div class="error-box">${escapeHtml(text)}</div>`; else alert(text);
  } finally {
    if (btn && btn.textContent === 'Making the PDF...') invoiceIdle(btn);
  }
}

// What is left of the quote's STC and BSTC credits on a job after every invoice and credit note on
// it: the cap the edit panel checks against. The same sum project.html's quoteCreditSummary makes
// from the job's stages, read fresh from the database here so the panel works on any page.
async function invoiceCreditLeft(projectId) {
  const [{ data: proj, error: e1 }, { data: centres, error: e2 }] = await Promise.all([
    supabaseClient.from('projects').select('stc_total, bstc_total').eq('id', projectId).single(),
    supabaseClient.from('cost_centres').select('id').eq('project_id', projectId),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const ids = (centres || []).map(c => c.id);
  const invQuery = supabaseClient.from('invoices').select('stc_amount, bstc_amount');
  const [{ data: invs, error: e3 }, { data: credits, error: e4 }] = await Promise.all([
    ids.length ? invQuery.or(`project_id.eq.${projectId},cost_centre_id.in.(${ids.join(',')})`) : invQuery.eq('project_id', projectId),
    ids.length ? supabaseClient.from('credit_note_claims').select('stc_amount, bstc_amount').in('cost_centre_id', ids) : Promise.resolve({ data: [] }),
  ]);
  if (e3) throw e3;
  if (e4) throw e4;
  const sum = (rows, k) => (rows || []).reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return {
    stcRemaining: Math.max(0, (Number(proj.stc_total) || 0) - sum(invs, 'stc_amount') + sum(credits, 'stc_amount')),
    bstcRemaining: Math.max(0, (Number(proj.bstc_total) || 0) - sum(invs, 'bstc_amount') + sum(credits, 'bstc_amount')),
  };
}

// The invoice's claims as numbers per stage (invoiceClaimRows in js/supabase-client.js, the same rows
// the Xero breakdown uses), with the claim and stage ids the edit and credit note panels write to.
const invoiceEditRows = (invoice) => invoiceClaimRows(invoice).map(r => ({
  id: r.id, cost_centre_id: r.cost_centre_id, stageName: r.stageName,
  labour: Number(r.labour_amount) || 0, material: Number(r.material_amount) || 0, stc: Number(r.stc_amount) || 0, bstc: Number(r.bstc_amount) || 0,
}));

// Lets an invoice's claim amounts and dates be corrected before it has been pushed to Xero: per
// stage, split into Labour, Materials, STC and BSTC (the invoice_claims granularity; a legacy
// single-stage invoice gets one row). Adjusts each touched stage's invoiced_amount by the delta
// between old and new (never overwrites it, since that figure aggregates every invoice on the
// stage). Only offered for an unpushed, unpaid invoice: once pushed, Xero rejects line edits on an
// AUTHORISED invoice, so a correction from then on is a credit note (openIssueCreditNotePanel).
function openEditInvoicePanel(invoice, project, onDone) {
  const isMultiStage = invoice.invoice_claims && invoice.invoice_claims.length > 0;
  const rows = invoiceEditRows(invoice);
  const sumOf = (list, k) => list.reduce((s, r) => s + r[k], 0);
  const totalOf = (list) => sumOf(list, 'labour') + sumOf(list, 'material') - sumOf(list, 'stc') - sumOf(list, 'bstc');

  const overlay = openModal(`
      <h2>Edit ${escapeHtml(invoice.invoice_number)}</h2>
      <p class="subtitle" style="margin-bottom:12px;">Not yet pushed to Xero: saving updates the amounts here, and the PDF is remade on the next email or view.</p>
      <div class="grid cols-2" style="margin-bottom:12px;">
        <div>
          <label style="margin-top:0">Invoice date</label>
          <input type="date" id="ei-date" value="${invoice.sent_at ? sydneyDateKey(new Date(invoice.sent_at)) : ''}" />
        </div>
        <div>
          <label style="margin-top:0">Due date</label>
          <input type="date" id="ei-due-date" value="${invoice.due_date || ''}" />
        </div>
      </div>
      <table>
        <thead><tr><th>Stage</th><th class="num">Labour</th><th class="num">Materials</th><th class="num">STC credit</th><th class="num">BSTC credit</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td>${escapeHtml(r.stageName)}</td>
              <td class="num"><input type="number" step="0.01" class="ei-labour" data-i="${i}" value="${r.labour}" style="width:100px;" /></td>
              <td class="num"><input type="number" step="0.01" class="ei-material" data-i="${i}" value="${r.material}" style="width:100px;" /></td>
              <td class="num"><input type="number" step="0.01" class="ei-stc" data-i="${i}" value="${r.stc}" style="width:100px;" /></td>
              <td class="num"><input type="number" step="0.01" class="ei-bstc" data-i="${i}" value="${r.bstc}" style="width:100px;" /></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p style="margin-top:12px;">Total (ex GST): <strong id="ei-total"></strong></p>
      <div style="margin-top:10px;">
        <button id="ei-save-btn">Save</button>
        <button type="button" class="secondary" id="ei-cancel-btn">Cancel</button>
      </div>
      <div id="ei-msg"></div>`, { maxWidth: 560 });

  function readValues() {
    return rows.map((r, i) => ({
      ...r,
      labour: parseFloat(overlay.querySelector(`.ei-labour[data-i="${i}"]`).value) || 0,
      material: parseFloat(overlay.querySelector(`.ei-material[data-i="${i}"]`).value) || 0,
      stc: parseFloat(overlay.querySelector(`.ei-stc[data-i="${i}"]`).value) || 0,
      bstc: parseFloat(overlay.querySelector(`.ei-bstc[data-i="${i}"]`).value) || 0,
    }));
  }
  function updateTotal() { overlay.querySelector('#ei-total').textContent = money(totalOf(readValues())); }
  overlay.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateTotal));

  overlay.querySelector('#ei-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#ei-save-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#ei-msg');
    const saveBtn = overlay.querySelector('#ei-save-btn');
    invoiceBusy(saveBtn, 'Saving...');
    try {
      const newRows = readValues();
      // The quote's STC and BSTC credits are the cap (the server caps labour and materials on a new
      // invoice): this invoice can hold at most what is left of each after every other invoice on
      // the job, and it can never be a credit on its own (that is a negative invoice).
      const credit = await invoiceCreditLeft(project.id);
      const stcCap = Math.max(0, credit.stcRemaining + sumOf(rows, 'stc'));
      const bstcCap = Math.max(0, credit.bstcRemaining + sumOf(rows, 'bstc'));
      if (newRows.some(r => r.labour < 0 || r.material < 0 || r.stc < 0 || r.bstc < 0)) throw new Error('Amounts cannot be negative.');
      if (sumOf(newRows, 'stc') > stcCap + 0.01) throw new Error(`The STC credit on this invoice can be at most ${money(stcCap)}: the quote's credit less what other invoices already hold.`);
      if (sumOf(newRows, 'bstc') > bstcCap + 0.01) throw new Error(`The BSTC credit on this invoice can be at most ${money(bstcCap)}: the quote's credit less what other invoices already hold.`);
      if (sumOf(newRows, 'labour') + sumOf(newRows, 'material') <= 0 && sumOf(newRows, 'stc') + sumOf(newRows, 'bstc') > 0) throw new Error('An invoice cannot be only a credit. Give it a labour or materials amount, or issue a credit note instead.');
      // Every write is checked. Order: claims, then the invoice, then each stage's
      // invoiced_amount. If one fails, what was already written is put back (best
      // effort) so the stage and the invoice never disagree.
      const undo = [];
      const mustUpdate = async (table, values, id, what) => {
        const { data, error } = await supabaseClient.from(table).update(values).eq('id', id).select('id');
        if (error) throw new Error(`Could not save ${what}: ${error.message}`);
        if (!data || !data.length) throw new Error(`Could not save ${what}: no permission or it no longer exists.`);
      };
      const newDate = overlay.querySelector('#ei-date').value;
      const newDueDate = overlay.querySelector('#ei-due-date').value || null;
      // Compared as Sydney dates: a deposit invoice's sent_at carries a time of day, so a save that
      // keeps the date keeps the timestamp too (or every save would drop the PDF as stale).
      const dateChanged = !!newDate && newDate !== (invoice.sent_at ? sydneyDateKey(new Date(invoice.sent_at)) : null);
      const dueChanged = (newDueDate || null) !== (invoice.due_date || null);
      try {
        if (isMultiStage) {
          for (let i = 0; i < rows.length; i++) {
            const o = rows[i], r = newRows[i];
            await mustUpdate('invoice_claims', { labour_amount: r.labour, material_amount: r.material, stc_amount: r.stc, bstc_amount: r.bstc }, r.id, `the ${r.stageName} claim`);
            undo.push(() => supabaseClient.from('invoice_claims').update({ labour_amount: o.labour, material_amount: o.material, stc_amount: o.stc, bstc_amount: o.bstc }).eq('id', o.id));
          }
        }

        const totalLabour = sumOf(newRows, 'labour');
        const totalMaterial = sumOf(newRows, 'material');
        const totalStc = sumOf(newRows, 'stc');
        const totalBstc = sumOf(newRows, 'bstc');
        const newSentAt = dateChanged ? new Date(newDate).toISOString() : invoice.sent_at;
        // The PDF made at creation shows the old figures and dates. Once any of them changes it is
        // dropped, so Email and View make a fresh one (both regenerate when pdf_path is empty).
        const changed = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.001;
        const pdfStale = changed(totalLabour, invoice.labour_amount) || changed(totalMaterial, invoice.material_amount)
          || changed(totalStc, invoice.stc_amount) || changed(totalBstc, invoice.bstc_amount)
          || newRows.some((r, i) => changed(r.labour, rows[i].labour) || changed(r.material, rows[i].material) || changed(r.stc, rows[i].stc) || changed(r.bstc, rows[i].bstc))
          || dateChanged || dueChanged;
        await mustUpdate('invoices', {
          labour_amount: totalLabour, material_amount: totalMaterial, stc_amount: totalStc, bstc_amount: totalBstc,
          sent_at: newSentAt,
          due_date: newDueDate,
          ...(pdfStale ? { pdf_path: null, pdf_generated_at: null } : {}),
        }, invoice.id, `invoice ${invoice.invoice_number}`);
        undo.push(() => supabaseClient.from('invoices').update({
          labour_amount: invoice.labour_amount, material_amount: invoice.material_amount, stc_amount: invoice.stc_amount, bstc_amount: invoice.bstc_amount,
          sent_at: invoice.sent_at, due_date: invoice.due_date, pdf_path: invoice.pdf_path, pdf_generated_at: invoice.pdf_generated_at,
        }).eq('id', invoice.id));

        for (let i = 0; i < rows.length; i++) {
          const oldRow = rows[i], newRow = newRows[i];
          if (!newRow.cost_centre_id) continue;
          const delta = (newRow.labour + newRow.material) - (oldRow.labour + oldRow.material);
          if (Math.abs(delta) < 0.001) continue;
          const { data: centre, error: ccErr } = await supabaseClient.from('cost_centres').select('invoiced_amount').eq('id', newRow.cost_centre_id).single();
          if (ccErr) throw new Error(`Could not read the ${newRow.stageName} stage: ${ccErr.message}`);
          const before = Number(centre && centre.invoiced_amount) || 0;
          await mustUpdate('cost_centres', { invoiced_amount: before + delta }, newRow.cost_centre_id, `the ${newRow.stageName} stage's invoiced amount`);
          undo.push(() => supabaseClient.from('cost_centres').update({ invoiced_amount: before }).eq('id', newRow.cost_centre_id));
        }
      } catch (saveErr) {
        let undoFailed = false;
        for (const fn of undo.reverse()) {
          try { const { error } = await fn(); if (error) undoFailed = true; } catch (e) { undoFailed = true; }
        }
        throw new Error(`${saveErr.message} ${undoFailed
          ? 'Some changes could not be put back: reload and check this invoice and its stages before trying again.'
          : 'Nothing was changed.'}`);
      }

      // The history line says what changed in one glance: the old and new total, and any date moved.
      const what = [`Total ex GST ${money(totalOf(rows))} to ${money(totalOf(newRows))}`];
      if (dateChanged) what.push(`dated ${invoiceShortDate(newDate)}`);
      if (dueChanged) what.push(newDueDate ? `due ${invoiceShortDate(newDueDate)}` : 'due date cleared');
      try {
        await recordInvoiceEvent(invoice.id, 'edited', what.join(', '));
      } catch (histErr) {
        alert(`Saved. ${histErr.message}`); // the amounts are saved; only the history line is missing
      }

      overlay.remove();
      if (onDone) onDone();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      invoiceIdle(saveBtn);
    }
  });

  updateTotal();
}

// The correction path for an invoice that is already in Xero (a raw edit no longer works past that
// point, see openEditInvoicePanel). Pre-fills each stage's still-creditable amount (this invoice's
// original claim, minus whatever has already been credited against it); any of them can be reduced
// for a partial credit. Finance and Admin only (the button is gated in openInvoicePanel and the
// server checks again, require-finance-role.js). The server writes the history line.
async function openIssueCreditNotePanel(invoice, project, onDone) {
  const { data: priorCredits } = await supabaseClient
    .from('credit_note_claims')
    .select('cost_centre_id, labour_amount, material_amount, stc_amount, bstc_amount, credit_notes!inner(invoice_id)')
    .eq('credit_notes.invoice_id', invoice.id);
  const alreadyCreditedByCentre = {};
  (priorCredits || []).forEach(pc => {
    const cur = alreadyCreditedByCentre[pc.cost_centre_id] || { labour: 0, material: 0, stc: 0, bstc: 0 };
    cur.labour += Number(pc.labour_amount) || 0;
    cur.material += Number(pc.material_amount) || 0;
    cur.stc += Number(pc.stc_amount) || 0;
    cur.bstc += Number(pc.bstc_amount) || 0;
    alreadyCreditedByCentre[pc.cost_centre_id] = cur;
  });

  const rows = invoiceEditRows(invoice).map(r => {
    const already = alreadyCreditedByCentre[r.cost_centre_id] || { labour: 0, material: 0, stc: 0, bstc: 0 };
    return {
      cost_centre_id: r.cost_centre_id, stageName: r.stageName,
      maxLabour: Math.max(0, r.labour - already.labour), maxMaterial: Math.max(0, r.material - already.material), maxStc: Math.max(0, r.stc - already.stc), maxBstc: Math.max(0, r.bstc - already.bstc),
    };
  }).filter(r => r.maxLabour + r.maxMaterial + r.maxStc + r.maxBstc > 0.004);

  if (!rows.length) {
    alert('This invoice has already been fully credited. There is nothing left to credit.');
    return;
  }

  const overlay = openModal(`
      <h2>Issue credit note: ${escapeHtml(invoice.invoice_number)}</h2>
      <p class="subtitle" style="margin-bottom:12px;">Defaults to a full credit of what is left claimable on this invoice. Reduce any amount for a partial credit. This creates the credit note here; push it to Xero separately once you are happy with it.</p>
      <table>
        <thead><tr><th>Stage</th><th class="num">Labour</th><th class="num">Materials</th><th class="num">STC</th><th class="num">BSTC</th></tr></thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td>${escapeHtml(r.stageName)}</td>
              <td class="num"><input type="number" step="0.01" min="0" max="${r.maxLabour}" class="cn-labour" data-i="${i}" value="${r.maxLabour.toFixed(2)}" style="width:100px;" /></td>
              <td class="num"><input type="number" step="0.01" min="0" max="${r.maxMaterial}" class="cn-material" data-i="${i}" value="${r.maxMaterial.toFixed(2)}" style="width:100px;" /></td>
              <td class="num"><input type="number" step="0.01" min="0" max="${r.maxStc}" class="cn-stc" data-i="${i}" value="${r.maxStc.toFixed(2)}" style="width:90px;" /></td>
              <td class="num"><input type="number" step="0.01" min="0" max="${r.maxBstc}" class="cn-bstc" data-i="${i}" value="${r.maxBstc.toFixed(2)}" style="width:90px;" /></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <p class="subtitle" style="margin-top:8px;">Total credit: <strong id="cn-total" style="color:var(--text);"></strong></p>
      <label style="margin-top:10px;">Reason</label>
      <input id="cn-reason" placeholder="e.g. Client disputed the materials line, agreed to reduce it" />
      <label style="display:flex; align-items:center; gap:6px; margin-top:12px;">
        <input type="checkbox" id="cn-refund" style="width:auto;" ${invoice.paid_at ? 'checked' : ''} />
        This has already been paid: refund the money back to the client (rather than leave it as account credit)
      </label>
      <div id="cn-refund-ref-row" style="display:${invoice.paid_at ? 'block' : 'none'};">
        <label>How was it refunded</label>
        <input id="cn-refund-ref" placeholder="e.g. Bank transfer 12 Sep, or Airwallex refund ID" />
      </div>
      <div style="margin-top:14px;">
        <button id="cn-save-btn">Create credit note</button>
        <button type="button" class="secondary" id="cn-cancel-btn">Cancel</button>
      </div>
      <div id="cn-msg"></div>`, { maxWidth: 600 });

  function readValues() {
    return rows.map((r, i) => ({
      cost_centre_id: r.cost_centre_id,
      labour: Math.min(r.maxLabour, Math.max(0, parseFloat(overlay.querySelector(`.cn-labour[data-i="${i}"]`).value) || 0)),
      material: Math.min(r.maxMaterial, Math.max(0, parseFloat(overlay.querySelector(`.cn-material[data-i="${i}"]`).value) || 0)),
      stc: Math.min(r.maxStc, Math.max(0, parseFloat(overlay.querySelector(`.cn-stc[data-i="${i}"]`).value) || 0)),
      bstc: Math.min(r.maxBstc, Math.max(0, parseFloat(overlay.querySelector(`.cn-bstc[data-i="${i}"]`).value) || 0)),
    }));
  }
  function updateTotal() {
    overlay.querySelector('#cn-total').textContent = money(readValues().reduce((s, r) => s + r.labour + r.material, 0));
  }
  overlay.querySelectorAll('input[type="number"]').forEach(inp => inp.addEventListener('input', updateTotal));
  overlay.querySelector('#cn-refund').addEventListener('change', (e) => {
    overlay.querySelector('#cn-refund-ref-row').style.display = e.target.checked ? 'block' : 'none';
  });

  overlay.querySelector('#cn-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#cn-save-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#cn-msg');
    const saveBtn = overlay.querySelector('#cn-save-btn');
    invoiceBusy(saveBtn, 'Creating...');
    try {
      const claims = readValues().filter(r => r.labour + r.material + r.stc + r.bstc > 0.004);
      if (!claims.length) throw new Error('Enter at least one non-zero credit amount');
      await emailPostFn('create-credit-note', {
        invoiceId: invoice.id,
        reason: overlay.querySelector('#cn-reason').value.trim() || null,
        refund: overlay.querySelector('#cn-refund').checked,
        refundReference: overlay.querySelector('#cn-refund-ref').value.trim() || null,
        claims: claims.map(c => ({ costCentreId: c.cost_centre_id, labourAmount: c.labour, materialAmount: c.material, stcAmount: c.stc, bstcAmount: c.bstc })),
      }, 'Could not create the credit note');
      overlay.remove();
      if (onDone) onDone();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
      invoiceIdle(saveBtn);
    }
  });

  updateTotal();
}
