// POST /.netlify/functions/xero-webhook
// Configured in the Xero Developer Portal against this URL, subscribed to
// the "Invoices" topic. No auth header from Xero - instead every request
// is signed with the Webhook Key (Settings > API Keys), verified below.
//
// Xero requires a 200 response within 5 seconds, including for the
// one-time "intent to receive" validation it sends when you first save
// the webhook - that validation is just an empty payload with a valid
// signature, handled the same way as a real event below.

const crypto = require('crypto');
const { getAdminClient } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { xeroRequest } = require('./_shared/xero-client');
const { regenerateInvoicePdf } = require('./_shared/regenerate-invoice-pdf');
const { advanceToActionOrReady, checkAndAdvanceComplete } = require('./_shared/advance-job-stage');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  let webhookKey;
  try {
    webhookKey = await getIntegrationKey('xero_webhook_key');
  } catch (err) {
    console.error('No Xero webhook key configured:', err.message);
    return { statusCode: 401, body: '' };
  }

  const signature = event.headers['x-xero-signature'] || event.headers['X-Xero-Signature'];
  const expected = crypto.createHmac('sha256', webhookKey).update(rawBody, 'utf8').digest('base64');
  if (signature !== expected) {
    // Wrong signature - could be a forged request, or the validation
    // handshake before the key was saved correctly. Either way, don't
    // process it, but still respond quickly.
    return { statusCode: 401, body: '' };
  }

  // Acknowledge immediately conceptually - everything below is fast
  // (one Xero lookup + one Supabase update per event), well inside the
  // 5 second budget, so it's safe to finish processing before returning.
  try {
    const payload = JSON.parse(rawBody || '{}');
    const events = payload.events || [];
    const supabaseAdmin = getAdminClient();

    for (const evt of events) {
      if (evt.eventCategory !== 'INVOICE') continue;

      const { data: invoiceRow } = await supabaseAdmin
        .from('invoices')
        .select('id, paid_at, is_deposit, project_id')
        .eq('xero_invoice_id', evt.resourceId)
        .maybeSingle();
      if (!invoiceRow) continue; // not one of ours, or not pushed to Xero (yet)

      const invoiceDetail = await xeroRequest('accounting', `Invoices/${evt.resourceId}`);
      const xeroInvoice = invoiceDetail.Invoices?.[0];
      if (!xeroInvoice) continue;

      // Paid = Xero says PAID and money was actually received (AmountPaid > 0).
      // A credit note fully allocated against an invoice zeroes AmountDue and
      // can leave it PAID with nothing received, which must not be recorded
      // here as paid_at (bug review M12).
      const isPaid = xeroInvoice.Status === 'PAID' && Number(xeroInvoice.AmountPaid || 0) > 0;
      const justPaid = isPaid && !invoiceRow.paid_at;

      await supabaseAdmin
        .from('invoices')
        .update({
          xero_invoice_status: xeroInvoice.Status,
          paid_at: justPaid ? new Date().toISOString() : invoiceRow.paid_at,
        })
        .eq('id', invoiceRow.id);

      // Deposit invoice just cleared - advance the job off
      // 'quote_approved' rather than leaving it waiting on a payment
      // that's already arrived. Only touches the row if it's still
      // sitting at quote_approved, so a redelivered/duplicate webhook
      // (or a deposit paid well after the job moved on for some other
      // reason) can't push it backwards.
      if (justPaid) await regenerateInvoicePdf(invoiceRow.id, 1200); // short wait: Xero wants its answer within 5 seconds // remake the PDF so it carries the PAID stamp

      if (justPaid && invoiceRow.project_id) {
        if (invoiceRow.is_deposit) {
          const { data: project } = await supabaseAdmin.from('projects').select('pipeline_stage').eq('id', invoiceRow.project_id).maybeSingle();
          if (project?.pipeline_stage === 'quote_approved') {
            await supabaseAdmin.from('projects').update({ pipeline_stage: 'deposit_paid' }).eq('id', invoiceRow.project_id);
            await advanceToActionOrReady(supabaseAdmin, invoiceRow.project_id);
          }
        }
        await checkAndAdvanceComplete(supabaseAdmin, invoiceRow.project_id);
      }
    }
  } catch (err) {
    // Log but still return 200 - Xero will retry on non-2xx, and a
    // processing bug on our end shouldn't cause repeated redelivery storms.
    console.error('Error processing Xero webhook event:', err.message);
  }

  return { statusCode: 200, body: '' };
};
