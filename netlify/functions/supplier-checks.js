// POST /.netlify/functions/supplier-checks
// Body: { action, id, ... } - the buttons on the Bill checks page (supplier-checks.html) and the
// supplier page. Pricing roles only (Admin, Finance, Sales). See spec A11c.
//
//   check_bill        { id }                       check a bill against its PO now
//   approve_bill      { id }                       approve for payment
//   resolve_bill      { id, note }                 accept the differences (or the query is sorted)
//   reconcile         { id }                       reconcile a statement now (after an upload)
//   statement_supplier{ id, supplier_id }          pick the supplier for a statement
//   statement_reviewed{ id }                       a person has gone through the issues
//   statement_retry   { id }                       read an emailed statement again
//   draft_email       { kind, id }                 kind: bill_query | statement_query | request_copies | request_statement
//   send_email        { kind, id, to, subject, body }

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { checkBillAndSiblings } = require('./_shared/bill-check');
const { reconcileStatement, startStatementProcessing } = require('./_shared/statement-intake');
const { draft, send } = require('./_shared/supplier-email');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const KINDS = ['bill_query', 'statement_query', 'request_copies', 'request_statement'];

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  const { supabaseAdmin: admin, user } = auth;

  try {
    const { action, id, note, supplier_id: supplierId, kind, to, subject, body } = JSON.parse(event.body || '{}');
    if (!id) return json(400, { ok: false, error: 'id is required' });
    const now = new Date().toISOString();
    const log = (entityType, entityId, act, description) => admin.from('activity_log').insert({ entity_type: entityType, entity_id: entityId, action: act, description, changed_by: user.id });

    if (action === 'check_bill') return json(200, { ok: true, ...(await checkBillAndSiblings(admin, id)) });

    if (action === 'approve_bill' || action === 'resolve_bill') {
      const { data: bill } = await admin.from('supplier_bills').select('id, supplier_id, bill_number, check_status').eq('id', id).maybeSingle();
      if (!bill) return json(404, { ok: false, error: 'That bill was not found.' });
      if (action === 'approve_bill') {
        await admin.from('supplier_bills').update({ approved_for_payment: true, approved_by: user.id, approved_at: now }).eq('id', id);
        await log('supplier', bill.supplier_id, 'bill_approved', `Bill ${bill.bill_number || ''} approved for payment${bill.check_status && bill.check_status !== 'matches' ? ` (check: ${bill.check_status})` : ''}`);
      } else {
        await admin.from('supplier_bills').update({ check_status: 'resolved', resolved_note: note || null, resolved_by: user.id, resolved_at: now }).eq('id', id);
        await log('supplier', bill.supplier_id, 'bill_resolved', `Bill ${bill.bill_number || ''} differences accepted${note ? ': ' + note : ''}`);
      }
      return json(200, { ok: true });
    }

    if (action === 'reconcile') return json(200, { ok: true, ...(await reconcileStatement(admin, id)) });
    if (action === 'statement_supplier') {
      if (!supplierId) return json(400, { ok: false, error: 'supplier_id is required' });
      await admin.from('supplier_statements').update({ supplier_id: supplierId }).eq('id', id);
      return json(200, { ok: true, ...(await reconcileStatement(admin, id)) });
    }
    if (action === 'statement_reviewed') {
      await admin.from('supplier_statements').update({ status: 'reviewed', reviewed_by: user.id, reviewed_at: now }).eq('id', id);
      return json(200, { ok: true });
    }
    if (action === 'statement_retry') {
      await admin.from('supplier_statements').update({ status: 'pending', attempts: 0, error: null, lines: [] }).eq('id', id);
      await startStatementProcessing();
      return json(200, { ok: true });
    }

    if (action === 'draft_email' || action === 'send_email') {
      if (!KINDS.includes(kind)) return json(400, { ok: false, error: 'Unknown email kind' });
      if (action === 'draft_email') return json(200, { ok: true, ...(await draft(admin, kind, id)) });
      const r = await send(admin, { kind, id, to, subject, body });
      const entity = kind === 'bill_query' ? 'bill' : (kind === 'request_statement' ? 'supplier' : 'statement');
      if (entity === 'supplier') await log('supplier', id, 'statement_requested', `Statement requested by email (to ${to})`);
      else {
        const table = entity === 'bill' ? 'supplier_bills' : 'supplier_statements';
        const { data: row } = await admin.from(table).select('supplier_id').eq('id', id).maybeSingle();
        if (row?.supplier_id) await log('supplier', row.supplier_id, `${entity}_query_sent`, `Emailed ${to}: ${subject}`);
      }
      return json(200, { ok: true, ...r });
    }
    return json(400, { ok: false, error: 'Unknown action' });
  } catch (err) {
    console.error('supplier-checks failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
