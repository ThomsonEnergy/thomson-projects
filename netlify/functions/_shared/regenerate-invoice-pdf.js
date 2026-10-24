// Asks generate-client-document-pdf to remake an invoice's PDF, so a PDF that was made while the
// invoice was unpaid gets its PAID stamp as soon as the payment is recorded.
//
// The PDF takes longer than a webhook should wait, so the request is sent and then let go after a few
// seconds: the PDF function carries on and finishes on its own. Never throws: a failed refresh must
// not make a payment webhook fail (the Regenerate PDF button on the invoice still works).
const fetch = require('node-fetch');
const { selfBaseUrl } = require('./site-url');
const { internalHeaders } = require('./require-internal');

async function regenerateInvoicePdf(invoiceId, waitMs = 3000) {
  if (!invoiceId) return;
  const base = selfBaseUrl();
  try {
    await Promise.race([
      fetch(`${base}/.netlify/functions/generate-client-document-pdf`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...internalHeaders() },
        body: JSON.stringify({ doc_type: 'invoice', record_id: invoiceId }),
      }).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, waitMs)),
    ]);
  } catch (err) {
    console.error('Could not ask for a fresh invoice PDF:', err.message);
  }
}

module.exports = { regenerateInvoicePdf };
