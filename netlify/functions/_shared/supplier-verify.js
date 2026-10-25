// Checks the supplier details read off a bill against the ABN Lookup (_shared/abr.js), and
// creates a supplier from a bill when nobody matches (spec A11a, migration 20261020010000).
//
// checkSupplierDetails() returns the abn_check stored on the supplier_bill_inbox row:
//   { checked_at, abn, legal_name, business_names, status, gst_registered, suggested_abn,
//     problems: [...], notes: [...] }
// problems (any one stops automatic saving):
//   the ABN on the bill does not exist, or is cancelled;
//   the ABN belongs to a business whose names do not match the bill;
//   the bill charges GST but the ABN is not registered for GST;
//   the bank details on the bill differ from the ones saved for the matched supplier
//   (the classic fake-invoice trick).
// No ABN on the bill: the name is searched and a likely ABN is suggested (a note, not a match).
// If the ABN Lookup cannot be reached, a note says so and nothing is blocked.

const { abnDetails, searchNames } = require('./abr');
const { fuzzyMatchScore } = require('./supplier-bill-intake');

const cleanAbn = (s) => String(s || '').replace(/\D/g, '');
const bestName = (names, wanted) => names.reduce((best, n) => {
  const score = Math.max(fuzzyMatchScore(n, wanted), fuzzyMatchScore(wanted, n));
  return score > best.score ? { name: n, score } : best;
}, { name: null, score: 0 });

async function checkSupplierDetails(ex, matchedSupplier) {
  const out = { checked_at: new Date().toISOString(), problems: [], notes: [] };
  const billName = ex.supplier || '';
  try {
    const abn = cleanAbn(ex.abn);
    if (abn) {
      const d = await abnDetails(abn);
      if (!d.ok) {
        out.problems.push(`The ABN on the bill (${ex.abn}) is not in the ABN Lookup`);
      } else {
        Object.assign(out, { abn: d.abn, legal_name: d.name, business_names: d.businessNames, status: d.status, gst_registered: !!d.gstFrom });
        if (!/active/i.test(d.status || '')) out.problems.push(`The ABN ${d.abn} is ${String(d.status || 'not active').toLowerCase()}`);
        const match = bestName([d.name, ...d.businessNames].filter(Boolean), billName);
        if (billName && match.score < 0.34) out.problems.push(`The ABN ${d.abn} belongs to "${d.name}"${d.businessNames.length ? ` (trading as ${d.businessNames.slice(0, 3).join(', ')})` : ''}, but the bill says "${billName}"`);
        else out.notes.push(`ABN checked: ${d.name}${match.name && match.name !== d.name ? ` trading as ${match.name}` : ''}`);
        if (Number(ex.gst) > 0 && !d.gstFrom) out.problems.push(`The bill charges GST but ${d.name} is not registered for GST`);
      }
    } else if (billName.trim().length >= 3) {
      const { results } = await searchNames(billName, 5);
      const active = results.filter(r => /active/i.test(r.status || '') || !r.status);
      const top = active.map(r => ({ ...r, score: Math.max(fuzzyMatchScore(r.name, billName), fuzzyMatchScore(billName, r.name)) })).sort((a, b) => b.score - a.score)[0];
      if (top && top.score >= 0.6) { out.suggested_abn = top.abn; out.notes.push(`No ABN on the bill. ABN Lookup suggests ${top.name} (ABN ${top.abn}${top.state ? ', ' + top.state : ''}): check before paying`); }
      else out.notes.push('No ABN on the bill and no clear match in the ABN Lookup');
    }
  } catch (err) {
    out.notes.push(`ABN Lookup could not be reached (${err.message.slice(0, 80)}); not checked`);
  }

  // bank details different from what we have saved for this supplier
  const s = matchedSupplier;
  if (s && ex.bank_account_number && s.bank_account_number && cleanAbn(ex.bank_account_number) !== cleanAbn(s.bank_account_number)) {
    out.problems.push(`The bank account on the bill (BSB ${ex.bsb || '?'} account ${ex.bank_account_number}) is different from the one saved for ${s.name}. Call the supplier on a number you already have before paying`);
  }
  if (s && s.abn && out.abn && cleanAbn(s.abn) !== cleanAbn(out.abn)) {
    out.problems.push(`The ABN on the bill (${out.abn}) is different from the one saved for ${s.name} (${s.abn})`);
  }
  return out;
}

// A new supplier from a bill nobody matched. The name is the registered business name that best
// matches the bill when the ABN checked out, otherwise the name as read. Marked needs_review: the
// bank details are not trusted (or paid to) until a person has opened and saved the supplier.
// Returns null when a supplier with that name is already saved (names are unique): the bill then
// waits for a person to pick the supplier, since its ABN or bank details did not match the saved one.
async function createSupplierFromBill(admin, ex, abnCheck) {
  const verified = abnCheck && abnCheck.legal_name && !abnCheck.problems.length;
  let name = (ex.supplier || '').trim() || 'Unknown supplier';
  if (verified) {
    const m = bestName([...(abnCheck.business_names || []), abnCheck.legal_name], name);
    name = m.score >= 0.34 ? m.name : abnCheck.legal_name;
  }
  const { data: taken } = await admin.from('suppliers').select('id').ilike('name', name.replace(/[\\%_]/g, '\\$&')).limit(1);
  if ((taken || []).length) return null;
  const { data, error } = await admin.from('suppliers').insert({
    name,
    kind: ex.supplier_kind === 'contractor' ? 'contractor' : 'supplier',
    needs_review: true,
    created_from: 'bill',
    credit_terms_type: 'net_days',
    credit_terms_days: 30,
    abn: abnCheck?.abn || ex.abn || null,
    abn_legal_name: abnCheck?.legal_name || null,
    gst_registered: abnCheck?.gst_registered ?? null,
    abn_checked_at: abnCheck?.legal_name ? abnCheck.checked_at : null,
    our_account_number: ex.our_account_number || null,
    contact_email: ex.contact_email || null,
    contact_phone: ex.contact_phone || null,
    bank_account_name: ex.bank_account_name || null,
    bsb: ex.bsb || null,
    bank_account_number: ex.bank_account_number || null,
    bpay_biller_code: ex.bpay_biller_code || null,
    bpay_reference: ex.bpay_reference || null,
  }).select('*').single();
  if (error && error.code === '23505') return null; // the name was taken between the look-up and the insert
  if (error) throw error;
  await admin.from('activity_log').insert({ entity_type: 'supplier', entity_id: data.id, action: 'created', description: `${data.kind === 'contractor' ? 'Contractor' : 'Supplier'} "${name}" created automatically from an emailed bill${verified ? ' (ABN checked)' : ''}. Check the details before paying.`, changed_by: null });
  return data;
}

module.exports = { checkSupplierDetails, createSupplierFromBill };
