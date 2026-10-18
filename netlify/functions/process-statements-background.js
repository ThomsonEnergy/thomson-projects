// POST /.netlify/functions/process-statements-background
//
// Background function: checks new supplier bills against their POs (_shared/bill-check.js) and
// reads and reconciles supplier statements emailed to sales@ or invoice@
// (_shared/statement-intake.js). Started by the Gmail sync when a statement arrives, while any
// are waiting, and once an hour; and by the Bill checks page (Try again). Calling it with no body
// is harmless. Reports to the ops manager (_shared/agent-log.js).

const { processStatements } = require('./_shared/statement-intake');
const { runAgent } = require('./_shared/agent-log');
const { extractAttachments } = require('./_shared/gmail-sync');

exports.handler = () => runAgent('statements', async () => {
  const r = await processStatements({ budgetMs: 12 * 60 * 1000, extractAttachments });
  const parts = [];
  if (r.checked) parts.push(`${r.checked} bill${r.checked === 1 ? '' : 's'} checked against their PO`);
  parts.push(...r.results.filter(x => !['not', 'error'].includes(x)));
  if (r.results.includes('error')) parts.push('a statement could not be read yet');
  return { quiet: !r.checked && !r.queued && !r.results.length, summary: parts.join('; ') || 'Nothing new', details: r, usage: r.usage };
});
