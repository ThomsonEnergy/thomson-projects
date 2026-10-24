// POST /.netlify/functions/process-price-lists-background
//
// Background function: reads supplier price lists emailed to sales@ or invoice@ and keeps
// material cost prices up to date (_shared/price-list-intake.js). Started by the Gmail sync when
// a likely price list arrives, while one is part read, and once an hour; and by the Price lists
// page (Read all pages, Try again). It only works through what is queued or in sales@, so calling
// it with no body is harmless. Reports to the ops manager (_shared/agent-log.js).

const { processPriceLists } = require('./_shared/price-list-intake');
const { runAgent } = require('./_shared/agent-log');
const { extractAttachments } = require('./_shared/gmail-sync');
const { requireInternal } = require('./_shared/require-internal');

exports.handler = (event) => {
  // only the Gmail sync and the Price lists function start it (x-internal-secret)
  if (!requireInternal(event)) {
    console.error('process-price-lists-background: refused, no internal secret');
    return { statusCode: 202, body: '' };
  }
  return runAgent('price-lists', async () => {
    const r = await processPriceLists({ budgetMs: 12 * 60 * 1000, extractAttachments });
    const lists = r.results.filter(x => !['more', 'not', 'error', 'too_large', 'to_check'].includes(x));
    const parts = [];
    if (r.queued) parts.push(`${r.queued} new file${r.queued === 1 ? '' : 's'}`);
    parts.push(...lists);
    if (r.results.includes('more')) parts.push('a big list is part read, carrying on next run');
    if (r.results.includes('to_check')) parts.push('a supplier to pick');
    if (r.results.includes('too_large')) parts.push('a very large file waiting for "Read all pages"');
    if (r.results.includes('error')) parts.push('a file could not be read yet');
    return {
      quiet: !r.queued && !r.results.length,
      summary: parts.join('; ') || 'Nothing new',
      details: r,
      needsMe: r.waiting,
      usage: r.usage,
    };
  });
};
