// Ops manager actions for the AI assistant (docs/AI_AGENTS_PLAN.md): save an emailed bill against
// its PO, put one aside, and close a "Needs me" task. Same two steps as ai-actions.js: prepare()
// only works out and describes the change, the person presses Confirm, then execute() checks it
// again and does it. Both run as the signed-in person, so the database rules decide who may:
// emailed bills are Admin / Finance / Sales, "Needs me" tasks are Admin only.

const { getAdminClient } = require('./require-admin');
const { saveInboxItemAsBill } = require('./supplier-bill-intake');

const money = (n) => '$' + (Number(n) || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const NOT_ALLOWED = 'You do not have permission to do that.';

async function loadBill(client, id) {
  if (!isUuid(id)) return { error: 'Look up the emailed bill id in supplier_bill_inbox first.' };
  const { data: item, error } = await client.from('supplier_bill_inbox').select('*').eq('id', id).maybeSingle();
  if (error) return { error: error.message };
  if (!item) return { error: 'That emailed bill was not found (or you cannot see emailed bills).' };
  return { item };
}

function billLabel(item, supplierName) {
  const ex = item.extracted || {};
  return `bill ${ex.bill_number || '(no number)'} (${money(ex.total)}) from ${supplierName || ex.supplier || 'an unknown supplier'}`;
}

async function prepareOps(client, type, input) {
  input = input || {};
  try {
    if (type === 'save_emailed_bill' || type === 'put_aside_emailed_bill') {
      const { item, error } = await loadBill(client, input.bill_inbox_id);
      if (error) return { ok: false, error };
      if (!['to_check', 'failed'].includes(item.status)) return { ok: false, error: `That bill is not waiting to be checked (it is ${item.status.replace('_', ' ')}).` };
      let supplierName = null;
      if (item.supplier_id) {
        const { data: s } = await client.from('suppliers').select('name').eq('id', item.supplier_id).maybeSingle();
        supplierName = s?.name || null;
      }

      if (type === 'put_aside_emailed_bill') {
        return { ok: true, type, params: { bill_inbox_id: item.id }, summary: `Put aside ${billLabel(item, supplierName)} as not a bill`, link: '/supplier-bills.html' };
      }

      if (!item.supplier_id) return { ok: false, error: 'The supplier on that bill was not recognised. It has to be picked on the Emailed bills page first.' };
      if (!item.extracted || item.attachment_part_id === 'none') return { ok: false, error: 'That one has no bill read from it yet.' };
      let po = null;
      if (input.no_po) po = null;
      else if (input.po_id || input.po_number) {
        let q = client.from('purchase_orders').select('id, po_number, description, status, supplier_id, projects(name, job_number, quote_number)');
        q = input.po_id && isUuid(input.po_id) ? q.eq('id', input.po_id) : q.ilike('po_number', String(input.po_number).trim());
        const { data: found } = await q.limit(2);
        if (!found || !found.length) return { ok: false, error: `No PO ${input.po_number || ''} found.` };
        if (found.length > 1) return { ok: false, error: `More than one PO matches ${input.po_number}. Give the exact PO number.` };
        po = found[0];
      } else if (item.po_id) {
        const { data } = await client.from('purchase_orders').select('id, po_number, description, status, supplier_id, projects(name, job_number, quote_number)').eq('id', item.po_id).maybeSingle();
        po = data || null;
      }
      const warnings = [];
      if (po && po.supplier_id !== item.supplier_id) warnings.push(`${po.po_number} is for a different supplier.`);
      if (po && ['paid', 'invoiced'].includes(po.status)) warnings.push(`${po.po_number} is already ${po.status}.`);
      if (!po) warnings.push('It will be saved with no PO.');
      const job = po?.projects ? (po.projects.job_number ? `J${po.projects.job_number} - ${po.projects.name}` : po.projects.name) : (po ? 'Stock' : '');
      return {
        ok: true, type, link: '/supplier-bills.html',
        params: { bill_inbox_id: item.id, po_id: po?.id || null },
        summary: `Save ${billLabel(item, supplierName)}${po ? ` against ${po.po_number} (${job})` : ' with no PO'}`,
        warnings,
      };
    }

    if (type === 'close_agent_task') {
      if (!isUuid(input.task_id)) return { ok: false, error: 'Look up the task id in agent_tasks first.' };
      const outcome = input.outcome === 'dismissed' ? 'dismissed' : 'done';
      const { data: task, error } = await client.from('agent_tasks').select('id, title, status').eq('id', input.task_id).maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!task) return { ok: false, error: 'That task was not found (only admins can see them).' };
      if (task.status !== 'open') return { ok: false, error: 'That task is already closed.' };
      return { ok: true, type, params: { task_id: task.id, outcome }, summary: `${outcome === 'done' ? 'Mark done' : 'Dismiss'}: "${task.title}"`, link: '/ops.html' };
    }
    return { ok: false, error: `Unknown action "${type}".` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function executeOps(client, userId, type, params) {
  const prepared = await prepareOps(client, type, { ...(params || {}), no_po: params && params.po_id === null });
  if (!prepared.ok) return prepared;
  const p = prepared.params;
  const now = new Date().toISOString();

  if (type === 'save_emailed_bill') {
    const { data: allowed } = await client.rpc('is_pricing_role');
    if (!allowed) return { ok: false, error: NOT_ALLOWED };
    try {
      await saveInboxItemAsBill(getAdminClient(), p.bill_inbox_id, { poId: p.po_id, userId });
    } catch (err) { return { ok: false, error: err.message }; }
    return { ok: true, message: 'Done. Bill saved.' };
  }
  if (type === 'put_aside_emailed_bill') {
    const { data, error } = await client.from('supplier_bill_inbox').update({ status: 'not_a_bill', resolved_by: userId, resolved_at: now }).eq('id', p.bill_inbox_id).select('id');
    if (error || !data?.length) return { ok: false, error: error?.message || NOT_ALLOWED };
    return { ok: true, message: 'Done. Put aside.' };
  }
  if (type === 'close_agent_task') {
    const { data, error } = await client.from('agent_tasks').update({ status: p.outcome, resolved_by: userId, resolved_at: now }).eq('id', p.task_id).select('id');
    if (error || !data?.length) return { ok: false, error: error?.message || NOT_ALLOWED };
    return { ok: true, message: p.outcome === 'done' ? 'Done. Marked done.' : 'Done. Dismissed.' };
  }
  return { ok: false, error: `Unknown action "${type}".` };
}

const PROPOSE_NOTE = ' This only PROPOSES it: the person sees a summary with a Confirm button and nothing happens until they press it.';
const OPS_TOOLS = [
  {
    name: 'save_emailed_bill',
    description: 'Ops manager: propose saving a supplier bill that was emailed to invoice@ (a supplier_bill_inbox row with status to_check) against a PO. Leave out po_number to use the PO the bill reader matched (supplier_bill_inbox.po_id); set no_po true to save it with no PO. Look up the row first. It does not change stock, material prices, Xero or payment approval.' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: {
      bill_inbox_id: { type: 'string', description: 'supplier_bill_inbox.id' },
      po_number: { type: 'string', description: 'e.g. PO2014, only if the person wants a different PO from the matched one.' },
      no_po: { type: 'boolean' },
    }, required: ['bill_inbox_id'] },
  },
  {
    name: 'put_aside_emailed_bill',
    description: 'Ops manager: propose putting an emailed bill aside as not a bill (a statement, remittance, quote or spam sent to invoice@).' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: { bill_inbox_id: { type: 'string' } }, required: ['bill_inbox_id'] },
  },
  {
    name: 'close_agent_task',
    description: 'Ops manager: propose closing an open "Needs me" item (agent_tasks) as done or dismissed. Admin only.' + PROPOSE_NOTE,
    input_schema: { type: 'object', properties: { task_id: { type: 'string' }, outcome: { type: 'string', enum: ['done', 'dismissed'] } }, required: ['task_id'] },
  },
];
const OPS_TOOL_NAMES = OPS_TOOLS.map(t => t.name);

module.exports = { prepareOps, executeOps, OPS_TOOLS, OPS_TOOL_NAMES };
