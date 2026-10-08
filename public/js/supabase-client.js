// Fill these in with your own Supabase project values (Settings > API in Supabase).
// The anon key is safe to expose in the browser, it only has the access RLS allows.
const SUPABASE_URL = 'https://ziakpklnzkbbjjnqgkmz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

async function requireLogin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return null;
  }

  // Every page calls requireLogin() as its first act, so this is the one
  // shared place to force incomplete onboarding to finish before anyone
  // touches the rest of the app - covers all pages without editing each
  // one individually.
  if (!window.location.pathname.endsWith('/onboarding.html')) {
    const { data: profile } = await supabaseClient.from('profiles').select('onboarding_completed_at').eq('id', session.user.id).maybeSingle();
    if (profile && !profile.onboarding_completed_at) {
      window.location.href = '/onboarding.html';
      return null;
    }
  }

  return session;
}

function money(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

// Uploads a single file to the private project-documents bucket. Returns the
// storage path (not a public URL, this bucket has no public access).
async function uploadPrivateFile(file, folder) {
  const path = `${folder}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error } = await supabaseClient.storage.from('project-documents').upload(path, file);
  if (error) throw error;
  return path;
}

// Generates a short-lived link to view/download a private document. Call this
// fresh each time, don't store the result, it expires.
async function getSignedDocUrl(path) {
  const { data, error } = await supabaseClient.storage.from('project-documents').createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

// Lazy-loaded third-party libraries for PDFs - only fetched the first time a
// PDF is actually opened, so pages that never show one pay nothing.
let _pdfJsPromise = null;
function loadPdfJs() {
  if (!_pdfJsPromise) {
    _pdfJsPromise = new Promise((resolve, reject) => {
      if (window.pdfjsLib) { resolve(window.pdfjsLib); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { _pdfJsPromise = null; reject(new Error('Could not load the PDF renderer')); };
      document.head.appendChild(s);
    });
  }
  return _pdfJsPromise;
}
let _pdfLibPromise = null;
function loadPdfLib() {
  if (!_pdfLibPromise) {
    _pdfLibPromise = new Promise((resolve, reject) => {
      if (window.PDFLib) { resolve(window.PDFLib); return; }
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js';
      s.onload = () => resolve(window.PDFLib);
      s.onerror = () => { _pdfLibPromise = null; reject(new Error('Could not load the PDF editor')); };
      document.head.appendChild(s);
    });
  }
  return _pdfLibPromise;
}

// Renders one page of an already-loaded pdf.js document to a JPEG data URL,
// scaled so its longest edge is `longEdge` pixels.
async function renderPdfPageToDataUrl(pdf, pageNumber, longEdge) {
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = longEdge / Math.max(base.width, base.height);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: base.width, height: base.height };
}

// First-page thumbnail of a PDF at a URL, as a data URL (for tiles that
// should look like photos instead of a generic document icon).
async function renderPdfThumbnail(url, longEdge = 360) {
  const [pdfjs, res] = await Promise.all([loadPdfJs(), fetch(url)]);
  if (!res.ok) throw new Error('Could not load the PDF');
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()) }).promise;
  const { dataUrl } = await renderPdfPageToDataUrl(pdf, 1, longEdge);
  return dataUrl;
}

// Draws markup-editor shapes (pen, arrow, box, text, plus the plan tools:
// symbols, schedule, scale, measure, cable - coordinates in the editor's own
// image pixels, y down) onto a PDF page as real vector graphics. Throws if
// anything can't be drawn (e.g. text pdf-lib can't encode) so the caller can
// fall back to flattening that page.
function drawShapesOnPdfPage(PDFLib, page, font, shapes, W, H) {
  const { rgb, LineCapStyle } = PDFLib;
  const { width: pw, height: ph } = page.getSize();
  const k = pw / W;
  const X = (x) => x * k;
  const Y = (y) => ph - y * k;
  const map = { X, Y, k, ph };
  const col = (hex) => rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
  const planLoaded = typeof scalePxPerMetre === 'function';
  const ppm = planLoaded ? scalePxPerMetre(shapes) : null;

  // One piece of text drawn "fill and outline" (a PDF text render mode),
  // not several offset copies - so searching/selecting the PDF finds the
  // words once. `size` is in PDF points; (x, baseline y) in PDF points.
  const outlinedText = (text, x, y, size, hex) => {
    const c = col(hex);
    const outline = hex === '#000000' ? rgb(1, 1, 1) : rgb(0, 0, 0);
    const safe = String(text).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
    if (PDFLib.TextRenderingMode && PDFLib.setTextRenderingMode && PDFLib.setStrokingColor && PDFLib.setLineWidth) {
      page.pushOperators(
        PDFLib.pushGraphicsState(),
        PDFLib.setTextRenderingMode(PDFLib.TextRenderingMode.FillAndOutline),
        PDFLib.setLineWidth(size * 0.07),
        PDFLib.setStrokingColor(outline),
      );
      page.drawText(safe, { x, y, size, font, color: c });
      page.pushOperators(PDFLib.popGraphicsState());
    } else {
      page.drawText(safe, { x, y, size, font, color: c });
    }
  };
  // A centred label at an editor-pixel position.
  const centredLabel = (text, cx, cy, sizePx, hex) => {
    const size = sizePx * k;
    const w = font.widthOfTextAtSize(String(text), size);
    outlinedText(text, X(cx) - w / 2, Y(cy) - size * 0.35, size, hex);
  };
  const midpointOf = (points) => {
    const half = polylineLength(points) / 2;
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (acc + seg >= half && seg > 0) {
        const t = (half - acc) / seg;
        return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      }
      acc += seg;
    }
    return points[0];
  };
  const endTicks = (s, c, lw) => {
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1) + Math.PI / 2;
    const t = s.width * 2.5;
    [[s.x1, s.y1], [s.x2, s.y2]].forEach(([x, y]) => {
      page.drawLine({
        start: { x: X(x - Math.cos(a) * t), y: Y(y - Math.sin(a) * t) }, end: { x: X(x + Math.cos(a) * t), y: Y(y + Math.sin(a) * t) },
        thickness: lw, color: c, lineCap: LineCapStyle.Round,
      });
    });
  };
  const metresText = (px) => {
    const m = px / ppm;
    return `${m.toFixed(m < 10 ? 2 : 1)} m`;
  };

  for (const s of shapes) {
    const c = col(s.colour);
    const lw = (s.width || 4) * k;
    if (s.type === 'pen') {
      const pts = s.points.length === 1 ? [s.points[0], [s.points[0][0] + 0.01, s.points[0][1]]] : s.points;
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: X(pts[i - 1][0]), y: Y(pts[i - 1][1]) }, end: { x: X(pts[i][0]), y: Y(pts[i][1]) },
          thickness: lw, color: c, lineCap: LineCapStyle.Round,
        });
      }
    } else if (s.type === 'box') {
      const rect = {
        x: X(Math.min(s.x1, s.x2)), y: Y(Math.max(s.y1, s.y2)),
        width: Math.abs(s.x2 - s.x1) * k, height: Math.abs(s.y2 - s.y1) * k,
      };
      if (s.fill === 1) page.drawRectangle({ ...rect, color: c });
      else if (s.fill === 2) page.drawRectangle({ ...rect, color: c, opacity: 0.35, borderColor: c, borderWidth: lw, borderOpacity: 1 });
      else page.drawRectangle({ ...rect, borderColor: c, borderWidth: lw });
    } else if (s.type === 'arrow') {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = s.width * 5;
      page.drawLine({ start: { x: X(s.x1), y: Y(s.y1) }, end: { x: X(s.x2), y: Y(s.y2) }, thickness: lw, color: c, lineCap: LineCapStyle.Round });
      const ax = s.x2 - head * Math.cos(angle - 0.45), ay = s.y2 - head * Math.sin(angle - 0.45);
      const bx = s.x2 - head * Math.cos(angle + 0.45), by = s.y2 - head * Math.sin(angle + 0.45);
      // SVG paths are drawn from the top-left and y-down, same as the editor.
      page.drawSvgPath(`M ${s.x2} ${s.y2} L ${ax} ${ay} L ${bx} ${by} Z`, { x: 0, y: ph, scale: k, color: c, borderWidth: 0 });
    } else if (s.type === 'text') {
      const size = Math.round(s.width * 6) * k;
      outlinedText(s.text, X(s.x1), Y(s.y1) - size * 0.82, size, s.colour);
    } else if (s.type === 'symbol' && planLoaded) {
      drawSymbolPdf(PDFLib, page, font, s.symbolId, s.x1, s.y1, s.side, s.colour, Math.max(1.5, s.side * 0.06), map);
      if (s.label) { const fs = Math.max(11, s.side * 0.42); centredLabel(s.label, s.x1 + s.side / 2, s.y1 + s.side + fs * 0.7, fs, s.colour); }
    } else if (s.type === 'schedule' && planLoaded && s.rows) {
      drawSchedulePdf(PDFLib, page, font, s, s.rows, map);
    } else if ((s.type === 'scale' || s.type === 'measure') && planLoaded) {
      page.drawLine({ start: { x: X(s.x1), y: Y(s.y1) }, end: { x: X(s.x2), y: Y(s.y2) }, thickness: lw, color: c, lineCap: LineCapStyle.Round });
      endTicks(s, c, lw);
      const label = s.type === 'scale' ? `Scale: ${s.metres} m` : (ppm ? metresText(Math.hypot(s.x2 - s.x1, s.y2 - s.y1)) : '?');
      centredLabel(label, (s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2 - Math.max(14, s.width * 4), Math.max(14, s.width * 4.5), s.colour);
    } else if (s.type === 'cable' && planLoaded) {
      for (let i = 1; i < s.points.length; i++) {
        page.drawLine({
          start: { x: X(s.points[i - 1][0]), y: Y(s.points[i - 1][1]) }, end: { x: X(s.points[i][0]), y: Y(s.points[i][1]) },
          thickness: lw, color: c, lineCap: LineCapStyle.Round, dashArray: [lw * 3, lw * 2],
        });
      }
      s.points.forEach(([x, y]) => page.drawCircle({ x: X(x), y: Y(y), size: lw * 0.9, color: c }));
      if (ppm && s.points.length > 1) {
        const [mx, my] = midpointOf(s.points);
        centredLabel(metresText(polylineLength(s.points)), mx, my - Math.max(12, s.width * 3.5), Math.max(13, s.width * 4), s.colour);
      }
    }
  }
}

// Shared in-app PDF viewer - one place quotes, invoices, documents and signed
// onboarding documents all show up. Pages are rendered to images (pdf.js)
// so a PDF looks and behaves like a photo: click through the pages, and -
// when `opts.projectId` is given - mark a page up with the same editor
// photos use. "Save marked-up copy" writes a NEW PDF into that project's
// Documents (the original is never changed): untouched pages are kept as
// they were, marked-up pages are replaced with the annotated picture.
// opts: { projectId, folder, onSaved }. Falls back to the browser's own PDF
// viewer in an iframe if pdf.js can't be loaded.
async function openPdfViewer(path, title, opts = {}) {
  ensureDarkOverlayStyles();
  const overlay = document.createElement('div');
  overlay.className = 'te-dark-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.92); z-index:300; display:flex; flex-direction:column; align-items:center; padding:12px; gap:10px;';
  overlay.innerHTML = `<p style="color:#fff;">Loading...</p>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();

  let signedUrl, bytes, pdf;
  try {
    signedUrl = await getSignedDocUrl(path);
    const [pdfjs, res] = await Promise.all([loadPdfJs(), fetch(signedUrl)]);
    if (!res.ok) throw new Error('Could not load the PDF');
    bytes = new Uint8Array(await res.arrayBuffer());
    pdf = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  } catch (err) {
    // pdf.js unavailable (offline CDN, etc.) - the browser's own viewer
    // still shows the document, just without page images or markup.
    if (signedUrl) {
      overlay.className = '';
      overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:300; padding:16px;';
      overlay.innerHTML = `
        <div class="card" style="max-width:900px; width:100%; height:90vh; display:flex; flex-direction:column; padding:0; overflow:hidden;">
          <div style="display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--border); flex-shrink:0;">
            <strong>${escapeHtml(title || 'Document')}</strong>
            <button type="button" class="secondary" id="pdf-fallback-close" style="font-size:12px; padding:6px 10px;">Close</button>
          </div>
          <iframe src="${signedUrl}" style="flex:1; width:100%; border:none;"></iframe>
        </div>`;
      overlay.querySelector('#pdf-fallback-close').addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    } else {
      overlay.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div><button type="button" id="pdf-err-close">Close</button>`;
      overlay.querySelector('#pdf-err-close').addEventListener('click', close);
    }
    return;
  }

  const pageCount = pdf.numPages;
  const canMarkup = !!opts.projectId;
  // Page names (Lighting plan, Power plan...) live on the document's row in
  // project_documents. A PDF with no row there (a generated quote/invoice)
  // simply has no names and can't be renamed.
  let docRowId = null;
  let pageNames = [];
  let planSummary = null; // what's already marked up on this document (see mergePlanSummary)
  try {
    const { data: docRow } = await supabaseClient.from('project_documents').select('id, page_names, plan_summary').eq('file_path', path).maybeSingle();
    if (docRow) { docRowId = docRow.id; pageNames = Array.isArray(docRow.page_names) ? docRow.page_names.slice() : []; planSummary = docRow.plan_summary || null; }
  } catch { /* names are a nicety - the viewer works without them */ }
  const pageLabel = (i) => pageNames[i] || `Page ${i + 1}`;
  const rendered = {};            // pageIndex -> { dataUrl, width, height }
  const annotated = new Map();    // pageIndex -> { blob (flattened JPEG), shapes, width, height }
  const annotatedUrls = new Map(); // pageIndex -> object URL of that blob (for display only)
  let index = 0;

  async function pageImage(i) {
    if (!rendered[i]) rendered[i] = await renderPdfPageToDataUrl(pdf, i + 1, 1800);
    return { url: annotatedUrls.has(i) ? annotatedUrls.get(i) : rendered[i].dataUrl };
  }

  // Copies one page of this PDF into a NEW PDF, once per name given - the
  // builder's blank electrical page becomes a Lighting, a Power and a Cable
  // paths page, each ready to mark up. The original is untouched; the new
  // document lands in the job's Plans folder and opens straight away.
  function openPlanPagesDialog() {
    const baseName = String(title || 'Plan').replace(/\.pdf$/i, '');
    const dlg = document.createElement('div');
    dlg.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.6); z-index:350; display:flex; align-items:center; justify-content:center; padding:16px;';
    const rowHtml = (name) => `<div class="pp-row" style="display:flex; gap:6px; margin-bottom:6px;"><input class="pp-name" value="${escapeHtml(name)}" style="flex:1; margin:0;" /><button type="button" class="secondary pp-remove" style="padding:6px 10px;">&times;</button></div>`;
    dlg.innerHTML = `
      <div class="card" style="max-width:460px; width:100%; max-height:90vh; overflow-y:auto;">
        <h2>Copy a page into plan pages</h2>
        <p class="subtitle" style="margin-bottom:10px;">Makes a new PDF with one copy of the chosen page for each name below - e.g. the blank electrical page, once each for lighting, power and cable paths. The original stays as it is.</p>
        <label style="margin-top:0;">Page to copy (1-${pageCount})</label>
        <input id="pp-page" type="number" min="1" max="${pageCount}" value="${index + 1}" />
        <label>One copy for each</label>
        <div id="pp-list">${['Lighting plan', 'Power plan', 'Cable paths'].map(rowHtml).join('')}</div>
        <button type="button" class="secondary" id="pp-add" style="font-size:12px; padding:6px 10px;">+ Add another page</button>
        <label style="display:flex; align-items:center; gap:8px; font-weight:400;"><input type="checkbox" id="pp-title" checked style="width:auto;" /> Print the name at the top of each page</label>
        <label>Save as</label>
        <input id="pp-save-name" value="${escapeHtml(baseName)} - Electrical plans" />
        <div id="pp-msg"></div>
        <div style="margin-top:12px; display:flex; gap:8px;">
          <button type="button" id="pp-go">Create plan pages</button>
          <button type="button" class="secondary" id="pp-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const wireRemove = () => dlg.querySelectorAll('.pp-remove').forEach(b => { b.onclick = () => b.closest('.pp-row').remove(); });
    wireRemove();
    dlg.querySelector('#pp-add').addEventListener('click', () => {
      dlg.querySelector('#pp-list').insertAdjacentHTML('beforeend', rowHtml(''));
      wireRemove();
    });
    dlg.querySelector('#pp-cancel').addEventListener('click', () => dlg.remove());
    dlg.querySelector('#pp-go').addEventListener('click', async () => {
      const msgEl = dlg.querySelector('#pp-msg');
      const goBtn = dlg.querySelector('#pp-go');
      const pageNum = parseInt(dlg.querySelector('#pp-page').value, 10);
      const names = [...dlg.querySelectorAll('.pp-name')].map(i => i.value.trim()).filter(Boolean);
      const saveName = dlg.querySelector('#pp-save-name').value.trim();
      if (!(pageNum >= 1 && pageNum <= pageCount)) { msgEl.innerHTML = `<div class="error-box">Pick a page between 1 and ${pageCount}.</div>`; return; }
      if (!names.length) { msgEl.innerHTML = `<div class="error-box">Add at least one page name.</div>`; return; }
      if (!saveName) { msgEl.innerHTML = `<div class="error-box">Give the new PDF a name.</div>`; return; }
      goBtn.disabled = true; goBtn.textContent = 'Creating...'; msgEl.innerHTML = '';
      try {
        const PDFLib = await loadPdfLib();
        const src = await PDFLib.PDFDocument.load(bytes);
        const out = await PDFLib.PDFDocument.create();
        const font = await out.embedFont(PDFLib.StandardFonts.HelveticaBold);
        const printTitle = dlg.querySelector('#pp-title').checked;
        for (const name of names) {
          const [copy] = await out.copyPages(src, [pageNum - 1]);
          const page = out.addPage(copy);
          if (printTitle) {
            const { height } = page.getSize();
            page.drawText(name.toUpperCase().replace(/[^\x20-\x7E\xA0-\xFF]/g, '?'), { x: 28, y: height - 40, size: 20, font, color: PDFLib.rgb(0, 0, 0) });
          }
        }
        const outBytes = await out.save();
        const { data: { user } } = await supabaseClient.auth.getUser();
        const outPath = `documents/${opts.projectId}/${Date.now()}-plan-pages.pdf`;
        const { error: upErr } = await supabaseClient.storage.from('project-documents').upload(outPath, new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
        if (upErr) throw upErr;
        const fileName = `${saveName.replace(/\.pdf$/i, '')}.pdf`;
        const { error: insErr } = await supabaseClient.from('project_documents').insert({
          project_id: opts.projectId, folder: 'Plans', file_path: outPath, file_name: fileName, mime_type: 'application/pdf', uploaded_by: user.id,
          page_names: names,
        });
        if (insErr) throw insErr;
        dlg.remove();
        annotatedUrls.forEach(u => URL.revokeObjectURL(u));
        close();
        if (opts.onSaved) opts.onSaved();
        openPdfViewer(outPath, fileName, { ...opts, folder: 'Plans' });
      } catch (err) {
        msgEl.innerHTML = `<div class="error-box">${escapeHtml(err.message)}</div>`;
        goBtn.disabled = false; goBtn.textContent = 'Create plan pages';
      }
    });
  }

  async function render() {
    overlay.innerHTML = `
      <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:center; color:#fff; width:100%;">
        <strong style="margin-right:8px;">${escapeHtml(title || 'Document')}</strong>
        ${pageCount > 1 ? `<button type="button" class="secondary" id="pv-prev" style="padding:6px 12px;">&larr;</button><span>${escapeHtml(pageLabel(index))} (${index + 1} / ${pageCount})</span><button type="button" class="secondary" id="pv-next" style="padding:6px 12px;">&rarr;</button>` : `<span>${escapeHtml(pageLabel(index))}</span>`}
        ${docRowId ? `<button type="button" class="secondary" id="pv-rename" style="padding:6px 12px;">Rename page</button>` : ''}
        ${canMarkup ? `<button type="button" id="pv-markup" style="padding:6px 12px;">Mark up this page</button>` : ''}
        ${canMarkup ? `<button type="button" class="secondary" id="pv-planpages" style="padding:6px 12px;">Copy page into plan pages</button>` : ''}
        ${canMarkup && annotated.size ? `<button type="button" id="pv-save" style="padding:6px 12px;">Save marked-up copy (${annotated.size} page${annotated.size === 1 ? '' : 's'})</button>` : ''}
        <a id="pv-download" class="link-quiet" href="${signedUrl}" target="_blank" style="color:#fff; font-size:13px;">Download original</a>
        <button type="button" class="secondary" id="pv-close" style="padding:6px 12px;">Close</button>
      </div>
      ${pageCount > 1 && pageNames.some(Boolean) ? `<div style="display:flex; flex-wrap:wrap; gap:6px; justify-content:center;">${Array.from({ length: pageCount }, (_, i) => `<button type="button" class="secondary pv-tab" data-i="${i}" style="padding:5px 12px; font-size:12px; ${i === index ? 'outline:2px solid #fff;' : ''}">${escapeHtml(pageLabel(i))}</button>`).join('')}</div>` : ''}
      <div id="pv-msg" style="color:#fca5a5; font-size:12px; min-height:14px;"></div>
      <div style="flex:1; min-height:0; width:100%; overflow:auto; display:flex; justify-content:center;">
        <p id="pv-loading" style="color:#fff;">Rendering page...</p>
      </div>`;
    overlay.querySelector('#pv-close').addEventListener('click', close);
    if (pageCount > 1) {
      overlay.querySelector('#pv-prev').addEventListener('click', () => { index = (index - 1 + pageCount) % pageCount; render(); });
      overlay.querySelector('#pv-next').addEventListener('click', () => { index = (index + 1) % pageCount; render(); });
    }

    const img = await pageImage(index);
    const holder = overlay.querySelector('#pv-loading') && overlay.querySelector('#pv-loading').parentElement;
    if (!holder) return; // navigated away / closed while rendering
    holder.innerHTML = `<img src="${img.url}" style="max-width:100%; max-height:100%; object-fit:contain; background:#fff; border-radius:4px; align-self:flex-start;" />`;

    overlay.querySelectorAll('.pv-tab').forEach(b => b.addEventListener('click', () => { index = parseInt(b.dataset.i, 10); render(); }));
    const renameBtn = overlay.querySelector('#pv-rename');
    if (renameBtn) renameBtn.addEventListener('click', async () => {
      const name = window.prompt('Name for this page (e.g. Lighting plan):', pageNames[index] || '');
      if (name === null) return;
      const next = Array.from({ length: pageCount }, (_, i) => pageNames[i] || '');
      next[index] = name.trim();
      const { error: renameErr } = await supabaseClient.from('project_documents').update({ page_names: next.some(Boolean) ? next : null }).eq('id', docRowId);
      if (renameErr) { overlay.querySelector('#pv-msg').textContent = `Could not save the name: ${renameErr.message}`; return; }
      pageNames = next;
      render();
    });
    const planBtn = overlay.querySelector('#pv-planpages');
    if (planBtn) planBtn.addEventListener('click', openPlanPagesDialog);
    const markupBtn = overlay.querySelector('#pv-markup');
    if (markupBtn) {
      markupBtn.addEventListener('click', () => {
        // Always starts from the clean page with any earlier shapes reloaded,
        // so a page can be edited again rather than drawn over a flattened copy.
        const pageIndex = index;
        const prev = annotated.get(pageIndex);
        // Plan tools (symbol schedule, cable lengths, scale) work across a
        // document's pages: an "all pages" schedule adds up the other
        // marked-up pages, and a scale set on one page is offered to the rest.
        const others = [...annotated.entries()].filter(([i]) => i !== pageIndex).map(([, a]) => a);
        const planExtra = typeof summariseMarkup === 'function' ? {
          otherSummaries: others.map(a => summariseMarkup(a.shapes)),
          inheritedScale: (others.map(a => a.shapes.find(sh => sh.type === 'scale')).find(Boolean)) || null,
        } : {};
        openPhotoMarkup(rendered[pageIndex].dataUrl, async (blob, shapes, size) => {
          if (annotatedUrls.has(pageIndex)) URL.revokeObjectURL(annotatedUrls.get(pageIndex));
          annotated.set(pageIndex, { blob, shapes, width: size.width, height: size.height });
          annotatedUrls.set(pageIndex, URL.createObjectURL(blob));
          render();
        }, prev ? prev.shapes : null, planExtra);
      });
    }
    const saveBtn = overlay.querySelector('#pv-save');
    if (saveBtn) saveBtn.addEventListener('click', async () => {
      const msgEl = overlay.querySelector('#pv-msg');
      saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; msgEl.textContent = '';
      try {
        const PDFLib = await loadPdfLib();
        const doc = await PDFLib.PDFDocument.load(bytes);
        const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
        for (const [i, a] of annotated) {
          if (!rendered[i]) rendered[i] = await renderPdfPageToDataUrl(pdf, i + 1, 1800);
          const { width, height } = rendered[i];
          const page = doc.getPage(i);
          const size = page.getSize();
          // Normal case: lay the drawings over the ORIGINAL page as vector
          // shapes, so its text stays selectable and the file stays small.
          // Only when the page is rotated or cropped in a way the shapes
          // wouldn't line up with does it fall back to swapping in the
          // flattened picture of the page.
          const lineUp = page.getRotation().angle === 0 && Math.abs(size.width - width) < 1.5 && Math.abs(size.height - height) < 1.5;
          let drawn = false;
          if (lineUp) {
            try { drawShapesOnPdfPage(PDFLib, page, font, a.shapes, a.width, a.height); drawn = true; }
            catch (shapeErr) { console.warn('Could not draw markup as vectors, flattening this page instead:', shapeErr.message); }
          }
          if (!drawn) {
            const jpg = await doc.embedJpg(await a.blob.arrayBuffer());
            doc.insertPage(i, [width, height]).drawImage(jpg, { x: 0, y: 0, width, height });
            doc.removePage(i + 1);
          }
        }
        const outBytes = await doc.save();
        const { data: { user } } = await supabaseClient.auth.getUser();
        const outPath = `documents/${opts.projectId}/${Date.now()}-marked-up.pdf`;
        const { error: upErr } = await supabaseClient.storage.from('project-documents').upload(outPath, new Blob([outBytes], { type: 'application/pdf' }), { contentType: 'application/pdf' });
        if (upErr) throw upErr;
        const baseName = String(title || 'Document').replace(/\.pdf$/i, '');
        const { error: insErr } = await supabaseClient.from('project_documents').insert({
          project_id: opts.projectId, folder: opts.folder || 'Marked up', file_path: outPath,
          file_name: `${baseName} (marked up).pdf`, mime_type: 'application/pdf', uploaded_by: user.id,
          page_names: pageNames.some(Boolean) ? pageNames : null,
          // Counts of what's now marked up, so the job/quote can export a
          // schedule PDF later (carries forward what was already on the plan).
          plan_summary: (() => {
            if (typeof mergePlanSummary !== 'function') return planSummary;
            const merged = mergePlanSummary(planSummary, annotated);
            return planSummaryIsEmpty(merged) ? null : merged;
          })(),
        });
        if (insErr) throw insErr;
        annotatedUrls.forEach(u => URL.revokeObjectURL(u));
        close();
        if (opts.onSaved) opts.onSaved();
      } catch (err) {
        msgEl.textContent = `Could not save: ${err.message}`;
        saveBtn.disabled = false; saveBtn.textContent = `Save marked-up copy (${annotated.size} page${annotated.size === 1 ? '' : 's'})`;
      }
    });
  }

  document.addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(overlay)) { document.removeEventListener('keydown', onKey); return; }
    if (document.querySelector('.photo-markup-overlay')) return; // markup editor is on top
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    else if (e.key === 'ArrowLeft' && pageCount > 1) { index = (index - 1 + pageCount) % pageCount; render(); }
    else if (e.key === 'ArrowRight' && pageCount > 1) { index = (index + 1) % pageCount; render(); }
  });
  render();
}

// Resizes/re-encodes an image client-side before upload, so a multi-MB
// phone-camera photo doesn't end up stored (and later re-fetched into a
// Chromium PDF render) at its full original size. 1920px on the long edge
// and JPEG quality 0.82 are well past what's visible on a screen or in a
// printed PDF, so this is a size win with no perceptible quality loss.
// Falls back to the original file untouched if the browser can't decode it
// (e.g. some HEIC variants) rather than blocking the upload.
async function compressImage(file, maxDimension = 1920, quality = 0.82) {
  if (!file.type.startsWith('image/')) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    // PNGs (logos, anything relying on transparency) stay PNG; phone
    // photos are already lossy JPEG/HEIC so JPEG loses nothing further.
    const outputType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, outputType, quality));
    if (!blob || blob.size >= file.size) return file;

    const ext = outputType === 'image/png' ? 'png' : 'jpg';
    const name = file.name.replace(/\.[^.]+$/, '') + '.' + ext;
    return new File([blob], name, { type: outputType });
  } catch (err) {
    console.warn('compressImage: falling back to original file —', err.message);
    return file;
  }
}

// Uploads one or more files to a public bucket and returns their public
// URLs. `folder` keeps things tidy, e.g. 'portfolio' or a project id.
// `bucket` defaults to proposal-photos (quotes/portfolio); site photos
// taken from the clock-out flow use 'site-photos' instead.
async function uploadPhotos(fileList, folder, bucket = 'proposal-photos') {
  const urls = [];
  for (const file of fileList) {
    const compressed = await compressImage(file);
    const path = `${folder}/${Date.now()}-${compressed.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const { error } = await supabaseClient.storage.from(bucket).upload(path, compressed);
    if (error) throw error;
    const { data } = supabaseClient.storage.from(bucket).getPublicUrl(path);
    urls.push(data.publicUrl);
  }
  return urls;
}

// Requests a resized, recompressed rendition of a Supabase Storage photo
// via its built-in image-transformation endpoint, rather than the full
// original file - a gallery thumbnail or a PDF cover photo never needs a
// multi-MB source image at full resolution (confirmed one real portfolio
// photo was 4.49MB; the same photo at width 1200/quality 70 is 341KB).
// Client-side compressImage() above already caps uploads at 1920px/0.82,
// but a detailed drone photo can still land in the multiple-MB range at
// that size - this is the second, display-time pass that actually fixes
// it, and costs nothing extra to add since every photo in this app is
// already a Supabase Storage public URL. Falls back to the original URL
// untouched for anything that isn't (e.g. a blank/missing value).
function supaImageVariant(url, width = 1200, quality = 70) {
  if (!url || typeof url !== 'string') return url;
  const marker = '/storage/v1/object/public/';
  const idx = url.indexOf(marker);
  if (idx === -1) return url;
  const rendered = `${url.slice(0, idx)}/storage/v1/render/image/public/${url.slice(idx + marker.length)}`;
  return `${rendered}?width=${width}&quality=${quality}`;
}

// The photo viewer, PDF viewer and markup editor sit on a near-black
// background whatever the app theme is, so the theme's own button/input
// colours (dark text on a light theme) vanish there. This gives everything
// inside them their own readable colours.
function ensureDarkOverlayStyles() {
  if (document.getElementById('te-dark-overlay-styles')) return;
  const style = document.createElement('style');
  style.id = 'te-dark-overlay-styles';
  style.textContent = `
    .te-dark-overlay button.secondary { background:#1e293b !important; color:#f8fafc !important; border:1px solid #64748b !important; }
    .te-dark-overlay button.secondary:hover { background:#334155 !important; }
    .te-dark-overlay button:disabled { opacity:0.5; }
    .te-dark-overlay input, .te-dark-overlay select { background:#0f172a !important; color:#f8fafc !important; border:1px solid #64748b !important; }
    .te-dark-overlay input::placeholder { color:#94a3b8; }
    .te-dark-overlay label, .te-dark-overlay .subtitle { color:#e2e8f0 !important; }
  `;
  document.head.appendChild(style);
}

// Full-size click-through viewer for any set of photo URLs - shared by
// every thumbnail strip in the app (renderPhotoThumbs below,
// settings.html's renderCategorizedThumbs, quote.html's galleries,
// project.html's site photos) so finding "the one that looks right"
// among a job's 30 photos doesn't mean squinting at 90x90 crops.
// Arrow keys/buttons move through the exact array passed in, starting
// at startIndex - the caller's own array order is what the viewer walks.
//
// `opts` (optional) turns on naming and markup for callers whose photos are
// real database rows: { captions: string[], onRename(index, name),
// onMarkup(index, blob), onClose() }. Without it, it's a plain viewer.
function openPhotoLightbox(urls, startIndex = 0, opts = null) {
  let index = startIndex;
  ensureDarkOverlayStyles();
  const overlay = document.createElement('div');
  overlay.className = 'te-dark-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.92); z-index:300; display:flex; align-items:center; justify-content:center;';
  const navBtnStyle = 'position:absolute; top:50%; transform:translateY(-50%); background:rgba(255,255,255,0.1); color:#fff; border:none; width:44px; height:44px; border-radius:50%; font-size:20px; cursor:pointer;';

  function close() {
    overlay.remove();
    if (opts && opts.onClose) opts.onClose();
  }

  function render() {
    const editable = opts && (opts.onRename || opts.onMarkup);
    overlay.innerHTML = `
      <button type="button" id="lb-close" style="position:absolute; top:16px; right:16px; background:rgba(255,255,255,0.1); color:#fff; border:none; width:36px; height:36px; border-radius:50%; font-size:18px; cursor:pointer;">&times;</button>
      ${urls.length > 1 ? `<button type="button" id="lb-prev" style="${navBtnStyle} left:16px;">&larr;</button>` : ''}
      <img src="${urls[index]}" style="max-width:88vw; max-height:${editable ? '74vh' : '85vh'}; object-fit:contain; border-radius:8px;${editable ? ' margin-bottom:60px;' : ''}" />
      ${urls.length > 1 ? `<button type="button" id="lb-next" style="${navBtnStyle} right:16px;">&rarr;</button>` : ''}
      ${urls.length > 1 ? `<div style="position:absolute; bottom:${editable ? '70px' : '20px'}; left:0; right:0; text-align:center; color:#fff; font-size:13px;">${index + 1} / ${urls.length}</div>` : ''}
      ${editable ? `
        <div style="position:absolute; bottom:14px; left:50%; transform:translateX(-50%); display:flex; gap:8px; align-items:center; width:min(560px, 92vw);">
          ${opts.onRename ? `<input id="lb-name" placeholder="Name this photo..." value="${String((opts.captions && opts.captions[index]) || '').replace(/"/g, '&quot;')}" style="flex:1; margin:0;" />` : '<span style="flex:1;"></span>'}
          ${opts.onMarkup ? `<button type="button" id="lb-markup" style="white-space:nowrap;">Mark up</button>` : ''}
        </div>
        <div id="lb-msg" style="position:absolute; bottom:56px; left:0; right:0; text-align:center; color:#fca5a5; font-size:12px;"></div>` : ''}
    `;
    overlay.querySelector('#lb-close').addEventListener('click', close);
    if (urls.length > 1) {
      overlay.querySelector('#lb-prev').addEventListener('click', (e) => { e.stopPropagation(); index = (index - 1 + urls.length) % urls.length; render(); });
      overlay.querySelector('#lb-next').addEventListener('click', (e) => { e.stopPropagation(); index = (index + 1) % urls.length; render(); });
    }
    const nameEl = overlay.querySelector('#lb-name');
    if (nameEl) {
      nameEl.addEventListener('change', async () => {
        const msgEl = overlay.querySelector('#lb-msg');
        try {
          await opts.onRename(index, nameEl.value.trim());
          if (opts.captions) opts.captions[index] = nameEl.value.trim();
          msgEl.textContent = '';
        } catch (err) { msgEl.textContent = `Could not save the name: ${err.message}`; }
      });
    }
    const markupBtn = overlay.querySelector('#lb-markup');
    if (markupBtn) {
      markupBtn.addEventListener('click', () => {
        openPhotoMarkup(urls[index], async (blob) => {
          await opts.onMarkup(index, blob);
          close();
        });
      });
    }
  }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function onKey(e) {
    if (!document.body.contains(overlay)) { document.removeEventListener('keydown', onKey); return; }
    if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (document.querySelector('.photo-markup-overlay')) return; // markup editor is on top
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    else if (e.key === 'ArrowLeft' && urls.length > 1) { index = (index - 1 + urls.length) % urls.length; render(); }
    else if (e.key === 'ArrowRight' && urls.length > 1) { index = (index + 1) % urls.length; render(); }
  });
  render();
  document.body.appendChild(overlay);
}

// Draw-on-a-photo editor: freehand pen, arrow, box and text in a few
// colours/sizes, with undo. Hands the finished picture to `onSave(blob, shapes,
// size)` as a JPEG plus the drawings as data - the caller decides where it goes
// (the original is never touched here). Output is capped at 1920px on the long
// edge, same as uploads.
//
// When electrical-symbols.js is also loaded it becomes a plan editor: a
// library of electrical symbols to place, a scale (draw a line across a known
// length), a measure tool, cable paths whose lengths come from that scale, and
// a live schedule of the symbols and cable lengths that can be stamped onto
// the page. `extra` (PDF viewer only): { otherSummaries, inheritedScale } -
// summaries of the document's other marked-up pages (for an "all pages"
// schedule) and a scale already set on one of them.
async function openPhotoMarkup(url, onSave, initialShapes = null, extra = {}) {
  const overlay = document.createElement('div');
  ensureDarkOverlayStyles();
  overlay.className = 'photo-markup-overlay te-dark-overlay';
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.96); z-index:400; display:flex; flex-direction:column; align-items:center; justify-content:center; justify-content:safe center; gap:8px; padding:12px; overflow:auto;';
  overlay.innerHTML = `<p style="color:#fff;">Loading photo...</p>`;
  document.body.appendChild(overlay);

  let bitmap;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not load the photo');
    bitmap = await createImageBitmap(await res.blob());
  } catch (err) {
    overlay.innerHTML = `<p style="color:#fca5a5;">${err.message}</p><button type="button" id="mk-err-close">Close</button>`;
    overlay.querySelector('#mk-err-close').addEventListener('click', () => overlay.remove());
    return;
  }

  const plan = typeof ELECTRICAL_SYMBOLS !== 'undefined';
  const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
  const W = Math.round(bitmap.width * scale);
  const H = Math.round(bitmap.height * scale);
  const COLOURS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#000000'];
  const SIZES = [1, 2, 3.5];
  const SYMBOL_SIZES = [1, 1.5, 2.2];
  let tool = 'pen', colour = COLOURS[0], sizeIdx = 1;
  let fillMode = 0; // boxes only: 0 outline, 1 solid fill, 2 see-through highlight
  const FILL_LABELS = ['Outline', 'Solid fill', 'Highlight'];
  // initialShapes lets a caller reopen earlier work (the PDF viewer does, so
  // a marked-up page can be edited again as shapes, not as a flattened picture).
  const shapes = initialShapes ? JSON.parse(JSON.stringify(initialShapes)) : [];
  let current = null;
  let dragging = null; // { shape, x, y } while the Move tool is dragging a shape
  let gridMode = 0; // 0 off, 1 fine, 2 medium, 3 coarse - symbols and points snap to it
  let exporting = false; // true while grabbing the picture, so the grid isn't baked into it
  let selected = null; // the shape the Move tool last picked (shows resize handles)
  let resizing = null; // { shape, orig, handle, anchor, handleOrig } while a handle is dragged
  let cableDraft = null; // a cable path being clicked out, point by point
  let currentSymbol = plan ? ELECTRICAL_SYMBOLS[0].id : null;
  let circuit = ''; // label given to each symbol as it's placed (e.g. "C1")
  let cableKind = plan ? CABLE_KINDS[0].kind : '';
  let cableSize = plan ? CABLE_KINDS[0].def : '';
  let customCable = ''; // a typed-in name, when "Other..." is the kind
  const cableName = () => (cableKind === '__custom' ? customCable : cableLabel(cableKind, cableSize));
  let allowance = 10;
  let scheduleScope = 'page';
  if (plan) {
    // A scale already set on another page of this document carries over (the
    // lighting / power / cable pages are copies of the same blank page).
    if (extra.inheritedScale && !shapes.some(s => s.type === 'scale')) shapes.push(JSON.parse(JSON.stringify(extra.inheritedScale)));
    const existing = shapes.find(s => s.type === 'schedule');
    if (existing) { allowance = existing.allowance ?? allowance; scheduleScope = existing.scope || 'page'; }
  }

  const toolBtn = (id, label, extraId = '') => `<button type="button" class="secondary mk-tool" data-tool="${id}" ${extraId ? `id="${extraId}"` : ''} style="padding:6px 12px; font-size:13px;">${label}</button>`;
  const smallInput = 'padding:5px 8px; font-size:12px; margin:0; width:auto;';
  overlay.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:center;">
      ${toolBtn('pen', 'Pen')}${toolBtn('arrow', 'Arrow')}${toolBtn('box', 'Box')}${toolBtn('text', 'Text')}${toolBtn('move', 'Move')}${toolBtn('erase', 'Delete')}
      <button type="button" class="secondary" id="mk-fill" style="padding:6px 12px; font-size:13px;">Outline</button>
      <span style="width:8px;"></span>
      ${COLOURS.map(c => `<button type="button" class="mk-colour" data-c="${c}" style="width:26px; height:26px; padding:0; border-radius:50%; background:${c}; border:2px solid #fff;"></button>`).join('')}
      <span style="width:8px;"></span>
      ${['S', 'M', 'L'].map((l, i) => `<button type="button" class="secondary mk-size" data-i="${i}" style="padding:6px 10px; font-size:12px;">${l}</button>`).join('')}
      <span style="width:8px;"></span>
      <button type="button" class="secondary" id="mk-undo" style="padding:6px 12px; font-size:13px;">Undo</button>
    </div>
    ${plan ? `
    <div style="display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:center;">
      ${toolBtn('symbol', 'Symbols', 'mk-symbols-btn')}
      <span style="color:#fff; font-size:12px;">Circuit</span><input id="mk-circuit" placeholder="e.g. C1" maxlength="20" style="${smallInput} width:70px;" />
      ${toolBtn('label', 'Label')}
      ${toolBtn('scale', 'Set scale')}${toolBtn('measure', 'Measure')}${toolBtn('cable', 'Cable path')}
      <select id="mk-cable-kind" style="${smallInput}">${CABLE_KINDS.map(c => `<option>${c.kind}</option>`).join('')}<option value="__custom">Other...</option></select>
      <select id="mk-cable-size" style="${smallInput}"></select>
      <button type="button" id="mk-finish-cable" style="padding:6px 12px; font-size:13px; display:none;">Finish cable</button>
      <span style="color:#fff; font-size:12px;">Grid snap</span><select id="mk-grid" style="${smallInput}"><option value="0">Off</option><option value="1">Fine</option><option value="2">Medium</option><option value="3">Coarse</option></select>
      <span style="color:#fff; font-size:12px;">Allowance</span><input id="mk-allow" type="number" min="0" max="100" value="${allowance}" style="${smallInput} width:60px;" /><span style="color:#fff; font-size:12px;">%</span>
      <select id="mk-scope" style="${smallInput}"><option value="page">Schedule: this page</option><option value="all">Schedule: all pages</option></select>
      <button type="button" class="secondary" id="mk-schedule" style="padding:6px 12px; font-size:13px;">Add schedule</button>
    </div>
    <div id="mk-palette" style="display:none; max-height:22vh; overflow:auto; background:#fff; border-radius:8px; padding:8px; max-width:94vw;">
      <div style="display:flex; flex-wrap:wrap; gap:6px;">
        ${ELECTRICAL_SYMBOLS.map(s => `<button type="button" class="mk-sym" data-id="${s.id}" title="${s.name}" style="width:84px; padding:4px; background:#fff; color:#000; border:1px solid #ccc; border-radius:6px; font-size:10px; line-height:1.15;"><canvas width="44" height="44" data-id="${s.id}" style="display:block; margin:0 auto 2px;"></canvas>${s.name}</button>`).join('')}
      </div>
    </div>
    <div id="mk-counts" style="color:#cbd5e1; font-size:12px; max-width:94vw; text-align:center;"></div>` : ''}
    <canvas id="mk-canvas" width="${W}" height="${H}" style="max-width:94vw; max-height:${plan ? '56vh' : '70vh'}; touch-action:none; border-radius:6px; cursor:crosshair; flex-shrink:0;"></canvas>
    <div id="mk-msg" style="color:#fca5a5; font-size:12px;"></div>
    <div style="display:flex; gap:8px;">
      <button type="button" id="mk-save">Save marked-up copy</button>
      <button type="button" class="secondary" id="mk-cancel">Cancel</button>
    </div>`;

  const canvas = overlay.querySelector('#mk-canvas');
  const ctx = canvas.getContext('2d');
  const baseWidth = () => Math.max(3, W / 300) * SIZES[sizeIdx];
  const symbolSide = () => Math.max(22, W / 45) * SYMBOL_SIZES[sizeIdx];
  const ppm = () => (plan ? scalePxPerMetre(shapes) : null);
  // Grid spacing in canvas pixels: real-world steps once a scale is set
  // (25 cm / 50 cm / 1 m), otherwise fixed fractions of the page width.
  const gridPx = () => {
    if (!gridMode) return 0;
    const m = plan ? ppm() : null;
    return m ? [0, 0.25, 0.5, 1][gridMode] * m : [0, W / 80, W / 40, W / 20][gridMode];
  };
  const snapPt = (x, y) => { const g = gridPx(); return g ? [Math.round(x / g) * g, Math.round(y / g) * g] : [x, y]; };
  const fmtM = (px) => `${(px / ppm()).toFixed(px / ppm() < 10 ? 2 : 1)} m`;
  const scheduleRows = (s) => buildSchedule(shapes, (s.scope || scheduleScope) === 'all' ? extra.otherSummaries : [], s.allowance ?? allowance);

  if (plan) {
    overlay.querySelectorAll('#mk-palette canvas').forEach(cv => {
      drawSymbolCanvas(cv.getContext('2d'), cv.dataset.id, 4, 4, 36, '#000000', 2);
    });
  }

  function outlinedLabel(text, x, y, size, fillColour) {
    ctx.save();
    ctx.font = `bold ${size}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round'; ctx.lineWidth = size * 0.28;
    ctx.strokeStyle = fillColour === '#000000' ? '#ffffff' : '#000000';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = fillColour; ctx.fillText(text, x, y);
    ctx.restore();
  }
  // Point half-way along a path, for putting a length label there.
  function midpointOf(points) {
    const half = polylineLength(points) / 2;
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      if (acc + seg >= half && seg > 0) {
        const t = (half - acc) / seg;
        return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      }
      acc += seg;
    }
    return points[0];
  }
  function endTicks(s, size) {
    const a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1) + Math.PI / 2;
    [[s.x1, s.y1], [s.x2, s.y2]].forEach(([x, y]) => {
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * size, y - Math.sin(a) * size);
      ctx.lineTo(x + Math.cos(a) * size, y + Math.sin(a) * size);
      ctx.stroke();
    });
  }

  const labelSize = (s) => Math.max(11, s.side * 0.42);
  function drawShape(s) {
    ctx.save();
    ctx.strokeStyle = s.colour; ctx.fillStyle = s.colour; ctx.lineWidth = s.width;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (s.type === 'pen') {
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.01, s.points[0][1]);
      ctx.stroke();
    } else if (s.type === 'box') {
      if (s.fill) {
        ctx.save();
        ctx.globalAlpha = s.fill === 2 ? 0.35 : 1;
        ctx.fillRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
        ctx.restore();
      }
      if (s.fill !== 1) ctx.strokeRect(s.x1, s.y1, s.x2 - s.x1, s.y2 - s.y1);
    } else if (s.type === 'arrow') {
      const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      const head = s.width * 5;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s.x2, s.y2);
      ctx.lineTo(s.x2 - head * Math.cos(angle - 0.45), s.y2 - head * Math.sin(angle - 0.45));
      ctx.lineTo(s.x2 - head * Math.cos(angle + 0.45), s.y2 - head * Math.sin(angle + 0.45));
      ctx.closePath(); ctx.fill();
    } else if (s.type === 'text') {
      ctx.font = `bold ${Math.round(s.width * 6)}px sans-serif`;
      ctx.textBaseline = 'top';
      // Outline in the opposite tone so text stays readable on any photo.
      ctx.lineWidth = s.width * 0.8;
      ctx.strokeStyle = s.colour === '#000000' ? '#ffffff' : '#000000';
      ctx.strokeText(s.text, s.x1, s.y1);
      ctx.fillText(s.text, s.x1, s.y1);
    } else if (s.type === 'symbol') {
      drawSymbolCanvas(ctx, s.symbolId, s.x1, s.y1, s.side, s.colour, Math.max(1.5, s.side * 0.06));
      if (s.label) outlinedLabel(s.label, s.x1 + s.side / 2, s.y1 + s.side + labelSize(s) * 0.7, labelSize(s), s.colour);
    } else if (s.type === 'schedule') {
      drawScheduleCanvas(ctx, s, scheduleRows(s));
    } else if (s.type === 'scale' || s.type === 'measure') {
      const tick = s.width * 2.5;
      ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
      endTicks(s, tick);
      const text = s.type === 'scale' ? `Scale: ${s.metres} m` : (ppm() ? fmtM(Math.hypot(s.x2 - s.x1, s.y2 - s.y1)) : '?');
      outlinedLabel(text, (s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2 - Math.max(14, s.width * 4), Math.max(14, s.width * 4.5), s.colour);
    } else if (s.type === 'cable') {
      const pts = cableDraft === s && s.hover ? [...s.points, s.hover] : s.points;
      ctx.setLineDash([s.width * 3, s.width * 2]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      s.points.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, s.width * 0.9, 0, Math.PI * 2); ctx.fill(); });
      if (pts.length > 1 && ppm()) {
        const [mx, my] = midpointOf(pts);
        outlinedLabel(fmtM(polylineLength(pts)), mx, my - Math.max(12, s.width * 3.5), Math.max(13, s.width * 4), s.colour);
      }
    }
    ctx.restore();
  }

  function distToSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }
  function shapeBounds(s, padded = true) {
    let x1, y1, x2, y2;
    if (s.points) {
      const xs = s.points.map(p => p[0]), ys = s.points.map(p => p[1]);
      x1 = Math.min(...xs); x2 = Math.max(...xs); y1 = Math.min(...ys); y2 = Math.max(...ys);
    } else if (s.type === 'text') {
      ctx.font = `bold ${Math.round(s.width * 6)}px sans-serif`;
      x1 = s.x1; y1 = s.y1; x2 = s.x1 + ctx.measureText(s.text).width; y2 = s.y1 + s.width * 6;
    } else if (s.type === 'symbol') {
      x1 = s.x1; y1 = s.y1; x2 = s.x1 + s.side; y2 = s.y1 + s.side + (s.label ? labelSize(s) * 1.4 : 0);
    } else if (s.type === 'schedule') {
      const { width, height } = scheduleItems(s, scheduleRows(s));
      x1 = s.x1; y1 = s.y1; x2 = s.x1 + width; y2 = s.y1 + height;
    } else {
      x1 = Math.min(s.x1, s.x2); x2 = Math.max(s.x1, s.x2); y1 = Math.min(s.y1, s.y2); y2 = Math.max(s.y1, s.y2);
    }
    const pad = padded ? Math.max((s.width || 4) * 2, 14) : 0;
    return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
  }
  const isLineShape = (s) => s.type === 'arrow' || s.type === 'measure' || s.type === 'scale';
  // Resize handles: both ends of a line/arrow/measure/scale, otherwise the
  // four corners of the shape (TL, TR, BR, BL).
  function handlePoints(s) {
    if (isLineShape(s)) return [[s.x1, s.y1], [s.x2, s.y2]];
    const b = shapeBounds(s, false);
    return [[b.x1, b.y1], [b.x2, b.y1], [b.x2, b.y2], [b.x1, b.y2]];
  }
  // Dragging a corner scales the shape about the opposite corner (a box just
  // takes the new corner; lines move the end that was grabbed).
  function applyResize(p) {
    const { shape: sh, orig, handle, anchor, handleOrig } = resizing;
    if (isLineShape(sh)) {
      if (handle === 0) { sh.x1 = p[0]; sh.y1 = p[1]; } else { sh.x2 = p[0]; sh.y2 = p[1]; }
      return;
    }
    if (sh.type === 'box') { sh.x1 = anchor[0]; sh.y1 = anchor[1]; sh.x2 = p[0]; sh.y2 = p[1]; return; }
    const d0 = Math.hypot(handleOrig[0] - anchor[0], handleOrig[1] - anchor[1]) || 1;
    const f = Math.max(0.1, Math.hypot(p[0] - anchor[0], p[1] - anchor[1]) / d0);
    const sc = (v, a) => a + (v - a) * f;
    if (orig.points) sh.points = orig.points.map(([x, y]) => [sc(x, anchor[0]), sc(y, anchor[1])]);
    else { sh.x1 = sc(orig.x1, anchor[0]); sh.y1 = sc(orig.y1, anchor[1]); }
    if (sh.type === 'symbol' || sh.type === 'schedule') { sh.side = Math.max(8, orig.side * f); sh.width = Math.max(1.5, sh.side * 0.06); }
    else if (sh.type === 'text') sh.width = Math.max(1, orig.width * f);
  }
  function moveShape(s, dx, dy) {
    if (s.points) s.points = s.points.map(([x, y]) => [x + dx, y + dy]);
    else {
      s.x1 += dx; s.y1 += dy;
      if (s.x2 !== undefined) { s.x2 += dx; s.y2 += dy; }
    }
  }
  // Lines and paths are picked by how close the click is to the line itself,
  // not by their (often huge) bounding box, so a long cable run doesn't
  // swallow clicks meant for what's underneath it.
  function shapeHit(s, x, y) {
    const tol = Math.max((s.width || 4) * 2, 12);
    if (s.points) {
      if (s.points.length === 1) return Math.hypot(x - s.points[0][0], y - s.points[0][1]) <= tol;
      for (let i = 1; i < s.points.length; i++) {
        if (distToSeg(x, y, s.points[i - 1][0], s.points[i - 1][1], s.points[i][0], s.points[i][1]) <= tol) return true;
      }
      return false;
    }
    if (s.type === 'arrow' || s.type === 'measure' || s.type === 'scale') return distToSeg(x, y, s.x1, s.y1, s.x2, s.y2) <= tol;
    const b = shapeBounds(s);
    return x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2;
  }
  function shapeAt(x, y) {
    for (let i = shapes.length - 1; i >= 0; i--) if (shapeHit(shapes[i], x, y)) return shapes[i];
    return null;
  }

  function updateCounts() {
    if (!plan) return;
    const el = overlay.querySelector('#mk-counts');
    const sum = summariseMarkup(shapes);
    const parts = ELECTRICAL_SYMBOLS.filter(s => sum.symbols[s.id]).map(s => `${s.name} x${sum.symbols[s.id]}`);
    const circuitParts = Object.entries(sum.circuits).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([l, n]) => `${l} x${n}`);
    if (circuitParts.length) parts.push(`Circuits: ${circuitParts.join(', ')}`);
    Object.entries(sum.cables).forEach(([name, c]) => {
      parts.push(ppm() ? `${name}: ${c.runs} run${c.runs === 1 ? '' : 's'}, ${c.metres.toFixed(1)} m` : `${name}: ${c.runs} run${c.runs === 1 ? '' : 's'} (set the scale for lengths)`);
    });
    el.textContent = parts.length ? `On this page: ${parts.join('  |  ')}` : (ppm() ? `Scale set. Place symbols, measure, or trace cable paths.` : 'Start with "Set scale": draw a line across something you know the length of.');
    overlay.querySelector('#mk-schedule').textContent = shapes.some(s => s.type === 'schedule') ? 'Remove schedule' : 'Add schedule';
    const gridSel = overlay.querySelector('#mk-grid');
    ['Fine', 'Medium', 'Coarse'].forEach((name, i) => {
      gridSel.options[i + 1].textContent = ppm() ? `${name} (${['25 cm', '50 cm', '1 m'][i]})` : name;
    });
  }

  function redraw() {
    ctx.drawImage(bitmap, 0, 0, W, H);
    const g = gridPx();
    if (g >= 5 && !exporting) {
      ctx.save();
      ctx.strokeStyle = 'rgba(14,165,233,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 0; gx <= W; gx += g) { ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
      for (let gy = 0; gy <= H; gy += g) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
      ctx.stroke();
      ctx.restore();
    }
    shapes.forEach(drawShape);
    if (current) drawShape(current);
    if (cableDraft) drawShape(cableDraft);
    if (selected && tool === 'move') {
      const b = shapeBounds(selected);
      const hs = Math.max(8, W / 110);
      ctx.save();
      ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = Math.max(2, W / 600); ctx.setLineDash([8, 6]);
      if (!isLineShape(selected)) ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.setLineDash([]);
      handlePoints(selected).forEach(([hx, hy]) => {
        ctx.fillStyle = '#ffffff'; ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      });
      ctx.restore();
    }
    updateCounts();
  }
  function refreshControls() {
    canvas.style.cursor = tool === 'move' ? 'move' : 'crosshair';
    overlay.querySelector('#mk-fill').textContent = FILL_LABELS[fillMode];
    overlay.querySelectorAll('.mk-tool').forEach(b => { b.style.outline = b.dataset.tool === tool ? '2px solid #fff' : 'none'; });
    overlay.querySelectorAll('.mk-colour').forEach(b => { b.style.outline = b.dataset.c === colour ? '2px solid #38bdf8' : 'none'; b.style.outlineOffset = '2px'; });
    overlay.querySelectorAll('.mk-size').forEach(b => { b.style.outline = parseInt(b.dataset.i) === sizeIdx ? '2px solid #fff' : 'none'; });
    if (plan) {
      overlay.querySelectorAll('.mk-sym').forEach(b => { b.style.outline = b.dataset.id === currentSymbol ? '3px solid #38bdf8' : 'none'; });
      overlay.querySelector('#mk-finish-cable').style.display = cableDraft ? '' : 'none';
    }
  }
  function setTool(t) {
    if (cableDraft && t !== 'cable') cableDraft = null;
    if (t !== 'move') selected = null;
    tool = t;
    refreshControls(); redraw();
  }
  overlay.querySelectorAll('.mk-tool').forEach(b => b.addEventListener('click', () => {
    if (b.dataset.tool === 'symbol') {
      const pal = overlay.querySelector('#mk-palette');
      pal.style.display = pal.style.display === 'none' ? 'block' : 'none';
    }
    setTool(b.dataset.tool);
  }));
  overlay.querySelectorAll('.mk-colour').forEach(b => b.addEventListener('click', () => { colour = b.dataset.c; refreshControls(); }));
  overlay.querySelectorAll('.mk-size').forEach(b => b.addEventListener('click', () => { sizeIdx = parseInt(b.dataset.i); refreshControls(); }));
  overlay.querySelector('#mk-undo').addEventListener('click', () => {
    if (cableDraft) { cableDraft.points.pop(); if (!cableDraft.points.length) cableDraft = null; refreshControls(); redraw(); return; }
    shapes.pop(); selected = null; redraw();
  });
  overlay.querySelector('#mk-cancel').addEventListener('click', () => overlay.remove());

  if (plan) {
    overlay.querySelectorAll('.mk-sym').forEach(b => b.addEventListener('click', () => { currentSymbol = b.dataset.id; setTool('symbol'); }));
    // Cable: pick a kind, then one of that kind's sizes.
    const kindSel = overlay.querySelector('#mk-cable-kind');
    const sizeSel = overlay.querySelector('#mk-cable-size');
    const fillSizes = () => {
      const k = CABLE_KINDS.find(c => c.kind === cableKind);
      sizeSel.style.display = k ? '' : 'none';
      if (!k) return;
      sizeSel.innerHTML = k.sizes.map(sz => `<option value="${sz}">${sz}${k.unit}</option>`).join('');
      sizeSel.value = cableSize;
    };
    const cableChanged = () => { if (cableDraft) cableDraft.cable = cableName(); };
    kindSel.addEventListener('change', () => {
      if (kindSel.value === '__custom') {
        const name = (window.prompt('Cable name (e.g. 4 core 16mm2 SDI):') || '').trim();
        if (!name) { kindSel.value = cableKind === '__custom' ? '__custom' : cableKind; return; }
        customCable = name; cableKind = '__custom';
      } else {
        cableKind = kindSel.value;
        cableSize = CABLE_KINDS.find(c => c.kind === cableKind).def;
      }
      fillSizes(); cableChanged();
    });
    sizeSel.addEventListener('change', () => { cableSize = sizeSel.value; cableChanged(); });
    fillSizes();
    overlay.querySelector('#mk-circuit').addEventListener('input', (e) => { circuit = e.target.value.trim(); });
    overlay.querySelector('#mk-grid').addEventListener('change', (e) => { gridMode = parseInt(e.target.value, 10) || 0; redraw(); });
    overlay.querySelector('#mk-allow').addEventListener('input', (e) => {
      allowance = Math.max(0, parseFloat(e.target.value) || 0);
      shapes.filter(s => s.type === 'schedule').forEach(s => { s.allowance = allowance; });
      redraw();
    });
    overlay.querySelector('#mk-scope').value = scheduleScope;
    overlay.querySelector('#mk-scope').addEventListener('change', (e) => {
      scheduleScope = e.target.value;
      shapes.filter(s => s.type === 'schedule').forEach(s => { s.scope = scheduleScope; });
      redraw();
    });
    overlay.querySelector('#mk-schedule').addEventListener('click', () => {
      const idx = shapes.findIndex(s => s.type === 'schedule');
      if (idx >= 0) { shapes.splice(idx, 1); redraw(); return; }
      const side = symbolSide();
      shapes.push({
        type: 'schedule', colour: colour === '#ffffff' ? '#000000' : colour, side, width: Math.max(1.5, side * 0.06),
        x1: Math.max(10, W - side * 13.5 - 20), y1: 20, allowance, scope: scheduleScope,
      });
      setTool('move');
    });
    const finishCable = () => {
      if (!cableDraft) return;
      if (cableDraft.points.length >= 2) {
        delete cableDraft.hover;
        shapes.push(cableDraft);
      }
      cableDraft = null;
      refreshControls(); redraw();
    };
    overlay.querySelector('#mk-finish-cable').addEventListener('click', finishCable);
    document.addEventListener('keydown', function onKey(e) {
      if (!document.body.contains(overlay)) { document.removeEventListener('keydown', onKey); return; }
      if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      if (e.key === 'Enter') finishCable();
      else if (e.key === 'Escape' && cableDraft) { cableDraft = null; refreshControls(); redraw(); }
    });
    canvas.addEventListener('dblclick', () => {
      if (tool !== 'cable' || !cableDraft) return;
      // The two clicks of a double-click each added a point at the same spot.
      const p = cableDraft.points;
      if (p.length > 1 && Math.hypot(p[p.length - 1][0] - p[p.length - 2][0], p[p.length - 1][1] - p[p.length - 2][1]) < 6) p.pop();
      finishCable();
    });
    refreshControls();
  }

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)];
  };
  overlay.querySelector('#mk-fill').addEventListener('click', () => { fillMode = (fillMode + 1) % 3; setTool('box'); });
  canvas.addEventListener('pointerdown', (e) => {
    const [rx, ry] = pos(e);
    // Everything except freehand drawing and picking/dragging snaps to the grid.
    const [x, y] = (tool === 'pen' || tool === 'move' || tool === 'erase' || tool === 'label') ? [rx, ry] : snapPt(rx, ry);
    if (tool === 'label') {
      const hit = shapeAt(x, y);
      if (hit && hit.type === 'symbol') {
        const text = window.prompt('Circuit / label for this symbol (blank to remove):', hit.label || circuit);
        if (text !== null) { if (text.trim()) hit.label = text.trim(); else delete hit.label; redraw(); }
      }
      return;
    }
    if (tool === 'move') {
      // A corner/end handle of the selected shape resizes it...
      if (selected) {
        const hs = handlePoints(selected);
        const reach = Math.max(14, W / 70);
        const idx = hs.findIndex(([hx, hy]) => Math.hypot(x - hx, y - hy) <= reach);
        if (idx >= 0) {
          canvas.setPointerCapture(e.pointerId);
          resizing = {
            shape: selected, orig: JSON.parse(JSON.stringify(selected)), handle: idx,
            anchor: isLineShape(selected) ? null : hs[(idx + 2) % 4], handleOrig: hs[idx],
          };
          return;
        }
      }
      // ...anything else picks a shape (and drags it), or clears the selection.
      const hit = shapeAt(x, y);
      selected = hit;
      if (!hit) { redraw(); return; }
      canvas.setPointerCapture(e.pointerId);
      dragging = { shape: hit, x0: x, y0: y, orig: JSON.parse(JSON.stringify(hit)) };
      redraw();
      return;
    }
    if (tool === 'erase') {
      const hit = shapeAt(x, y);
      if (hit) { shapes.splice(shapes.indexOf(hit), 1); redraw(); }
      return;
    }
    if (tool === 'text') {
      const text = window.prompt('Text to add:');
      if (text && text.trim()) {
        shapes.push({ type: 'text', colour, width: baseWidth(), x1: x, y1: y, text: text.trim() });
        // Straight into Move so the text can be dragged to the right spot.
        setTool('move');
      }
      return;
    }
    if (tool === 'symbol') {
      const side = symbolSide();
      shapes.push({ type: 'symbol', symbolId: currentSymbol, colour, side, width: Math.max(1.5, side * 0.06), x1: x - side / 2, y1: y - side / 2, ...(circuit ? { label: circuit } : {}) });
      redraw();
      return;
    }
    if (tool === 'cable') {
      if (!ppm()) { window.alert('Set the scale first (use "Set scale" on something you know the length of) so cable lengths can be measured.'); return; }
      if (!cableDraft) cableDraft = { type: 'cable', colour, width: baseWidth(), cable: cableName(), points: [[x, y]] };
      else cableDraft.points.push([x, y]);
      refreshControls(); redraw();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    current = tool === 'pen'
      ? { type: 'pen', colour, width: baseWidth(), points: [[x, y]] }
      : { type: tool, colour: tool === 'scale' ? '#0ea5e9' : colour, width: baseWidth(), x1: x, y1: y, x2: x, y2: y, ...(tool === 'box' ? { fill: fillMode } : {}) };
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    const [rx, ry] = pos(e);
    if (resizing) { applyResize([rx, ry]); redraw(); return; }
    if (dragging) {
      // Always re-applied from where the shape started, so snapping to the
      // grid doesn't accumulate rounding as the pointer moves.
      const sh = dragging.shape;
      Object.assign(sh, JSON.parse(JSON.stringify(dragging.orig)));
      moveShape(sh, rx - dragging.x0, ry - dragging.y0);
      if (gridPx()) {
        const anchor = sh.type === 'symbol' ? [sh.x1 + sh.side / 2, sh.y1 + sh.side / 2] : (sh.points ? sh.points[0] : [sh.x1, sh.y1]);
        const [ax, ay] = snapPt(anchor[0], anchor[1]);
        moveShape(sh, ax - anchor[0], ay - anchor[1]);
      }
      redraw();
      return;
    }
    const [x, y] = (current && current.type === 'pen') ? [rx, ry] : snapPt(rx, ry);
    if (cableDraft) { cableDraft.hover = [x, y]; redraw(); return; }
    if (!current) return;
    if (current.type === 'pen') current.points.push([x, y]);
    else { current.x2 = x; current.y2 = y; }
    redraw();
  });
  // Double-click a piece of text (Move tool) to change what it says.
  canvas.addEventListener('dblclick', (e) => {
    if (tool !== 'move') return;
    const [x, y] = pos(e);
    const hit = shapeAt(x, y);
    if (hit && hit.type === 'text') {
      const text = window.prompt('Edit text:', hit.text);
      if (text && text.trim()) hit.text = text.trim();
      redraw();
    } else if (hit && hit.type === 'symbol') {
      const text = window.prompt('Circuit / label for this symbol (blank to remove):', hit.label || '');
      if (text !== null) { if (text.trim()) hit.label = text.trim(); else delete hit.label; redraw(); }
    }
  });
  const finish = () => {
    if (resizing) { resizing = null; redraw(); return; }
    if (dragging) { dragging = null; redraw(); return; }
    if (!current) return;
    const s = current;
    current = null;
    if (s.type === 'scale' || s.type === 'measure') {
      if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 8) { redraw(); return; }
      if (s.type === 'scale') {
        const metres = parseFloat(window.prompt('How long is that line in real life, in metres?'));
        if (!(metres > 0)) { redraw(); return; }
        s.metres = metres;
        for (let i = shapes.length - 1; i >= 0; i--) if (shapes[i].type === 'scale') shapes.splice(i, 1);
        shapes.push(s);
        setTool('measure');
        return;
      }
      if (!ppm()) { window.alert('Set the scale first.'); redraw(); return; }
    }
    shapes.push(s);
    redraw();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  overlay.querySelector('#mk-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#mk-save');
    const msgEl = overlay.querySelector('#mk-msg');
    saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; msgEl.textContent = '';
    try {
      cableDraft = null; dragging = null; current = null; selected = null; resizing = null;
      exporting = true; redraw();
      const blobPromise = new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      exporting = false; redraw();
      const blob = await blobPromise;
      if (!blob) throw new Error('Could not export the picture');
      // Schedules carry the rows they showed when saved, so the PDF export
      // doesn't need the other pages' data to draw them.
      const out = JSON.parse(JSON.stringify(shapes));
      if (plan) out.forEach(s => { if (s.type === 'schedule') s.rows = scheduleRows(s); });
      // Second/third arguments are for callers that want the drawings as data
      // (shapes in image-pixel coordinates) as well as the flattened picture.
      await onSave(blob, out, { width: W, height: H });
      overlay.remove();
    } catch (err) {
      msgEl.textContent = err.message;
      saveBtn.disabled = false; saveBtn.textContent = 'Save marked-up copy';
    }
  });

  refreshControls();
  redraw();
}

// Renders a small thumbnail strip with remove buttons into `containerEl`,
// keeping `photosArray` (array of URL strings) in sync. Clicking a
// thumbnail (rather than its x) opens the full-size lightbox instead of
// doing nothing.
function renderPhotoThumbs(containerEl, photosArray, onChange) {
  containerEl.innerHTML = photosArray.map((url, i) => `
    <div style="position:relative; display:inline-block; margin:0 8px 8px 0;">
      <img src="${url}" data-i="${i}" class="thumb-view" style="width:90px; height:90px; object-fit:cover; border-radius:8px; border:1px solid var(--border); cursor:pointer;" />
      <button type="button" data-i="${i}" class="thumb-remove" style="position:absolute; top:-6px; right:-6px; width:20px; height:20px; padding:0; border-radius:50%; font-size:11px; line-height:1;">x</button>
    </div>
  `).join('');
  containerEl.querySelectorAll('.thumb-view').forEach(img => {
    img.addEventListener('click', () => openPhotoLightbox(photosArray, parseInt(img.dataset.i)));
  });
  containerEl.querySelectorAll('.thumb-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      photosArray.splice(parseInt(btn.dataset.i), 1);
      renderPhotoThumbs(containerEl, photosArray, onChange);
      onChange && onChange();
    });
  });
}

// Returns the logged-in user's role (admin/finance/sales/staff), cached
// for the life of the page. Defaults to the safest option, 'staff', if
// anything goes wrong - better to under-show pricing than leak it.
let _cachedRole = null;
async function getMyRole() {
  if (_cachedRole) return _cachedRole;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return 'staff';
  const { data } = await supabaseClient
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .maybeSingle();
  _cachedRole = data?.role || 'staff';
  return _cachedRole;
}

function isPricingRole(role) {
  return role === 'admin' || role === 'finance' || role === 'sales';
}

// The two cost_centres column lists used across the app when embedding
// via a projects query. Pricing columns are only requested for roles that
// are actually allowed to see them - the database also enforces this via
// column-level grants (see migration_007), so a role-check bug here can't
// by itself leak pricing.
const COST_CENTRE_COLS_BASE = 'id, project_id, name, description, sort_order';
const COST_CENTRE_COLS_PRICING = 'markup_percent, quoted_amount, estimated_labour_cost, estimated_material_cost, labour_cost, material_cost, invoiced_amount, stc_total';
const LINE_ITEM_COLS_BASE = 'id, cost_centre_id, description, item_type, sort_order, quantity';
const LINE_ITEM_COLS_PRICING = 'unit_cost';

async function costCentreColumns() {
  const role = await getMyRole();
  return isPricingRole(role) ? `${COST_CENTRE_COLS_BASE}, ${COST_CENTRE_COLS_PRICING}` : COST_CENTRE_COLS_BASE;
}

async function lineItemColumns() {
  const role = await getMyRole();
  return isPricingRole(role) ? `${LINE_ITEM_COLS_BASE}, ${LINE_ITEM_COLS_PRICING}` : LINE_ITEM_COLS_BASE;
}

// For display: tells a null pricing value (masked by role) apart from a
// genuine $0. Use instead of money() wherever a value might be masked.
function moneyOrHidden(n) {
  return (n === null || n === undefined) ? ' - ' : money(n);
}

// Wraps a plain address string as a link that opens it in Google Maps in a
// new tab - a plain maps search URL, no API key needed (unlike the Places
// Autocomplete used on the address input fields). Returns '' for a falsy
// address so it drops out cleanly of .filter(Boolean).join(...) patterns.
// stopPropagation guards against the many places an address sits inside a
// whole-row click handler (e.g. a client list row that opens on click) -
// without it, clicking the address would both open Maps and trigger
// whatever the row itself does.
function mapsLink(address) {
  if (!address) return '';
  return `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="link-quiet" onclick="event.stopPropagation()">${address}</a>`;
}

// Dev Mode - a time-limited unlock (20 min) for the most dangerous admin
// actions (API keys, company details, Xero mapping, bulk-delete). The
// password is verified server-side by verify-dev-mode.js, never shipped to
// the browser - this is a UI-layer gate, same trust level as the rest of
// this app's admin-only tabs, not a database-level enforcement.
const DEV_MODE_STORAGE_KEY = 'te-dev-mode-expires';

function isDevModeActive() {
  const exp = parseInt(localStorage.getItem(DEV_MODE_STORAGE_KEY) || '0', 10);
  return exp > Date.now();
}

function devModeMinutesRemaining() {
  const exp = parseInt(localStorage.getItem(DEV_MODE_STORAGE_KEY) || '0', 10);
  return Math.max(0, Math.ceil((exp - Date.now()) / 60000));
}

function setDevModeExpiry(expiresAt) {
  localStorage.setItem(DEV_MODE_STORAGE_KEY, String(expiresAt));
}

function clearDevMode() {
  localStorage.removeItem(DEV_MODE_STORAGE_KEY);
}

// Shared across the Suppliers and supplier-detail pages - both need to
// read a file for AI extraction and fuzzy-match text against existing
// records, so these live here once rather than being copy-pasted twice.
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function fuzzyMatchScore(a, b) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const wordsA = new Set(norm(a));
  const wordsB = norm(b);
  if (!wordsA.size || !wordsB.length) return 0;
  const matches = wordsB.filter(w => wordsA.has(w)).length;
  return matches / Math.max(wordsA.size, wordsB.length);
}

// Given fields pulled off an uploaded document, finds the best matching
// existing supplier - checked in the order real invoices proved most
// reliable: their account number for us (the same MMEM account shows
// different logos across Haymans/Greentech/TLE but an identical "Charge
// To" number), then ABN, then their own bank details, and only as a
// last resort, fuzzy business name matching. Returns null if nothing
// matches confidently enough - the caller should offer to create a new
// supplier rather than silently guessing wrong.
async function findMatchingSupplier(fields) {
  const { name, ourAccountNumber, abn, bsb, bankAccountNumber } = typeof fields === 'string' ? { name: fields } : fields;
  const { data: suppliers } = await supabaseClient.from('suppliers').select('*');
  const list = suppliers || [];

  if (ourAccountNumber) {
    const match = list.find(s => s.our_account_number && s.our_account_number.trim() === String(ourAccountNumber).trim());
    if (match) return match;
  }
  if (abn) {
    const normalizedAbn = String(abn).replace(/\s/g, '');
    const match = list.find(s => s.abn && s.abn.replace(/\s/g, '') === normalizedAbn);
    if (match) return match;
  }
  if (bsb && bankAccountNumber) {
    const match = list.find(s => s.bsb === bsb && s.bank_account_number === bankAccountNumber);
    if (match) return match;
  }

  let best = null, bestScore = 0;
  list.forEach(s => {
    const score = fuzzyMatchScore(s.name, name);
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return bestScore >= 0.5 ? best : null;
}

// Single source of truth for the main nav - every page calls
// renderMainNav('key') into empty <nav id="topbar-tabs"> and
// <div id="mobile-menu-dropdown"> containers, instead of each page
// hand-maintaining its own copy of the same 13 links (which is exactly
// how small nav inconsistencies kept creeping in before this existed).
const MAIN_NAV_ITEMS = [
  { key: 'my-day', label: 'My Day', href: '/my-day.html', icon: '&#127749;' },
  { key: 'inbox', label: 'Inbox', href: '/inbox.html', icon: '&#128231;' },
  { key: 'leads', label: 'Leads', href: '/leads.html', icon: '&#127919;' },
  { key: 'quotes', label: 'Quotes', href: '/quotes.html', icon: '&#128221;' },
  { key: 'projects', label: 'Projects', href: '/projects.html', icon: '&#128202;' },
  { key: 'job-pipeline', label: 'Job pipeline', href: '/dashboard.html', icon: '&#128203;' },
  { key: 'invoices', label: 'Invoices', href: '/invoices.html', icon: '&#128179;' },
  { key: 'purchase-orders', label: 'Purchase Orders', href: '/purchase-orders.html', icon: '&#128230;' },
  { key: 'tasks', label: 'Tasks', href: '/tasks.html', icon: '&#9989;' },
  { key: 'suppliers', label: 'Suppliers', href: '/suppliers.html', icon: '&#128194;' },
  { key: 'timesheets', label: 'Timesheets', href: '/timesheets.html', icon: '&#9203;' },
  { key: 'clients', label: 'Clients', href: '/clients.html', icon: '&#128100;' },
  { key: 'stock', label: 'Stock', href: '/stock.html', icon: '&#128736;' },
  { key: 'prebuilds', label: 'Prebuilds', href: '/prebuilds.html', icon: '&#129513;', pricingOnly: true },
  { key: 'knowledge', label: 'Knowledge', href: '/knowledge.html', icon: '&#128218;' },
  { key: 'team', label: 'Team', href: '/team.html', icon: '&#128101;' },
  { key: 'dnsp', label: 'DNSP', href: '/dnsp.html', icon: '&#9889;' },
  { key: 'fleet', label: 'Fleet', href: '/fleet.html', icon: '&#128666;' },
  { key: 'bugs', label: 'Bugs & Updates', href: '/bugs.html', icon: '&#128030;' },
  { key: 'logs', label: 'Logs', href: '/logs.html', icon: '&#128209;', adminOnly: true },
];

// Fallback for anyone who hasn't customized their Home page tiles yet
// (profiles.home_shortcuts is null) - the set that used to be hardcoded
// on home.html, so existing users see no change until they actually open
// "Edit" there.
// Doesn't include Schedule - that's already one click away via its own
// topbar icon on every page, unlike everything else here.
const DEFAULT_HOME_SHORTCUTS = [
  'job-pipeline', 'projects', 'timesheets', 'quotes', 'invoices', 'suppliers',
  'leads', 'clients', 'stock', 'team', 'fleet', 'bugs',
];

let _cachedHomeShortcuts = null;
async function getMyHomeShortcuts() {
  if (_cachedHomeShortcuts) return _cachedHomeShortcuts;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return DEFAULT_HOME_SHORTCUTS;
  const { data, error } = await supabaseClient.from('profiles').select('home_shortcuts').eq('id', session.user.id).maybeSingle();
  if (error) console.error('getMyHomeShortcuts failed:', error.message); // surfaced, not swallowed - a column-grant or RLS gap here silently fell back to defaults before
  _cachedHomeShortcuts = data?.home_shortcuts || DEFAULT_HOME_SHORTCUTS;
  return _cachedHomeShortcuts;
}
async function setMyHomeShortcuts(keys) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;
  const { error } = await supabaseClient.from('profiles').update({ home_shortcuts: keys }).eq('id', session.user.id);
  if (error) { console.error('setMyHomeShortcuts failed:', error.message); throw error; }
  _cachedHomeShortcuts = keys; // only cache once the write's actually confirmed to have gone through
}
async function toggleHomeShortcut(key) {
  const current = (await getMyHomeShortcuts()).slice();
  const idx = current.indexOf(key);
  if (idx === -1) current.push(key); else current.splice(idx, 1);
  await setMyHomeShortcuts(current);
  return current.includes(key);
}

// Async (unlike before) so an admin-only/pricing-only link can be filtered
// out for everyone else before it's ever painted, not hidden after the
// fact - existing callers don't need to change, they just fire-and-forget
// this same as always, nothing downstream awaits it.
async function renderMainNav(activeKey) {
  const tabsEl = document.getElementById('topbar-tabs');
  const dropdownEl = document.getElementById('mobile-menu-dropdown');
  const role = await getMyRole();
  const items = MAIN_NAV_ITEMS.filter(item =>
    (!item.adminOnly || role === 'admin') && (!item.pricingOnly || isPricingRole(role)));
  const shortcuts = await getMyHomeShortcuts();
  const starHtml = (key) => {
    const starred = shortcuts.includes(key);
    return `<span class="nav-star ${starred ? 'starred' : ''}" data-key="${key}" title="${starred ? 'Remove from Home page' : 'Add to Home page'}" onclick="event.preventDefault(); event.stopPropagation(); window.__onNavStarClick(this);">${starred ? '&#9733;' : '&#9734;'}</span>`;
  };
  const linksHtml = (asTab) => items.map(item =>
    `<a href="${item.href}" class="${asTab ? 'topbar-tab' : ''} ${item.key === activeKey ? 'active' : ''}"><span style="display:flex; align-items:center; gap:5px;">${starHtml(item.key)}${item.label}</span></a>`
  ).join('');
  if (tabsEl) tabsEl.innerHTML = linksHtml(true);
  if (dropdownEl) dropdownEl.innerHTML = linksHtml(false);

  // Delegated via a single global so the inline onclick above (needed
  // since tabs/dropdown get fully replaced on every renderMainNav call,
  // which would otherwise leak listeners) has one stable place to call
  // into - toggles the star everywhere it appears (desktop + mobile both
  // render the same key), not just the one clicked.
  window.__onNavStarClick = async (el) => {
    const key = el.dataset.key;
    try {
      const nowStarred = await toggleHomeShortcut(key);
      document.querySelectorAll(`.nav-star[data-key="${key}"]`).forEach(s => {
        s.classList.toggle('starred', nowStarred);
        s.innerHTML = nowStarred ? '&#9733;' : '&#9734;';
        s.title = nowStarred ? 'Remove from Home page' : 'Add to Home page';
      });
    } catch (err) {
      alert('Could not save that - ' + err.message);
    }
  };
  renderAIChatWidget();
}

// Floating "Ask AI" widget - piggybacks on renderMainNav() so it shows up
// on every page that renders the topbar (i.e. every authenticated page)
// without needing to be wired in individually. Backed by the ai-chat
// Netlify function, which can query the live database (read-only, scoped
// to whatever this logged-in staff member is allowed to see) to answer
// with real numbers instead of guessing.
// Shared HTML-escape for dropping any plain text (AI output, anything not
// already known-safe) into an innerHTML template literal.
function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : String(s);
  return div.innerHTML;
}

// Proxies abn-lookup.js (which itself proxies abr.business.gov.au - needs
// an ABR GUID set under Settings > API Keys, free from
// abr.business.gov.au/Tools/WebServices). Returns [] rather than
// throwing on any failure (missing GUID, rate limit, bad name) - this is
// always a convenience lookup, never something that should block a save
// or crash a bulk run partway through.
async function searchAbnByName(name) {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const res = await fetch(`/.netlify/functions/abn-lookup?name=${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const json = await res.json();
    return (json.ok && json.results) || [];
  } catch (err) {
    return [];
  }
}

// Wires a business-name search-as-you-type dropdown onto a text input.
// Picking a result gives the ABR's own registered entity name and ABN,
// instead of typing a company name and hoping it's spelled/legally
// correct.
function wireAbnNameSearch(inputEl, resultsEl, onSelect) {
  let searchTimeout = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = inputEl.value.trim();
    if (q.length < 3) { resultsEl.style.display = 'none'; return; }
    searchTimeout = setTimeout(async () => {
      const results = await searchAbnByName(q);
      if (!results.length) { resultsEl.style.display = 'none'; return; }
      try {
        resultsEl.innerHTML = results.map(r => `
          <div class="abn-search-result" data-name="${escapeHtml(r.name)}" data-abn="${escapeHtml(r.abn || '')}" style="padding:8px 12px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);">
            <div style="font-weight:600;">${escapeHtml(r.name)}</div>
            <div style="color:var(--muted); font-size:12px;">${r.abn ? 'ABN ' + r.abn : 'No ABN on file'}${r.status ? ' &middot; ' + escapeHtml(r.status) : ''}${r.state ? ' &middot; ' + escapeHtml(r.state) : ''}</div>
          </div>`).join('');
        resultsEl.querySelectorAll('.abn-search-result').forEach(row => {
          row.addEventListener('click', () => {
            onSelect({ name: row.dataset.name, abn: row.dataset.abn });
            resultsEl.style.display = 'none';
          });
        });
        resultsEl.style.display = 'block';
      } catch (err) {
        resultsEl.style.display = 'none';
      }
    }, 300);
  });
  document.addEventListener('click', (e) => {
    if (e.target !== inputEl && !resultsEl.contains(e.target)) resultsEl.style.display = 'none';
  });
}

let _aiChatHistory = [];
function _aiChatLoadHistory() {
  try { return JSON.parse(sessionStorage.getItem('te-ai-chat-history') || '[]'); } catch (e) { return []; }
}
function _aiChatSaveHistory() {
  try { sessionStorage.setItem('te-ai-chat-history', JSON.stringify(_aiChatHistory.slice(-30))); } catch (e) { /* private browsing etc - chat still works, just won't persist */ }
}
function renderAIChatWidget() {
  if (document.getElementById('ai-chat-widget')) return;
  _aiChatHistory = _aiChatLoadHistory();

  const wrap = document.createElement('div');
  wrap.id = 'ai-chat-widget';
  wrap.innerHTML = `
    <button type="button" id="ai-chat-toggle" title="Ask AI"><svg width="30" height="30" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13 1.5 2.5 14.5h7.2l-1.2 8 11.5-14h-7.4l1.4-7z" fill="#FFCC33" stroke="#1a1a1a" stroke-width="1.1" stroke-linejoin="round"/><circle cx="9" cy="10.6" r="0.95" fill="#1a1a1a"/><circle cx="13.4" cy="9.6" r="0.95" fill="#1a1a1a"/><path d="M9.3 13.2q1.8 1.5 3.6 0.1" stroke="#1a1a1a" stroke-width="1.1" fill="none" stroke-linecap="round"/></svg></button>
    <div id="ai-chat-panel">
      <div id="ai-chat-panel-header">
        <strong style="font-size:14px;">Ask AI</strong>
        <div>
          <button type="button" id="ai-chat-clear" title="Clear conversation" style="background:none; border:none; cursor:pointer; font-size:12px; color:var(--muted); margin-right:10px;">Clear</button>
          <button type="button" id="ai-chat-close" title="Close" style="background:none; border:none; cursor:pointer; font-size:18px; line-height:1;">&times;</button>
        </div>
      </div>
      <div id="ai-chat-messages"></div>
      <div id="ai-chat-input-row">
        <input id="ai-chat-input" placeholder="Ask about a job, quote, stock..." autocomplete="off" />
        <button type="button" id="ai-chat-send">Send</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  const panel = wrap.querySelector('#ai-chat-panel');
  const messagesEl = wrap.querySelector('#ai-chat-messages');
  const input = wrap.querySelector('#ai-chat-input');
  const sendBtn = wrap.querySelector('#ai-chat-send');

  function renderMessages() {
    if (!_aiChatHistory.length) {
      messagesEl.innerHTML = `<p class="subtitle" style="margin:0;">Ask about a job, a quote, stock levels, what's overdue - anything in the app. Read-only, can't make changes for you.</p>`;
      return;
    }
    messagesEl.innerHTML = _aiChatHistory.map(m => `
      <div style="display:flex; ${m.role === 'user' ? 'justify-content:flex-end;' : 'justify-content:flex-start;'} margin-bottom:8px;">
        <div style="max-width:85%; padding:8px 11px; border-radius:10px; white-space:pre-wrap; ${m.role === 'user' ? 'background:var(--accent); color:#fff;' : 'background:var(--surface-2); border:1px solid var(--border);'}">${escapeHtml(m.content)}</div>
      </div>`).join('');
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  renderMessages();

  function togglePanel(show) {
    panel.classList.toggle('open', show);
    if (show) { renderMessages(); input.focus(); }
  }
  wrap.querySelector('#ai-chat-toggle').addEventListener('click', () => togglePanel(!panel.classList.contains('open')));
  wrap.querySelector('#ai-chat-close').addEventListener('click', () => togglePanel(false));
  wrap.querySelector('#ai-chat-clear').addEventListener('click', () => {
    _aiChatHistory = [];
    _aiChatSaveHistory();
    renderMessages();
  });

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    _aiChatHistory.push({ role: 'user', content: text });
    renderMessages();
    _aiChatSaveHistory();

    sendBtn.disabled = true;
    messagesEl.insertAdjacentHTML('beforeend', `<div id="ai-chat-thinking" class="subtitle" style="margin-top:2px;">Thinking...</div>`);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      const startRes = await fetch('/.netlify/functions/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ messages: _aiChatHistory.slice(-20) }),
      });
      const startData = await startRes.json();
      if (!startRes.ok || !startData.ok) throw new Error(startData.error || 'Something went wrong.');

      // The real answer runs in the background - a deep lookup (search the
      // knowledge base, dig into a specific document, maybe check live
      // data too) is several chained calls and was timing out held open as
      // one request. Poll for the result instead.
      let answer = null;
      for (let i = 0; i < 60 && answer === null; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const pollRes = await fetch('/.netlify/functions/ai-chat-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ job_id: startData.job_id }),
        });
        const pollData = await pollRes.json();
        if (!pollRes.ok || !pollData.ok) throw new Error(pollData.error || 'Lost track of that answer.');
        if (pollData.status === 'done') answer = pollData.answer;
        else if (pollData.status === 'error') throw new Error(pollData.error || 'Something went wrong.');
      }
      if (answer === null) throw new Error("This one's taking a while - try asking again in a moment.");
      _aiChatHistory.push({ role: 'assistant', content: answer });
    } catch (err) {
      _aiChatHistory.push({ role: 'assistant', content: `Sorry, couldn't get an answer - ${err.message}` });
    }
    sendBtn.disabled = false;
    renderMessages();
    _aiChatSaveHistory();
    input.focus();
  }
  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

// Shared job search - by job number, name, client name, or site address.
// Used by the Schedule day view's draggable job panel, the Timesheets job
// picker, and anywhere else that needs "find a job by anything about it."
// Blocks scheduling a job that still has an outstanding task marked
// "required before this job can be scheduled" - project.html shows that
// flag as a red warning, but nothing actually enforced it anywhere a
// schedule_assignments row gets created (Schedule's drag-drop/mobile-add,
// or the "Also put this on their Schedule" task-creation checkbox).
// Returns the blocking task descriptions - empty array means safe to
// schedule.
async function requiredTasksBlockingSchedule(projectId) {
  if (!projectId) return [];
  const { data } = await supabaseClient
    .from('job_tasks')
    .select('description')
    .eq('project_id', projectId)
    .eq('required_before_scheduling', true)
    .eq('completed', false);
  return (data || []).map(t => t.description);
}

async function searchProjects(query, limit = 15) {
  if (!query || query.trim().length < 2) return [];
  const q = query.trim();
  const isNumeric = /^\d+$/.test(q);
  const orClauses = [`name.ilike.%${q}%`, `client_name.ilike.%${q}%`, `client_address.ilike.%${q}%`];
  if (isNumeric) orClauses.push(`job_number.eq.${q}`, `quote_number.eq.${q}`);
  const { data, error } = await supabaseClient
    .from('projects')
    .select('id, name, job_number, quote_number, client_name, client_address, pipeline_stage, laha_approved')
    .or(orClauses.join(','))
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('searchProjects error:', error.message); return []; }
  return data || [];
}

// Opens Gmail's own compose window directly, rather than whatever the
// browser/OS decides is the "default" mail app for a plain mailto: link -
// most people using Gmail actually use it in the browser, not a desktop
// mail client, so mailto: often opens the wrong thing entirely.
function gmailComposeUrl({ to = '', subject = '', body = '' } = {}) {
  const params = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
  return `https://mail.google.com/mail/?${params.toString()}`;
}

// Cost centre numbers (e.g. "7000-2") are computed from the job number
// plus the stage's position, not stored - position is 1-indexed.
function costCentreNumber(jobNumber, position) {
  return jobNumber ? `J${jobNumber}-${position}` : `-${position}`;
}

// Splits a clock-in/clock-out pair into one segment per Sydney calendar
// day, so a shift that runs past midnight never lands as a single
// time_entries row spanning two days - both the "your timesheet this
// week" view and the server-side labour-cost banding key everything off
// the Sydney LOCAL date of a row, so a row that crosses midnight would
// otherwise have its hours entirely misattributed to whichever day it
// started on. Returns [{clock_in, clock_out}, ...] as ISO strings - a
// same-day shift returns a single segment matching the input exactly.
function sydneyOffsetMinutesAt(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'shortOffset' }).formatToParts(date);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  const m = tzPart && tzPart.value.match(/GMT([+-]\d+)/);
  return m ? parseInt(m[1], 10) * 60 : 600;
}
function sydneyDateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function sydneyMidnightUtc(dateKey) {
  const naive = new Date(`${dateKey}T00:00:00Z`);
  // The offset has to be the one in force AT Sydney's midnight, not at
  // 00:00 UTC of the same date - on the day daylight saving changes those
  // differ, and using the UTC-midnight offset put the answer an hour early,
  // so splitAtSydneyMidnight below stopped advancing and froze the page
  // (any shift crossing the changeover, e.g. a clock-out left open for days).
  const guess = new Date(naive.getTime() - sydneyOffsetMinutesAt(naive) * 60000);
  return new Date(naive.getTime() - sydneyOffsetMinutesAt(guess) * 60000);
}
function splitAtSydneyMidnight(clockInIso, clockOutIso) {
  const segments = [];
  let cursor = new Date(clockInIso);
  const end = new Date(clockOutIso);
  while (cursor < end) {
    const dateKey = sydneyDateKey(cursor);
    const nextDateKey = new Date(`${dateKey}T00:00:00Z`);
    nextDateKey.setUTCDate(nextDateKey.getUTCDate() + 1);
    const nextMidnight = sydneyMidnightUtc(nextDateKey.toISOString().slice(0, 10));
    const segEnd = nextMidnight < end ? nextMidnight : end;
    if (segEnd <= cursor) break; // never loop forever if a boundary ever fails to advance
    segments.push({ clock_in: cursor.toISOString(), clock_out: segEnd.toISOString() });
    cursor = segEnd;
  }
  return segments.length ? segments : [{ clock_in: clockInIso, clock_out: clockOutIso }];
}

// Finds timesheet problems in the last `days` days: entries for the same
// person that overlap each other (usually a manual entry added over time that
// was already logged), and entries left clocked in for 16+ hours (a forgotten
// clock-out - these would otherwise overlap everything after them, so they're
// reported on their own). staffId = one person; omit it for everyone the
// caller's role is allowed to see. Returns { overlaps: [{ a, b, date, staffId }],
// stale: [entry] } with entries as { id, staff_id, clock_in, clock_out, projects }.
async function findTimesheetProblems({ staffId = null, days = 45 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = supabaseClient.from('time_entries')
    .select('id, staff_id, clock_in, clock_out, project_id, projects(name, job_number, quote_number)')
    .gte('clock_in', since).order('clock_in');
  if (staffId) q = q.eq('staff_id', staffId);
  const { data } = await q;
  const now = Date.now();
  const STALE_MS = 16 * 3600000;
  const entries = data || [];
  const stale = entries.filter(e => !e.clock_out && now - new Date(e.clock_in).getTime() > STALE_MS);
  const live = entries
    .filter(e => e.clock_out || now - new Date(e.clock_in).getTime() <= STALE_MS)
    .map(e => ({ e, start: new Date(e.clock_in).getTime(), end: e.clock_out ? new Date(e.clock_out).getTime() : now }));
  const byStaff = {};
  live.forEach(x => { (byStaff[x.e.staff_id] = byStaff[x.e.staff_id] || []).push(x); });
  const overlaps = [];
  Object.entries(byStaff).forEach(([sid, list]) => {
    list.sort((p, q2) => p.start - q2.start);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].start < list[i].end; j++) {
        // a minute's overlap is rounding, not a double-booking
        if (Math.min(list[i].end, list[j].end) - list[j].start < 60000) continue;
        overlaps.push({ a: list[i].e, b: list[j].e, date: sydneyDateKey(new Date(list[j].start)), staffId: sid });
      }
    }
  });
  return { overlaps, stale };
}

// Punches (clock in/out button presses, not manual entries or later edits)
// round to the nearest 15 minutes - real punches drift by a minute or two
// either way, and that shouldn't show up as odd timesheet totals.
function roundToQuarterHour(date) {
  const ms = 15 * 60 * 1000;
  return new Date(Math.round(date.getTime() / ms) * ms);
}

// Clocks out an active (clock_out is null) time_entries row, splitting it
// at each Sydney midnight it crosses - shared by my-day.html and the
// quick clock in/out button on home.html so there's one place that knows
// how to do this correctly. `entry` needs id/staff_id/project_id/
// cost_centre_id/selected_cost_centre_ids/time_category/clock_in.
// `opts.clockOutIso` overrides "now" (e.g. a rounded/edited punch time).
// `opts.carryFields` (e.g. a corrected cost centre) applies to the closed
// segment AND any overnight carryover segments, since it describes the
// whole shift. `opts.onceFields` (e.g. break info) applies only to the
// segment actually being closed - a break is a single point in time, not
// something to duplicate onto a carried-over segment. Returns { error } -
// never throws.
async function clockOutActiveEntry(entry, opts = {}) {
  const clockOutIso = opts.clockOutIso || new Date().toISOString();
  const carryFields = opts.carryFields || {};
  const onceFields = opts.onceFields || {};

  const segments = splitAtSydneyMidnight(entry.clock_in, clockOutIso);

  const { error } = await supabaseClient.from('time_entries')
    .update({ clock_out: segments[0].clock_out, ...carryFields, ...onceFields })
    .eq('id', entry.id);
  if (error) return { error };

  if (segments.length > 1) {
    const extraEntries = segments.slice(1).map(seg => ({
      staff_id: entry.staff_id, project_id: entry.project_id, cost_centre_id: entry.cost_centre_id,
      selected_cost_centre_ids: entry.selected_cost_centre_ids, time_category: entry.time_category,
      ...carryFields,
      clock_in: seg.clock_in, clock_out: seg.clock_out,
    }));
    const { error: insErr } = await supabaseClient.from('time_entries').insert(extraEntries);
    if (insErr) return { error: insErr };
  }
  return { error: null };
}

// ---------- clock-out confirmation wizard ----------
// Runs whenever someone clocks out (My Day, and the quick button on
// Home) - confirms which stage(s) the time counts against, lets them
// nudge the rounded punch time, captures the mandatory break if they've
// worked more than 6 hours today (or why it wasn't taken - asked once
// per Sydney calendar day, not every single clock-out), and finishes
// with real "before you go" actions: log a site photo, jot a note (with
// an optional signature), or head to the job.
// `entry` needs id/staff_id/project_id/cost_centre_id/
// selected_cost_centre_ids/time_category/clock_in. Calls `onDone` (if
// given) once the clock-out has actually saved. `opts.switchTo`
// ({projectId, label}), when given, clocks straight into that job once
// this clock-out (and its before-you-go step) is done - see
// openJobSwitchModal.
async function openClockOutModal(entry, onDone, opts = {}) {
  let project = null, centres = [];
  if (entry.project_id) {
    const [{ data: proj }, { data: cc }] = await Promise.all([
      supabaseClient.from('projects').select('id, name, job_number, quote_number, laha_approved, pipeline_stage').eq('id', entry.project_id).maybeSingle(),
      supabaseClient.from('cost_centres').select('id, name').eq('project_id', entry.project_id).order('sort_order'),
    ]);
    project = proj;
    centres = (cc || []).map((c, i) => ({ ...c, number: costCentreNumber(proj ? proj.job_number : null, i + 1) }));
  }
  let chosenCentres = (entry.selected_cost_centre_ids && entry.selected_cost_centre_ids.length)
    ? entry.selected_cost_centre_ids.slice()
    : (entry.cost_centre_id ? [entry.cost_centre_id] : []);
  let splitPercentages = [];

  // Has today's mandatory break already been answered against another
  // entry today? Generous UTC window, exact Sydney-date match in JS -
  // same pattern used server-side for day banding. The same fetch also
  // gives us everything ELSE clocked today, to check the 6-hour
  // threshold below.
  const windowStart = new Date(); windowStart.setUTCDate(windowStart.getUTCDate() - 1);
  const { data: recentEntries } = await supabaseClient
    .from('time_entries')
    .select('id, project_id, clock_in, clock_out, break_taken, stayed_overnight')
    .eq('staff_id', entry.staff_id)
    .gte('clock_in', windowStart.toISOString());
  const todayKey = sydneyDateKey(new Date());
  const todaysEntries = (recentEntries || []).filter(r => sydneyDateKey(new Date(r.clock_in)) === todayKey);
  const breakAlreadyLogged = todaysEntries.some(r => r.break_taken !== null && r.break_taken !== undefined);
  // Everything already clocked today (other entries) plus however long
  // THIS entry ends up running once a clock-out time is picked below.
  const otherTodayMs = todaysEntries.filter(r => r.id !== entry.id && r.clock_out)
    .reduce((s, r) => s + (new Date(r.clock_out) - new Date(r.clock_in)), 0);
  // Overnight-stay is asked once per (day, job) - a mobilisation job
  // usually runs several consecutive days, so this only needs answering
  // once per day even if it's clocked in and out of more than once.
  const lahaAlreadyLogged = todaysEntries.some(r => r.project_id === entry.project_id && r.stayed_overnight !== null && r.stayed_overnight !== undefined);

  const state = { outIso: roundToQuarterHour(new Date()).toISOString(), breakTaken: null, breakStart: '', breakMinutes: 30, breakSkipReason: '', stayedOvernight: null };

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:200; padding:16px;';
  document.body.appendChild(overlay);

  function pad(n) { return String(n).padStart(2, '0'); }
  function timePartLocal(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function totalMinutesForSplit() {
    const mins = Math.round((new Date(state.outIso) - new Date(entry.clock_in)) / 60000);
    return mins > 0 ? mins : 0;
  }

  function renderStep1() {
    const outDate = new Date(state.outIso);
    overlay.innerHTML = `
      <div class="card" style="max-width:460px; width:100%; max-height:85vh; overflow-y:auto;">
        <h2>Confirm clock-out</h2>
        <p class="subtitle" style="margin-bottom:12px;">${project ? projectRef(project) : 'General / Office'}</p>
        ${centres.length ? `
          <label style="margin-top:0">Stage(s) this time counts against</label>
          <div id="cko-cc-chips">${centres.map(c => `
            <button type="button" class="cc-chip ${chosenCentres.includes(c.id) ? 'selected' : ''}" data-id="${c.id}">
              <span class="cc-chip-num">${c.number}</span> ${c.name}
            </button>`).join('')}</div>
        ` : ''}
        <div id="cko-split-section" style="display:none; margin-top:10px;"></div>
        <label>Clock-out time</label>
        <input type="time" id="cko-time" value="${timePartLocal(outDate)}" />
        <p class="subtitle" style="margin:4px 0 0;">Rounded to the nearest 15 minutes - adjust if that's not quite right.</p>
        <div style="margin-top:14px;">
          <button id="cko-next-btn">Next</button>
          <button type="button" class="secondary" id="cko-cancel-btn">Cancel</button>
        </div>
        <div id="cko-msg"></div>
      </div>`;

    if (centres.length) {
      overlay.querySelectorAll('#cko-cc-chips .cc-chip').forEach(chip => {
        chip.addEventListener('click', () => {
          chip.classList.toggle('selected');
          const id = chip.dataset.id;
          if (chip.classList.contains('selected')) chosenCentres.push(id);
          else chosenCentres = chosenCentres.filter(x => x !== id);
          splitPercentages = [];
          refreshClockOutSplit();
        });
      });
    }
    overlay.querySelector('#cko-time').addEventListener('input', (e) => {
      const [hh, mm] = e.target.value.split(':').map(Number);
      const combined = new Date(outDate);
      if (!isNaN(hh)) combined.setHours(hh, mm || 0, 0, 0);
      state.outIso = combined.toISOString();
      refreshClockOutSplit();
    });
    overlay.querySelector('#cko-cancel-btn').addEventListener('click', () => overlay.remove());
    overlay.querySelector('#cko-next-btn').addEventListener('click', () => {
      const msg = overlay.querySelector('#cko-msg');
      if (centres.length && !chosenCentres.length) { msg.innerHTML = `<div class="error-box">Pick at least one stage this time counts against.</div>`; return; }
      const timeVal = overlay.querySelector('#cko-time').value;
      if (!timeVal) { msg.innerHTML = `<div class="error-box">Pick a clock-out time.</div>`; return; }
      const [hh, mm] = timeVal.split(':').map(Number);
      const combined = new Date(outDate);
      combined.setHours(hh, mm, 0, 0);
      if (combined <= new Date(entry.clock_in)) { msg.innerHTML = `<div class="error-box">Clock-out must be after your clock-in time.</div>`; return; }
      state.outIso = combined.toISOString();
      // Only worth asking about a break once today's actual worked hours
      // (this entry included) pass 6 - a short day doesn't need one.
      const todayHours = (otherTodayMs + (combined - new Date(entry.clock_in))) / 3600000;
      if (breakAlreadyLogged || todayHours <= 6) proceedAfterBreak(); else renderStep2();
    });

    refreshClockOutSplit();
  }

  // Splits the shift across stages right here (percentage sliders, same
  // mechanics as the Timesheets split) instead of just crediting each
  // ticked stage the full time and pointing them at Timesheets to fix it
  // up afterwards.
  function refreshClockOutSplit() {
    const section = overlay.querySelector('#cko-split-section');
    if (!section) return;
    const totalMin = totalMinutesForSplit();
    if (chosenCentres.length < 2 || totalMin <= 0) { section.style.display = 'none'; section.innerHTML = ''; splitPercentages = []; return; }

    const splitCentres = centres.filter(c => chosenCentres.includes(c.id));
    if (splitPercentages.length !== splitCentres.length) {
      splitPercentages = splitCentres.map(() => Math.round(100 / splitCentres.length));
      splitPercentages[0] += 100 - splitPercentages.reduce((a, b) => a + b, 0);
    }

    section.style.display = 'block';
    section.innerHTML = `
      <p class="subtitle" style="margin:0 0 8px;">Split ${fmtDuration(totalMin * 60000)} across these stages.</p>
      <div style="display:flex; height:18px; border-radius:6px; overflow:hidden; margin-bottom:10px;">
        ${splitCentres.map((c, i) => `<div class="cko-split-bar-seg" data-index="${i}" style="width:${splitPercentages[i]}%; background:${segmentColor(i)};"></div>`).join('')}
      </div>
      ${splitCentres.map((c, i) => `
        <div style="margin-bottom:10px;">
          <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; margin-bottom:3px; gap:8px;">
            <span><span style="display:inline-block; width:9px; height:9px; border-radius:3px; background:${segmentColor(i)}; margin-right:5px;"></span><strong>${c.number}</strong> ${c.name}</span>
            <span style="display:flex; align-items:center; gap:4px;">
              <input type="number" min="0" max="100" value="${splitPercentages[i]}" class="cko-split-number" data-index="${i}" style="width:50px; padding:3px 5px; text-align:right;" />%
              <span class="cko-split-label subtitle" data-index="${i}" style="min-width:60px; text-align:right;">${fmtDuration(Math.round(totalMin * splitPercentages[i] / 100) * 60000)}</span>
            </span>
          </div>
          <input type="range" min="0" max="100" value="${splitPercentages[i]}" class="cko-split-slider" data-index="${i}" style="width:100%; touch-action:none;" />
        </div>
      `).join('')}`;

    const sliders = [...section.querySelectorAll('.cko-split-slider')];
    const numbers = [...section.querySelectorAll('.cko-split-number')];
    const labels = [...section.querySelectorAll('.cko-split-label')];
    const barSegs = [...section.querySelectorAll('.cko-split-bar-seg')];

    function paint() {
      sliders.forEach((s, i) => { s.value = splitPercentages[i]; });
      numbers.forEach((n, i) => { if (document.activeElement !== n) n.value = splitPercentages[i]; });
      labels.forEach((l, i) => { l.textContent = fmtDuration(Math.round(totalMin * splitPercentages[i] / 100) * 60000); });
      barSegs.forEach((b, i) => { b.style.width = `${splitPercentages[i]}%`; });
    }
    function rebalance(idx, newVal) {
      newVal = Math.max(0, Math.min(100, newVal));
      const isLast = idx === splitCentres.length - 1;
      const flexIdxs = isLast ? splitCentres.map((_, i) => i).filter(i => i < idx) : splitCentres.map((_, i) => i).filter(i => i > idx);
      const lockedSum = splitCentres.map((_, i) => i).filter(i => i !== idx && !flexIdxs.includes(i)).reduce((s, i) => s + splitPercentages[i], 0);
      newVal = Math.min(newVal, 100 - lockedSum);
      splitPercentages[idx] = newVal;
      const remaining = 100 - newVal - lockedSum;
      const flexOldTotal = flexIdxs.reduce((s, i) => s + splitPercentages[i], 0);
      let assigned = 0;
      flexIdxs.forEach((i, n) => {
        const isLastFlex = n === flexIdxs.length - 1;
        const share = isLastFlex ? remaining - assigned : Math.round(flexOldTotal > 0 ? (splitPercentages[i] / flexOldTotal) * remaining : remaining / flexIdxs.length);
        splitPercentages[i] = Math.max(0, share);
        assigned += share;
      });
      paint();
    }
    sliders.forEach(s => s.addEventListener('input', () => rebalance(parseInt(s.dataset.index), parseInt(s.value))));
    numbers.forEach(n => n.addEventListener('input', () => { const v = parseInt(n.value); if (!isNaN(v)) rebalance(parseInt(n.dataset.index), v); }));
  }

  function renderStep2() {
    overlay.innerHTML = `
      <div class="card" style="max-width:460px; width:100%; max-height:85vh; overflow-y:auto;">
        <h2>Did you take your break today?</h2>
        <p class="subtitle" style="margin-bottom:12px;">It's mandatory to take at least 30 minutes - let us know when, or why not.</p>
        <div style="display:flex; gap:10px; margin-bottom:12px;">
          <button type="button" id="cko-break-yes" class="secondary" style="flex:1;">Yes, I took it</button>
          <button type="button" id="cko-break-no" class="secondary" style="flex:1;">No, I didn't</button>
        </div>
        <div id="cko-break-detail"></div>
        <div style="margin-top:14px;">
          <button id="cko-break-continue-btn">Continue</button>
          <button type="button" class="secondary" id="cko-back-btn">Back</button>
        </div>
        <div id="cko-msg"></div>
      </div>`;

    const detailEl = overlay.querySelector('#cko-break-detail');
    const breakMinuteOptions = [30, 45, 60, 75, 90].map(m => `<option value="${m}" ${m === state.breakMinutes ? 'selected' : ''}>${m} minutes</option>`).join('');
    overlay.querySelector('#cko-break-yes').addEventListener('click', () => {
      state.breakTaken = true;
      overlay.querySelector('#cko-break-yes').style.borderColor = 'var(--accent)';
      overlay.querySelector('#cko-break-no').style.borderColor = '';
      detailEl.innerHTML = `
        <label style="margin-top:0">What time did your break start?</label>
        <input type="time" id="cko-break-start" value="${state.breakStart}" />
        <label>How long was it?</label>
        <select id="cko-break-minutes">${breakMinuteOptions}</select>`;
    });
    overlay.querySelector('#cko-break-no').addEventListener('click', () => {
      state.breakTaken = false;
      overlay.querySelector('#cko-break-no').style.borderColor = 'var(--accent)';
      overlay.querySelector('#cko-break-yes').style.borderColor = '';
      detailEl.innerHTML = `<label style="margin-top:0">Why not?</label><input id="cko-break-reason" placeholder="e.g. too busy on site" />`;
    });
    overlay.querySelector('#cko-back-btn').addEventListener('click', renderStep1);
    overlay.querySelector('#cko-break-continue-btn').addEventListener('click', () => {
      const msg = overlay.querySelector('#cko-msg');
      if (state.breakTaken === null) { msg.innerHTML = `<div class="error-box">Let us know if you took a break.</div>`; return; }
      if (state.breakTaken) {
        const startVal = overlay.querySelector('#cko-break-start')?.value;
        if (!startVal) { msg.innerHTML = `<div class="error-box">Enter when your break started.</div>`; return; }
        state.breakStart = startVal;
        state.breakMinutes = parseInt(overlay.querySelector('#cko-break-minutes')?.value) || 30;
      } else {
        const reasonVal = overlay.querySelector('#cko-break-reason')?.value.trim();
        if (!reasonVal) { msg.innerHTML = `<div class="error-box">A quick reason is required.</div>`; return; }
        state.breakSkipReason = reasonVal;
      }
      proceedAfterBreak();
    });
  }

  // Break's been asked (or didn't need to be) - LAHA is the last
  // question before actually clocking out, only for a job approved for
  // it and not already answered today.
  function proceedAfterBreak() {
    if (project && project.laha_approved && !lahaAlreadyLogged) renderStepLaha(); else finalizeClockOut();
  }

  function renderStepLaha() {
    overlay.innerHTML = `
      <div class="card" style="max-width:460px; width:100%; max-height:85vh; overflow-y:auto;">
        <h2>Staying overnight?</h2>
        <p class="subtitle" style="margin-bottom:12px;">${projectRef(project)} is approved for LAHA (living-away-from-home allowance). Did you stay overnight away from home for it?</p>
        <div style="display:flex; gap:10px;">
          <button type="button" id="cko-laha-yes" style="flex:1;">Yes</button>
          <button type="button" class="secondary" id="cko-laha-no" style="flex:1;">No</button>
        </div>
        <div id="cko-msg"></div>
      </div>`;
    overlay.querySelector('#cko-laha-yes').addEventListener('click', () => { state.stayedOvernight = true; finalizeClockOut(); });
    overlay.querySelector('#cko-laha-no').addEventListener('click', () => { state.stayedOvernight = false; finalizeClockOut(); });
  }

  async function finalizeClockOut() {
    const onceFields = {};
    if (state.breakTaken !== null) {
      onceFields.break_taken = state.breakTaken;
      if (state.breakTaken) {
        const [hh, mm] = state.breakStart.split(':').map(Number);
        const breakStartDate = new Date(state.outIso);
        breakStartDate.setHours(hh, mm, 0, 0);
        onceFields.break_start = breakStartDate.toISOString();
        onceFields.break_minutes = state.breakMinutes;
      } else {
        onceFields.break_skip_reason = state.breakSkipReason;
      }
    }
    if (state.stayedOvernight !== null) {
      onceFields.stayed_overnight = state.stayedOvernight;
    }

    const doingSplit = chosenCentres.length > 1 && splitPercentages.length === chosenCentres.length;
    let saveError = null;

    if (!doingSplit) {
      const carryFields = {};
      if (chosenCentres.length === 1) { carryFields.cost_centre_id = chosenCentres[0]; carryFields.selected_cost_centre_ids = null; }
      else { carryFields.cost_centre_id = null; carryFields.selected_cost_centre_ids = null; }
      const { error } = await clockOutActiveEntry(entry, { clockOutIso: state.outIso, carryFields, onceFields });
      saveError = error;
    } else {
      // Physically split today's segment across stages (sequential time
      // ranges, same as the Timesheets split) - any portion carried past
      // midnight keeps crediting all the ticked stages evenly rather than
      // re-splitting again, since that combination is rare enough not to
      // need its own slider.
      const segments = splitAtSydneyMidnight(entry.clock_in, state.outIso);
      const splitCentres = centres.filter(c => chosenCentres.includes(c.id));
      const totalMin = Math.round((new Date(segments[0].clock_out) - new Date(segments[0].clock_in)) / 60000);
      const rows = [];
      let cursor = new Date(segments[0].clock_in);
      splitCentres.forEach((c, i) => {
        const isLast = i === splitCentres.length - 1;
        const minutes = isLast ? totalMin - rows.reduce((s, r) => s + r.minutes, 0) : Math.round(totalMin * splitPercentages[i] / 100);
        const segStart = new Date(cursor);
        const segEnd = new Date(cursor.getTime() + minutes * 60000);
        rows.push({ minutes, clock_in: segStart.toISOString(), clock_out: segEnd.toISOString(), cost_centre_id: c.id });
        cursor = segEnd;
      });

      const inserts = rows.map((r, i) => ({
        staff_id: entry.staff_id, project_id: entry.project_id, cost_centre_id: r.cost_centre_id,
        time_category: entry.time_category, clock_in: r.clock_in, clock_out: r.clock_out,
        ...(i === 0 ? onceFields : {}),
      }));
      const { error: insErr } = await supabaseClient.from('time_entries').insert(inserts);
      if (insErr) saveError = insErr;

      if (!saveError && segments.length > 1) {
        const extra = segments.slice(1).map(seg => ({
          staff_id: entry.staff_id, project_id: entry.project_id, cost_centre_id: null,
          selected_cost_centre_ids: chosenCentres, time_category: entry.time_category,
          clock_in: seg.clock_in, clock_out: seg.clock_out,
        }));
        const { error: e2 } = await supabaseClient.from('time_entries').insert(extra);
        if (e2) saveError = e2;
      }
      if (!saveError) {
        const { error: delErr } = await supabaseClient.from('time_entries').delete().eq('id', entry.id);
        if (delErr) saveError = delErr;
      }
    }

    if (saveError) {
      const msg = overlay.querySelector('#cko-msg');
      if (msg) msg.innerHTML = `<div class="error-box">${saveError.message}</div>`;
      return;
    }
    // Only asked for an actual job (not a quote/site-visit), and only
    // while it's genuinely mid-install - once it's moved on to handover
    // or beyond there's nothing left to ask about here.
    if (project && project.job_number && ['job_booked', 'job_not_complete'].includes(project.pipeline_stage)) renderStepJobStatus();
    else if (project) renderStep3();
    else await finishAndMaybeSwitch();
  }

  // "Complete" moves the job on to Client Handover. "Not complete - back
  // tomorrow" is the routine, no-note-needed case for an ordinary
  // multi-day job - it auto-books the same person on the same job for
  // the next calendar day and flags (doesn't block) if that slot's
  // already got something else on it. This is separate from the
  // Job Not Complete a PM can still set by hand from the pipeline board
  // for something genuinely stuck, not just "see you tomorrow".
  function renderStepJobStatus() {
    overlay.innerHTML = `
      <div class="card" style="max-width:460px; width:100%; max-height:85vh; overflow-y:auto;">
        <h2>How's the job?</h2>
        <p class="subtitle" style="margin-bottom:12px;">${projectRef(project)}</p>
        <div style="display:flex; flex-direction:column; gap:10px;">
          <button type="button" id="cko-job-complete">Complete</button>
          <button type="button" class="secondary" id="cko-job-not-complete">Not complete - back tomorrow</button>
        </div>
        <div id="cko-job-status-msg" style="margin-top:10px;"></div>
      </div>`;

    overlay.querySelector('#cko-job-complete').addEventListener('click', async () => {
      await supabaseClient.from('projects').update({ pipeline_stage: 'client_handover' }).eq('id', project.id).in('pipeline_stage', ['job_booked', 'job_not_complete']);
      await logActivity('project', project.id, 'job_complete', 'Marked complete at clock-out - moved to Client Handover');
      renderStep3();
    });

    overlay.querySelector('#cko-job-not-complete').addEventListener('click', async () => {
      const msgEl = overlay.querySelector('#cko-job-status-msg');
      const btn = overlay.querySelector('#cko-job-not-complete');
      btn.disabled = true;
      try {
        await supabaseClient.from('projects').update({ pipeline_stage: 'job_not_complete' }).eq('id', project.id).in('pipeline_stage', ['job_booked', 'job_not_complete']);

        const tomorrow = new Date(state.outIso);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().slice(0, 10);

        const { data: existingTomorrow } = await supabaseClient
          .from('schedule_assignments')
          .select('id, project_id, projects(name, job_number)')
          .eq('staff_id', entry.staff_id)
          .eq('assignment_date', tomorrowStr);
        const doubleBooked = (existingTomorrow || []).filter(a => a.project_id !== project.id);

        await supabaseClient.from('schedule_assignments').insert({
          staff_id: entry.staff_id, project_id: project.id, block_type: 'job',
          assignment_date: tomorrowStr, start_time: '07:00', end_time: '15:00',
        });
        await logActivity('project', project.id, 'job_not_complete', `Not complete at clock-out - booked back in for ${tomorrowStr}`);

        if (doubleBooked.length) {
          await logActivity('project', project.id, 'schedule_conflict', `Also booked on ${tomorrowStr} against: ${doubleBooked.map(a => a.projects?.name || 'another job').join(', ')}`);
          msgEl.innerHTML = `<div class="error-box">Heads up - you're already booked on something else for ${tomorrowStr} too. Let your PM know.</div>`;
          setTimeout(renderStep3, 2500);
        } else {
          renderStep3();
        }
      } catch (err) {
        msgEl.innerHTML = `<div class="error-box">${err.message}</div>`;
        btn.disabled = false;
      }
    });
  }

  // Clocking out is done at this point - if this clock-out was part of a
  // job switch (see openJobSwitchModal), this is where the new job's
  // clock-in actually happens, so the gap between jobs is exactly however
  // long the before-you-go step took, not zero and not backdated.
  async function finishAndMaybeSwitch() {
    if (opts.switchTo) {
      await supabaseClient.from('time_entries').insert({
        staff_id: entry.staff_id, project_id: opts.switchTo.projectId,
        time_category: 'job', clock_in: roundToQuarterHour(new Date()).toISOString(),
      });
    }
    overlay.remove();
    if (onDone) await onDone();
  }

  function renderStep3() {
    overlay.innerHTML = `
      <div class="card" style="max-width:480px; width:100%; max-height:85vh; overflow-y:auto;">
        <h2>Before you go...</h2>
        <p class="subtitle" style="margin-bottom:12px;">You're clocked out of ${projectRef(project)}.${opts.switchTo ? ` Next up: ${opts.switchTo.label}.` : ''}</p>

        <div style="padding:12px; background:var(--surface-2); border-radius:8px; margin-bottom:10px;">
          <label style="margin-top:0">Site photos</label>
          <input type="file" id="cko-photo-file" accept="image/*" multiple capture="environment" />
          <div id="cko-photo-msg"></div>
        </div>

        <div style="padding:12px; background:var(--surface-2); border-radius:8px; margin-bottom:10px;">
          <label style="margin-top:0">Note (materials used, forms sorted, anything worth flagging)</label>
          <textarea id="cko-note-text" rows="2" placeholder="e.g. used 2x 6mm cable, isolator installed"></textarea>
          <label style="display:flex; align-items:center; gap:6px; margin-top:8px; font-weight:400;">
            <input type="checkbox" id="cko-note-sign-toggle" style="width:auto;" /> Sign this note
          </label>
          <div id="cko-note-sign-section" style="display:none; margin-top:8px;"></div>
          <button type="button" class="secondary" id="cko-note-save-btn" style="margin-top:8px;">Save note</button>
          <div id="cko-note-msg"></div>
        </div>

        <a href="/project.html?id=${project.id}" class="link-quiet" style="display:block; text-align:center; margin-bottom:10px; font-size:13px;">Go to job page</a>
        <button type="button" id="cko-finish-btn" style="width:100%;">${opts.switchTo ? `Clock into ${opts.switchTo.label}` : 'Done'}</button>
      </div>`;

    let sigCanvas = null, sigCtx = null, hasSignature = false;
    overlay.querySelector('#cko-note-sign-toggle').addEventListener('change', (e) => {
      const section = overlay.querySelector('#cko-note-sign-section');
      if (!e.target.checked) { section.style.display = 'none'; section.innerHTML = ''; sigCanvas = null; return; }
      section.style.display = 'block';
      section.innerHTML = `
        <label style="margin-top:0">Signed by (name)</label>
        <input id="cko-note-signed-name" placeholder="Full name" />
        <label>Signature</label>
        <canvas id="cko-note-sig-canvas" width="380" height="120" style="width:100%; max-width:380px; height:120px; border:1px solid var(--border); border-radius:6px; touch-action:none; background:#fff; display:block;"></canvas>
        <button type="button" class="secondary" id="cko-note-sig-clear-btn" style="margin-top:8px; font-size:12px; padding:6px 10px;">Clear signature</button>`;
      sigCanvas = section.querySelector('#cko-note-sig-canvas');
      sigCtx = sigCanvas.getContext('2d');
      sigCtx.strokeStyle = '#000'; sigCtx.lineWidth = 2; sigCtx.lineJoin = 'round'; sigCtx.lineCap = 'round';
      hasSignature = false;
      let drawing = false;
      function pointerPos(ev) {
        const rect = sigCanvas.getBoundingClientRect();
        return { x: (ev.clientX - rect.left) * (sigCanvas.width / rect.width), y: (ev.clientY - rect.top) * (sigCanvas.height / rect.height) };
      }
      sigCanvas.addEventListener('pointerdown', (ev) => { drawing = true; hasSignature = true; const p = pointerPos(ev); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); });
      sigCanvas.addEventListener('pointermove', (ev) => { if (!drawing) return; const p = pointerPos(ev); sigCtx.lineTo(p.x, p.y); sigCtx.stroke(); });
      window.addEventListener('pointerup', () => { drawing = false; });
      section.querySelector('#cko-note-sig-clear-btn').addEventListener('click', () => { sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height); hasSignature = false; });
    });

    // Fires the moment photos are chosen - previously needed a second
    // "Upload" click that staff often skipped, assuming picking the file
    // was already the whole job done.
    overlay.querySelector('#cko-photo-file').addEventListener('change', async () => {
      const fileInput = overlay.querySelector('#cko-photo-file');
      const msg = overlay.querySelector('#cko-photo-msg');
      if (!fileInput.files.length) return;
      msg.innerHTML = `<p class="subtitle">Uploading...</p>`;
      try {
        const urls = await uploadPhotos(fileInput.files, project.id, 'site-photos');
        const { error } = await supabaseClient.from('project_photos').insert(urls.map(url => ({ project_id: project.id, staff_id: entry.staff_id, url })));
        if (error) throw error;
        fileInput.value = '';
        msg.innerHTML = `<div class="success-box">${urls.length} photo${urls.length === 1 ? '' : 's'} added.</div>`;
      } catch (err) { msg.innerHTML = `<div class="error-box">${err.message}</div>`; }
    });

    overlay.querySelector('#cko-note-save-btn').addEventListener('click', async () => {
      const msg = overlay.querySelector('#cko-note-msg');
      const noteText = overlay.querySelector('#cko-note-text').value.trim();
      if (!noteText) { msg.innerHTML = `<div class="error-box">Write a note first.</div>`; return; }
      const row = { project_id: project.id, staff_id: entry.staff_id, note: noteText };
      if (overlay.querySelector('#cko-note-sign-toggle').checked) {
        const signedName = overlay.querySelector('#cko-note-signed-name')?.value.trim();
        if (!signedName) { msg.innerHTML = `<div class="error-box">Enter the signer's name.</div>`; return; }
        if (!hasSignature) { msg.innerHTML = `<div class="error-box">Draw a signature.</div>`; return; }
        row.signed_by_name = signedName;
        row.signature_data_url = sigCanvas.toDataURL('image/png');
      }
      const { error } = await supabaseClient.from('project_field_notes').insert(row);
      if (error) { msg.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
      overlay.querySelector('#cko-note-text').value = '';
      msg.innerHTML = `<div class="success-box">Note saved.</div>`;
    });

    overlay.querySelector('#cko-finish-btn').addEventListener('click', finishAndMaybeSwitch);
  }

  renderStep1();
}

// Lets someone currently clocked in search for a different job and move
// straight onto it - picking a job here just runs the exact same
// clock-out flow as normal (confirm stage(s), the 6-hour break question,
// before-you-go photos/notes/sign) with one difference: finishing that
// flow clocks straight into the new job instead of just stopping, so the
// gap between jobs is whatever the wrap-up actually took, not backdated
// to zero. `entry` is the currently active time_entries row (needs
// id/staff_id/project_id/cost_centre_id/selected_cost_centre_ids/
// time_category/clock_in, same as openClockOutModal). Calls `onDone`
// once the whole switch (old job's clock-out through to the new job's
// clock-in) is done.
async function openJobSwitchModal(entry, onDone) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:200; padding:16px;';
  document.body.appendChild(overlay);

  overlay.innerHTML = `
    <div class="card" style="max-width:460px; width:100%; max-height:85vh; overflow-y:auto;">
      <h2>Switch job</h2>
      <p class="subtitle" style="margin-bottom:12px;">Search for the job you're moving onto - you'll be asked to wrap up your current one first.</p>
      <input id="switch-job-search" placeholder="Job number, name, client, address..." autocomplete="off" />
      <div id="switch-job-results" style="margin-top:8px;"></div>
      <button type="button" class="secondary" id="switch-job-cancel-btn" style="margin-top:14px; width:100%;">Cancel</button>
    </div>`;

  function renderResults(results, label) {
    const resultsEl = overlay.querySelector('#switch-job-results');
    if (!results.length) { resultsEl.innerHTML = label ? '' : `<p class="subtitle">No matches.</p>`; return; }
    resultsEl.innerHTML = `
      ${label ? `<p class="subtitle" style="margin:0 0 4px; font-size:12px;">${label}</p>` : ''}
      <div style="border:1px solid var(--border); border-radius:8px;">
        ${results.filter(p => p.id !== entry.project_id).map(p => `<div class="job-pick-row" data-id="${p.id}" data-label="${projectRef(p).replace(/"/g, '&quot;')}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${projectRef(p)} <span class="subtitle">${p.client_name || ''}</span></div>`).join('')}
      </div>`;
    resultsEl.querySelectorAll('.job-pick-row').forEach(row => {
      row.addEventListener('click', () => {
        overlay.remove();
        openClockOutModal(entry, onDone, { switchTo: { projectId: row.dataset.id, label: row.dataset.label } });
      });
    });
  }

  async function showRecent() {
    const { data } = await supabaseClient
      .from('time_entries')
      .select('project_id, clock_in, projects(id, name, job_number, quote_number, client_name)')
      .eq('staff_id', entry.staff_id)
      .not('project_id', 'is', null)
      .order('clock_in', { ascending: false })
      .limit(50);
    const seen = new Set();
    const recent = [];
    for (const row of data || []) {
      if (!row.projects || seen.has(row.project_id)) continue;
      seen.add(row.project_id);
      recent.push(row.projects);
      if (recent.length >= 8) break;
    }
    renderResults(recent, 'Recent jobs');
  }

  overlay.querySelector('#switch-job-search').addEventListener('focus', (e) => {
    if (e.target.value.trim().length < 2) showRecent();
  });
  let searchTimeout;
  overlay.querySelector('#switch-job-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    if (q.length === 0) { showRecent(); return; }
    if (q.length < 2) { overlay.querySelector('#switch-job-results').innerHTML = ''; return; }
    searchTimeout = setTimeout(async () => renderResults(await searchProjects(q)), 250);
  });
  overlay.querySelector('#switch-job-cancel-btn').addEventListener('click', () => overlay.remove());

  showRecent();
}

// Creates a job with no quote/estimate behind it - straight to Job
// Booked (a job number is assigned immediately, no approval to wait for)
// with one cost centre already in place so time (timesheets) and
// materials (POs, or logged manually) have somewhere to attach to right
// away. There's nothing quoted here to raise a % claim against - see
// openInvoiceActualCostsPanel (project.html) for how it gets invoiced
// instead, off whatever actually accrued. Shared by the Job pipeline
// board and My Day. `onCreated({id, name, job_number})` is called once
// saved - the caller decides what to do next (redirect, auto-select it
// for clocking in, etc), nothing is baked in here.
function openQuickJobPanel(onCreated) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:150; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:480px; width:100%; max-height:85vh; overflow-y:auto;">
      <h2>New job - no quote</h2>
      <p class="subtitle" style="margin-bottom:12px;">Skips the quote/proposal step entirely and goes straight to Job Booked. Time and materials get logged against it as normal (timesheets, POs, or manually); invoice it for whatever's actually been spent once it's done.</p>

      <label style="margin-top:0">Job name</label>
      <input id="qj-name" placeholder="e.g. 14 Miller St - Switchboard Repair" />

      <label>What's this job about</label>
      <textarea id="qj-brief" rows="2" placeholder="Brief description of the work"></textarea>

      <label>Client - search existing, or just type a new one below</label>
      <input id="qj-client-search" placeholder="Search existing clients..." autocomplete="off" />
      <div id="qj-client-results"></div>

      <div class="grid cols-2" style="margin-top:8px;">
        <div>
          <label style="margin-top:0">Client name</label>
          <input id="qj-client-name" required />
        </div>
        <div>
          <label style="margin-top:0">Client email</label>
          <input id="qj-client-email" type="email" />
        </div>
      </div>
      <label>Client phone</label>
      <input id="qj-client-phone" />

      <label>Site address</label>
      <input id="qj-address" placeholder="Job site address" />

      <label style="display:flex; align-items:center; gap:8px; margin-top:14px; font-weight:400;">
        <input type="checkbox" id="qj-laha-approved" style="width:auto;" /> LAHA approved (more than 100km from base)
      </label>
      <p class="subtitle" style="margin-top:4px;">Staff clocking out of this job will be asked whether they stayed overnight, and the allowance gets added to their pay automatically.</p>

      <div style="margin-top:14px;">
        <button id="qj-confirm-btn">Create job</button>
        <button type="button" class="secondary" id="qj-cancel-btn">Cancel</button>
      </div>
      <div id="qj-msg"></div>
    </div>`;

  let selectedClientId = null;

  let searchTimeout;
  overlay.querySelector('#qj-client-search').addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const q = e.target.value.trim();
    selectedClientId = null;
    if (q.length < 2) { overlay.querySelector('#qj-client-results').innerHTML = ''; return; }
    searchTimeout = setTimeout(async () => {
      const { data } = await supabaseClient
        .from('clients')
        .select('id, name, email, phone, address')
        .or(`name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8);
      const resultsEl = overlay.querySelector('#qj-client-results');
      if (!data || !data.length) { resultsEl.innerHTML = `<p class="subtitle" style="margin-top:4px;">No matches - fill in the fields below to add them as a new client.</p>`; return; }
      resultsEl.innerHTML = `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">
        ${data.map(c => `<div class="client-pick-row" data-id="${c.id}" data-name="${c.name}" data-email="${c.email || ''}" data-phone="${c.phone || ''}" data-address="${c.address || ''}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${c.name} <span class="subtitle">${c.email || ''}</span></div>`).join('')}
      </div>`;
      resultsEl.querySelectorAll('.client-pick-row').forEach(row => {
        row.addEventListener('click', () => {
          selectedClientId = row.dataset.id;
          overlay.querySelector('#qj-client-search').value = row.dataset.name;
          overlay.querySelector('#qj-client-name').value = row.dataset.name;
          overlay.querySelector('#qj-client-email').value = row.dataset.email;
          overlay.querySelector('#qj-client-phone').value = row.dataset.phone;
          if (row.dataset.address && !overlay.querySelector('#qj-address').value) {
            overlay.querySelector('#qj-address').value = row.dataset.address;
          }
          resultsEl.innerHTML = '';
        });
      });
    }, 250);
  });

  overlay.querySelector('#qj-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#qj-confirm-btn').addEventListener('click', async () => {
    const confirmBtn = overlay.querySelector('#qj-confirm-btn');
    const panelMsg = overlay.querySelector('#qj-msg');
    const name = overlay.querySelector('#qj-name').value.trim();
    const brief = overlay.querySelector('#qj-brief').value.trim();
    const clientName = overlay.querySelector('#qj-client-name').value.trim();
    const clientEmail = overlay.querySelector('#qj-client-email').value.trim();
    const clientPhone = overlay.querySelector('#qj-client-phone').value.trim();
    const clientAddress = overlay.querySelector('#qj-address').value.trim();

    if (!name) { panelMsg.innerHTML = `<div class="error-box">Job name is required.</div>`; return; }
    if (!clientName) { panelMsg.innerHTML = `<div class="error-box">Client name is required - search for an existing client or type a new one.</div>`; return; }

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Creating...';
    try {
      let clientId = selectedClientId;
      if (!clientId) {
        const { data: newClient, error: clientErr } = await supabaseClient
          .from('clients')
          .insert({ name: clientName, email: clientEmail, phone: clientPhone, address: clientAddress })
          .select('id')
          .single();
        if (clientErr) throw clientErr;
        clientId = newClient.id;
      }

      const { data: project, error } = await supabaseClient.from('projects').insert({
        name,
        sow_text: brief || null,
        client_id: clientId,
        client_name: clientName,
        client_email: clientEmail,
        client_phone: clientPhone,
        client_address: clientAddress,
        proposal_template: 'direct_job',
        pipeline_stage: 'job_booked',
        status: 'in_progress',
        laha_approved: overlay.querySelector('#qj-laha-approved').checked,
      }).select('id, name, job_number').single();
      if (error) throw error;

      // One cost centre so time and materials have somewhere to attach to
      // immediately - no quote behind it, so there's nothing to estimate.
      const { error: ccErr } = await supabaseClient.from('cost_centres').insert({
        project_id: project.id, name: 'Labour & Materials', sort_order: 0, markup_percent: 45,
      });
      if (ccErr) throw ccErr;

      overlay.remove();
      if (onCreated) onCreated(project);
    } catch (err) {
      panelMsg.innerHTML = `<div class="error-box">${err.message}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Create job';
    }
  });

  document.body.appendChild(overlay);
}

// Re-checked any time the handover data fields are saved or a
// task_type='handover' job_task is completed - advances Client Handover
// -> Ready to Invoice once both are true: every handover task done, AND
// (solar jobs only - this data doesn't exist on the handover card for
// anything else) NMI, panel/inverter serials, and a Formbay lodgement
// status are all filled in.
async function checkAndAdvanceHandover(projectId) {
  const { data: project } = await supabaseClient
    .from('projects')
    .select('pipeline_stage, proposal_template, nmi, panel_serial_numbers, inverter_serial_numbers, formbay_lodgement_status')
    .eq('id', projectId)
    .maybeSingle();
  if (!project || project.pipeline_stage !== 'client_handover') return;

  if (project.proposal_template === 'solar') {
    const dataComplete = !!(project.nmi || '').trim() && !!(project.panel_serial_numbers || '').trim()
      && !!(project.inverter_serial_numbers || '').trim() && !!project.formbay_lodgement_status;
    if (!dataComplete) return;
  }

  const { data: outstanding } = await supabaseClient
    .from('job_tasks')
    .select('id')
    .eq('project_id', projectId)
    .eq('task_type', 'handover')
    .eq('completed', false);
  if ((outstanding || []).length) return;

  await supabaseClient.from('projects').update({ pipeline_stage: 'ready_to_invoice' }).eq('id', projectId).eq('pipeline_stage', 'client_handover');
}

// Mirrors advance-job-stage.js's server-side logic (run right after a
// deposit is paid) - re-checked any time a required-before-scheduling
// task is completed or a new one is added, but only while the job
// hasn't been scheduled yet (awaiting_action/ready_to_book). Once it's
// actually job_booked or further along, a task change shouldn't silently
// move it backwards - see PROJECT_SPEC/the job-not-complete flow for
// how a job returns to awaiting_action deliberately instead.
async function refreshPipelineTaskGate(projectId) {
  const { data: project } = await supabaseClient.from('projects').select('pipeline_stage').eq('id', projectId).maybeSingle();
  if (!project || !['awaiting_action', 'ready_to_book'].includes(project.pipeline_stage)) return;
  const { data: outstanding } = await supabaseClient
    .from('job_tasks')
    .select('id')
    .eq('project_id', projectId)
    .eq('required_before_scheduling', true)
    .eq('completed', false);
  const stage = (outstanding || []).length ? 'awaiting_action' : 'ready_to_book';
  if (stage !== project.pipeline_stage) {
    await supabaseClient.from('projects').update({ pipeline_stage: stage }).eq('id', projectId);
  }
}

// Best-effort carry-over of a site inspection across lead -> quote -> job.
// A job created from an approved quote is a NEW projects row
// (source_quote_id points back at the quote, lead_id is never copied onto
// it), and a quote created from a lead only ever gets lead_id set on the
// quote itself. Rather than physically moving or duplicating the
// site_inspections row (which would orphan whichever earlier stage still
// wants to see it - the lead's own page still needs it, for instance),
// this just looks in every place an inspection could have been recorded
// for this same project's chain: directly on it, on the lead it came
// from, or - for a job - on the quote it came from and that quote's own
// lead. Same underlying inspection (and its answers/photos) shows up at
// every stage.
async function findLinkedSiteInspection(project) {
  const { data: direct } = await supabaseClient.from('site_inspections')
    .select('id, status').eq('project_id', project.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (direct) return direct;

  if (project.lead_id) {
    const { data: viaLead } = await supabaseClient.from('site_inspections')
      .select('id, status').eq('lead_id', project.lead_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (viaLead) return viaLead;
  }

  if (project.source_quote_id) {
    const { data: viaQuote } = await supabaseClient.from('site_inspections')
      .select('id, status').eq('project_id', project.source_quote_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (viaQuote) return viaQuote;

    const { data: quote } = await supabaseClient.from('projects').select('lead_id').eq('id', project.source_quote_id).maybeSingle();
    if (quote?.lead_id) {
      const { data: viaQuoteLead } = await supabaseClient.from('site_inspections')
        .select('id, status').eq('lead_id', quote.lead_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (viaQuoteLead) return viaQuoteLead;
    }
  }

  return null;
}

// Schedules a site inspection against a lead or job/quote - picks a
// checklist template (see Settings > Inspection Checklists) and who/when,
// creates the site_inspections row plus a matching schedule_assignments
// block (block_type 'site_inspection') so it shows up on the Schedule
// page like any other booking. `record` is the lead or project row
// (just needs .id); `kind` is 'lead' or 'project'.
async function openScheduleInspectionPanel(record, kind, onScheduled) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:200; padding:16px;';
  overlay.innerHTML = `<div class="card" style="max-width:420px; width:100%;"><p class="subtitle">Loading...</p></div>`;
  document.body.appendChild(overlay);

  const [{ data: templates }, { data: staff }] = await Promise.all([
    supabaseClient.from('inspection_checklist_templates').select('id, name').eq('active', true).eq('checklist_type', 'site_inspection').order('sort_order'),
    supabaseClient.from('profiles').select('id, full_name').eq('active', true).order('full_name'),
  ]);

  if (!templates || !templates.length) {
    overlay.innerHTML = `<div class="card" style="max-width:420px; width:100%;"><div class="error-box">No checklist templates set up yet - add one under Settings &gt; Inspection Checklists first.</div><button type="button" class="secondary" id="si-close-btn" style="margin-top:10px; width:100%;">Close</button></div>`;
    overlay.querySelector('#si-close-btn').addEventListener('click', () => overlay.remove());
    return;
  }

  overlay.innerHTML = `
    <div class="card" style="max-width:460px; width:100%; max-height:88vh; overflow-y:auto;">
      <h2>Schedule inspection</h2>
      <label style="margin-top:0">Checklist</label>
      <select id="si-template">${templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</select>
      <label>Assign to</label>
      <select id="si-staff">${(staff || []).map(s => `<option value="${s.id}">${s.full_name || 'Unnamed'}</option>`).join('')}</select>
      <div class="grid cols-3">
        <div>
          <label>Date</label>
          <input type="date" id="si-date" value="${new Date().toISOString().slice(0, 10)}" />
        </div>
        <div>
          <label>Start time</label>
          <input type="time" id="si-start" value="09:00" />
        </div>
        <div>
          <label>End time</label>
          <input type="time" id="si-end" value="10:00" />
        </div>
      </div>

      <div style="margin-top:10px; padding:10px; background:var(--surface-2); border-radius:8px;">
        <p class="subtitle" style="margin:0 0 6px; font-weight:600;">Their day, so far</p>
        <div id="si-day-preview"><p class="subtitle">Loading...</p></div>
      </div>

      <div style="margin-top:14px;">
        <button id="si-confirm-btn">Schedule</button>
        <button type="button" class="secondary" id="si-cancel-btn">Cancel</button>
      </div>
      <div id="si-msg"></div>
    </div>`;

  // Shows what the selected staff member already has on for the selected
  // date - existing schedule_assignments plus approved leave - so
  // whoever's booking an inspection can actually see a gap instead of
  // guessing someone's free.
  async function refreshDayPreview() {
    const previewEl = overlay.querySelector('#si-day-preview');
    const staffId = overlay.querySelector('#si-staff').value;
    const dateStr = overlay.querySelector('#si-date').value;
    if (!staffId || !dateStr) { previewEl.innerHTML = ''; return; }
    previewEl.innerHTML = `<p class="subtitle">Loading...</p>`;

    const [{ data: existing }, { data: leave }] = await Promise.all([
      supabaseClient.from('schedule_assignments').select('start_time, end_time, block_type, note, projects(name, job_number)').eq('staff_id', staffId).eq('assignment_date', dateStr).order('start_time'),
      supabaseClient.from('leave_requests').select('leave_type').eq('staff_id', staffId).eq('status', 'approved').lte('start_date', dateStr).gte('end_date', dateStr).maybeSingle(),
    ]);

    if (leave) {
      previewEl.innerHTML = `<p style="margin:0; color:var(--red);">On approved leave (${leave.leave_type || 'leave'}) this day.</p>`;
      return;
    }
    if (!existing || !existing.length) {
      previewEl.innerHTML = `<p style="margin:0; color:var(--green);">Nothing booked this day yet.</p>`;
      return;
    }
    const labelFor = (a) => a.block_type === 'site_inspection' ? 'Inspection' + (a.projects?.name ? ': ' + a.projects.name : '')
      : a.projects ? `${a.block_type === 'site_visit' ? 'Site visit: ' : ''}${a.projects.name}${a.projects.job_number ? ' #' + a.projects.job_number : ''}`
      : `${{ training: 'Training', office: 'Office / admin', other: 'Other' }[a.block_type] || 'Office / admin'}${a.note ? ' - ' + a.note : ''}`;
    previewEl.innerHTML = existing.map(a => `<p style="margin:2px 0;">${a.start_time.slice(0, 5)}-${a.end_time.slice(0, 5)} &middot; ${labelFor(a)}</p>`).join('');
  }
  overlay.querySelector('#si-staff').addEventListener('change', refreshDayPreview);
  overlay.querySelector('#si-date').addEventListener('change', refreshDayPreview);
  refreshDayPreview();

  overlay.querySelector('#si-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#si-confirm-btn').addEventListener('click', async () => {
    const confirmBtn = overlay.querySelector('#si-confirm-btn');
    const msg = overlay.querySelector('#si-msg');
    const startTime = overlay.querySelector('#si-start').value;
    const endTime = overlay.querySelector('#si-end').value;
    if (!startTime || !endTime || endTime <= startTime) { msg.innerHTML = `<div class="error-box">Pick a valid start/end time.</div>`; return; }
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Scheduling...';
    try {
      const { data: inspection, error } = await supabaseClient.from('site_inspections').insert({
        lead_id: kind === 'lead' ? record.id : null,
        project_id: kind === 'project' ? record.id : null,
        template_id: overlay.querySelector('#si-template').value,
      }).select('id').single();
      if (error) throw error;

      const { error: schedErr } = await supabaseClient.from('schedule_assignments').insert({
        staff_id: overlay.querySelector('#si-staff').value,
        project_id: kind === 'project' ? record.id : null,
        assignment_date: overlay.querySelector('#si-date').value,
        start_time: startTime, end_time: endTime,
        block_type: 'site_inspection',
        site_inspection_id: inspection.id,
      });
      if (schedErr) throw schedErr;

      overlay.remove();
      if (onScheduled) onScheduled(inspection);
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${err.message}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Schedule';
    }
  });
}

// A warranty job for `originalProject` - functionally a quick job (own
// job number, one cost centre, no quote) so it reuses every existing
// clock-in/timesheet/PO mechanism unchanged, but tagged via
// warranty_of_project_id so its accrued cost rolls back into the
// original job's actual profit (net of whatever's recovered - see
// project.html's loadProject()) and its page can show a reference back
// to the original job's scope of works/documents. Client/site details
// default from the original (same property, same client contact) but
// stay editable in case the site contact for the warranty visit differs.
function openWarrantyJobPanel(originalProject, onCreated) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:150; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:480px; width:100%; max-height:85vh; overflow-y:auto;">
      <h2>Create warranty job</h2>
      <p class="subtitle" style="margin-bottom:12px;">For ${projectRef(originalProject)}. Its own job number - clock in, log POs, and invoice it same as any job - but its cost pulls back against the original job's actual profit, and once you close it out you'll choose whether it's absorbed, billed to the manufacturer, or partly billed to the client.</p>

      <label style="margin-top:0">Job name</label>
      <input id="wj-name" value="${(originalProject.name || '').replace(/"/g, '&quot;')} - Warranty" />

      <label>What's the warranty issue</label>
      <textarea id="wj-brief" rows="2" placeholder="Brief description of what's gone wrong"></textarea>

      <div class="grid cols-2" style="margin-top:8px;">
        <div>
          <label style="margin-top:0">Client name</label>
          <input id="wj-client-name" required value="${(originalProject.client_name || '').replace(/"/g, '&quot;')}" />
        </div>
        <div>
          <label style="margin-top:0">Client email</label>
          <input id="wj-client-email" type="email" value="${originalProject.client_email || ''}" />
        </div>
      </div>
      <label>Client phone</label>
      <input id="wj-client-phone" value="${originalProject.client_phone || ''}" />

      <label>Site address</label>
      <input id="wj-address" value="${(originalProject.client_address || '').replace(/"/g, '&quot;')}" />

      <div style="margin-top:14px;">
        <button id="wj-confirm-btn">Create warranty job</button>
        <button type="button" class="secondary" id="wj-cancel-btn">Cancel</button>
      </div>
      <div id="wj-msg"></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#wj-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#wj-confirm-btn').addEventListener('click', async () => {
    const confirmBtn = overlay.querySelector('#wj-confirm-btn');
    const panelMsg = overlay.querySelector('#wj-msg');
    const name = overlay.querySelector('#wj-name').value.trim();
    const brief = overlay.querySelector('#wj-brief').value.trim();
    const clientName = overlay.querySelector('#wj-client-name').value.trim();
    const clientEmail = overlay.querySelector('#wj-client-email').value.trim();
    const clientPhone = overlay.querySelector('#wj-client-phone').value.trim();
    const clientAddress = overlay.querySelector('#wj-address').value.trim();

    if (!name) { panelMsg.innerHTML = `<div class="error-box">Job name is required.</div>`; return; }
    if (!clientName) { panelMsg.innerHTML = `<div class="error-box">Client name is required.</div>`; return; }

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Creating...';
    try {
      const { data: project, error } = await supabaseClient.from('projects').insert({
        name,
        sow_text: brief || null,
        client_id: originalProject.client_id || null,
        client_name: clientName,
        client_email: clientEmail,
        client_phone: clientPhone,
        client_address: clientAddress,
        proposal_template: 'direct_job',
        pipeline_stage: 'job_booked',
        status: 'in_progress',
        warranty_of_project_id: originalProject.id,
      }).select('id, name, job_number').single();
      if (error) throw error;

      const { error: ccErr } = await supabaseClient.from('cost_centres').insert({
        project_id: project.id, name: 'Labour & Materials', sort_order: 0, markup_percent: 45,
      });
      if (ccErr) throw ccErr;

      overlay.remove();
      if (onCreated) onCreated(project);
    } catch (err) {
      panelMsg.innerHTML = `<div class="error-box">${err.message}</div>`;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Create warranty job';
    }
  });
}

// STC (Small-scale Technology Certificate) quantity, per the Clean Energy
// Regulator's published formula (cer.gov.au/schemes/renewable-energy-target
// /small-scale-renewable-energy-scheme/small-scale-technology-certificates):
// system size (kW) x postcode zone rating x deeming years, rounded down.
// Deeming years = years remaining until the scheme ends in 2030 inclusive -
// a system installed in year Y is deemed for (2031 - Y) years (2026 -> 5,
// 2030 -> 1, per the Regulator's own worked examples).
//
// Zone rating is a manual pick, not looked up from the address - the
// Regulator's postcode-to-zone table is only published as a PDF, not
// something this can reliably parse. Zone 3 covers the whole east coast
// from about Sydney to Brisbane/the Gold Coast (i.e. this business's own
// service area), so it's the sane default; only override it for a job
// genuinely outside that band.
const STC_ZONES = [
  { rating: 1.622, label: 'Zone 1 (far north QLD/NT/WA)' },
  { rating: 1.536, label: 'Zone 2' },
  { rating: 1.382, label: 'Zone 3 (most of the east coast - Sydney to Brisbane/Gold Coast)' },
  { rating: 1.185, label: 'Zone 4 (Tasmania, far south NSW/VIC coast)' },
];

function stcDeemingYears(installYear) {
  return Math.max(0, 2031 - (installYear || new Date().getFullYear()));
}

function calculateStcQuantity({ kw, zoneRating, installYear }) {
  const deemingYears = stcDeemingYears(installYear);
  if (!kw || !zoneRating || !deemingYears) return 0;
  return Math.floor(kw * zoneRating * deemingYears);
}

// Every field the contract needs that ISN'T already a profile fact -
// letter date, position, hours/days actually worked, and the few dollar
// figures the app's own banded overtime rates don't map onto directly.
// Shown as an actual form in the admin's contract generator, not left as
// raw [bracket] text to hand-edit.
const CONTRACT_ANSWER_FIELDS = [
  { key: 'letter_date', label: 'Letter date', type: 'date' },
  { key: 'position', label: 'Position / job title', type: 'text' },
  { key: 'location_of_work', label: 'Location of work', type: 'text' },
];

function contractHoursFields(employmentType) {
  if (employmentType === 'full_time') {
    return [
      { key: 'hours_days_count', label: 'Days worked per week (number)', type: 'text', placeholder: 'e.g. 5' },
      { key: 'hours_day_from', label: 'Spread of hours - from day', type: 'text', placeholder: 'e.g. Monday' },
      { key: 'hours_day_to', label: 'Spread of hours - to day', type: 'text', placeholder: 'e.g. Friday' },
    ];
  }
  if (employmentType === 'part_time') {
    return [
      { key: 'hours_per_week', label: 'Hours per week', type: 'text', placeholder: 'e.g. 25' },
      { key: 'hours_time_from', label: 'Spread of hours - from time', type: 'text', placeholder: 'e.g. 8:00am' },
      { key: 'hours_time_to', label: 'Spread of hours - to time', type: 'text', placeholder: 'e.g. 4:00pm' },
      { key: 'hours_day_from', label: 'Spread of hours - from day', type: 'text', placeholder: 'e.g. Tuesday' },
      { key: 'hours_day_to', label: 'Spread of hours - to day', type: 'text', placeholder: 'e.g. Thursday' },
    ];
  }
  // casual
  return [
    { key: 'hours_day_from', label: 'Rostered day range - from', type: 'text', placeholder: 'e.g. Monday' },
    { key: 'hours_day_to', label: 'Rostered day range - to', type: 'text', placeholder: 'e.g. Sunday' },
  ];
}

function contractPayFields(profile) {
  if (profile.pay_type === 'salary') {
    return profile.salary_includes_super
      ? [{ key: 'salary_super_component', label: 'Super component of annual salary ($)', type: 'number' }]
      : [];
  }
  return [
    { key: 'travel_allowance_per_day', label: 'Travel allowance ($/day, if required to work away)', type: 'number' },
  ];
}

function money2(n) { return (Number(n) || 0).toFixed(2); }

function buildRemunerationClause(profile, answers) {
  const rate = (n) => (n !== null && n !== undefined && n !== '') ? money2(n) : '[insert pay rate]';
  if (profile.employment_type === 'casual') {
    return `4. Remuneration
4.1 You will be paid an hourly rate of $${rate(profile.ordinary_rate)} (Hourly Rate).
4.2 The Hourly Rate is inclusive of an applicable casual loading amount of twenty-five (25) per cent of the Hourly Rate (Casual Loading Amount).
4.3 The Casual Loading Amount is to compensate you for not having one or more of the following entitlements: (a) paid annual leave; (b) paid personal / carer's leave; (c) paid compassionate leave; (d) payment for absence on a public holiday; (e) payment in lieu of notice of termination; and/or (f) redundancy pay.
4.4 Subject to the Terms, this is the total remuneration paid to you.
4.5 You may also be entitled to other payments, including: penalty rates, overtime, special rates and allowances (if applicable), in accordance with any applicable modern award.
4.6 The remuneration payable under these Terms (including any allowances) is intended to satisfy all entitlements to which you are or may become entitled in respect of the performance of work, under these Terms, any applicable modern award and/or the Fair Work Act 2009 (Cth) (Act).
4.7 The remuneration payable under these Terms (including any allowances) may be specifically set-off against, applied to and may otherwise absorb any existing or newly-introduced payments or benefits to which you are or may become entitled under these Terms, any applicable modern award and/or the Act, including but not limited to, minimum wage rates, overtime and penalty rates, annual leave and other loadings, weekend and other penalty rates, allowances and any other monetary entitlement which may otherwise be payable to you.`;
  }

  const isPartTime = profile.employment_type === 'part_time';
  let payClause;
  if (profile.pay_type === 'salary') {
    const total = Number(profile.annual_salary) || 0;
    if (profile.salary_includes_super) {
      const superPortion = Number(answers.salary_super_component) || 0;
      payClause = `4.1 $${money2(total)} per annum made up of superannuation contributions of $${money2(superPortion)} and the balance of $${money2(total - superPortion)} as cash payments (Annual Salary).`;
    } else {
      payClause = `4.1 You will be paid an annual base salary of $${money2(total)} (Annual Salary).`;
    }
    if (isPartTime) {
      payClause += `\n4.2 For the avoidance of doubt, you will be paid the appropriate pro-rata portion of the Annual Salary, according to the part-time hours that you work.`;
    }
  } else {
    payClause = `4.1 You will be paid an hourly rate of $${rate(profile.ordinary_rate)} (Ordinary Hourly Rate) for the first eight (8) hours worked on any day, Monday to Friday.
4.2 For the next two (2) hours worked on a weekday beyond the first eight (8) hours, you will be paid an hourly rate of $${rate(profile.rate_1_5x)} (Overtime Rate 1).
4.3 For any further hours worked on a weekday beyond that, you will be paid an hourly rate of $${rate(profile.rate_2x)} (Overtime Rate 2).
4.4 For work performed on a Saturday, you will be paid the Overtime Rate 1 for the first four (4) hours worked and the Overtime Rate 2 for any hours worked after that.
4.5 For work performed on a Sunday, you will be paid the Overtime Rate 2 for all hours worked.
4.6 For work performed on a public holiday, you will be paid an hourly rate of $${rate(profile.rate_2_5x)} (Public Holiday Rate) for all hours worked.
4.7 Where you are required to work away from your usual place of residence such that, in the Employer's reasonable opinion, it is not practicable for you to return home at the end of the working day, the Employer will arrange and pay for reasonable and suitable accommodation for the duration of the assignment. You will also be paid a travel allowance of $${rate(answers.travel_allowance_per_day)} per day, including for the purpose of covering meals while you are required to work away from home.
4.8 You may also be entitled to other payments, including: penalty rates, special rates, allowances and annual leave loading (if applicable) (Other Payments).
4.9 For the avoidance of doubt, Other Payments are calculated based on the rate that may apply to you specified in the applicable modern award (if any).`;
  }

  return `4. Remuneration
${payClause}
4.10 Subject to the Terms, this is the total remuneration paid to you.
4.11 The remuneration payable under these Terms (including any allowances) is intended to satisfy all entitlements to which you are or may become entitled in respect of the performance of work, under these Terms, any applicable modern award and/or the Fair Work Act 2009 (Cth) (Act).
4.12 The remuneration payable under these Terms (including any allowances) may be specifically set-off against, applied to and may otherwise absorb any existing or newly-introduced payments or benefits to which you are or may become entitled under these Terms, any applicable modern award and/or the Act, including but not limited to, minimum wage rates, overtime and penalty rates, annual leave and other loadings, weekend and other penalty rates, allowances and any other monetary entitlement which may otherwise be payable to you.`;
}

function buildSuperannuationClause(profile) {
  const standard = `5. Superannuation
In addition to your remuneration set out in clause 4, you will receive superannuation contributions in line with the minimum compulsory contribution rate required to be paid by the Employer, in accordance with applicable legislation.`;
  if (profile.pay_type !== 'salary') return standard;
  return profile.salary_includes_super
    ? `5. Superannuation
The superannuation contribution will be deducted from the Annual Salary. In the event that the amount of superannuation contribution required to be paid by law increases then the increased amount will be deducted from the Annual Salary.`
    : standard;
}

function buildTerminationClause(profile) {
  const isCasual = profile.employment_type === 'casual';
  const byYouClause = isCasual
    ? 'You may terminate your employment with the Employer at any time, effective at the end of your current engagement.'
    : "You may terminate your employment with the Employer by giving two (2) weeks' notice in writing to the Employer.";
  const byEmployerNoticeClause = isCasual
    ? 'Your employment may be terminated by the Employer at any time, effective at the end of your current engagement.'
    : `The Employer may terminate your employment with the Employer in accordance with the following table:
Employee's period of continuous service with the Employer on termination / Period
Not more than 1 year / 1 week
More than 1 year but not more than 3 years / 2 weeks
More than 3 years but not more than 5 years / 3 weeks
More than 5 years / 4 weeks
The period specified above will be increased by one (1) week if you are 45 years of age or over and have completed at least two (2) years of continuous service with the Employer.`;
  return `16. Termination of employment
16.1 Termination by You
${byYouClause}
16.2 Termination by the Employer upon giving notice
${byEmployerNoticeClause}
16.3 By the Employer without notice
The Employer may terminate your employment, effective immediately and without payment of any notice, where at any time, and provided always that procedural fairness has been followed, the Employer forms the view that you: (a) have committed any act of wilful or serious misconduct; (b) are in breach of any of the Terms; or (c) are continually or significantly neglectful of your Duties.`;
}

// Auto-fills the employment contract template's [bracket] placeholders
// and resolves every full-time/part-time/casual alternation - always an
// ADMIN-REVIEWED DRAFT, never shown to the employee directly. The
// Remuneration/Superannuation/Termination sections nest alternatives too
// deeply to safely auto-detect from the raw text, so those three are
// synthesized directly from explicit answers (buildRemunerationClause
// etc. above) rather than parsed out of the template - deterministic by
// construction instead of guessed from bracket position.
function generateContractDraft(profile, templateBody, answers = {}) {
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  const employmentLabel = { full_time: 'full-time', part_time: 'part-time', casual: 'casual' }[profile.employment_type] || '[full-time / part-time / casual]';

  const lines = templateBody.split('\n');
  const out = [];
  let mode = null; // null = no active alternation (always include); true/false = current selection
  for (const raw of lines) {
    const tag = raw.trim().toLowerCase();
    if (tag === '[for existing permanent part-time and full-time employees]') { mode = false; continue; }
    if (tag === '[for all new employees]') { mode = true; continue; }
    if (tag === '[for full-time employees]') { mode = profile.employment_type === 'full_time'; continue; }
    if (tag === '[for part-time employees]') { mode = profile.employment_type === 'part_time'; continue; }
    if (tag === '[for casual employees]') { mode = profile.employment_type === 'casual'; continue; }
    if (tag === '[for full-time and part-time employees]' || tag === '[for full-time or part-time employees]') { mode = profile.employment_type !== 'casual'; continue; }
    if (tag === '[end options]' || tag === '[end of options]') { mode = null; continue; }
    if (mode === false) continue;

    let line = raw;
    if (line.includes('[insert for Hourly Rate employees, otherwise delete]')) {
      if (profile.pay_type !== 'hourly') continue;
      line = line.replace('[insert for Hourly Rate employees, otherwise delete] ', '');
    }
    if (line.includes('[insert for Annual Salary Employees, otherwise delete]')) {
      if (profile.pay_type !== 'salary') continue;
      line = line.replace('[insert for Annual Salary Employees, otherwise delete] ', '');
    }
    out.push(line);
  }
  let body = out.join('\n');

  // Editorial instructions left in the template's own section headings
  // (e.g. "2. Period of Employment [Delete the options which are not
  // applicable]") - distinct from the data-driven [insert ...] placeholders
  // handled elsewhere in this function, these are just leftover authoring
  // notes meant to be deleted once the applicable option was chosen, and
  // were never actually stripped, so they survived into every generated
  // contract.
  body = body.replace(/\s*\[Delete[^\]]*\]/gi, '');

  // Whole-clause toggles: removed as contiguous ranges rather than
  // same-vs-alternative pairs, since the template marks them as a single
  // clause to delete-if-not-applicable, not a choice between two texts.
  if (!profile.has_company_vehicle) {
    body = body.replace(/7\. Fully Maintained Company Vehicle[\s\S]*?(?=\n8\. Apparel)/, '');
  }
  if (!profile.has_probationary_period) {
    body = body.replace(/2\.2 Probation[\s\S]*?(?=\n3\. Hours of Work)/, '');
  }

  // The three structurally-tangled sections get replaced wholesale with
  // freshly-synthesized text instead of edited in place.
  body = body.replace(/4\. Remuneration[\s\S]*?(?=\n5\. Superannuation)/, buildRemunerationClause(profile, answers) + '\n\n');
  body = body.replace(/5\. Superannuation[\s\S]*?(?=\n6\. Expenses)/, buildSuperannuationClause(profile) + '\n\n');
  body = body.replace(/16\. Termination of employment[\s\S]*?(?=\n17\. Fair Work Information Statement)/, buildTerminationClause(profile) + '\n\n');

  if (profile.employment_type === 'full_time') {
    body = body.replaceAll('[insert number of days]', answers.hours_days_count || '[insert number of days]');
    body = body.replaceAll('[insert day] to [insert day]', `${answers.hours_day_from || '[insert day]'} to ${answers.hours_day_to || '[insert day]'}`);
  } else if (profile.employment_type === 'part_time') {
    body = body.replaceAll('[insert amount] hours per week', `${answers.hours_per_week || '[insert amount]'} hours per week`);
    body = body.replaceAll('[insert time] and [insert time]', `${answers.hours_time_from || '[insert time]'} and ${answers.hours_time_to || '[insert time]'}`);
    body = body.replaceAll('[insert day] to [insert day]', `${answers.hours_day_from || '[insert day]'} to ${answers.hours_day_to || '[insert day]'}`);
  } else if (profile.employment_type === 'casual') {
    body = body.replaceAll('[insert day] to [insert day]', `${answers.hours_day_from || '[insert day]'} to ${answers.hours_day_to || '[insert day]'}`);
  }

  const employeeAddress = [profile.residential_address, profile.residential_suburb, profile.residential_state, profile.residential_postcode].filter(Boolean).join(', ') || '[insert employee address]';
  const position = answers.position || '[insert position]';
  const commencementDate = fmtDate(profile.employment_start_date);
  const letterDate = fmtDate(answers.letter_date);

  body = body
    .replaceAll('[insert Thomson Energy Australia Pty Ltd ACN 689 985 831 letterhead]', 'Thomson Energy Australia Pty Ltd\nACN 689 985 831')
    .replaceAll('[insert employee name]', profile.full_name || '[insert employee name]')
    .replaceAll('[insert employee]', profile.full_name || '[insert employee]')
    .replaceAll('[insert employee address]', employeeAddress)
    .replaceAll('[insert position]', position)
    .replaceAll('[full-time / part-time / casual]', employmentLabel)
    .replaceAll('[insert location of work]', answers.location_of_work || '[insert location of work]')
    .replaceAll('is [insert date] (Commencement Date)', commencementDate ? `is ${commencementDate} (Commencement Date)` : 'is [insert date] (Commencement Date)')
    .replace('[insert date]', letterDate || '[insert date]'); // the one remaining occurrence: the letter's own date, at the top

  return body;
}

// Turns a project's raw pylon_data (the attributes object pulled from
// Pylon's solar_designs API - see netlify/functions/pylon-sync.js) into a
// one-line plain-text hardware summary, e.g. "10.56kW system - 24x Longi
// LR5-54HTH 440W - 1x SolarEdge SE10000H - 1x Tesla Powerwall 2 13.5kWh".
// Pylon's API doesn't expose production/ROI figures at all, only hardware
// counts, so that's all this can ever show - the full interactive design
// and ROI calc still lives behind the Pylon link itself.
function pylonSystemSummary(pylonData) {
  if (!pylonData || typeof pylonData !== 'object') return '';
  const parts = [];
  if (pylonData.summary?.dc_output_kw) parts.push(`${pylonData.summary.dc_output_kw}kW system`);
  [...(pylonData.module_types || []), ...(pylonData.inverter_types || []), ...(pylonData.storage_types || [])]
    .forEach(item => { if (item?.description) parts.push(`${item.quantity || 1}x ${item.description}`); });
  return parts.join(' &middot; ');
}

// Kicks off a background extraction function and polls the resulting job
// row until it's done. Used for pricelist/statement extraction, which can
// genuinely run past a normal function's ~10s ceiling for a long document.
async function runBackgroundExtraction(jobType, functionName, file, mediaType) {
  const { data: { user } } = await supabaseClient.auth.getUser();
  const { data: job, error: jobErr } = await supabaseClient.from('ai_extraction_jobs').insert({
    job_type: jobType, status: 'pending', created_by: user.id,
  }).select('id').single();
  if (jobErr) throw jobErr;

  // Background Functions cap request payloads at 256KB - nowhere near
  // enough for a base64-encoded PDF, even a small one. Upload the file to
  // storage first and pass only the path (a short string), then the
  // background function downloads it itself server-side. This is also
  // what removes any real size ceiling on what can be uploaded at all.
  const filePath = await uploadPrivateFile(file, 'ai-extraction-uploads');

  const { data: { session } } = await supabaseClient.auth.getSession();

  let triggerRes;
  try {
    triggerRes = await fetch(`/.netlify/functions/${functionName}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ jobId: job.id, filePath, mediaType }),
    });
  } catch (networkErr) {
    throw new Error(`Couldn't reach the extraction service: ${networkErr.message}`);
  }

  if (triggerRes.status !== 202) {
    const text = await triggerRes.text().catch(() => '');
    throw new Error(`The extraction didn't start (status ${triggerRes.status}). ${text || 'Check the function is deployed.'}`);
  }

  const maxAttempts = 60; // ~3 minutes at 3s intervals - a genuinely stuck job should surface an error well before this
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const { data: row } = await supabaseClient.from('ai_extraction_jobs').select('*').eq('id', job.id).single();
    if (row?.status === 'complete') return row.result;
    if (row?.status === 'failed') throw new Error(row.error || 'Extraction failed');
  }
  throw new Error('This is taking longer than expected - try again shortly.');
}

// Markup for a search-existing-or-type-new supplier picker - shared by
// every "create a purchase order" panel (purchase-orders.html,
// project.html, stock.html, vehicle-stock.html) so picking/creating a
// supplier works identically everywhere a PO gets made. `ids` supplies
// this panel's own id prefix-free element ids (search/results/selected/
// newSection/newEmail/newPhone) so multiple pickers can coexist on one
// page without colliding.
function supplierPickerHtml(ids) {
  return `
    <input id="${ids.search}" placeholder="Search suppliers, or type a new one..." autocomplete="off" />
    <div id="${ids.results}"></div>
    <div id="${ids.selected}" class="subtitle" style="margin-top:4px;"></div>
    <div id="${ids.newSection}" style="display:none; margin-top:8px; padding:10px; background:var(--surface-2); border-radius:8px;">
      <p class="subtitle" style="margin:0 0 8px;">No match - this'll be created as a new supplier.</p>
      <div class="grid cols-2">
        <div><label style="margin-top:0">Contact email</label><input id="${ids.newEmail}" type="email" /></div>
        <div><label style="margin-top:0">Contact phone</label><input id="${ids.newPhone}" /></div>
      </div>
    </div>`;
}

// Wires the search/select/new-supplier behaviour for the markup above.
// Returns an async `resolveSupplier()` - call it once at save time; it
// creates the typed name as a real supplier row on first call if nothing
// was matched/selected, and returns { supplierId, supplierName } (both
// null if the field was left blank, e.g. a Warehouse-stock pull with no
// supplier at all).
function wireSupplierPicker(overlay, suppliers, ids) {
  let selectedSupplierId = null;
  const searchInput = overlay.querySelector(`#${ids.search}`);
  const resultsEl = overlay.querySelector(`#${ids.results}`);
  const selectedEl = overlay.querySelector(`#${ids.selected}`);
  const newSection = overlay.querySelector(`#${ids.newSection}`);
  let searchTimeout;

  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    selectedSupplierId = null;
    selectedEl.textContent = '';
    const q = e.target.value.trim();
    if (!q) { resultsEl.innerHTML = ''; newSection.style.display = 'none'; return; }
    searchTimeout = setTimeout(() => {
      const matches = (suppliers || []).filter(s => s.name.toLowerCase().includes(q.toLowerCase()));
      if (matches.length) {
        resultsEl.innerHTML = `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">
          ${matches.map(s => `<div class="supplier-pick-row" data-id="${s.id}" data-name="${s.name.replace(/"/g, '&quot;')}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${s.name}</div>`).join('')}
        </div>`;
        resultsEl.querySelectorAll('.supplier-pick-row').forEach(row => {
          row.addEventListener('click', () => {
            selectedSupplierId = row.dataset.id;
            searchInput.value = row.dataset.name;
            selectedEl.textContent = `Selected: ${row.dataset.name}`;
            newSection.style.display = 'none';
            resultsEl.innerHTML = '';
          });
        });
        newSection.style.display = 'none';
      } else {
        resultsEl.innerHTML = '';
        newSection.style.display = 'block';
      }
    }, 250);
  });

  return async function resolveSupplier() {
    if (selectedSupplierId) {
      return { supplierId: selectedSupplierId, supplierName: (suppliers.find(s => s.id === selectedSupplierId) || {}).name || searchInput.value.trim() };
    }
    const typedName = searchInput.value.trim();
    if (!typedName) return { supplierId: null, supplierName: null };
    const { data: newSupplier, error } = await supabaseClient.from('suppliers').insert({
      name: typedName,
      contact_email: (overlay.querySelector(`#${ids.newEmail}`)?.value || '').trim() || null,
      contact_phone: (overlay.querySelector(`#${ids.newPhone}`)?.value || '').trim() || null,
    }).select('id').single();
    if (error) throw error;
    return { supplierId: newSupplier.id, supplierName: typedName };
  };
}

// Shared searchable "add a prebuild to this stage" picker - was a plain
// <select> duplicated in project.html and new-project.html, unworkable
// once the ServiceM8 import brought the library up to 55+ entries. Caches
// the full prebuild list client-side (there's no volume here that needs
// server-side search like searchProjects()) and filters by name/category/
// subcategory as the user types. Calls the including page's own global
// `addLineItem(stageRow, {...})` - both pages already define one with the
// same signature.
// Multi-word "contains every word, any order" matcher for the stock/
// prebuild pickers below - a plain substring match fails on a search like
// "90mm downlight" against "90mm LED Downlight" (the words aren't
// contiguous - "LED" sits between them), which is exactly how staff
// actually type a search.
function matchesAllWords(haystack, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const h = (haystack || '').toLowerCase();
  return words.every(w => h.includes(w));
}

let _prebuildsCache = null;
async function getPrebuilds() {
  if (_prebuildsCache) return _prebuildsCache;
  const { data, error } = await supabaseClient.from('prebuilds').select('*, prebuild_components(*)').order('category').order('name');
  _prebuildsCache = error ? [] : data;
  return _prebuildsCache;
}

let _materialsCache = null;
async function getMaterials() {
  if (_materialsCache) return _materialsCache;
  const { data, error } = await supabaseClient.from('materials').select('id, name, category, cost_price, sell_price').order('name');
  _materialsCache = error ? [] : data;
  return _materialsCache;
}

// Shared "add material or prebuild to this stage" picker - searches Stock
// materials and the Prebuild library together so staff don't need to
// remember which one a given item lives in (e.g. "90mm downlight" matches
// both the material and the prebuild package). Picking a material adds one
// line item with its cost pulled straight from Stock; picking a prebuild
// keeps the existing explode-into-components behaviour. Calls the
// including page's own global `addLineItem(stageRow, {...})` - both
// project.html and new-project.html already define one with the same
// signature.
async function openStockPicker(stageRow) {
  const [materials, prebuilds] = await Promise.all([getMaterials(), getPrebuilds()]);
  if (!materials.length && !prebuilds.length) { alert('No materials or prebuilds set up yet. Add stock under the Stock tab or a prebuild under the Prebuilds tab.'); return; }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:480px; width:100%; max-height:80vh; overflow-y:auto;">
      <h2>Add material or prebuild</h2>
      <label style="margin-top:0">Quantity</label>
      <input id="stock-pick-qty" type="number" value="1" min="0.01" step="0.01" style="margin-bottom:12px;" />
      <label>Search</label>
      <input id="stock-pick-search" placeholder="Name, category..." autocomplete="off" />
      <div id="stock-pick-results" style="margin-top:8px;"></div>
      <div style="margin-top:16px; text-align:right;">
        <button type="button" class="secondary" id="stock-pick-cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#stock-pick-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const resultsEl = overlay.querySelector('#stock-pick-results');
  function renderResults() {
    const q = overlay.querySelector('#stock-pick-search').value.trim().toLowerCase();
    const prebuildMatches = (q
      ? prebuilds.filter(p => matchesAllWords(`${p.name} ${p.category} ${p.subcategory || ''}`, q))
      : prebuilds).slice(0, 25);
    const materialMatches = (q
      ? materials.filter(m => matchesAllWords(`${m.name} ${m.category || ''}`, q))
      : materials).slice(0, 25);
    if (!prebuildMatches.length && !materialMatches.length) { resultsEl.innerHTML = `<p class="subtitle">No matches.</p>`; return; }
    resultsEl.innerHTML = [
      ...prebuildMatches.map(p => `
        <div class="stock-pick-row" data-kind="prebuild" data-id="${p.id}" style="padding:10px; border-radius:8px; cursor:pointer; border-bottom:0.5px solid var(--border);">
          <div style="font-weight:600;">${p.name} <span class="subtitle" style="font-weight:400;">Prebuild</span></div>
          <div class="subtitle" style="font-size:12px;">${p.category}${p.subcategory ? ' / ' + p.subcategory : ''}</div>
        </div>`),
      ...materialMatches.map(m => `
        <div class="stock-pick-row" data-kind="material" data-id="${m.id}" style="padding:10px; border-radius:8px; cursor:pointer; border-bottom:0.5px solid var(--border);">
          <div style="font-weight:600;">${m.name} <span class="subtitle" style="font-weight:400;">Material - ${money(m.cost_price)}</span></div>
          <div class="subtitle" style="font-size:12px;">${m.category || ''}</div>
        </div>`),
    ].join('');
    resultsEl.querySelectorAll('.stock-pick-row').forEach(row => {
      row.addEventListener('click', () => {
        const qty = parseFloat(overlay.querySelector('#stock-pick-qty').value) || 1;
        if (row.dataset.kind === 'material') {
          const material = materials.find(m => m.id === row.dataset.id);
          addLineItem(stageRow, { description: material.name, item_type: 'material', quantity: qty, unit_cost: material.cost_price });
          overlay.remove();
          return;
        }
        const prebuild = prebuilds.find(p => p.id === row.dataset.id);
        // One group id shared by every component this click adds - lets the
        // client-facing quote collapse them back into a single line (the
        // prebuild's own client_description) while staff still see and can
        // edit each component individually here. A second "Add prebuild"
        // for the same prebuild gets its own group, so it collapses on its
        // own rather than merging with the first.
        const groupId = crypto.randomUUID();
        const clientDescription = prebuild.client_description || prebuild.name;
        const components = (prebuild.prebuild_components || []).map(comp => ({
          description: `${prebuild.name} - ${comp.description}`,
          item_type: comp.item_type,
          quantity: (parseFloat(comp.quantity) || 0) * qty,
          unit_cost: comp.unit_cost,
          // Un-multiplied - the group's own quantity control rescales from
          // this base rather than the qty typed into this picker, which
          // only sets the starting point.
          prebuild_base_quantity: parseFloat(comp.quantity) || 0,
        }));
        renderPrebuildGroup(stageRow, groupId, clientDescription, components);
        overlay.remove();
      });
    });
  }
  overlay.querySelector('#stock-pick-search').addEventListener('input', renderResults);
  renderResults();
}

// Renders one "prebuild instance" as a single collapsed control in a
// stage's line-item list: the prebuild's client-facing name, a running
// total, and ONE quantity field that rescales every underlying component
// together - added because rescaling used to mean editing every labour/
// material/markup component's own quantity by hand to keep them in
// proportion. "Components" expands to the individual rows underneath,
// still fully editable one at a time (each is a real addLineItem() row,
// just appended into this group's own container instead of straight into
// .li-rows). Used both for a freshly-added prebuild and for reconstructing
// a previously-saved group (see renderStageLineItems below) - the two
// cases differ only in whether `components` came from a prebuild's master
// template or from saved cost_centre_line_items rows.
function renderPrebuildGroup(stageRow, groupId, clientDescription, components) {
  const group = document.createElement('div');
  group.className = 'li-prebuild-group';
  group.dataset.groupId = groupId;
  group.style.cssText = 'margin-bottom:10px; border:0.5px solid var(--border); border-radius:8px; overflow:hidden;';

  // The group's own quantity isn't stored directly - it's derived from
  // any one component's own quantity / its recorded base quantity (see
  // prebuild_base_quantity). Falls back to 1 if a component predates that
  // column (old data) - the qty control still works from that point on,
  // it just can't know the true starting ratio for pre-existing rows.
  const first = components.find(c => parseFloat(c.prebuild_base_quantity) > 0);
  const initialGroupQty = first ? (parseFloat(first.quantity) / parseFloat(first.prebuild_base_quantity)) : 1;
  const qtyDisplay = Math.round(initialGroupQty * 100) / 100;

  group.innerHTML = `
    <div class="li-prebuild-header" style="display:grid; grid-template-columns:2fr 0.6fr 1fr auto; gap:8px; align-items:center; padding:10px; background:var(--surface-2);">
      <div>
        <input class="li-prebuild-desc" value="${clientDescription.replace(/"/g, '&quot;')}" style="font-size:13px; font-weight:600;" />
        <div class="subtitle" style="font-size:11px; margin-top:2px;">Prebuild - the client sees this one line, not the components below</div>
      </div>
      <input class="li-prebuild-qty" type="number" step="0.01" min="0.01" value="${qtyDisplay}" title="Quantity of this whole prebuild - rescales every component together" style="font-size:13px;" />
      <div class="li-prebuild-total" style="font-size:13px; font-weight:600;">$0.00</div>
      <div style="white-space:nowrap;">
        <button type="button" class="secondary li-prebuild-toggle" style="font-size:12px; padding:6px 10px;">Components &#9656;</button>
        <button type="button" class="secondary li-prebuild-remove" style="font-size:12px; padding:6px 10px;">Remove</button>
      </div>
    </div>
    <div class="li-prebuild-components" style="display:none; padding:10px 10px 4px 20px;">
      <div class="li-prebuild-rows"></div>
      <button type="button" class="secondary li-prebuild-add-component" style="font-size:12px; padding:6px 12px; margin-top:4px;">+ Add component</button>
    </div>`;
  stageRow.querySelector('.li-rows').appendChild(group);

  const componentsEl = group.querySelector('.li-prebuild-components');
  const rowsEl = group.querySelector('.li-prebuild-rows');
  components.forEach(comp => {
    addLineItem(stageRow, { ...comp, prebuild_group_id: groupId, prebuild_client_description: clientDescription }, rowsEl);
  });

  function recalcGroupTotal() {
    const total = [...rowsEl.querySelectorAll('.li-row')].reduce((s, li) =>
      s + (parseFloat(li.querySelector('.li-qty').value) || 0) * (parseFloat(li.querySelector('.li-cost').value) || 0), 0);
    group.querySelector('.li-prebuild-total').textContent = money(total);
  }

  group.querySelector('.li-prebuild-toggle').addEventListener('click', (e) => {
    const showing = componentsEl.style.display !== 'none';
    componentsEl.style.display = showing ? 'none' : 'block';
    e.target.innerHTML = showing ? 'Components &#9656;' : 'Components &#9662;';
  });

  group.querySelector('.li-prebuild-remove').addEventListener('click', () => {
    group.remove();
    updateStageTotals(stageRow);
  });

  group.querySelector('.li-prebuild-qty').addEventListener('input', (e) => {
    const newQty = parseFloat(e.target.value) || 0;
    [...rowsEl.querySelectorAll('.li-row')].forEach(li => {
      const base = parseFloat(li.dataset.prebuildBaseQuantity);
      if (!base) return; // no base recorded (predates this column) - edit that component's own qty directly instead
      li.querySelector('.li-qty').value = (base * newQty).toFixed(2);
    });
    updateStageTotals(stageRow);
    recalcGroupTotal();
  });

  // Editing the client-facing description here re-tags every current (and
  // future - see the add-component handler below) component with the new
  // text, since each component row carries its own copy of it rather than
  // there being one separate "group" record to update.
  group.querySelector('.li-prebuild-desc').addEventListener('input', (e) => {
    const newDesc = e.target.value;
    [...rowsEl.querySelectorAll('.li-row')].forEach(li => { li.dataset.prebuildClientDescription = newDesc; });
  });

  group.querySelector('.li-prebuild-add-component').addEventListener('click', () => {
    // A manually-added extra has no master quantity to rescale from, so it
    // sits outside the group's bulk quantity control - edited directly,
    // same as any component whose base predates this column.
    addLineItem(stageRow, { prebuild_group_id: groupId, prebuild_client_description: group.querySelector('.li-prebuild-desc').value }, rowsEl);
    recalcGroupTotal();
  });

  // Any edit/removal inside the component list (qty, cost, type, or the
  // per-row "x" remove button) should update the header's running total -
  // delegated here rather than threading a callback through addLineItem,
  // since e.target is still readable even after a remove-button's own
  // click handler has already detached its row.
  rowsEl.addEventListener('input', recalcGroupTotal);
  rowsEl.addEventListener('click', (e) => { if (e.target.classList.contains('li-remove')) recalcGroupTotal(); });

  recalcGroupTotal();
}

// Renders a stage's saved line items into its editor, collapsing any that
// share a prebuild_group_id back into one renderPrebuildGroup() control
// instead of showing every component as a flat row - so reopening a saved
// quote looks the same as when the prebuild was first added, not exploded
// back out. Replaces the old `lineItems.forEach(li => addLineItem(div, li))`
// in both project.html and new-project.html's addRow().
function renderStageLineItems(stageRow, lineItems) {
  if (!lineItems.length) { addLineItem(stageRow); return; }
  const rendered = new Set();
  lineItems.forEach(li => {
    if (rendered.has(li.id)) return;
    if (li.prebuild_group_id) {
      const groupMembers = lineItems.filter(m => m.prebuild_group_id === li.prebuild_group_id);
      groupMembers.forEach(m => rendered.add(m.id));
      renderPrebuildGroup(stageRow, li.prebuild_group_id, li.prebuild_client_description, groupMembers);
    } else {
      rendered.add(li.id);
      addLineItem(stageRow, li);
    }
  });
}

// Wires an "upload the supplier's invoice instead" button - reads the
// file, extracts supplier + line item detail, then hands off to
// resolveSupplierAndHandoff to match/create the supplier and continue on
// their page (which can create a new PO with real line items straight
// from the bill). Shared by every "create a PO" panel; `msgEl` shows
// read/error status inline in that panel while it works.
function wireUploadInvoiceButton(btnEl, msgEl) {
  btnEl.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      msgEl.innerHTML = `<p class="subtitle">Reading the invoice...</p>`;
      try {
        const fileBase64 = await fileToBase64(file);
        const { data: { session } } = await supabaseClient.auth.getSession();
        const res = await fetch('/.netlify/functions/extract-supplier-invoice', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify({ fileBase64, mediaType: file.type }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || 'Extraction failed');
        msgEl.innerHTML = '';
        await resolveSupplierAndHandoff(data.extracted, 'bill', data.extracted, file);
      } catch (err) {
        msgEl.innerHTML = `<div class="error-box">${err.message}</div>`;
      }
    };
    input.click();
  });
}

// Shared between the Suppliers page and the Stock page's "Upload
// pricelist" button - given a document's extracted supplier info, either
// confirms a match, lets the person pick manually, or creates a brand
// new supplier automatically, then hands off to that supplier's own page
// with the extraction already done (no re-uploading, no re-running AI).
async function resolveSupplierAndHandoff(extracted, uploadType, extractedPayload, file) {
  const matchFields = {
    name: extracted.supplier || extracted, // bills/statements pass the object, pricelist passes just the name string
    ourAccountNumber: extracted.our_account_number,
    abn: extracted.abn,
    bsb: extracted.bsb,
    bankAccountNumber: extracted.bank_account_number,
  };
  const extractedSupplierName = matchFields.name;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `<div class="card" style="max-width:420px; width:100%;"><p class="subtitle">Working out which supplier this is...</p></div>`;
  document.body.appendChild(overlay);

  const match = await findMatchingSupplier(matchFields);
  const fileBase64 = await fileToBase64(file);

  function proceedTo(supplierId) {
    sessionStorage.setItem('pending_upload', JSON.stringify({
      type: uploadType, extracted: extractedPayload, fileBase64, fileName: file.name, fileType: file.type,
    }));
    window.location.href = `/supplier-detail.html?id=${supplierId}&resume_upload=1`;
  }

  if (match) {
    overlay.querySelector('.card').innerHTML = `
      <h2>Is this ${match.name}?</h2>
      <p class="subtitle" style="margin-bottom:14px;">${matchFields.ourAccountNumber ? `Matched by account number ${matchFields.ourAccountNumber}.` : (matchFields.abn ? `Matched by ABN.` : `The document says "${extractedSupplierName}".`)}</p>
      <button id="rs-yes-btn">Yes, that's ${match.name}</button>
      <button type="button" class="secondary" id="rs-no-btn">No, pick a different supplier</button>`;
    overlay.querySelector('#rs-yes-btn').addEventListener('click', () => proceedTo(match.id));
    overlay.querySelector('#rs-no-btn').addEventListener('click', () => showManualPick());
  } else {
    showNewSupplierPrompt();
  }

  async function showManualPick() {
    const { data: suppliers } = await supabaseClient.from('suppliers').select('id, name').order('name');
    overlay.querySelector('.card').innerHTML = `
      <h2>Pick the supplier</h2>
      <select id="rs-manual-select"><option value="">-- Select --</option>${(suppliers || []).map(s => `<option value="${s.id}">${s.name}</option>`).join('')}</select>
      <p class="subtitle" style="margin:10px 0;">Or</p>
      <button type="button" class="secondary" id="rs-new-instead-btn">This is actually a new supplier</button>
      <div style="margin-top:14px;"><button id="rs-manual-continue-btn">Continue</button></div>`;
    overlay.querySelector('#rs-new-instead-btn').addEventListener('click', () => showNewSupplierPrompt());
    overlay.querySelector('#rs-manual-continue-btn').addEventListener('click', () => {
      const id = overlay.querySelector('#rs-manual-select').value;
      if (id) proceedTo(id);
    });
  }

  async function showNewSupplierPrompt() {
    overlay.querySelector('.card').innerHTML = `<h2>Creating supplier</h2><p class="subtitle">Setting up "${extractedSupplierName}" - you can add or adjust anything anytime from their page.</p>`;
    const { data: created, error } = await supabaseClient.from('suppliers').insert({
      name: extractedSupplierName || 'Unknown supplier',
      credit_terms_type: 'net_days',
      credit_terms_days: 30,
      our_account_number: matchFields.ourAccountNumber || null,
      abn: matchFields.abn || null,
      contact_phone: extracted.contact_phone || null,
      contact_email: extracted.contact_email || null,
      bank_account_name: extracted.bank_account_name || null,
      bsb: matchFields.bsb || null,
      bank_account_number: matchFields.bankAccountNumber || null,
      bpay_biller_code: extracted.bpay_biller_code || null,
      bpay_reference: extracted.bpay_reference || null,
    }).select('id').single();
    if (error) {
      overlay.querySelector('.card').innerHTML = `<h2>Couldn't create the supplier</h2><div class="error-box">${error.message}</div><button type="button" class="secondary" id="rs-new-err-close">Close</button>`;
      overlay.querySelector('#rs-new-err-close').addEventListener('click', () => overlay.remove());
      return;
    }
    proceedTo(created.id);
  }
}

// Shared across supplier, job, and vehicle PO views - each line item on
// a PO gets ticked off and sent wherever it actually needs to go, not
// just wherever the PO as a whole defaults to (buying materials for a
// job and a tool for the van in the same order needs two destinations).
function renderPoLineItemsReceivable(po, canEdit) {
  const items = po.purchase_order_line_items || [];
  return items.map(li => {
    if (li.received) {
      const destLabel = li.destination_type === 'job' ? 'Job' : li.destination_type === 'vehicle' ? 'Vehicle' : 'Warehouse';
      return `<div style="font-size:13px; display:flex; justify-content:space-between; align-items:center; padding:4px 0;">
        <span>${li.description} — ${li.quantity} × ${money(li.unit_cost)} = ${money(li.quantity * li.unit_cost)}</span>
        <span class="badge accepted" style="font-size:11px;">Received - ${destLabel}</span>
      </div>`;
    }
    const etaLabel = li.backorder_eta ? new Date(li.backorder_eta + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : null;
    return `<div style="font-size:13px; display:flex; justify-content:space-between; align-items:center; padding:4px 0; flex-wrap:wrap; gap:6px;">
      <span>${li.description} — ${li.quantity} × ${money(li.unit_cost)} = ${money(li.quantity * li.unit_cost)}
        ${li.is_backordered ? `<span class="badge draft" style="font-size:11px; margin-left:6px;">Backordered${etaLabel ? ' - ETA ' + etaLabel : ''}</span>` : ''}
      </span>
      ${canEdit ? `
        <span style="display:flex; gap:6px;">
          <button type="button" class="secondary receive-line-item-btn" data-line-id="${li.id}" style="font-size:11px; padding:4px 8px;">Receive</button>
          <button type="button" class="secondary backorder-line-item-btn" data-line-id="${li.id}" style="font-size:11px; padding:4px 8px;">${li.is_backordered ? 'Update backorder' : 'Mark backordered'}</button>
        </span>` : '<span class="subtitle" style="font-size:11px;">Not yet received</span>'}
    </div>`;
  }).join('');
}

// Wires up every ".receive-line-item-btn"/".backorder-line-item-btn"
// found in the container - call this after rendering a PO list that
// used renderPoLineItemsReceivable.
function wireReceiveLineItemButtons(containerEl, allPos, defaultDestinationFor, onComplete) {
  function findLineItem(lineId) {
    for (const po of allPos) {
      const found = (po.purchase_order_line_items || []).find(li => li.id === lineId);
      if (found) return { lineItem: found, parentPo: po };
    }
    return {};
  }
  containerEl.querySelectorAll('.receive-line-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { lineItem, parentPo } = findLineItem(btn.dataset.lineId);
      if (lineItem) openReceiveLineItemPanel(lineItem, parentPo, defaultDestinationFor(parentPo), onComplete);
    });
  });
  containerEl.querySelectorAll('.backorder-line-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const { lineItem } = findLineItem(btn.dataset.lineId);
      if (lineItem) openBackorderPanel(lineItem, onComplete);
    });
  });
}

// Marks a not-yet-received line item as backordered with an expected
// date - a separate status from "received", for when a supplier says an
// item's delayed rather than it having actually arrived.
function openBackorderPanel(lineItem, onComplete) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:360px; width:100%;">
      <h2>Backorder</h2>
      <p class="subtitle" style="margin-bottom:10px;">${lineItem.description} x${lineItem.quantity}</p>
      <label style="margin-top:0">Expected date</label>
      <input type="date" id="bo-eta" value="${lineItem.backorder_eta || ''}" />
      <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap;">
        <button id="bo-save-btn">Save</button>
        ${lineItem.is_backordered ? '<button type="button" class="secondary" id="bo-clear-btn">No longer backordered</button>' : ''}
        <button type="button" class="secondary" id="bo-cancel-btn">Cancel</button>
      </div>
      <div id="bo-msg"></div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector('#bo-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#bo-save-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#bo-msg');
    const { error } = await supabaseClient.from('purchase_order_line_items')
      .update({ is_backordered: true, backorder_eta: overlay.querySelector('#bo-eta').value || null })
      .eq('id', lineItem.id);
    if (error) { msg.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
    overlay.remove();
    await onComplete();
  });
  const clearBtn = overlay.querySelector('#bo-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const msg = overlay.querySelector('#bo-msg');
      const { error } = await supabaseClient.from('purchase_order_line_items')
        .update({ is_backordered: false, backorder_eta: null })
        .eq('id', lineItem.id);
      if (error) { msg.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
      overlay.remove();
      await onComplete();
    });
  }
}

async function openReceiveLineItemPanel(lineItem, po, defaultDestination, onComplete) {
  const sourceIsWarehouse = !!po.vehicle_id && !po.supplier_id; // pulled from the shed, not a new purchase
  const { data: vehicles } = await supabaseClient.from('fleet_vehicles').select('id, vehicle_name, rego').eq('holds_stock', true).order('vehicle_name');

  let defaultJobName = null;
  if (po.project_id) {
    const { data: proj } = await supabaseClient.from('projects').select('name, job_number').eq('id', po.project_id).maybeSingle();
    defaultJobName = proj ? (proj.job_number ? `J${proj.job_number}` : proj.name) : null;
  }

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:420px; width:100%; max-height:85vh; overflow-y:auto;">
      <h2>Receive item</h2>
      <p class="subtitle" style="margin-bottom:10px;">${lineItem.description} x${lineItem.quantity}</p>
      <label style="margin-top:0">Send to</label>
      <select id="rl-dest-type">
        <option value="warehouse" ${defaultDestination === 'warehouse' ? 'selected' : ''}>Warehouse</option>
        <option value="job" ${defaultDestination === 'job' ? 'selected' : ''}>A job</option>
        ${vehicles?.length ? `<option value="vehicle" ${defaultDestination === 'vehicle' ? 'selected' : ''}>A vehicle</option>` : ''}
      </select>
      <div id="rl-job-section" style="display:none; margin-top:8px;">
        <input id="rl-job-search" placeholder="Search for the job..." autocomplete="off" />
        <div id="rl-job-results"></div>
        <div id="rl-job-selected" class="subtitle" style="margin-top:4px;"></div>
      </div>
      <div id="rl-vehicle-section" style="display:none; margin-top:8px;">
        <select id="rl-vehicle-select">${(vehicles || []).map(v => `<option value="${v.id}" ${v.id === po.vehicle_id ? 'selected' : ''}>${v.vehicle_name || v.rego}</option>`).join('')}</select>
      </div>
      <div style="margin-top:14px;">
        <button id="rl-confirm-btn">Confirm received</button>
        <button type="button" class="secondary" id="rl-cancel-btn">Cancel</button>
      </div>
      <div id="rl-msg"></div>
    </div>`;
  document.body.appendChild(overlay);

  function syncSections() {
    const val = overlay.querySelector('#rl-dest-type').value;
    overlay.querySelector('#rl-job-section').style.display = val === 'job' ? 'block' : 'none';
    overlay.querySelector('#rl-vehicle-section').style.display = val === 'vehicle' ? 'block' : 'none';
  }
  overlay.querySelector('#rl-dest-type').addEventListener('change', syncSections);
  syncSections();

  let selectedJob = po.project_id ? { id: po.project_id, name: defaultJobName } : null;
  const jobSearchInput = overlay.querySelector('#rl-job-search');
  if (po.project_id) {
    overlay.querySelector('#rl-job-selected').textContent = defaultJobName ? `This PO's own job: ${defaultJobName}` : 'This PO\'s own job (default)';
  }
  let jobSearchTimeout;
  jobSearchInput.addEventListener('input', (e) => {
    clearTimeout(jobSearchTimeout);
    selectedJob = null;
    const q = e.target.value.trim();
    if (q.length < 2) { overlay.querySelector('#rl-job-results').innerHTML = ''; return; }
    jobSearchTimeout = setTimeout(async () => {
      const results = await searchProjects(q);
      const resultsEl = overlay.querySelector('#rl-job-results');
      resultsEl.innerHTML = `<div style="border:1px solid var(--border); border-radius:8px; margin-top:6px;">
        ${results.map(p => `<div class="rl-job-pick" data-id="${p.id}" data-name="${p.name}" data-job-number="${p.job_number || ''}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid var(--border);">${projectRef(p)}</div>`).join('')}
      </div>`;
      resultsEl.querySelectorAll('.rl-job-pick').forEach(row => {
        row.addEventListener('click', () => {
          selectedJob = { id: row.dataset.id, name: row.dataset.jobNumber ? `J${row.dataset.jobNumber}` : row.dataset.name };
          jobSearchInput.value = row.dataset.name;
          overlay.querySelector('#rl-job-selected').textContent = `Selected: ${row.dataset.name}`;
          resultsEl.innerHTML = '';
        });
      });
    }, 250);
  });

  overlay.querySelector('#rl-cancel-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#rl-confirm-btn').addEventListener('click', async () => {
    const msg = overlay.querySelector('#rl-msg');
    const destType = overlay.querySelector('#rl-dest-type').value;
    if (destType === 'job' && !selectedJob) { msg.innerHTML = `<div class="error-box">Search for and select a job.</div>`; return; }
    const vehicleId = destType === 'vehicle' ? overlay.querySelector('#rl-vehicle-select').value : null;

    try {
      const { data: { user } } = await supabaseClient.auth.getUser();

      if (destType === 'warehouse') {
        // If this PO itself was a vehicle-pull-from-stock (no supplier),
        // the warehouse quantity was already the source, not the
        // destination - this path only ever ADDS to warehouse.
        const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', lineItem.material_id).eq('location_type', 'warehouse').maybeSingle();
        if (whRow) {
          await supabaseClient.from('material_stock_by_location').update({ quantity: Number(whRow.quantity) + Number(lineItem.quantity), updated_at: new Date().toISOString() }).eq('id', whRow.id);
        } else {
          await supabaseClient.from('material_stock_by_location').insert({ material_id: lineItem.material_id, location_type: 'warehouse', quantity: lineItem.quantity });
        }
      } else if (destType === 'job') {
        await supabaseClient.from('job_material_usage').insert({
          project_id: selectedJob.id, cost_centre_id: po.cost_centre_id || null, material_id: lineItem.material_id,
          quantity: lineItem.quantity, unit_cost: lineItem.unit_cost, source: 'from_po', po_line_item_id: lineItem.id, created_by: user.id,
        });
      } else if (destType === 'vehicle') {
        if (sourceIsWarehouse) {
          const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', lineItem.material_id).eq('location_type', 'warehouse').maybeSingle();
          const warehouseQty = Number(whRow?.quantity) || 0;
          if (lineItem.quantity > warehouseQty) throw new Error(`Only ${warehouseQty} available in the Warehouse.`);
          if (whRow) {
            await supabaseClient.from('material_stock_by_location').update({ quantity: warehouseQty - lineItem.quantity, updated_at: new Date().toISOString() }).eq('id', whRow.id);
          }
        }
        const { data: vehRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', lineItem.material_id).eq('location_type', 'vehicle').eq('vehicle_id', vehicleId).maybeSingle();
        if (vehRow) {
          await supabaseClient.from('material_stock_by_location').update({ quantity: Number(vehRow.quantity) + Number(lineItem.quantity), updated_at: new Date().toISOString() }).eq('id', vehRow.id);
        } else {
          await supabaseClient.from('material_stock_by_location').insert({ material_id: lineItem.material_id, location_type: 'vehicle', vehicle_id: vehicleId, quantity: lineItem.quantity });
        }
      }

      await supabaseClient.from('purchase_order_line_items').update({
        received: true, destination_type: destType,
        destination_job_id: destType === 'job' ? selectedJob.id : null,
        destination_vehicle_id: destType === 'vehicle' ? vehicleId : null,
        received_by: user.id, received_at: new Date().toISOString(),
      }).eq('id', lineItem.id);

      const destLabel = destType === 'job' ? (selectedJob.name || 'a job') : destType === 'vehicle' ? (vehicles.find(v => v.id === vehicleId)?.vehicle_name || vehicles.find(v => v.id === vehicleId)?.rego || 'a vehicle') : 'Warehouse';
      await logActivity('purchase_order', po.id, 'item_received', `${lineItem.description} x${lineItem.quantity} received - sent to ${destLabel}`);
      if (destType === 'job') {
        await logActivity('project', selectedJob.id, 'material_received', `${lineItem.description} x${lineItem.quantity} received from PO ${po.po_number || ''}, costed to this job`);
      }

      // If every line item on this PO is now received, mark the PO
      // itself received and approve any linked bill for payment.
      const { data: allItems } = await supabaseClient.from('purchase_order_line_items').select('received').eq('po_id', po.id);
      if ((allItems || []).every(li => li.received)) {
        await supabaseClient.from('purchase_orders').update({
          received: true, received_by: user.id, received_at: new Date().toISOString(),
        }).eq('id', po.id);
        await supabaseClient.from('supplier_bills').update({ approved_for_payment: true }).eq('po_id', po.id);
        await logActivity('purchase_order', po.id, 'fully_received', `PO ${po.po_number || ''} fully received - any linked bill approved for payment`);
      }

      overlay.remove();
      if (onComplete) await onComplete();
    } catch (err) {
      msg.innerHTML = `<div class="error-box">${err.message}</div>`;
    }
  });
}

// Draws the next sequential PO number (e.g. "PO2001") - same atomic
// counter pattern already used for quotes/jobs/invoices, so two people
// creating a PO at the same moment never collide.
async function drawNextPoNumber() {
  const { data: settings } = await supabaseClient.from('company_settings').select('po_number_prefix').eq('id', 1).single();
  const prefix = settings?.po_number_prefix || 'PO';
  const { data: nextNum, error } = await supabaseClient.rpc('get_next_number', { counter_name: 'po' });
  if (error) throw error;
  return `${prefix}${nextNum}`;
}

// Upload a photo/file of a supplier invoice straight against a specific
// PO - lets staff scan it while still standing at the wholesaler, rather
// than typing every line item by hand later. The supplier is already
// known from the PO, so this skips straight to the review screen on
// that supplier's page instead of asking which supplier it's for.
function uploadInvoiceForPo(po) {
  if (!po.supplier_id) {
    alert("This PO has no supplier attached - it was pulled from Warehouse stock, so there's no invoice to upload.");
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.pdf,.jpg,.jpeg,.png';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:100; padding:16px;';
    overlay.innerHTML = `<div class="card" style="max-width:400px; width:100%;"><p class="subtitle">Reading the invoice...</p></div>`;
    document.body.appendChild(overlay);

    try {
      const fileBase64 = await fileToBase64(file);
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/extract-supplier-invoice', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ fileBase64, mediaType: file.type }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Extraction failed');

      sessionStorage.setItem('pending_upload', JSON.stringify({
        type: 'bill', extracted: data.extracted, fileBase64, fileName: file.name, fileType: file.type, preselectedPoId: po.id,
      }));
      window.location.href = `/supplier-detail.html?id=${po.supplier_id}&resume_upload=1`;
    } catch (err) {
      overlay.querySelector('.card').innerHTML = `<h2>Couldn't read that invoice</h2><div class="error-box">${err.message}</div><button type="button" class="secondary" id="uip-close">Close</button>`;
      overlay.querySelector('#uip-close').addEventListener('click', () => overlay.remove());
    }
  };
  input.click();
}

// Shared searchable material picker for PO line items - replaces a plain
// dropdown (unworkable with a large materials list) with type-ahead
// search, while still allowing a free-text item that isn't in Stock at
// all yet (e.g. a one-off "10A power point") rather than forcing a full
// Stock record to be created just to order something. Also matches
// against the Prebuild library (e.g. searching "90mm downlight" surfaces
// both the material and the prebuild package) - picking a prebuild result
// doesn't fill this one row (a prebuild is several materials, not one), it
// removes this row and adds one new row per material component instead,
// so a whole prebuild's worth of stock can be ordered in one click.
function buildMaterialSearchRow(materials, containerId) {
  const row = document.createElement('div');
  row.className = 'po-material-line';
  row.style.cssText = 'display:grid; grid-template-columns:2fr 1fr 1fr auto; gap:6px; margin-bottom:6px; position:relative;';
  row.innerHTML = `
    <div style="position:relative;">
      <input class="po-line-search" placeholder="Search Stock or type a new item..." autocomplete="off" style="font-size:13px;" />
      <input type="hidden" class="po-line-material-id" />
      <div class="po-line-results" style="position:absolute; top:100%; left:0; right:0; z-index:10; background:var(--surface-2); border:1px solid var(--border); border-radius:8px; display:none;"></div>
    </div>
    <input class="po-line-qty" type="number" step="1" value="1" placeholder="Qty" style="font-size:13px;" />
    <input class="po-line-cost" type="number" step="0.01" value="0" placeholder="Unit cost" style="font-size:13px;" />
    <button type="button" class="secondary po-remove-line" style="padding:6px 10px; font-size:12px;">&times;</button>`;
  document.getElementById(containerId).appendChild(row);

  const searchInput = row.querySelector('.po-line-search');
  const resultsEl = row.querySelector('.po-line-results');
  const materialIdInput = row.querySelector('.po-line-material-id');

  searchInput.addEventListener('input', async (e) => {
    materialIdInput.value = ''; // typing again means whatever was selected no longer applies
    const q = e.target.value.trim().toLowerCase();
    if (q.length < 2) { resultsEl.style.display = 'none'; return; }
    const prebuilds = await getPrebuilds();
    const prebuildMatches = prebuilds.filter(p => matchesAllWords(`${p.name} ${p.category}`, q)).slice(0, 5);
    const materialMatches = materials.filter(m => matchesAllWords(m.name, q)).slice(0, 8);
    if (!prebuildMatches.length && !materialMatches.length) { resultsEl.style.display = 'none'; return; }
    resultsEl.innerHTML = [
      ...prebuildMatches.map(p => `<div class="po-line-pick" data-kind="prebuild" data-id="${p.id}" style="padding:8px 10px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);">${p.name} <span class="subtitle">(Prebuild - adds each material)</span></div>`),
      ...materialMatches.map(m => `<div class="po-line-pick" data-kind="material" data-id="${m.id}" data-name="${m.name}" data-cost="${m.cost_price}" style="padding:8px 10px; cursor:pointer; font-size:13px; border-bottom:1px solid var(--border);">${m.name} <span class="subtitle">(${money(m.cost_price)})</span></div>`),
    ].join('');
    resultsEl.style.display = 'block';
    resultsEl.querySelectorAll('.po-line-pick').forEach(pick => {
      pick.addEventListener('click', () => {
        if (pick.dataset.kind === 'prebuild') {
          const prebuild = prebuilds.find(p => p.id === pick.dataset.id);
          row.remove();
          (prebuild.prebuild_components || []).filter(c => c.item_type === 'material').forEach(comp => {
            const newRow = buildMaterialSearchRow(materials, containerId);
            newRow.querySelector('.po-line-search').value = `${prebuild.name} - ${comp.description}`;
            newRow.querySelector('.po-line-qty').value = parseFloat(comp.quantity) || 1;
            newRow.querySelector('.po-line-cost').value = comp.unit_cost;
          });
          return;
        }
        searchInput.value = pick.dataset.name;
        materialIdInput.value = pick.dataset.id;
        row.querySelector('.po-line-cost').value = pick.dataset.cost;
        resultsEl.style.display = 'none';
      });
    });
  });
  searchInput.addEventListener('blur', () => setTimeout(() => { resultsEl.style.display = 'none'; }, 200));

  row.querySelector('.po-remove-line').addEventListener('click', () => row.remove());
  return row;
}

// Reads every .po-material-line row inside a container into plain line
// item objects - materialId is null for a free-text item not in Stock.
function readMaterialLineRows(containerId) {
  return [...document.querySelectorAll(`#${containerId} .po-material-line`)].map(row => ({
    materialId: row.querySelector('.po-line-material-id').value || null,
    description: row.querySelector('.po-line-search').value.trim(),
    quantity: parseFloat(row.querySelector('.po-line-qty').value) || 0,
    unit_cost: parseFloat(row.querySelector('.po-line-cost').value) || 0,
  })).filter(l => l.description && l.quantity > 0);
}

// Universal activity log - one shared table for every entity type. Call
// logActivity() from anywhere something gets created, changed, or
// approved; call renderActivityLog() to show a "Log" section on any
// detail page, filtered to that one record.
async function logActivity(entityType, entityId, action, description) {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    await supabaseClient.from('activity_log').insert({
      entity_type: entityType, entity_id: entityId, action, description, changed_by: user?.id || null,
    });
  } catch (err) {
    console.error('Activity log write failed:', err); // never block the real action over a logging failure
  }
}

// Logs meaningful per-stage differences after a quote/job save - stages
// added, removed, renamed, or re-priced. Was previously never called at
// all, so saving a quote/job's stage editor left no trace in its own
// Activity tab even though PO/invoice/task activity on the same project
// showed up fine. Shared by both save paths in project.html (quote:
// delete-and-reinsert; job: update-in-place) - takes the same
// `stagesPayload` shape either way, and `existingCentres` is just
// whatever project.cost_centres held before the save. Doesn't log every
// line-item edit individually (would be noisy) since a line-item change
// almost always shows up here anyway as a price change on its stage.
async function logStageChanges(projectId, existingCentres, stagesPayload) {
  const keptIds = stagesPayload.map(s => s.id).filter(Boolean);
  const entries = [];
  stagesPayload.forEach(s => {
    if (!s.id) {
      entries.push(`Stage "${s.name}" added (${money(s.quoted_amount)})`);
      return;
    }
    const original = existingCentres.find(c => c.id === s.id);
    if (!original) return;
    if ((original.name || '') !== s.name) {
      entries.push(`Stage renamed from "${original.name}" to "${s.name}"`);
    }
    const oldAmount = Number(original.quoted_amount) || 0;
    if (Math.abs(s.quoted_amount - oldAmount) >= 0.01) {
      entries.push(`Stage "${s.name}" price changed from ${money(oldAmount)} to ${money(s.quoted_amount)}`);
    }
  });
  existingCentres.filter(c => !keptIds.includes(c.id)).forEach(c => {
    entries.push(`Stage "${c.name}" removed (was ${money(Number(c.quoted_amount) || 0)})`);
  });
  for (const description of entries) {
    await logActivity('project', projectId, 'stage_updated', description);
  }
}

// Every job-linked purchase order gets a matching follow-up task
// automatically, so a delivery doesn't quietly fall through the cracks -
// left unassigned, so whoever's watching the job can pick it up. Only
// called where a PO is being newly ordered against a real job (never for
// a stock/vehicle PO with no project, or one created after the fact from
// an already-reconciled supplier bill - there's nothing to "follow up"
// on there).
async function createPoFollowUpTask(projectId, poNumber, supplierName) {
  if (!projectId) return;
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    await supabaseClient.from('job_tasks').insert({
      project_id: projectId,
      description: `Follow up PO${poNumber ? ' ' + poNumber : ''} with ${supplierName || 'the supplier'}`,
      created_by: user?.id || null,
    });
  } catch (err) {
    console.error('PO follow-up task creation failed:', err); // never block the PO creation over this
  }
}

async function renderActivityLog(entityType, entityId, containerId) {
  const containerEl = document.getElementById(containerId);
  if (!containerEl) return;
  containerEl.innerHTML = `<p class="subtitle">Loading...</p>`;

  const { data: entries, error } = await supabaseClient
    .from('activity_log')
    .select('*, profiles(full_name)')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false });

  if (error) { containerEl.innerHTML = `<div class="error-box">${error.message}</div>`; return; }
  if (!entries.length) { containerEl.innerHTML = `<p class="subtitle">No activity logged yet.</p>`; return; }

  containerEl.innerHTML = entries.map(e => `
    <div style="display:flex; justify-content:space-between; gap:12px; padding:8px 0; border-bottom:1px solid var(--border); font-size:13px;">
      <span>${e.description}</span>
      <span class="subtitle" style="white-space:nowrap;">${e.profiles?.full_name || 'Someone'} - ${new Date(e.created_at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
    </div>`).join('');
}

// Shared safety check before deleting a quote/job - blocks (rather than
// just warns) if real activity already exists against it, since an
// invoice, PO, or logged time represents something that actually
// happened and shouldn't just disappear via a bulk delete.
async function checkProjectHasActivity(project) {
  const reasons = [];
  const invoiced = (project.cost_centres || []).reduce((s, c) => s + (Number(c.invoiced_amount) || 0), 0);
  if (invoiced > 0) reasons.push(`has ${money(invoiced)} invoiced`);

  const { count: poCount } = await supabaseClient.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('project_id', project.id);
  if (poCount > 0) reasons.push(`has ${poCount} purchase order${poCount === 1 ? '' : 's'}`);

  const { count: timeCount } = await supabaseClient.from('time_entries').select('id', { count: 'exact', head: true }).eq('project_id', project.id);
  if (timeCount > 0) reasons.push(`has ${timeCount} logged time ${timeCount === 1 ? 'entry' : 'entries'}`);

  return reasons;
}

// Same idea as checkProjectHasActivity, but scoped to one stage - used
// when a job's edit removes a stage that used to exist, so only the
// specific stage being removed gets blocked, not the whole save.
async function checkCostCentreHasActivity(costCentre) {
  const reasons = [];
  const invoiced = Number(costCentre.invoiced_amount) || 0;
  if (invoiced > 0) reasons.push(`has ${money(invoiced)} invoiced`);

  const { count: poCount } = await supabaseClient.from('purchase_orders').select('id', { count: 'exact', head: true }).eq('cost_centre_id', costCentre.id);
  if (poCount > 0) reasons.push(`has ${poCount} purchase order${poCount === 1 ? '' : 's'}`);

  const [{ count: directTimeCount }, { count: splitTimeCount }] = await Promise.all([
    supabaseClient.from('time_entries').select('id', { count: 'exact', head: true }).eq('cost_centre_id', costCentre.id),
    supabaseClient.from('time_entries').select('id', { count: 'exact', head: true }).contains('selected_cost_centre_ids', [costCentre.id]),
  ]);
  const timeCount = (directTimeCount || 0) + (splitTimeCount || 0);
  if (timeCount > 0) reasons.push(`has ${timeCount} logged time ${timeCount === 1 ? 'entry' : 'entries'}`);

  return reasons;
}

// Deletes a project after the caller has already run the activity
// check (or, in dev mode, deliberately chosen to delete it anyway).
// Cascade behavior on several of these foreign keys isn't something I
// can verify locally (some of these tables predate the migration files
// I have visibility into), so this explicitly cleans up every
// dependent record in the correct order rather than assuming the
// database will do it - invoices/purchase orders first (since old-style
// invoices can reference a cost_centre directly), then the cost
// centres themselves, then the project.
async function deleteProject(projectId) {
  const { data: centres } = await supabaseClient.from('cost_centres').select('id').eq('project_id', projectId);
  const centreIds = (centres || []).map(c => c.id);

  const { data: invoices } = await supabaseClient.from('invoices').select('id').eq('project_id', projectId);
  const invoiceIds = (invoices || []).map(i => i.id);
  if (invoiceIds.length) {
    await supabaseClient.from('invoice_claims').delete().in('invoice_id', invoiceIds);
    await supabaseClient.from('invoices').delete().in('id', invoiceIds);
  }

  const { data: pos } = await supabaseClient.from('purchase_orders').select('id').eq('project_id', projectId);
  const poIds = (pos || []).map(po => po.id);
  if (poIds.length) {
    await supabaseClient.from('purchase_order_line_items').delete().in('po_id', poIds);
    await supabaseClient.from('purchase_orders').delete().in('id', poIds);
  }

  if (centreIds.length) {
    await supabaseClient.from('cost_centre_line_items').delete().in('cost_centre_id', centreIds);
    await supabaseClient.from('cost_centre_photo_groups').delete().in('cost_centre_id', centreIds);
    await supabaseClient.from('cost_centres').delete().in('id', centreIds);
  }

  const { error } = await supabaseClient.from('projects').delete().eq('id', projectId);
  if (error) throw error;
}

// The two correct ways to change a material's Warehouse stock - used
// everywhere Warehouse quantity changes, so material_stock_by_location
// (and the trigger-maintained materials.quantity_on_hand total) never
// drifts out of sync the way direct writes to quantity_on_hand did.

// Adds (or subtracts, if negative) a quantity - for bills arriving,
// materials being drawn for a job, etc. Never goes below zero.
async function adjustWarehouseStock(materialId, quantityDelta) {
  const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('*').eq('material_id', materialId).eq('location_type', 'warehouse').maybeSingle();
  if (whRow) {
    await supabaseClient.from('material_stock_by_location').update({
      quantity: Math.max(0, Number(whRow.quantity) + quantityDelta), updated_at: new Date().toISOString(),
    }).eq('id', whRow.id);
  } else {
    await supabaseClient.from('material_stock_by_location').insert({
      material_id: materialId, location_type: 'warehouse', quantity: Math.max(0, quantityDelta),
    });
  }
}

// Sets Warehouse quantity to an exact value - for manual admin edits
// where the person is stating "we have X of these", not adding to
// whatever's already recorded.
async function setWarehouseStock(materialId, absoluteQuantity) {
  const { data: whRow } = await supabaseClient.from('material_stock_by_location').select('id').eq('material_id', materialId).eq('location_type', 'warehouse').maybeSingle();
  if (whRow) {
    await supabaseClient.from('material_stock_by_location').update({
      quantity: Math.max(0, absoluteQuantity), updated_at: new Date().toISOString(),
    }).eq('id', whRow.id);
  } else {
    await supabaseClient.from('material_stock_by_location').insert({
      material_id: materialId, location_type: 'warehouse', quantity: Math.max(0, absoluteQuantity),
    });
  }
}

// Consistent number-first formatting for jobs and quotes, used
// everywhere a project gets referenced - a job number always wins once
// one exists (an approved job), falling back to the quote number
// before it's approved, matching the same numbering-over-naming
// convention already used for POs (PO2000) and invoices (SI3000).
function projectRef(project) {
  if (!project) return '';
  if (project.job_number) return `J${project.job_number} - ${project.name}`;
  if (project.quote_number) return `Q${project.quote_number} - ${project.name}`;
  return project.name || '';
}

// Just the number+prefix on its own, no name - for compact contexts
// like table columns where the name already has its own column.
function projectNumberOnly(project) {
  if (!project) return '-';
  if (project.job_number) return `J${project.job_number}`;
  if (project.quote_number) return `Q${project.quote_number}`;
  return '-';
}

// Resolves one invoice row into a flat list of per-stage claims - mirrors
// invoice_claims when present (a multi-stage claim), else synthesizes one
// claim from the invoice's own totals for a legacy single-stage invoice
// (cost_centre_id set directly, no invoice_claims rows). Needs the invoice
// fetched with both invoice_claims(*, cost_centres(name, sort_order)) and
// cost_centres(name) embedded - nothing else is looked up externally, so
// this works the same wherever an invoice is fetched from.
function invoiceClaimRows(invoice) {
  if (invoice.invoice_claims && invoice.invoice_claims.length) {
    return invoice.invoice_claims.slice()
      .sort((a, b) => (a.cost_centres?.sort_order || 0) - (b.cost_centres?.sort_order || 0))
      .map(ic => ({ stageName: ic.cost_centres?.name || 'Stage', labour_amount: ic.labour_amount, material_amount: ic.material_amount, stc_amount: ic.stc_amount }));
  }
  return [{
    stageName: invoice.cost_centres?.name || invoice.description || 'Invoice',
    labour_amount: invoice.labour_amount, material_amount: invoice.material_amount, stc_amount: invoice.stc_amount,
  }];
}

// Groups an invoice's claims by Xero category (Labour/Materials/STC
// credit) instead of by stage - this is how Xero actually receives it
// (push-invoice-to-xero.js sends one line per stage per category), and
// how it should read for anyone checking the coding before pushing.
// clientType picks the right STC mapping (a company vs an individual
// gets credited to a different account). Drops any category with
// nothing in it.
function xeroCategoryGroups(invoice, mappings, clientType) {
  const rows = invoiceClaimRows(invoice);
  const labourMap = (mappings || []).find(m => m.category === 'labour');
  const materialsMap = (mappings || []).find(m => m.category === 'materials');
  const stcMap = (mappings || []).find(m => m.category === (clientType === 'company' ? 'stc_credits_company' : 'stc_credits_individual'));
  return [
    { label: 'Labour', map: labourMap, lines: rows.map(r => ({ stageName: r.stageName, amount: Number(r.labour_amount) || 0 })).filter(l => l.amount > 0) },
    { label: 'Materials', map: materialsMap, lines: rows.map(r => ({ stageName: r.stageName, amount: Number(r.material_amount) || 0 })).filter(l => l.amount > 0) },
    { label: 'STC Credit', map: stcMap, lines: rows.map(r => ({ stageName: r.stageName, amount: -(Number(r.stc_amount) || 0) })).filter(l => l.amount !== 0) },
  ].filter(g => g.lines.length);
}

// Renders the category-grouped breakdown above as HTML - a per-stage line
// only shows when a category spans more than one stage, since most
// invoices are single-stage and a stage-vs-total line repeating the same
// number twice is just noise.
function xeroBreakdownHtml(invoice, mappings, clientType) {
  const groups = xeroCategoryGroups(invoice, mappings, clientType);
  if (!groups.length) return `<p class="subtitle">Nothing to post.</p>`;
  return groups.map(g => {
    const total = g.lines.reduce((s, l) => s + l.amount, 0);
    return `
      <div style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; gap:10px; font-weight:600;">
          <span>${g.label}</span>
          <span style="text-align:right; font-weight:400;">${g.map ? `${g.map.xero_account_code} (${g.map.xero_tax_type})` : '<span style="color:var(--red);">Not mapped - set this in Settings &gt; Xero Mapping</span>'}</span>
        </div>
        ${g.lines.length > 1 ? g.lines.map(l => `<div style="display:flex; justify-content:space-between; font-size:12px; color:var(--muted); padding-left:12px;"><span>${l.stageName}</span><span>${money(l.amount)}</span></div>`).join('') : ''}
        <div style="display:flex; justify-content:space-between; font-size:13px; ${g.lines.length > 1 ? 'border-top:1px solid var(--border); margin-top:2px; padding-top:2px;' : ''}"><span>${g.lines.length === 1 ? g.lines[0].stageName : 'Subtotal'}</span><span>${money(total)}</span></div>
      </div>`;
  }).join('');
}
