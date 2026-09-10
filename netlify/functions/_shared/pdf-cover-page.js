const fetch = require('node-fetch');
const { StandardFonts, rgb } = require('pdf-lib');

// One shared title/cover page, drawn identically for every document type
// this app turns into a real PDF (employment contracts, quotes, invoices)
// so "housing" all three in one place actually looks like it comes from
// the same system - company logo, name, ABN/address/phone/website, the
// document's own title, who it's for, and the date - instead of each
// generator inventing its own header treatment.

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;

async function fetchCompanySettings(supabaseAdmin) {
  const { data } = await supabaseAdmin.from('company_settings').select('*').eq('id', 1).single();
  return data || {};
}

async function embedLogo(pdfDoc, logoUrl) {
  if (!logoUrl) return null;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = (logoUrl.split('.').pop() || '').toLowerCase().split('?')[0];
    if (ext === 'png') return await pdfDoc.embedPng(bytes);
    return await pdfDoc.embedJpg(bytes); // jpg/jpeg - the only other format company_settings.logo_url has ever stored
  } catch (err) {
    console.error('Could not embed company logo:', err.message);
    return null;
  }
}

// docTitle: e.g. "Employment Contract", "Quote Q1042", "Tax Invoice SI3021"
// preparedFor: e.g. an employee name or client name
// subtitle: optional second line under preparedFor (a project name, etc.)
async function drawCoverPage(pdfDoc, supabaseAdmin, { docTitle, preparedFor, subtitle, dateLabel }) {
  const settings = await fetchCompanySettings(supabaseAdmin);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImage = await embedLogo(pdfDoc, settings.logo_url);

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - 90;

  if (logoImage) {
    const logoHeight = 50;
    const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
    page.drawImage(logoImage, { x: MARGIN, y: y - logoHeight, width: logoWidth, height: logoHeight });
    y -= logoHeight + 30;
  } else if (settings.company_name) {
    page.drawText(settings.company_name, { x: MARGIN, y, size: 20, font: boldFont, color: rgb(0, 0, 0) });
    y -= 50;
  }

  // A thin rule under the header, the same width as the body content
  // below it - separates "who this is from" at the top from "what this
  // document is" underneath, on an otherwise mostly-empty page.
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: rgb(0.75, 0.75, 0.75) });
  y -= 60;

  page.drawText(docTitle, { x: MARGIN, y, size: 26, font: boldFont, color: rgb(0, 0, 0) });
  y -= 40;

  if (preparedFor) {
    page.drawText(`Prepared for: ${preparedFor}`, { x: MARGIN, y, size: 13, font, color: rgb(0.2, 0.2, 0.2) });
    y -= 20;
  }
  if (subtitle) {
    page.drawText(subtitle, { x: MARGIN, y, size: 13, font, color: rgb(0.2, 0.2, 0.2) });
    y -= 20;
  }
  if (dateLabel) {
    page.drawText(dateLabel, { x: MARGIN, y, size: 13, font, color: rgb(0.2, 0.2, 0.2) });
  }

  // Company details, pinned to the bottom of the cover page rather than
  // packed under the title - reads as a footer/letterhead block, not part
  // of the document's own opening line.
  const detailParts = [
    settings.company_name,
    settings.abn ? `ABN ${settings.abn}` : null,
    settings.address,
    settings.phone,
    settings.website,
  ].filter(Boolean);
  let footerY = MARGIN + (detailParts.length - 1) * 14;
  for (const line of detailParts) {
    page.drawText(line, { x: MARGIN, y: footerY, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    footerY -= 14;
  }

  return page;
}

module.exports = { drawCoverPage, fetchCompanySettings, PAGE_WIDTH, PAGE_HEIGHT, MARGIN };
