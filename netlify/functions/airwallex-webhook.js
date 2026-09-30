// POST /.netlify/functions/airwallex-webhook
// Configured in Airwallex web app > Settings > Developer > Webhooks,
// subscribed to the single event payment_link.paid.
//
// Signature verification confirmed directly from Airwallex's own code
// examples: HMAC-SHA256(secret, x-timestamp + rawBody), hex digest,
// compared against the x-signature header.

const crypto = require('crypto');
const { getAdminClient } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { advanceToActionOrReady, checkAndAdvanceComplete } = require('./_shared/advance-job-stage');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');

  let webhookSecret;
  try {
    webhookSecret = await getIntegrationKey('airwallex_webhook_secret');
  } catch (err) {
    console.error('Airwallex webhook: no secret found in Settings > API Keys. Save one and try again.', err.message);
    return { statusCode: 401, body: '' };
  }

  const timestamp = event.headers['x-timestamp'] || event.headers['X-Timestamp'];
  const signature = event.headers['x-signature'] || event.headers['X-Signature'];

  if (!timestamp || !signature) {
    console.error('Airwallex webhook: missing x-timestamp or x-signature header.');
    return { statusCode: 401, body: '' };
  }

  const expected = crypto.createHmac('sha256', webhookSecret).update(timestamp + rawBody, 'utf8').digest('hex');
  if (signature !== expected) {
    console.error(
      `Airwallex webhook: signature mismatch. Received length ${signature.length}, expected length ${expected.length}. ` +
      `Double-check Settings > API Keys > Airwallex Webhook Secret matches the secret shown when the webhook was created.`
    );
    return { statusCode: 401, body: '' };
  }

  try {
    const payload = JSON.parse(rawBody || '{}');
    // Standard Airwallex webhook envelope: { name, data: { object: {...} } }
    const eventName = payload.name;
    const resource = payload.data?.object;

    if (eventName === 'payment_link.paid' && resource) {
      const supabaseAdmin = getAdminClient();
      const linkId = resource.id;
      const reference = resource.reference; // we set this to our invoice_number at creation

      const query = supabaseAdmin.from('invoices').select('id, paid_at, is_deposit, project_id');
      const { data: invoiceRow } = linkId
        ? await query.eq('airwallex_payment_link_id', linkId).maybeSingle()
        : await query.eq('invoice_number', reference).maybeSingle();

      if (invoiceRow && !invoiceRow.paid_at) {
        await supabaseAdmin
          .from('invoices')
          .update({ paid_at: new Date().toISOString() })
          .eq('id', invoiceRow.id);

        // Same deposit -> quote_approved advancement as xero-webhook.js -
        // see advance-job-stage.js for why this only moves a job that's
        // still actually waiting at quote_approved.
        if (invoiceRow.project_id) {
          if (invoiceRow.is_deposit) {
            const { data: project } = await supabaseAdmin.from('projects').select('pipeline_stage').eq('id', invoiceRow.project_id).maybeSingle();
            if (project?.pipeline_stage === 'quote_approved') {
              await supabaseAdmin.from('projects').update({ pipeline_stage: 'deposit_paid' }).eq('id', invoiceRow.project_id);
              await advanceToActionOrReady(supabaseAdmin, invoiceRow.project_id);
            }
          }
          await checkAndAdvanceComplete(supabaseAdmin, invoiceRow.project_id);
        }
      } else if (!invoiceRow) {
        console.error(`Airwallex webhook: payment_link.paid for link ${linkId} (reference ${reference}) didn't match any invoice.`);
      }
    }
  } catch (err) {
    // Log but still return 200 - Airwallex will retry on non-2xx, and a
    // processing bug on our end shouldn't cause repeated redelivery storms.
    console.error('Error processing Airwallex webhook event:', err.message);
  }

  return { statusCode: 200, body: '' };
};
