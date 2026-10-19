// POST /.netlify/functions/process-supplier-bills-background
//
// Background function (reading a PDF with Claude takes longer than a normal function gets).
// Started by the Gmail sync (_shared/gmail-sync.js) when an invoice@ bill comes in, when
// bills are still waiting, and once an hour; and by the Emailed bills page's Retry button.
// It only works through rows already queued or emails already in the Supplier Bills label,
// so calling it with no body is harmless. The work lives in _shared/supplier-bill-intake.js;
// each run reports to the ops manager (_shared/agent-log.js).

const { processSupplierBills } = require('./_shared/supplier-bill-intake');
const { runAgent } = require('./_shared/agent-log');
const { extractAttachments, extractPlainText } = require('./_shared/gmail-sync');

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

exports.handler = () => runAgent('supplier-bills', async () => {
  const r = await processSupplierBills({ budgetMs: 12 * 60 * 1000, extractAttachments, extractPlainText });
  const c = r.counts;
  const read = Object.values(c).reduce((a, b) => a + b, 0);
  const parts = [];
  if (r.queued) parts.push(`${plural(r.queued, 'new file')} from invoice@`);
  if (c.saved) parts.push(`${c.saved} saved automatically`);
  if (c.to_check) parts.push(`${c.to_check} to check`);
  if (c.duplicate) parts.push(`${plural(c.duplicate, 'duplicate')}`);
  if (c.error) parts.push(`${c.error} could not be read yet`);
  if (r.replies) parts.push(`${plural(r.replies, '"invoices only" reply')} (Tally)`);
  return {
    quiet: !r.queued && !read && !r.replies,
    summary: parts.length ? parts.join(', ') : 'Nothing new',
    details: { ...r },
    needsMe: r.waiting,
    usage: r.usage,
  };
});
