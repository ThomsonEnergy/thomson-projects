const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { getAdminClient } = require('./_shared/require-admin');
const { drawCoverPage } = require('./_shared/pdf-cover-page');

// Turns one onboarding_document_signatures row into a real, saved PDF -
// the plain-text snapshot of what was agreed to, the signer's name and
// the date, and their drawn signature, baked into one document instead of
// three separate database fields nobody can hand to anyone as a single
// file. For the Employment Contract specifically, appends the Fair Work
// Information Statement (a fixed static copy kept in Storage - see
// migration_098) so the contract's own clause 17 promise ("please find
// enclosed a copy of the Fair Work Information Statement") is actually
// true. Called right after a signature is inserted (public/onboarding.html)
// and once per pre-existing row via a one-off backfill.

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;
const FONT_SIZE = 10;
const LINE_GAP = 14;
const FWIS_PATH = 'reference/fair-work-information-statement.pdf';

function wrapLine(text, font, fontSize, maxWidth) {
  if (!text) return [''];
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(test, fontSize) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// pdf-lib's default (WinAnsi) text encoding can't draw a bare \r (found
// the hard way - a document pasted in from a Windows-authored source
// keeps \r\n line endings, and splitting on \n alone leaves a trailing \r
// on every line) or anything outside the Windows-1252 codepage. Normalize
// the common smart-punctuation cases and drop anything else unencodable
// rather than letting a single stray character fail the whole PDF.
function sanitizeForPdf(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–/g, '-')
    .replace(/—/g, '--')
    .replace(/…/g, '...')
    .replace(/[^\x00-\xFF]/g, '?');
}

async function buildDocumentPdf({ title, bodyText, signedByName, signedAt, signatureDataUrl, supabaseAdmin }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  bodyText = sanitizeForPdf(bodyText);
  title = sanitizeForPdf(title);
  signedByName = sanitizeForPdf(signedByName);

  await drawCoverPage(pdfDoc, supabaseAdmin, {
    docTitle: title,
    preparedFor: signedByName,
    dateLabel: `Signed ${new Date(signedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })}`,
  });

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  function newPage() {
    page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  function draw(text, { size = FONT_SIZE, useFont = font } = {}) {
    if (y - LINE_GAP < MARGIN) newPage();
    page.drawText(text, { x: MARGIN, y, size, font: useFont, color: rgb(0, 0, 0) });
    y -= LINE_GAP;
  }

  for (const para of bodyText.split('\n')) {
    if (!para.trim()) { if (y - LINE_GAP < MARGIN) newPage(); else y -= LINE_GAP; continue; }
    for (const line of wrapLine(para, font, FONT_SIZE, maxWidth)) draw(line);
  }

  y -= 20;
  if (y - 80 < MARGIN) newPage();
  draw(`Signed by: ${signedByName}`, { useFont: boldFont });
  draw(`Date: ${new Date(signedAt).toLocaleString('en-AU', { dateStyle: 'long', timeStyle: 'short' })}`);
  y -= 6;

  if (signatureDataUrl && signatureDataUrl.includes(',')) {
    const pngBytes = Buffer.from(signatureDataUrl.split(',')[1], 'base64');
    const pngImage = await pdfDoc.embedPng(pngBytes);
    const sigWidth = 160;
    const sigHeight = (pngImage.height / pngImage.width) * sigWidth;
    if (y - sigHeight < MARGIN) newPage();
    page.drawImage(pngImage, { x: MARGIN, y: y - sigHeight, width: sigWidth, height: sigHeight });
    y -= sigHeight + 10;
  }

  return pdfDoc;
}

async function appendFwis(pdfDoc, supabaseAdmin) {
  try {
    const { data, error } = await supabaseAdmin.storage.from('project-documents').download(FWIS_PATH);
    if (error || !data) return;
    const fwisBytes = Buffer.from(await data.arrayBuffer());
    const fwisDoc = await PDFDocument.load(fwisBytes);
    const copiedPages = await pdfDoc.copyPages(fwisDoc, fwisDoc.getPageIndices());
    copiedPages.forEach((p) => pdfDoc.addPage(p));
  } catch (err) {
    // A missing/corrupt FWIS copy shouldn't block saving the actual signed
    // contract - log it and move on.
    console.error('Could not append Fair Work Information Statement:', err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const { signature_id } = JSON.parse(event.body || '{}');
    if (!signature_id) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'signature_id is required' }) };

    const supabaseAdmin = getAdminClient();
    const { data: sig, error } = await supabaseAdmin
      .from('onboarding_document_signatures')
      .select('id, profile_id, document_title_snapshot, document_body_snapshot, signature_data_url, signed_by_name, signed_at')
      .eq('id', signature_id)
      .single();
    if (error || !sig) throw new Error(error?.message || 'Signature not found');

    const pdfDoc = await buildDocumentPdf({
      title: sig.document_title_snapshot,
      bodyText: sig.document_body_snapshot,
      signedByName: sig.signed_by_name,
      signedAt: sig.signed_at,
      signatureDataUrl: sig.signature_data_url,
      supabaseAdmin,
    });

    if (/employment contract/i.test(sig.document_title_snapshot)) {
      await appendFwis(pdfDoc, supabaseAdmin);
    }

    const pdfBytes = await pdfDoc.save();
    const path = `signed-documents/${sig.profile_id}/${sig.id}.pdf`;
    const { error: upErr } = await supabaseAdmin.storage.from('project-documents')
      .upload(path, Buffer.from(pdfBytes), { contentType: 'application/pdf', upsert: true });
    if (upErr) throw upErr;

    const safeTitle = sig.document_title_snapshot.replace(/[^a-zA-Z0-9._ -]/g, '');
    const fileName = `${safeTitle} - signed ${new Date(sig.signed_at).toLocaleDateString('en-AU')}.pdf`;
    const { error: updErr } = await supabaseAdmin.from('onboarding_document_signatures')
      .update({ file_path: path, file_name: fileName })
      .eq('id', sig.id);
    if (updErr) throw updErr;

    return { statusCode: 200, body: JSON.stringify({ ok: true, file_path: path, file_name: fileName }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
