// POST /.netlify/functions/process-supplier-bills-background
//
// Background function (reading a PDF with Claude takes longer than a normal function gets).
// Started by the Gmail sync (_shared/gmail-sync.js) when an invoice@ bill comes in, when
// bills are still waiting, and once an hour; and by the Emailed bills page's Retry button.
// It only works through rows already queued or emails already in the Supplier Bills label,
// so calling it with no body is harmless. The work lives in _shared/supplier-bill-intake.js.

const { processSupplierBills } = require('./_shared/supplier-bill-intake');
const { extractAttachments, extractPlainText } = require('./_shared/gmail-sync');

exports.handler = async () => {
  try {
    const result = await processSupplierBills({ budgetMs: 12 * 60 * 1000, extractAttachments, extractPlainText });
    return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
  } catch (err) {
    console.error('process-supplier-bills failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
