const fetch = require('node-fetch');
const { StandardFonts, rgb } = require('pdf-lib');

// One shared title/cover page, drawn identically for every document type
// this app turns into a real PDF (employment contracts, quotes, invoices)
// so "housing" all three in one place actually looks like it comes from
// the same system - company logo, name, ABN/address/phone/website, the
// document's own title, who it's for, and the date - instead of each
// generator inventing its own header treatment.
//
// Full-bleed photo background, centered layout - picked over a mockup of
// a plain accent-color header block or a photo-banner-up-top treatment
// (both reviewed and rejected in favour of this one). The photo is one
// fixed, dedicated cover photo (Settings > Cover page photo) - the same
// image on every document, rather than a different real portfolio photo
// picked per job. A single company-controlled image is both simpler to
// keep looking good behind overlaid text and easier to keep a sensible
// file size, versus inheriting whatever a given job's own photo happens
// to be (one was found to be 4.49MB at full resolution).

const PAGE_WIDTH = 595.28; // A4 in points
const PAGE_HEIGHT = 841.89;
const MARGIN = 50;

async function fetchCompanySettings(supabaseAdmin) {
  const { data } = await supabaseAdmin.from('company_settings').select('*').eq('id', 1).single();
  return data || {};
}

// Requests a resized, recompressed rendition via Supabase Storage's own
// image-transformation endpoint rather than the original file - the same
// 4.49MB drone photo renders at width 1400/quality 70 as ~250KB, plenty
// for a full-bleed A4 background sitting behind a 50%-opacity dark wash.
// Falls back to the original URL for anything not a Supabase Storage
// public URL (shouldn't normally happen, but embedImageFromUrl below
// still works fine against the untransformed original either way).
function resizedImageUrl(url, width, quality = 70) {
  if (!url) return url;
  const marker = '/storage/v1/object/public/';
  const idx = url.indexOf(marker);
  if (idx === -1) return url;
  return `${url.slice(0, idx)}/storage/v1/render/image/public/${url.slice(idx + marker.length)}?width=${width}&quality=${quality}`;
}

async function embedImageFromUrl(pdfDoc, url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = (url.split('.').pop() || '').toLowerCase().split('?')[0];
    if (ext === 'png') return await pdfDoc.embedPng(bytes);
    return await pdfDoc.embedJpg(bytes); // jpg/jpeg - the only other format logos/cover photos get uploaded as
  } catch (err) {
    console.error(`Could not embed image from ${url}:`, err.message);
    return null;
  }
}

// docTitle: e.g. "Employment Contract", "Quote Q1042", "Tax Invoice SI3021"
// preparedFor: e.g. an employee name or client name
// subtitle: optional second line under preparedFor (a project name, etc.)
// showCoverPhoto: true for a client-facing quote/invoice - an employment
// contract (generate-signed-document.js, which never sets this) stays on
// the plain white/black treatment, since a job-site photo behind HR
// paperwork doesn't make sense there.
async function drawCoverPage(pdfDoc, supabaseAdmin, { docTitle, preparedFor, subtitle, dateLabel, showCoverPhoto }) {
  const settings = await fetchCompanySettings(supabaseAdmin);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const logoImage = await embedImageFromUrl(pdfDoc, settings.logo_url);
  const coverPhotoImage = (showCoverPhoto && settings.cover_photo_url)
    ? await embedImageFromUrl(pdfDoc, resizedImageUrl(settings.cover_photo_url, 1400))
    : null;

  const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);

  if (coverPhotoImage) {
    // Cover the full page (object-fit: cover equivalent) - scale to fill
    // both dimensions, cropping whichever axis overhangs, rather than
    // stretching the photo out of its own aspect ratio.
    const pageRatio = PAGE_WIDTH / PAGE_HEIGHT;
    const imgRatio = coverPhotoImage.width / coverPhotoImage.height;
    let drawWidth, drawHeight;
    if (imgRatio > pageRatio) { drawHeight = PAGE_HEIGHT; drawWidth = drawHeight * imgRatio; }
    else { drawWidth = PAGE_WIDTH; drawHeight = drawWidth / imgRatio; }
    page.drawImage(coverPhotoImage, {
      x: (PAGE_WIDTH - drawWidth) / 2, y: (PAGE_HEIGHT - drawHeight) / 2, width: drawWidth, height: drawHeight,
    });
    // Flat dark wash rather than a true gradient (pdf-lib has no gradient
    // primitive) - still reliably legible over any photo, and simpler to
    // get right than faking a gradient out of stacked rectangles.
    page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: rgb(0, 0, 0), opacity: 0.5 });
  }

  const white = rgb(1, 1, 1);
  const black = rgb(0, 0, 0);
  const textColor = coverPhotoImage ? white : black;
  const mutedColor = coverPhotoImage ? rgb(0.85, 0.85, 0.85) : rgb(0.2, 0.2, 0.2);
  const footerColor = coverPhotoImage ? rgb(0.75, 0.75, 0.75) : rgb(0.4, 0.4, 0.4);
  const centerX = PAGE_WIDTH / 2;

  // Centered layout - logo, title, details all stacked around the
  // vertical middle of the page, rather than the old plain version's
  // everything-pinned-to-the-top-left.
  let y = coverPhotoImage ? PAGE_HEIGHT / 2 + 110 : PAGE_HEIGHT - 90;

  if (logoImage) {
    const logoHeight = 50;
    const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
    // A white card behind the logo when it's sitting on a photo - most
    // logos aren't designed to survive an arbitrary photo behind them,
    // this guarantees contrast regardless of the logo's own colours.
    if (coverPhotoImage) {
      const pad = 10;
      page.drawRectangle({
        x: centerX - logoWidth / 2 - pad, y: y - logoHeight - pad, width: logoWidth + pad * 2, height: logoHeight + pad * 2,
        color: white, opacity: 0.95,
      });
    }
    page.drawImage(logoImage, { x: centerX - logoWidth / 2, y: y - logoHeight, width: logoWidth, height: logoHeight });
    y -= logoHeight + (coverPhotoImage ? 55 : 30);
  } else if (settings.company_name) {
    const w = boldFont.widthOfTextAtSize(settings.company_name, 20);
    page.drawText(settings.company_name, { x: centerX - w / 2, y, size: 20, font: boldFont, color: textColor });
    y -= 50;
  }

  if (!coverPhotoImage) {
    // A thin rule under the header, the same width as the body content
    // below it - only makes sense on the plain white version; a photo
    // background already separates the header visually on its own.
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_WIDTH - MARGIN, y }, thickness: 0.75, color: rgb(0.75, 0.75, 0.75) });
    y -= 60;
  }

  const titleSize = 26;
  const titleWidth = boldFont.widthOfTextAtSize(docTitle, titleSize);
  page.drawText(docTitle, { x: centerX - titleWidth / 2, y, size: titleSize, font: boldFont, color: textColor });
  y -= 40;

  const centeredLine = (text, size, useFont) => {
    const w = useFont.widthOfTextAtSize(text, size);
    page.drawText(text, { x: centerX - w / 2, y, size, font: useFont, color: mutedColor });
    y -= 20;
  };
  if (preparedFor) centeredLine(coverPhotoImage ? `Prepared for ${preparedFor}` : `Prepared for: ${preparedFor}`, 13, font);
  if (subtitle) centeredLine(subtitle, 13, font);
  if (dateLabel) centeredLine(dateLabel, 13, font);

  // Company details, pinned to the bottom of the cover page rather than
  // packed under the title - reads as a footer/letterhead block, not part
  // of the document's own opening line. Still centered to match the rest
  // of this layout.
  const detailParts = [
    settings.company_name,
    settings.abn ? `ABN ${settings.abn}` : null,
    settings.address,
    settings.phone,
    settings.website,
  ].filter(Boolean);
  let footerY = MARGIN + (detailParts.length - 1) * 14;
  for (const line of detailParts) {
    const w = font.widthOfTextAtSize(line, 9);
    page.drawText(line, { x: centerX - w / 2, y: footerY, size: 9, font, color: footerColor });
    footerY -= 14;
  }

  return page;
}

module.exports = { drawCoverPage, fetchCompanySettings, PAGE_WIDTH, PAGE_HEIGHT, MARGIN };
