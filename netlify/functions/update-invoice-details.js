// POST /.netlify/functions/update-invoice-details (owner, 16 Nov 2026). Pricing roles.
// Edit details on an invoice that is not paid, whether or not it is in Xero: the invoice date, due
// date and name, and the job's name and site address (the invoice reads those from the job, so the
// job and every document on it stay the same). Amounts are not touched: they change through Edit
// (before Xero) or a credit note (after). In one go: saves, writes one history line, remakes the
// PDF, and when the invoice is in Xero sends the change there (_shared/update-invoice-in-xero.js).
// A Xero update that does not go is recorded in the history as "Xero not updated: <reason>", and the
// panel offers Resend to Xero ({ invoiceId, resend: true }) until one goes.
// Body: { invoiceId, invoiceDate (YYYY-MM-DD), dueDate (YYYY-MM-DD or ''), description, jobName, siteAddress }
//   or  { invoiceId, resend: true }
// Answer: { ok, changed, xero: null | { ok, error } }

const { requirePricingRole } = require('./_shared/require-pricing-role');
const { logInvoiceEvent } = require('./_shared/invoice-events');
const { regenerateInvoicePdf } = require('./_shared/regenerate-invoice-pdf');
const { updateInvoiceInXero, readXeroInvoice, xeroInvoiceBlocker } = require('./_shared/update-invoice-in-xero');

const reply = (statusCode, body) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const sydneyDay = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' }) : null);
const dayText = (key) => (key ? new Date(`${key}T12:00:00Z`).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : 'none');
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const quoted = (v) => (v ? `"${v}"` : 'none');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { ok: false, error: 'Method not allowed' });
  const auth = await requirePricingRole(event);
  if (!auth) return reply(403, { ok: false, error: 'Only Admin, Finance or Sales can change an invoice.' });
  const { supabaseAdmin: admin, user } = auth;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { ok: false, error: 'Bad request' }); }
  const { invoiceId } = body;
  if (!invoiceId) return reply(400, { ok: false, error: 'invoiceId is required' });

  try {
    const { data: inv, error } = await admin.from('invoices')
      .select('id, invoice_number, sent_at, due_date, description, paid_at, xero_invoice_id, pdf_path, project_id, cost_centre_id, cost_centres(project_id)')
      .eq('id', invoiceId).maybeSingle();
    if (error) throw error;
    if (!inv) return reply(404, { ok: false, error: 'Invoice not found' });
    if (inv.paid_at) return reply(400, { ok: false, error: 'This invoice is paid. Changes go through a credit note.' });

    // Resend to Xero: the invoice's details as they are now, nothing else changes
    if (body.resend) {
      if (!inv.xero_invoice_id) return reply(400, { ok: false, error: 'This invoice is not in Xero yet. Use Push to Xero.' });
      try {
        await updateInvoiceInXero(admin, inv.id);
      } catch (err) {
        await logInvoiceEvent(admin, { invoiceId: inv.id, kind: 'edited', actorId: user.id, detail: `Xero not updated: ${err.message}` });
        return reply(200, { ok: true, changed: false, xero: { ok: false, error: err.message } });
      }
      await logInvoiceEvent(admin, { invoiceId: inv.id, kind: 'pushed_to_xero', actorId: user.id, detail: 'Changes sent to Xero (Xero updated)' });
      return reply(200, { ok: true, changed: false, xero: { ok: true } });
    }

    const projectId = inv.project_id || (inv.cost_centres && inv.cost_centres.project_id) || null;
    const { data: project } = projectId
      ? await admin.from('projects').select('id, name, client_address, client_site_id, client_id').eq('id', projectId).maybeSingle()
      : { data: null };

    // What changed (only the fields sent are looked at)
    const invoiceChange = {}, projectChange = {}, said = [];
    const oldDate = sydneyDay(inv.sent_at);
    if (body.invoiceDate !== undefined) {
      if (!isDay(body.invoiceDate)) return reply(400, { ok: false, error: 'Pick the invoice date.' });
      if (body.invoiceDate !== oldDate) { invoiceChange.sent_at = new Date(`${body.invoiceDate}T00:00:00Z`).toISOString(); said.push(`Invoice date ${dayText(oldDate)} to ${dayText(body.invoiceDate)}`); }
    }
    if (body.dueDate !== undefined) {
      const due = body.dueDate || null;
      if (due && !isDay(due)) return reply(400, { ok: false, error: 'The due date is not a date.' });
      if (due !== (inv.due_date || null)) { invoiceChange.due_date = due; said.push(`Due ${dayText(inv.due_date)} to ${dayText(due)}`); }
    }
    const newDate = body.invoiceDate !== undefined ? body.invoiceDate : oldDate;
    const newDue = body.dueDate !== undefined ? (body.dueDate || null) : inv.due_date;
    if (newDue && newDate && newDue < newDate) return reply(400, { ok: false, error: 'The due date is before the invoice date.' });
    if (body.description !== undefined) {
      const d = clean(body.description) || null;
      if (d !== (clean(inv.description) || null)) { invoiceChange.description = d; said.push(`Name ${quoted(inv.description)} to ${quoted(d)}`); }
    }
    if (project && body.jobName !== undefined) {
      const n = clean(body.jobName);
      if (!n) return reply(400, { ok: false, error: 'The job needs a name.' });
      if (n !== clean(project.name)) { projectChange.name = n; said.push(`Job name ${quoted(project.name)} to ${quoted(n)}`); }
    }
    if (project && body.siteAddress !== undefined) {
      const a = clean(body.siteAddress);
      if (!a) return reply(400, { ok: false, error: 'The job needs a site address.' });
      if (a.toLowerCase() !== clean(project.client_address).toLowerCase()) {
        projectChange.client_address = a;
        projectChange.client_site_id = await siteIdFor(admin, project.client_id, a);
        said.push(`Job site ${quoted(project.client_address)} to ${quoted(a)}`);
      }
    }
    if (!said.length) return reply(200, { ok: true, changed: false, xero: null });

    // Xero first: when it already shows a payment it will refuse, so nothing here changes either.
    // If Xero cannot be reached the change is saved here and offered again (Resend to Xero).
    let xeroReachError = null;
    if (inv.xero_invoice_id) {
      try {
        const blocker = xeroInvoiceBlocker(await readXeroInvoice(inv.xero_invoice_id));
        if (blocker) return reply(400, { ok: false, error: `Nothing was changed: ${blocker}` });
      } catch (err) { xeroReachError = err.message; }
    }

    if (Object.keys(invoiceChange).length) {
      const { error: upErr } = await admin.from('invoices').update(invoiceChange).eq('id', inv.id).is('paid_at', null);
      if (upErr) throw upErr;
    }
    if (Object.keys(projectChange).length) {
      const { error: pErr } = await admin.from('projects').update(projectChange).eq('id', project.id);
      if (pErr) throw pErr;
    }

    let xero = null;
    if (inv.xero_invoice_id) {
      try {
        if (xeroReachError) throw new Error(xeroReachError);
        await updateInvoiceInXero(admin, inv.id);
        xero = { ok: true };
      } catch (err) { xero = { ok: false, error: err.message }; }
    }
    const tail = !xero ? '' : xero.ok ? '. Xero updated' : `. Xero not updated: ${xero.error}`;
    await logInvoiceEvent(admin, { invoiceId: inv.id, kind: 'edited', actorId: user.id, detail: `${said.join('; ')}${tail}` });
    if (inv.pdf_path) await regenerateInvoicePdf(inv.id);
    return reply(200, { ok: true, changed: true, xero });
  } catch (err) {
    console.error('update-invoice-details:', err.message);
    return reply(500, { ok: false, error: err.message || 'Could not save the invoice details.' });
  }
};

// The client's saved site for this address (made when new), or none when it is their office address:
// the same rule the job page uses (resolveClientSite in js/supabase-client.js).
async function siteIdFor(admin, clientId, address) {
  if (!clientId) return null;
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const { data: client } = await admin.from('clients').select('address').eq('id', clientId).maybeSingle();
  if (client && same(client.address, address)) return null;
  const { data: sites } = await admin.from('client_sites').select('id, address').eq('client_id', clientId);
  const found = (sites || []).find((s) => same(s.address, address));
  if (found) return found.id;
  const { data: made, error } = await admin.from('client_sites').insert({ client_id: clientId, address }).select('id').single();
  if (!error && made) return made.id;
  const again = ((await admin.from('client_sites').select('id, address').eq('client_id', clientId)).data || []).find((s) => same(s.address, address));
  return again ? again.id : null;
}
