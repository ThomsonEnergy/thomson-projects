// Reads a supplier invoice or bill (PDF or photo) with Claude and returns the
// structured fields. Shared by extract-supplier-invoice.js (manual upload) and
// the invoice@ bill intake (_shared/supplier-bill-intake.js), so both read
// bills the same way. Extraction only: nothing is saved here.

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./get-integration-key');
const { claudeJson } = require('./claude-json');

// Returns { extracted, usage } (usage = the Claude tokens, for the ops manager's log).
async function extractSupplierInvoiceWithUsage({ fileBase64, mediaType }) {
  const apiKey = await getIntegrationKey('anthropic');
  const isPdf = mediaType === 'application/pdf';

  const prompt = `This is a supplier invoice or bill for an electrical/solar contracting business. Extract the following as accurately as possible:

- supplier: the supplier/vendor's business name
- our_account_number: the account number THIS SUPPLIER uses to identify US as their customer - often labelled "Charge To", "Customer Account", "Account No", "Customer No", or similar, shown near the billing address. This is NOT their ABN and NOT their own bank details - it's specifically the number that identifies our account with them. Null if not shown.
- our_order_reference: the reference to OUR purchase order, if the supplier's invoice shows one - often labelled "Your Order", "Customer PO No", "PO Number", "Order Ref", or similar. This is different from their own invoice number. Null if not shown.
- abn: the supplier's own ABN, if shown
- contact_phone: the supplier's phone number, if shown
- contact_email: the supplier's email address, if shown
- bank_account_name: the account name for paying them by bank transfer, if shown
- bsb: their BSB, if shown
- bank_account_number: their bank account number, if shown
- bpay_biller_code: their BPAY Biller Code, if shown
- bpay_reference: the BPAY reference/Ref number for paying this account, if shown
- document_type: one of "invoice" (a tax invoice or bill to pay), "credit_note", "statement" (a list of several invoices or an account summary), or "other" (a quote, remittance, order confirmation, delivery docket or anything else)
- supplier_kind: "contractor" if the bill is mostly labour or services (hours, call-out, installation, labour hire, equipment hire with an operator, trade work), "supplier" if it is mostly goods or materials
- bill_number: their invoice or bill number
- bill_date: the invoice date, as YYYY-MM-DD
- line_items: an array of every line item, each with:
  - description: the item/material description as written
  - quantity: numeric quantity (default to 1 if not shown)
  - unit_cost: the cost per unit, ex-GST if both are shown, as a plain number (no currency symbols)
- subtotal: the subtotal before GST, as a plain number
- gst: the GST amount, as a plain number
- total: the total amount, as a plain number

If a field genuinely isn't visible or determinable, use null rather than guessing. Respond with ONLY a JSON object, no other text, no markdown fences.`;

  const contentBlock = isPdf
    ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: claudeJson({
      model: 'claude-sonnet-5-5',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: prompt }],
      }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const raw = data.content.map((b) => b.text || '').join('').trim();
  const cleaned = raw.replace(/^```json/i, '').replace(/```$/, '').trim();
  return { extracted: JSON.parse(cleaned), usage: data.usage || {} };
}

async function extractSupplierInvoice(file) {
  return (await extractSupplierInvoiceWithUsage(file)).extracted;
}

module.exports = { extractSupplierInvoice, extractSupplierInvoiceWithUsage };
