// POST /.netlify/functions/sync-sm8-deposits-to-xero
// Body: { projectId }
// Pricing roles only. A deposit taken in ServiceM8 (a paid claim on the job's
// stage, cost_centres.imported_claims with paid and method, item 71) lands in
// Xero as a prepayment that ServiceM8 made, not an invoice. For each such claim
// not yet in Xero this: finds that unallocated prepayment on the client's Xero
// contact (same amount), raises a deposit invoice in Xero for the amount on the
// payment date (one line, Labour Income, GST inclusive), and allocates the
// prepayment to it, so both read Paid and the job's final invoice from the app
// claims only the balance. Nothing is raised when no matching prepayment is
// there: the claim records why, and the job page shows it. Safe to call twice:
// a claim is locked while it is being sent, and a claim with its invoice but no
// allocation only gets the allocation. After a Xero error the job page tries
// again an hour later, so a prepayment made since is picked up. The job page calls this when it opens
// with such a claim; the ServiceM8 import page calls it after an import.

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { xeroRequest } = require('./_shared/xero-client');
const { getOrCreateContact } = require('./_shared/build-xero-invoice-payload');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isUuid = (s) => /^[0-9a-f-]{36}$/i.test(String(s || ''));
const needsXero = (c) => c && c.source === 'servicem8' && c.paid && !c.xero_prepayment_id;

// Changes one claim on a stage, by number (the claim's other keys kept). With lock: true it only
// goes through when nobody else holds the claim (the row is matched on not containing
// xero_lock true, which Postgres re-checks under the row lock, so two calls at once cannot both
// send the same deposit); a lock older than ten minutes (a call that died) is taken over.
async function patchClaim(supabaseAdmin, stageId, number, patch, { lock = false } = {}) {
  const { data: stage, error } = await supabaseAdmin.from('cost_centres').select('imported_claims').eq('id', stageId).single();
  if (error) throw error;
  const current = Array.isArray(stage.imported_claims) ? stage.imported_claims : [];
  const mine = current.find(c => String(c.number) === String(number));
  if (!mine) return null;
  const next = current.map(c => (c === mine ? { ...c, ...patch } : c));
  let q = supabaseAdmin.from('cost_centres').update({ imported_claims: next }).eq('id', stageId)
    .filter('imported_claims', 'cs', JSON.stringify([{ number: mine.number }]));
  if (lock) {
    const stale = mine.xero_lock && mine.xero_started_at && (Date.now() - new Date(mine.xero_started_at).getTime() > 10 * 60 * 1000);
    if (!stale) q = q.not('imported_claims', 'cs', JSON.stringify([{ number: mine.number, xero_lock: true }]));
  }
  const { data: updated, error: upErr } = await q.select('id');
  if (upErr) throw upErr;
  return updated && updated.length ? next.find(c => c.number === mine.number) : null;
}

// Xero's JSON dates look like /Date(1590000000000+0000)/.
const xeroDate = (s) => { const m = String(s || '').match(/\/Date\((\d+)/); return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : String(s || '').slice(0, 10); };

async function findPrepayment(contactId, amountIncGst, paidDate) {
  const where = encodeURIComponent(`Contact.ContactID==Guid("${contactId}") AND Status=="AUTHORISED"`);
  const res = await xeroRequest('accounting', `Prepayments?where=${where}`);
  const open = (res.Prepayments || []).filter(p => r2(p.RemainingCredit) >= amountIncGst - 0.011);
  // the one made for this payment: same amount and date first, then same amount, then any with enough left
  const score = (p) => (Math.abs(r2(p.Total) - amountIncGst) < 0.011 ? 2 : 0) + (xeroDate(p.Date) === paidDate ? 1 : 0);
  return open.sort((a, b) => score(b) - score(a))[0] || null;
}

async function sendDeposit(supabaseAdmin, project, stage, claim, contactId, labourMap) {
  const amountIncGst = r2(claim.amount_inc > 0 ? claim.amount_inc : Number(claim.amount) * 1.1);
  const sm8 = project.sm8_job_number ? `#${project.sm8_job_number}` : 'job';
  let invoiceId = claim.xero_invoice_id || null, invoiceNumber = claim.xero_invoice_number || null;

  const prepayment = await findPrepayment(contactId, amountIncGst, claim.paid);
  if (!prepayment) {
    throw new Error(`No unallocated prepayment of $${amountIncGst.toFixed(2)} for ${project.client_name} in Xero. Check Sales > Invoices in Xero: if the deposit went in another way, make the deposit invoice there by hand.`);
  }
  if (!invoiceId) {
    const result = await xeroRequest('accounting', 'Invoices', {
      method: 'POST',
      body: {
        Invoices: [{
          Type: 'ACCREC',
          Contact: { ContactID: contactId },
          LineItems: [{
            Description: `Deposit, ServiceM8 ${sm8} (J${project.job_number})${claim.method ? `, paid by ${claim.method}` : ''}`,
            Quantity: 1, UnitAmount: amountIncGst, AccountCode: labourMap.xero_account_code, TaxType: labourMap.xero_tax_type,
          }],
          LineAmountTypes: 'Inclusive',
          Reference: `J${project.job_number} deposit`,
          Date: claim.paid,
          DueDate: claim.paid,
          Status: 'AUTHORISED',
        }],
      },
    });
    const inv = result.Invoices[0];
    invoiceId = inv.InvoiceID;
    invoiceNumber = inv.InvoiceNumber;
    // remembered straight away, so a failure below never makes a second invoice
    await patchClaim(supabaseAdmin, stage.id, claim.number, { xero_invoice_id: invoiceId, xero_invoice_number: invoiceNumber });
  }
  await xeroRequest('accounting', `Prepayments/${prepayment.PrepaymentID}/Allocations`, {
    method: 'PUT',
    body: { Allocations: [{ Invoice: { InvoiceID: invoiceId }, Amount: amountIncGst, Date: claim.paid }] },
  });
  await patchClaim(supabaseAdmin, stage.id, claim.number, {
    xero_invoice_id: invoiceId, xero_invoice_number: invoiceNumber, xero_prepayment_id: prepayment.PrepaymentID,
    xero_error: null, xero_lock: false, xero_started_at: null, xero_tried_at: new Date().toISOString(),
  });
  return { invoiceNumber, amountIncGst };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ error: 'Not authorized' }) };
  const { supabaseAdmin, user } = auth;

  try {
    const { projectId } = JSON.parse(event.body || '{}');
    if (!isUuid(projectId)) return { statusCode: 400, body: JSON.stringify({ error: 'projectId is required' }) };

    const { data: project, error: pErr } = await supabaseAdmin.from('projects')
      .select('id, job_number, sm8_job_number, client_name, client_email, xero_contact_id, clients(address, xero_contact_id), cost_centres(id, sort_order, imported_claims)')
      .eq('id', projectId).single();
    if (pErr || !project) return { statusCode: 404, body: JSON.stringify({ error: 'Job not found' }) };

    const todo = [];
    for (const stage of (project.cost_centres || []).sort((a, b) => a.sort_order - b.sort_order)) {
      for (const claim of (Array.isArray(stage.imported_claims) ? stage.imported_claims : [])) {
        if (needsXero(claim)) todo.push({ stage, claim });
      }
    }
    if (!todo.length) return { statusCode: 200, body: JSON.stringify({ ok: true, results: [] }) };

    const { data: mappings } = await supabaseAdmin.from('xero_account_mapping').select('*');
    const labourMap = (mappings || []).find(m => m.category === 'labour');
    if (!labourMap) throw new Error('Set the Labour Income account in Settings > Xero Mapping first.');

    const existingContact = project.xero_contact_id || project.clients?.xero_contact_id || null;
    const contactId = await getOrCreateContact({ name: project.client_name, email: project.client_email, address: project.clients?.address }, { xero_contact_id: existingContact });
    if (!project.xero_contact_id) await supabaseAdmin.from('projects').update({ xero_contact_id: contactId }).eq('id', project.id);

    const results = [];
    for (const { stage, claim } of todo) {
      // taken by this call, or already on its way in another
      const taken = await patchClaim(supabaseAdmin, stage.id, claim.number, { xero_lock: true, xero_started_at: new Date().toISOString() }, { lock: true });
      if (!taken) { results.push({ number: claim.number, ok: false, error: 'Already being sent' }); continue; }
      try {
        const sent = await sendDeposit(supabaseAdmin, project, stage, taken, contactId, labourMap);
        results.push({ number: claim.number, ok: true, ...sent });
        await supabaseAdmin.from('activity_log').insert({
          entity_type: 'project', entity_id: project.id, action: 'deposit_in_xero',
          description: `ServiceM8 deposit $${sent.amountIncGst.toFixed(2)} raised in Xero as ${sent.invoiceNumber} and the prepayment allocated to it`,
          changed_by: user.id,
        });
      } catch (err) {
        console.error('sync-sm8-deposits-to-xero:', project.job_number, claim.number, err.message);
        await patchClaim(supabaseAdmin, stage.id, claim.number, { xero_error: String(err.message).slice(0, 300), xero_lock: false, xero_started_at: null, xero_tried_at: new Date().toISOString() });
        results.push({ number: claim.number, ok: false, error: err.message });
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, results }) };
  } catch (err) {
    console.error('sync-sm8-deposits-to-xero error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
