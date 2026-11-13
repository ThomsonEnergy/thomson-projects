// Supplier bills to Xero (H4, item 83 part C). Pushes one approved supplier bill as an AUTHORISED
// Xero Bill (ACCPAY), or a credit note (item 82) as a supplier credit note (ACCPAYCREDIT) allocated to
// its PO's bills already in Xero, and attaches the invoice file. Shared by push-bill-to-xero.js (a
// person presses Push to Xero on the supplier page) and push-bills-to-xero-background.js (every
// approved bill not yet in Xero, every 15 minutes while api_keys xero_bills_push = 'on').
//
// What Xero gets: Contact = the supplier (suppliers.xero_contact_id, found by name or created);
// InvoiceNumber = their bill number; Date = the bill date; DueDate = our pay-on date (else their terms
// date); Reference = "PO2009 J7040" (the PO and the job, or Stock); the bill's lines ex GST with the
// account from Settings > Xero Mapping (purchase_materials, purchase_contractor for a contractor,
// purchase_freight for a freight line, purchase_tools on a tools PO) and that row's tax type; or one
// GST-inclusive line for the bill total when the lines do not add up to it. Never before approval,
// never a payment (the bank feed matches the transfer to the bill in Xero).
// Writes supplier_bills.xero_bill_* and suppliers.xero_contact_id, and a line on the supplier's log.

const { xeroRequest, xeroUpload } = require('./xero-client');
const { getOrCreateContact } = require('./build-xero-invoice-payload');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isFreight = (s) => /(freight|delivery|deliver|shipping|postage|courier|handling|cartage)/i.test(String(s || ''));
const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function loadMapping(admin) {
  const { data } = await admin.from('xero_account_mapping').select('category, label, xero_account_code, xero_tax_type');
  const map = {};
  (data || []).forEach(m => { map[m.category] = m; });
  return map;
}

function needAccount(mapping, category) {
  const m = mapping[category];
  const labels = { purchase_materials: 'Materials bought (supplier bills)', purchase_contractor: 'Subcontractors (contractor bills)', purchase_freight: 'Freight and delivery on supplier bills', purchase_tools: 'Tools and equipment bought' };
  if (!m || !String(m.xero_account_code || '').trim()) throw new Error(`Set the Xero account for "${(m && m.label) || labels[category] || category}" in Settings > Xero Mapping first.`);
  return { AccountCode: m.xero_account_code, TaxType: m.xero_tax_type || 'INPUT' };
}

function categoryFor({ supplier, po, line }) {
  if (line && isFreight(line.description)) return 'purchase_freight';
  if (po && po.po_kind === 'tools') return 'purchase_tools';
  if (supplier && supplier.kind === 'contractor') return 'purchase_contractor';
  return 'purchase_materials';
}

async function pushBillToXero(admin, billId, { actorId = null } = {}) {
  const { data: bill } = await admin.from('supplier_bills')
    .select('*, supplier_bill_line_items(description, quantity, unit_cost, part_number), purchase_orders(id, po_number, po_kind, project_id, projects(job_number))')
    .eq('id', billId).maybeSingle();
  if (!bill) throw new Error('That bill was not found.');
  const isCredit = bill.kind === 'credit_note';
  const word = isCredit ? 'Credit note' : 'Bill';
  if (bill.xero_bill_id) throw new Error(`${word} ${bill.bill_number || ''} is already in Xero.`);
  if (!bill.approved_for_payment && !bill.paid) throw new Error(`${word} ${bill.bill_number || ''} is not approved yet: close its PO (or approve it on Bill checks) first.`);
  if (!bill.supplier_id) throw new Error('Pick the supplier first.');
  const { data: supplier } = await admin.from('suppliers').select('id, name, kind, contact_email, needs_review, xero_contact_id').eq('id', bill.supplier_id).single();
  if (supplier.needs_review) throw new Error(`Check ${supplier.name}'s details (New, check details) before anything goes to Xero.`);

  const contactId = await getOrCreateContact({ name: supplier.name, email: supplier.contact_email }, supplier);
  if (!supplier.xero_contact_id) await admin.from('suppliers').update({ xero_contact_id: contactId }).eq('id', supplier.id);

  const mapping = await loadMapping(admin);
  const po = bill.purchase_orders || null;
  const lines = bill.supplier_bill_line_items || [];
  const amount = Math.abs(Number(bill.amount) || 0);
  const linesEx = r2(lines.reduce((s, l) => s + Math.abs(Number(l.quantity) || 0) * (Number(l.unit_cost) || 0), 0));
  const linesAddUp = lines.length > 0 && (Math.abs(r2(linesEx * 1.1) - amount) <= 1 || Math.abs(linesEx - amount) <= 1);
  let lineItems, lineAmountTypes;
  if (linesAddUp) {
    lineAmountTypes = Math.abs(linesEx - amount) <= 1 && Math.abs(r2(linesEx * 1.1) - amount) > 1 ? 'Inclusive' : 'Exclusive'; // a GST-free bill read as its total
    lineItems = lines.map(l => ({
      Description: String(l.description || 'Item').slice(0, 4000), Quantity: Math.abs(Number(l.quantity) || 1), UnitAmount: r2(l.unit_cost),
      ...needAccount(mapping, categoryFor({ supplier, po, line: l })),
    }));
  } else {
    lineAmountTypes = 'Inclusive';
    lineItems = [{ Description: `${word} ${bill.bill_number || ''} from ${supplier.name}${po ? ' for ' + po.po_number : ''}`.trim(), Quantity: 1, UnitAmount: amount, ...needAccount(mapping, categoryFor({ supplier, po })) }];
  }
  const job = po?.projects?.job_number ? `J${po.projects.job_number}` : (po ? 'Stock' : '');
  const reference = [po?.po_number, job].filter(Boolean).join(' ') || undefined;
  const date = bill.bill_date || new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });

  let xeroId, xeroNumber, xeroStatus, note = null;
  if (!isCredit) {
    const result = await xeroRequest('accounting', 'Invoices', {
      method: 'POST',
      body: { Invoices: [{ Type: 'ACCPAY', Contact: { ContactID: contactId }, Date: date, DueDate: bill.pay_on || bill.due_date || date, InvoiceNumber: bill.bill_number || undefined, Reference: reference, LineAmountTypes: lineAmountTypes, LineItems: lineItems, Status: 'AUTHORISED' }] },
    });
    const x = result.Invoices[0];
    xeroId = x.InvoiceID; xeroNumber = x.InvoiceNumber; xeroStatus = x.Status;
  } else {
    const result = await xeroRequest('accounting', 'CreditNotes', {
      method: 'POST',
      body: { CreditNotes: [{ Type: 'ACCPAYCREDIT', Contact: { ContactID: contactId }, Date: date, CreditNoteNumber: bill.bill_number || undefined, Reference: reference, LineAmountTypes: lineAmountTypes, LineItems: lineItems, Status: 'AUTHORISED' }] },
    });
    const x = result.CreditNotes[0];
    xeroId = x.CreditNoteID; xeroNumber = x.CreditNoteNumber; xeroStatus = x.Status;
  }
  await admin.from('supplier_bills').update({ xero_bill_id: xeroId, xero_bill_number: xeroNumber || null, xero_bill_status: xeroStatus || null, xero_pushed_at: new Date().toISOString(), xero_tried_at: new Date().toISOString(), xero_bill_error: null }).eq('id', bill.id);

  // a credit note comes off its PO's bills in Xero too (Xero's rule: create, then allocate), oldest bill first
  if (isCredit && po) {
    try {
      const { data: poBills } = await admin.from('supplier_bills').select('id, bill_number, xero_bill_id').eq('po_id', po.id).eq('kind', 'bill').not('xero_bill_id', 'is', null).order('bill_date');
      let left = r2(amount);
      for (const b of poBills || []) {
        if (left <= 0.004) break;
        const inv = await xeroRequest('accounting', `Invoices/${b.xero_bill_id}`);
        const due = r2(inv.Invoices?.[0]?.AmountDue);
        if (due <= 0.004) continue;
        const take = Math.min(left, due);
        await xeroRequest('accounting', `CreditNotes/${xeroId}/Allocations`, { method: 'PUT', body: { Allocations: [{ Invoice: { InvoiceID: b.xero_bill_id }, Amount: take, Date: date }] } });
        left = r2(left - take);
      }
      if (left > 0.004) note = `${money(left)} of the credit is not allocated in Xero yet (no bill of ${po.po_number} in Xero to take it off): allocate it in Xero when the next bill arrives.`;
    } catch (err) {
      note = `In Xero, but not allocated to the bills: ${err.message}`;
    }
  }

  // the supplier's file on the Xero bill, so the bookkeeper sees the document there
  if (bill.file_path) {
    try {
      const { data: blob, error } = await admin.storage.from('project-documents').download(bill.file_path);
      if (error) throw error;
      const buffer = Buffer.from(await blob.arrayBuffer());
      const name = String(bill.file_name || bill.file_path.split('/').pop() || 'bill.pdf').replace(/[^A-Za-z0-9._-]/g, '_');
      await xeroUpload(`${isCredit ? 'CreditNotes' : 'Invoices'}/${xeroId}/Attachments/${encodeURIComponent(name)}`, buffer, blob.type || 'application/pdf');
    } catch (err) {
      note = (note ? note + ' ' : '') + `The file did not attach in Xero: ${err.message}`;
    }
  }
  if (note) await admin.from('supplier_bills').update({ xero_bill_error: note }).eq('id', bill.id);

  await admin.from('activity_log').insert({
    entity_type: 'supplier', entity_id: supplier.id, action: 'bill_pushed_xero', changed_by: actorId,
    description: `${word} ${bill.bill_number || '(no number)'} (${money(amount)}) sent to Xero as ${xeroNumber || xeroId}${reference ? ', reference ' + reference : ''}${note ? '. ' + note : ''}`,
  });
  return { xeroId, xeroNumber, note };
}

// The worker's run: every approved bill or credit note not yet in Xero (a failed one is tried again
// after a day). Does nothing until api_keys xero_bills_push = 'on' (new integrations start off on
// production until proven); Push to Xero by hand works regardless.
async function pushApprovedBills(admin, { limit = 20 } = {}) {
  const { data: flag } = await admin.from('api_keys').select('key_value').eq('key_name', 'xero_bills_push').maybeSingle();
  if ((flag?.key_value || '').toLowerCase() !== 'on') return { on: false, pushed: 0, failed: 0, errors: [] };
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: bills } = await admin.from('supplier_bills').select('id, bill_number')
    .is('xero_bill_id', null).not('supplier_id', 'is', null).or('approved_for_payment.eq.true,paid.eq.true')
    .or(`xero_tried_at.is.null,xero_tried_at.lt.${dayAgo}`).order('bill_date').limit(limit);
  let pushed = 0, failed = 0;
  const errors = [];
  for (const b of bills || []) {
    try { await pushBillToXero(admin, b.id); pushed += 1; }
    catch (err) {
      failed += 1;
      errors.push(`${b.bill_number || b.id}: ${err.message}`);
      await admin.from('supplier_bills').update({ xero_bill_error: String(err.message).slice(0, 500), xero_tried_at: new Date().toISOString() }).eq('id', b.id);
    }
  }
  return { on: true, pushed, failed, errors };
}

module.exports = { pushBillToXero, pushApprovedBills };
