// Emailed bills waiting to be matched to a PO, shown where the people who know the job are: on the
// PO page (item 83, owner 13 Nov 2026: sales staff know which bill is for which PO). Loaded by
// purchase-order.html, purchase-orders.html and project.html.
//
// A bill emailed to invoice@ whose supplier is known but whose PO is not sure (no PO number on it,
// or a number that is not that supplier's) shows on every open PO of that supplier; one whose PO is
// sure (our PO number is on it) shows on that PO only, waiting for its one tap. Reads
// supplier_bill_inbox (pricing roles). "This bill is for PO2009" is the same save as the Emailed
// bills page (supplier-bill-inbox 'save', the total confirmed first). Writes nothing itself.

// The rows worth matching: read, supplier known, not saved, an invoice (never a packing slip, a
// credit note or a statement). supplierIds null = every supplier.
async function loadBillsToMatch(supplierIds) {
  let q = supabaseClient.from('supplier_bill_inbox')
    .select('id, supplier_id, po_id, match_confidence, match_reason, po_candidates, file_path, file_name, email_from, received_at, created_at, extracted')
    .eq('status', 'to_check').not('supplier_id', 'is', null).neq('attachment_part_id', 'none')
    .order('received_at', { ascending: false }).limit(200);
  if (supplierIds && supplierIds.length) q = q.in('supplier_id', supplierIds);
  const { data, error } = await q;
  if (error) { console.error('bills to match:', error.message); return []; }
  return (data || []).filter(r => r.extracted && r.extracted.bill_number !== undefined && (r.extracted.document_type || 'invoice') === 'invoice');
}

// The bills that belong on one PO's page: sure ones for this PO, unsure ones from its supplier.
function billsToMatchFor(rows, po) {
  if (!po || !po.supplier_id || po.closed_at) return [];
  return (rows || []).filter(r => r.supplier_id === po.supplier_id && (r.match_confidence === 'confident' ? r.po_id === po.id : true));
}

// "1 bill to match" for a PO row on a list, or '' when none.
function billsToMatchNote(rows, po) {
  const n = billsToMatchFor(rows, po).length;
  return n ? `<span style="color:var(--amber); font-weight:600;">${n} bill${n === 1 ? '' : 's'} to match</span>` : '';
}

function renderBillsToMatch(rows, po) {
  const mine = billsToMatchFor(rows, po);
  if (!mine.length) return '';
  const day = (iso) => iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : '';
  return `<div class="po-match" style="margin-bottom:10px;">
    <div class="subtitle" style="font-size:12px; margin-bottom:4px; color:var(--amber);">Waiting to be matched</div>
    ${mine.map(r => {
      const ex = r.extracted || {};
      const sure = r.match_confidence === 'confident' && r.po_id === po.id;
      const why = sure ? `our PO number is on it` : (ex.our_order_reference ? `says ${escapeHtml(ex.our_order_reference)}, not one of ${escapeHtml(po.suppliers?.name || po.supplier_name || 'this supplier')}'s POs` : 'no PO number on it');
      return `<div class="po-match-row" data-id="${escapeHtml(r.id)}" style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center; font-size:13px; padding:4px 0 4px 8px; border-left:3px solid var(--amber); margin-top:3px;">
        <span><strong>Bill ${escapeHtml(ex.bill_number || '(no number)')}</strong>${ex.bill_date ? ' &middot; ' + escapeHtml(day(ex.bill_date)) : ''}${ex.total != null ? ' &middot; ' + money(ex.total) : ''} <span style="color:var(--amber);">${why}</span></span>
        <span style="display:flex; gap:4px; flex-wrap:wrap;">
          ${r.file_path ? `<button type="button" class="secondary btn-sm po-match-open" data-path="${escapeHtml(r.file_path)}">Open invoice</button>` : ''}
          <button type="button" class="po-match-save btn-sm">This bill is for ${escapeHtml(po.po_number || 'this PO')}</button>
        </span>
      </div>`;
    }).join('')}
  </div>`;
}

// Save through the same server step as the Emailed bills page: the total read is confirmed first.
function wireBillsToMatch(container, rows, po, onDone) {
  container.querySelectorAll('.po-match-open').forEach(btn => btn.addEventListener('click', async () => {
    try { await openSignedDocInNewTab(btn.dataset.path); } catch (err) { alert(friendlyError(err)); }
  }));
  container.querySelectorAll('.po-match-save').forEach(btn => btn.addEventListener('click', async () => {
    const row = btn.closest('.po-match-row');
    const item = (rows || []).find(r => r.id === row.dataset.id);
    if (!item) return;
    const ex = item.extracted || {};
    const raw = prompt(`Bill ${ex.bill_number || ''} is for ${po.po_number}. Bill total inc GST, as printed on the bill${ex.total != null ? ` (read as ${money(ex.total)})` : ' (no total was read)'}:`, ex.total != null ? String(ex.total) : '');
    if (raw === null) return;
    const amount = Number(String(raw).replace(/[^0-9.]/g, ''));
    if (!(amount > 0)) { alert('Enter the bill total as a number, more than zero.'); return; }
    btn.disabled = true; btn.textContent = 'Saving...';
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/supplier-bill-inbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ action: 'save', id: item.id, po_id: po.id, amount }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
      showToast(`Bill ${ex.bill_number || ''} saved against ${po.po_number}`);
      if (onDone) await onDone();
    } catch (err) {
      alert(friendlyError(err));
      btn.disabled = false; btn.textContent = `This bill is for ${po.po_number || 'this PO'}`;
    }
  }));
}
