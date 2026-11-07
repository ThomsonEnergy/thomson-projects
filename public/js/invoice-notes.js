// Invoice notes (item 57): the "Work completed" note printed on the client's invoice and PDF above
// the terms (invoices.notes). Written by AI from the job's site notes, feed posts and finished tasks
// (netlify/functions/generate-invoice-notes.js), then edited by a person. Never sent to Xero.
//   wireInvoiceNotesWrite(textarea, button, msgEl, args): the "Write from the site notes" button,
//     used by the Invoice actual costs panel (js/project-invoice-actuals.js) and the panel below.
//     args() returns { projectId, invoiceId?, lines? }.
//   openInvoiceNotesPanel(invoice, project, onSaved): the invoice card's Notes button (project.html):
//     edit and save invoices.notes, then remake the PDF when the invoice has one.
// Loaded on demand with loadJsOnce (js/supabase-client.js). Needs supabaseClient, escapeHtml,
// friendlyError, generateClientPdf.

function wireInvoiceNotesWrite(textarea, button, msgEl, args) {
  const label = button.textContent;
  button.addEventListener('click', async () => {
    if (textarea.value.trim() && !confirm('Replace the notes with a fresh write-up from the site notes?')) return;
    button.disabled = true;
    button.textContent = 'Writing...';
    msgEl.innerHTML = '';
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/generate-invoice-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(args()),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.ok) throw new Error(data.error || 'Could not write the notes');
      textarea.value = data.notes;
      textarea.dispatchEvent(new Event('input'));
    } catch (err) {
      msgEl.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(err))}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });
}

function openInvoiceNotesPanel(invoice, project, onSaved) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:560px; width:100%; max-height:85vh; overflow-y:auto;">
      <h2>Notes on ${escapeHtml(invoice.invoice_number)}</h2>
      <p class="subtitle" style="margin-bottom:10px;">Printed on the client's invoice as "Work completed", above the terms. Not sent to Xero.</p>
      <textarea id="in-notes" rows="7" maxlength="2000" placeholder="What was done on site">${escapeHtml(invoice.notes || '')}</textarea>
      <button type="button" class="secondary" id="in-write-btn" style="margin-top:8px; font-size:13px;">Write from the site notes</button>
      <div id="in-msg"></div>
      <div style="margin-top:14px;">
        <button id="in-save-btn">Save</button>
        <button type="button" class="secondary" id="in-cancel-btn">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const textarea = overlay.querySelector('#in-notes');
  const msg = overlay.querySelector('#in-msg');
  wireInvoiceNotesWrite(textarea, overlay.querySelector('#in-write-btn'), msg, () => ({ projectId: project.id, invoiceId: invoice.id }));
  overlay.querySelector('#in-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#in-save-btn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = 'Saving...';
    msg.innerHTML = '';
    const notes = textarea.value.trim().slice(0, 2000) || null;
    const { error } = await supabaseClient.from('invoices').update({ notes }).eq('id', invoice.id);
    if (error) {
      msg.innerHTML = `<div class="error-box">${escapeHtml(friendlyError(error))}</div>`;
      btn.disabled = false;
      btn.textContent = 'Save';
      return;
    }
    // The PDF is a copy of the invoice page: remake it so it shows the new notes.
    if (invoice.pdf_path) {
      btn.textContent = 'Remaking the PDF...';
      try { await generateClientPdf('invoice', invoice.id); } catch (err) {
        msg.innerHTML = `<div class="error-box">Notes saved, but the PDF was not remade: ${escapeHtml(friendlyError(err))}. Use Regenerate PDF.</div>`;
        btn.style.display = 'none';
        overlay.querySelector('#in-cancel-btn').textContent = 'Close';
        overlay.querySelector('#in-cancel-btn').addEventListener('click', () => onSaved && onSaved());
        return;
      }
    }
    overlay.remove();
    if (onSaved) onSaved();
  });
}
