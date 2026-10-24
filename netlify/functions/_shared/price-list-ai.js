// Reads supplier price lists with Claude for the emailed price list reader
// (_shared/price-list-intake.js).
//
// PDFs: read a few pages at a time (a catalogue can run to hundreds of items per page and one
// reply has a size limit). If a reply is cut off, the batch is split in half and read again.
// The first batch also says whether the document is a price list at all and whose it is.
// Spreadsheets: Claude only looks at the first rows of each sheet to say which columns hold the
// description, part number and price; every row is then read by code, so nothing is skipped.
// Every call returns the tokens it used, for the ops manager's log.

const fetch = require('node-fetch');
const XLSX = require('xlsx');
const { PDFDocument } = require('pdf-lib');
const { getIntegrationKey } = require('./get-integration-key');

const MODEL = 'claude-sonnet-5-5';

async function callClaude(content, maxTokens) {
  const apiKey = await getIntegrationKey('anthropic');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data.content.map((b) => b.text || '').join('').trim();
  return { raw: raw.replace(/^```json/i, '').replace(/```$/, '').trim(), truncated: data.stop_reason === 'max_tokens', usage: data.usage || {} };
}

const addUsage = (total, u) => { total.input_tokens += u.input_tokens || 0; total.output_tokens += u.output_tokens || 0; };

const ITEM_RULES = `- items: every product line with a price, each with:
  - description: the item/product name or description as written
  - part_number: their part/SKU/product code if shown, otherwise null
  - unit_cost: the price per unit as a plain number (no currency symbols). If both ex-GST and inc-GST prices are shown, use ex-GST. If there are several price columns (e.g. list price and your price / nett / trade), use OUR price: the nett, trade, account or "your price" one, not the RRP or list price.
Extract every item on these pages, however many - do not stop early or summarise. If a price is not legible, use null.`;

// ---------- PDF ----------

async function pdfPageCount(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  return doc.getPageCount();
}

async function pdfPagesBase64(buffer, start, count) {
  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const idx = [];
  for (let i = start; i < Math.min(start + count, src.getPageCount()); i++) idx.push(i);
  (await out.copyPages(src, idx)).forEach(p => out.addPage(p));
  return Buffer.from(await out.save()).toString('base64');
}

// First look at a document (the first pages of a PDF, or an image): is it a price list, whose,
// and the items on those pages.
async function readFirstPages({ fileBase64, mediaType, usage }) {
  const block = mediaType === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }
    : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };
  const prompt = `This document was emailed to an electrical/solar contracting business. Decide whether it is a SUPPLIER PRICE LIST (a list of products with the prices this supplier charges us: a price file, price update, custom/account pricelist, or a product catalogue with prices). Then extract:

- is_price_list: true or false. A tax invoice, statement, quote for one job, order confirmation, remittance or brochure without prices is NOT a price list.
- supplier: the supplier's business name shown on the document
- abn: the supplier's ABN if shown, else null
- our_account_number: our account/customer number with them if shown, else null
${ITEM_RULES}

If is_price_list is false, return an empty items array. Respond with ONLY a JSON object {"is_price_list": ..., "supplier": ..., "abn": ..., "our_account_number": ..., "items": [...]}, no other text.`;
  const r = await callClaude([block, { type: 'text', text: prompt }], 16000);
  addUsage(usage, r.usage);
  if (r.truncated) return { truncated: true };
  return JSON.parse(r.raw);
}

async function readItemPages({ fileBase64, usage }) {
  const prompt = `These are pages from a supplier price list for an electrical/solar contracting business.
${ITEM_RULES}

Respond with ONLY a JSON object {"items": [...]}, no other text.`;
  const r = await callClaude([{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fileBase64 } }, { type: 'text', text: prompt }], 16000);
  addUsage(usage, r.usage);
  if (r.truncated) return { truncated: true };
  return JSON.parse(r.raw);
}

// Reads `count` pages from `start`; a cut-off reply is read again as two halves.
async function readPdfRange(buffer, start, count, usage, first) {
  const fileBase64 = await pdfPagesBase64(buffer, start, count);
  const result = first ? await readFirstPages({ fileBase64, mediaType: 'application/pdf', usage }) : await readItemPages({ fileBase64, usage });
  if (!result.truncated) return result;
  if (count === 1) throw new Error(`Page ${start + 1} has too many items to read in one go.`);
  const half = Math.ceil(count / 2);
  const a = await readPdfRange(buffer, start, half, usage, first);
  if (first && a.is_price_list === false) return a;
  const b = await readPdfRange(buffer, start + half, count - half, usage, false);
  return { ...a, items: [...(a.items || []), ...(b.items || [])] };
}

// ---------- spreadsheets ----------

// The xlsx package has known problems on a crafted file (prototype pollution, a regex that can
// hang), so a spreadsheet over 5 MB is never opened, whoever sent it.
const MAX_SHEET_BYTES = 5 * 1024 * 1024;

function sheetsOf(buffer) {
  if (!buffer || buffer.length > MAX_SHEET_BYTES) throw new Error('Spreadsheet is over 5 MB, so it is not read automatically. Ask the supplier for a smaller file or a PDF.');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  return wb.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null, blankrows: false }) }))
    .filter(s => s.rows.length);
}

const toNumber = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function readSpreadsheet({ buffer, usage }) {
  const sheets = sheetsOf(buffer);
  if (!sheets.length) return { is_price_list: false, items: [] };
  const sample = sheets.slice(0, 5).map(s => `Sheet "${s.name}" (${s.rows.length} rows), first rows (row index: cells):\n` +
    s.rows.slice(0, 25).map((r, i) => `${i}: ${JSON.stringify(r.slice(0, 15))}`).join('\n')).join('\n\n');
  const prompt = `This spreadsheet was emailed to an electrical/solar contracting business. Here are the first rows of each sheet:

${sample}

Decide whether it is a SUPPLIER PRICE LIST (products with the prices the supplier charges us). For each sheet that holds price list rows, say which column (0-based index) holds what. If there are several price columns, pick OUR price (nett, trade, account, "your price"), not RRP or list price, and prefer ex-GST.

Respond with ONLY a JSON object:
{"is_price_list": true/false, "supplier": "name or null", "sheets": [{"name": "...", "header_row": <row index of the column headings, or -1>, "description_col": <index>, "part_number_col": <index or null>, "unit_cost_col": <index>, "cost_includes_gst": true/false}]}`;
  const r = await callClaude([{ type: 'text', text: prompt }], 2000);
  addUsage(usage, r.usage);
  const plan = JSON.parse(r.raw);
  if (!plan.is_price_list) return { is_price_list: false, supplier: plan.supplier || null, items: [] };

  const items = [];
  for (const sp of plan.sheets || []) {
    const sheet = sheets.find(s => s.name === sp.name);
    if (!sheet || sp.description_col == null || sp.unit_cost_col == null) continue;
    sheet.rows.slice((sp.header_row ?? -1) + 1).forEach(row => {
      const description = row[sp.description_col] == null ? '' : String(row[sp.description_col]).trim();
      let cost = toNumber(row[sp.unit_cost_col]);
      if (!description || cost == null || cost <= 0) return;
      if (sp.cost_includes_gst) cost = Math.round((cost / 1.1) * 100) / 100;
      const part = sp.part_number_col == null || row[sp.part_number_col] == null ? null : String(row[sp.part_number_col]).trim() || null;
      items.push({ description, part_number: part, unit_cost: cost });
    });
  }
  return { is_price_list: items.length > 0, supplier: plan.supplier || null, items };
}

// A whole uploaded file (the manual price list upload on Stock and Suppliers): a PDF a few
// pages at a time with the same cut-off handling as the emailed reader, or one image.
async function readWholeDocument({ fileBase64, mediaType, usage, pageBatch = 4 }) {
  if (mediaType !== 'application/pdf') {
    const r = await readFirstPages({ fileBase64, mediaType, usage });
    if (r.truncated) throw new Error('The photo has too many items to read in one go. Send it as a PDF, or split it.');
    return { is_price_list: r.is_price_list !== false, supplier: r.supplier || null, items: r.items || [] };
  }
  const buffer = Buffer.from(fileBase64, 'base64');
  const total = await pdfPageCount(buffer);
  let supplier = null, isPriceList = true, items = [];
  for (let done = 0; done < total;) {
    const count = Math.min(pageBatch, total - done);
    const r = await readPdfRange(buffer, done, count, usage, done === 0);
    if (done === 0) { supplier = r.supplier || null; isPriceList = r.is_price_list !== false; }
    items = items.concat(r.items || []);
    done += count;
  }
  return { is_price_list: isPriceList, supplier, items };
}

module.exports = { pdfPageCount, readPdfRange, readFirstPages, readSpreadsheet, readWholeDocument, sheetsOf, toNumber };
