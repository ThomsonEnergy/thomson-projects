// The picture editor on step 4 of a quote (backlog item 73c): shows the equipment on the client's
// own wall. The wall picture is one already on the quote; a second picture (the inverter or the
// battery) is cut out and placed on top, dragged and sized by hand, and the result is saved as a
// new picture on the quote, captioned "Indicative picture" by the caller. Nothing here changes
// either original picture.
//
// Who calls it: js/quote-pictures.js, as openPhotoComposer({ project, baseUrl, others, onSaved })
// from a picture's "Put equipment on this picture" button. onSaved(url) gets the new picture.
// What it reads: product_pictures (Settings > Company Details > Product pictures), other jobs'
// pictures tagged with this quote's brands (js/photo-tags.js, already on the page), and
// cut-out-picture.js for the automatic cut-out when its key is set.
// What it writes: one picture into the proposal's own folder (uploadPhotos, 'reference'), and
// "not for other customers" on another job's picture when a person says so.
//
// Two views. Place: the wall picture with the equipment on it (drag it, size it with the slider or
// two fingers, crop the wall picture). Cut out: the equipment's own picture, where it is cut out
// automatically (one tap, when the service is set up) or by hand: Trace (draw around it and
// everything outside the line goes), Box (a rectangle), Rub out and Bring back (a brush to tidy the
// edge). Undo steps back one cut at a time. Works with a finger and with a mouse. One editor at a
// time; closing it lets go of its pictures (a phone has little room for them).
//
// Laid out to use the whole screen (owner's rule, 12 Nov 2026): on a laptop the picture fills the
// window with the tools in a column beside it, nothing to scroll to; on a phone the hint, the
// picture and the tools stack.

const COMPOSE_WORK = 1200; // the equipment picture is worked on at up to this many pixels on its long side
const COMPOSE_OUT = 1920;  // the saved picture's long side, at most
const COMPOSE_UNDO = 15;   // cuts kept for Undo
let composeOverlay = null; // the editor on the screen, if there is one

// A picture as a canvas no bigger than max on its long side. Fetched as a file first, so drawing
// it never locks the canvas (a picture from another address drawn straight in would).
async function composeLoad(source, max) {
  let blob = source;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error('That picture could not be opened. Try again.');
    blob = await res.blob();
  }
  let bitmap;
  try { bitmap = await createImageBitmap(blob); } catch (err) { throw new Error('That picture could not be read. Use a JPG or PNG picture.'); }
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

// The part of a picture that shows (is not see-through), as { x, y, w, h } in its own pixels;
// null when nothing does.
function composeKeptBox(canvas) {
  const { width, height } = canvas;
  const data = canvas.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// Hands a canvas's memory back at once (a phone does not wait for it otherwise).
const composeFree = (canvas) => { if (canvas) { canvas.width = 0; canvas.height = 0; } };

async function openPhotoComposer({ project, baseUrl, others, onSaved }) {
  if (composeOverlay && document.body.contains(composeOverlay)) return;
  const overlay = openModal(`
      <h2 style="margin-bottom:6px; font-size:16px;">Put the equipment on this picture</h2>
      <div id="pc-grid" style="display:grid; gap:8px 16px; align-items:start;">
        <p class="subtitle" id="pc-hint" style="grid-area:hint; margin:0; font-size:12.5px;">Opening the picture...</p>
        <div id="pc-wrap" style="grid-area:stage; border-radius:8px; overflow:hidden; touch-action:none; text-align:center; line-height:0; user-select:none; -webkit-user-select:none; -webkit-touch-callout:none;">
          <canvas id="pc-stage" style="max-width:100%; touch-action:none; cursor:grab;"></canvas>
        </div>
        <div id="pc-tools" style="grid-area:tools;"></div>
        <div id="pc-msg" style="grid-area:msg; font-size:12.5px; min-height:18px;"></div>
      </div>`, { maxWidth: 1500, zIndex: 110 });
  composeOverlay = overlay;
  const $ = (sel) => overlay.querySelector(sel);
  const stage = $('#pc-stage'), wrap = $('#pc-wrap'), tools = $('#pc-tools'), hint = $('#pc-hint'), msg = $('#pc-msg'), grid = $('#pc-grid');
  const ctx = stage.getContext('2d');
  const say = (text, bad) => { msg.innerHTML = text ? `<span ${bad ? 'style="color:var(--red);"' : 'class="subtitle"'}>${escapeHtml(text)}</span>` : ''; };
  const btn = (id, label, kind = 'secondary') => `<button type="button" id="${id}" class="${kind}" style="font-size:13px; padding:7px 11px;">${escapeHtml(label)}</button>`;

  let base = null;          // the wall picture, a canvas
  let crop = null;          // the part of it in use: { x, y, w, h } in its pixels
  let ov = null;            // the equipment: { img, mask, cut, box, cx, cy, w, history }; cx, cy and w are in the wall picture's pixels, so cropping the wall never moves it
  let view = 'place';       // 'place' or 'cut'
  let mode = 'move';        // place: 'move' or 'cropbase'; cut: 'trace', 'box', 'rub' or 'bring'
  let brush = 0.05;         // brush width as a share of the equipment picture's long side
  let autoCut = false;      // the automatic cut-out is set up
  let stroke = null;        // the cut being drawn: { points: [[x, y]] } in the equipment picture's pixels, or { start, box } in the stage's
  let strokeId = null;      // the finger or mouse drawing it: any other is ignored until it lifts
  let drag = null;          // place view: { from, cx, cy } for one finger, { spread, w } for two
  let busy = false;         // saving, or waiting on the automatic cut-out: nothing else is taken meanwhile
  const pointers = new Map();
  // the cut out view sits on a chequered ground, so what is see-through shows as see-through
  const CHEQUERS = 'repeating-conic-gradient(#d9d9d9 0% 25%, #f4f4f4 0% 50%) 50% / 20px 20px';

  const onResize = () => { if (base) redraw(); };
  window.addEventListener('resize', onResize);
  function close() {
    window.removeEventListener('resize', onResize);
    overlay.remove();
    [base, ov && ov.img, ov && ov.mask, ov && ov.cut].forEach(composeFree);
    base = null; ov = null;
    if (composeOverlay === overlay) composeOverlay = null;
  }
  function setBusy(on, text) {
    busy = on;
    tools.style.pointerEvents = on ? 'none' : '';
    tools.style.opacity = on ? '0.5' : '';
    if (text !== undefined) say(text);
  }
  const dropStroke = () => { stroke = null; strokeId = null; };
  // while it is busy no button or slider does anything, however it is pressed (a key press too)
  ['click', 'input'].forEach(type => tools.addEventListener(type, (e) => { if (busy) { e.stopPropagation(); e.preventDefault(); } }, true));

  // ---------- drawing ----------
  // The picture on the stage in this view, and its size on the screen.
  const shown = () => (view === 'cut' ? { w: ov.img.width, h: ov.img.height } : { w: crop.w, h: crop.h });
  // A wide window puts the tools beside the picture, which then gets the window's whole height; a
  // narrow one stacks them, and the picture leaves room for the tools under it.
  function layOut() {
    const wide = window.innerWidth >= 900;
    grid.style.gridTemplateColumns = wide ? 'minmax(0, 1fr) 270px' : 'minmax(0, 1fr)';
    grid.style.gridTemplateAreas = wide ? '"stage hint" "stage tools" "stage msg"' : '"hint" "stage" "tools" "msg"';
    grid.style.gridTemplateRows = wide ? 'auto auto 1fr' : '';
    return wide;
  }
  function fit() {
    const { w, h } = shown();
    const wide = layOut();
    const maxW = wrap.clientWidth || 600, maxH = Math.max(240, Math.round(window.innerHeight * (wide ? 0.88 : 0.55)) - (wide ? 110 : 0));
    const scale = Math.min(maxW / w, maxH / h);
    const cssW = Math.max(40, Math.round(w * scale)), cssH = Math.max(40, Math.round(h * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    stage.style.width = `${cssW}px`; stage.style.height = `${cssH}px`;
    stage.width = Math.round(cssW * dpr); stage.height = Math.round(cssH * dpr);
  }
  // An equipment picture with its cut applied (what the mask keeps of the picture).
  function applyCut(o = ov) {
    const c = o.cut.getContext('2d');
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, o.cut.width, o.cut.height);
    c.drawImage(o.img, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(o.mask, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }
  // Where the equipment sits on the cropped wall picture drawn W wide: its kept part, centred on
  // (cx, cy) and w wide in the wall picture's own pixels.
  const placed = (W) => { const k = W / crop.w, w = ov.w * k, h = w * ov.box.h / ov.box.w; return { x: (ov.cx - crop.x) * k - w / 2, y: (ov.cy - crop.y) * k - h / 2, w, h }; };
  // keeps the equipment's centre on the part of the wall picture in use, so it cannot be lost off the edge
  const keepOnWall = () => { if (!ov) return; ov.cx = Math.min(crop.x + crop.w, Math.max(crop.x, ov.cx)); ov.cy = Math.min(crop.y + crop.h, Math.max(crop.y, ov.cy)); };
  function draw() {
    const W = stage.width, H = stage.height;
    ctx.clearRect(0, 0, W, H);
    if (view === 'place') {
      ctx.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
      if (ov && ov.box) {
        const p = placed(W);
        ctx.drawImage(ov.cut, ov.box.x, ov.box.y, ov.box.w, ov.box.h, p.x, p.y, p.w, p.h);
        if (mode === 'move') { ctx.save(); ctx.setLineDash([8, 6]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.strokeRect(p.x, p.y, p.w, p.h); ctx.restore(); }
      }
      if (mode === 'cropbase' && stroke && stroke.box) {
        const b = stroke.box;
        ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, W, b.y); ctx.fillRect(0, b.y + b.h, W, H - b.y - b.h); ctx.fillRect(0, b.y, b.x, b.h); ctx.fillRect(b.x + b.w, b.y, W - b.x - b.w, b.h);
        ctx.restore();
      }
      return;
    }
    // cut view: what has been cut away shows faintly, so Bring back has something to aim at
    const k = W / ov.img.width;
    ctx.save(); ctx.globalAlpha = 0.25; ctx.drawImage(ov.img, 0, 0, W, H); ctx.restore();
    ctx.drawImage(ov.cut, 0, 0, W, H);
    if (!stroke) return;
    ctx.save(); ctx.lineWidth = 2; ctx.strokeStyle = '#ff3b30'; ctx.setLineDash([6, 4]);
    if (stroke.box) ctx.strokeRect(stroke.box.x, stroke.box.y, stroke.box.w, stroke.box.h);
    else if (mode === 'trace' && stroke.points && stroke.points.length > 1) { ctx.beginPath(); stroke.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k))); ctx.stroke(); }
    ctx.restore();
  }
  const redraw = () => { fit(); draw(); };

  // ---------- the cut (the mask), with Undo ----------
  // The mask as it stands, taken before a cut so Undo can put it back. Kept as a small file, and
  // the copy it was made from is let go as soon as the file is ready.
  function remember() {
    const copy = document.createElement('canvas');
    copy.width = ov.mask.width; copy.height = ov.mask.height;
    copy.getContext('2d').drawImage(ov.mask, 0, 0);
    ov.history.push(new Promise((resolve) => copy.toBlob((blob) => { composeFree(copy); resolve(blob); }, 'image/png')));
    if (ov.history.length > COMPOSE_UNDO) ov.history.shift();
  }
  // Puts the last remembered mask back. False when there was none.
  async function restoreLast() {
    const o = ov;
    const blob = await o.history.pop();
    if (!blob) return false;
    const bitmap = await createImageBitmap(blob);
    const m = o.mask.getContext('2d');
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, o.mask.width, o.mask.height);
    m.drawImage(bitmap, 0, 0);
    bitmap.close();
    applyCut(o);
    return true;
  }
  async function undo() {
    if (!ov || !ov.history.length || busy) return;
    await restoreLast();
    draw(); toolsCut();
  }
  // Keeps only what is inside a shape (Trace and Box).
  function keepInside(path) {
    remember();
    const m = ov.mask.getContext('2d');
    m.globalCompositeOperation = 'destination-in';
    m.fillStyle = '#fff';
    m.fill(path);
    m.globalCompositeOperation = 'source-over';
    applyCut();
  }
  // One dab of the brush between two points (Rub out takes away, Bring back puts back).
  function dab(from, to) {
    const m = ov.mask.getContext('2d');
    m.globalCompositeOperation = mode === 'rub' ? 'destination-out' : 'source-over';
    m.strokeStyle = '#fff'; m.lineCap = 'round'; m.lineJoin = 'round';
    m.lineWidth = Math.max(4, brush * Math.max(ov.img.width, ov.img.height));
    m.beginPath(); m.moveTo(from[0], from[1]); m.lineTo(to[0], to[1]); m.stroke();
    m.globalCompositeOperation = 'source-over';
    applyCut();
  }
  // The whole picture back. (What was see-through in the picture to begin with stays see-through:
  // the mask only ever takes away.)
  function wholeMask(o = ov) {
    const m = o.mask.getContext('2d');
    m.globalCompositeOperation = 'source-over';
    m.fillStyle = '#fff';
    m.fillRect(0, 0, o.mask.width, o.mask.height);
  }

  async function cutAutomatically() {
    if (busy || !ov) return;
    const target = ov;
    setBusy(true, 'Cutting it out...');
    try {
      const jpeg = document.createElement('canvas');
      jpeg.width = target.img.width; jpeg.height = target.img.height;
      const j = jpeg.getContext('2d');
      j.fillStyle = '#fff'; j.fillRect(0, 0, jpeg.width, jpeg.height); j.drawImage(target.img, 0, 0);
      const image = jpeg.toDataURL('image/jpeg', 0.9).split(',')[1];
      composeFree(jpeg);
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/cut-out-picture', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ image }) });
      const out = await res.json().catch(() => ({}));
      if (!out.ok || !out.png) throw new Error(out.error || 'The automatic cut-out did not answer. Cut it out by hand with Trace.');
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${out.png}`)).blob());
      // only for the picture it was asked about, still on the cut out screen
      if (ov !== target || view !== 'cut' || !document.body.contains(overlay)) { bitmap.close(); return; }
      remember();
      const m = ov.mask.getContext('2d');
      m.globalCompositeOperation = 'source-over';
      m.clearRect(0, 0, ov.mask.width, ov.mask.height);
      m.drawImage(bitmap, 0, 0, ov.mask.width, ov.mask.height);
      bitmap.close();
      applyCut();
      if (!composeKeptBox(ov.cut)) { await restoreLast(); throw new Error('It found nothing to cut out in this picture. Cut it out by hand with Trace.'); }
      draw(); toolsCut();
      setBusy(false, 'Cut out. Tidy the edge with Rub out and Bring back if it needs it, then press Done.');
    } catch (err) {
      if (document.body.contains(overlay)) { say(friendlyError(err, 'The automatic cut-out failed. Cut it out by hand with Trace.'), true); draw(); }
    } finally { if (busy) setBusy(false); }
  }

  // ---------- the two toolbars ----------
  function toolsPlace() {
    view = 'place'; if (mode !== 'cropbase') mode = 'move';
    stage.style.cursor = mode === 'cropbase' ? 'crosshair' : 'grab';
    wrap.style.background = 'var(--surface-2)';
    hint.textContent = !ov ? 'Choose the equipment to show on this picture.'
      : mode === 'cropbase' ? 'Drag a box over the part of the wall picture to keep.'
        : 'Drag the equipment to where it will go. Size it with the slider, or with two fingers.';
    const cropped = crop.w < base.width || crop.h < base.height;
    tools.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        ${btn('pc-choose', ov ? 'Change the equipment' : 'Choose the equipment', ov ? 'secondary' : '')}
        ${ov ? btn('pc-tidy', 'Cut it out or tidy the cut') : ''}
        ${btn('pc-cropbase', mode === 'cropbase' ? 'Stop cropping' : 'Crop the wall picture')}
        ${cropped ? btn('pc-uncrop', 'Whole wall picture again') : ''}
      </div>
      ${ov ? `<label style="margin:10px 0 0; font-size:12.5px;">Size<input type="range" id="pc-size" min="5" max="100" step="1" value="${Math.min(100, Math.round(ov.w / crop.w * 100))}" style="width:100%; margin:4px 0 0;" /></label>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
        ${ov ? btn('pc-save', 'Save as a new picture', '') : ''}
        ${btn('pc-cancel', 'Cancel')}
      </div>`;
    $('#pc-choose').addEventListener('click', chooseEquipment);
    $('#pc-cancel').addEventListener('click', close);
    $('#pc-cropbase').addEventListener('click', () => { mode = mode === 'cropbase' ? 'move' : 'cropbase'; dropStroke(); toolsPlace(); draw(); });
    if (cropped) $('#pc-uncrop').addEventListener('click', () => { crop = { x: 0, y: 0, w: base.width, h: base.height }; mode = 'move'; dropStroke(); toolsPlace(); redraw(); });
    if (!ov) return;
    $('#pc-tidy').addEventListener('click', () => { mode = 'trace'; dropStroke(); toolsCut(); redraw(); });
    $('#pc-size').addEventListener('input', (e) => { ov.w = Number(e.target.value) / 100 * crop.w; draw(); });
    $('#pc-save').addEventListener('click', saveResult);
  }
  function toolsCut() {
    view = 'cut'; if (!['trace', 'box', 'rub', 'bring'].includes(mode)) mode = 'trace';
    stage.style.cursor = 'crosshair';
    wrap.style.background = CHEQUERS;
    hint.textContent = { trace: 'Trace: draw around the equipment. Everything outside your line goes.', box: 'Box: drag a rectangle around the equipment. Everything outside it goes.', rub: 'Rub out: brush away what should not be there.', bring: 'Bring back: brush over a piece that was taken by mistake.' }[mode];
    const pick = (id, label) => btn(id, label, mode === id.slice(3) ? '' : 'secondary');
    tools.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        ${autoCut ? btn('pc-auto', 'Cut out automatically') : ''}
        ${pick('pc-trace', 'Trace')}${pick('pc-box', 'Box')}${pick('pc-rub', 'Rub out')}${pick('pc-bring', 'Bring back')}
      </div>
      ${autoCut ? '<p class="subtitle" style="margin:6px 0 0; font-size:11.5px;">Cut out automatically sends this one picture to the cut-out service (Photoroom). Nothing else about the quote goes with it.</p>' : ''}
      ${mode === 'rub' || mode === 'bring' ? `<label style="margin:10px 0 0; font-size:12.5px;">Brush size<input type="range" id="pc-brush" min="1" max="20" step="1" value="${Math.round(brush * 100)}" style="width:100%; margin:4px 0 0;" /></label>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
        ${btn('pc-done', 'Done', '')}
        <button type="button" id="pc-undo" class="secondary" style="font-size:13px; padding:7px 11px;" ${ov.history.length ? '' : 'disabled'}>Undo</button>
        ${btn('pc-whole', 'Start again')}
        ${btn('pc-cancel', 'Cancel')}
      </div>`;
    ['trace', 'box', 'rub', 'bring'].forEach(m => $(`#pc-${m}`).addEventListener('click', () => { mode = m; dropStroke(); toolsCut(); draw(); }));
    if (autoCut) $('#pc-auto').addEventListener('click', cutAutomatically);
    const b = $('#pc-brush'); if (b) b.addEventListener('input', () => { brush = Number(b.value) / 100; });
    $('#pc-undo').addEventListener('click', undo);
    $('#pc-whole').addEventListener('click', () => { remember(); wholeMask(); applyCut(); draw(); toolsCut(); });
    $('#pc-cancel').addEventListener('click', close);
    $('#pc-done').addEventListener('click', () => {
      const box = composeKeptBox(ov.cut);
      if (!box) { say('Nothing is left of the picture. Press Undo or Start again.', true); return; }
      ov.box = box; say(''); mode = 'move'; dropStroke(); toolsPlace(); redraw();
    });
  }

  // ---------- choosing the equipment's picture ----------
  async function chooseEquipment() {
    const brands = typeof quoteBrands === 'function' ? quoteBrands(project) : [];
    const [products, installs] = await Promise.all([
      supabaseClient.from('product_pictures').select('id, brand, model, url').order('brand').order('model').then(({ data }) => data || []).catch(() => []),
      typeof recentInstallPhotos === 'function' && brands.length ? recentInstallPhotos({ brands, excludeProjectId: project.id }).catch(() => []) : [],
    ]);
    // the quote's own makes first (a make is matched as a whole word, so "sma" is not found in "Smart")
    const names = (p) => ` ${`${p.brand || ''} ${p.model || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
    const mine = (p) => brands.some(b => names(p).includes(` ${String(b).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `));
    products.sort((a, b) => Number(mine(b)) - Number(mine(a)));
    const tile = (kind, i, url, label, onLight) => `<button type="button" class="pc-pick" data-kind="${kind}" data-i="${i}" title="${escapeHtml(label)}" style="padding:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:${onLight ? '#f4f4f4' : 'none'}; cursor:pointer;"><img src="${escapeHtml(supaImageVariant(url, 200, 60))}" alt="${escapeHtml(label)}" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:${onLight ? 'contain' : 'cover'}; display:block;" /><span style="display:block; font-size:11px; padding:3px 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.3;">${escapeHtml(label)}</span></button>`;
    const grid = (html) => `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px;">${html}</div>`;
    const picker = openModal(`
        <h2 style="margin-bottom:4px;">Choose the equipment</h2>
        <p class="subtitle" style="margin:0 0 10px; font-size:12.5px;">A product picture is already cut out. Any other picture is cut out on the next screen.</p>
        <div style="max-height:60vh; overflow:auto;">
          <label style="margin-top:0; font-weight:600;">Product pictures</label>
          ${products.length ? grid(products.map((p, i) => tile('product', i, p.url, [p.brand, p.model].filter(Boolean).join(' ') || 'Product picture', true)).join('')) : '<p class="subtitle" style="margin:2px 0 0; font-size:12.5px;">None yet. An Admin adds them once in Settings, Company Details, Product pictures.</p>'}
          ${installs.length ? `<label style="margin-top:14px; font-weight:600;">Recent installs with this gear</label>${grid(installs.map((p, i) => tile('install', i, p.url, p.ai_caption || 'Install picture')).join(''))}` : ''}
          ${(others || []).length ? `<label style="margin-top:14px; font-weight:600;">Pictures on this quote</label>${grid(others.map((p, i) => tile('other', i, p.url, p.caption || 'Picture')).join(''))}` : ''}
        </div>
        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <label style="margin:0; font-weight:600; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;">From your phone or computer<input type="file" id="pc-file" accept="image/*" style="display:none;" /></label>
          <button type="button" class="secondary" id="pc-pick-close" style="font-size:13px; padding:7px 11px;">Cancel</button>
        </div>
        <div id="pc-pick-msg" style="font-size:12.5px; min-height:18px; margin-top:6px;"></div>`, { maxWidth: 640, zIndex: 120 });
    let opening = false;
    const use = async (source) => {
      if (opening) return;
      opening = true;
      const note = picker.querySelector('#pc-pick-msg');
      note.innerHTML = '<span class="subtitle">Opening the picture...</span>';
      try { await setEquipment(source); picker.remove(); }
      catch (err) { note.innerHTML = `<span style="color:var(--red);">${escapeHtml(friendlyError(err, 'That picture could not be opened.'))}</span>`; }
      opening = false;
    };
    // Another customer's place: a person looks at the whole picture before it is used, the same
    // as Recent installs on the quote, and can take it off the offer for good.
    const lookFirst = (p, tileEl) => {
      const look = openModal(`
          <h2 style="margin-bottom:4px;">Use this picture?</h2>
          <p class="subtitle" style="margin:0 0 10px;">It is from another job. Check there is nobody in it and nothing that says whose place it is (a street number, a number plate, paperwork), and cut the equipment out so the rest of their place does not show.</p>
          <img src="${escapeHtml(supaImageVariant(p.url, 1200, 75))}" alt="" style="width:100%; max-height:55vh; object-fit:contain; background:var(--surface-2); border-radius:8px; display:block;" />
          <p class="subtitle" style="margin:8px 0 0; font-size:12.5px;">${escapeHtml(p.ai_caption || '')}</p>
          <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;"><button type="button" id="pc-look-yes">Use this picture</button><button type="button" class="secondary" id="pc-look-never">Not for other customers</button><button type="button" class="secondary" id="pc-look-no">Back</button></div>
          <div id="pc-look-msg" style="font-size:12px;"></div>`, { maxWidth: 640, zIndex: 130 });
      look.querySelector('#pc-look-no').addEventListener('click', () => look.remove());
      look.querySelector('#pc-look-yes').addEventListener('click', () => { look.remove(); use(supaImageVariant(p.url, 1600, 90)); });
      look.querySelector('#pc-look-never').addEventListener('click', async () => {
        const { error } = await supabaseClient.from('project_photos').update({ ok_for_proposals: false }).eq('id', p.id);
        if (error) { look.querySelector('#pc-look-msg').innerHTML = `<div class="error-box" style="margin-top:8px;">${escapeHtml(friendlyError(error))}</div>`; return; }
        look.remove(); tileEl.remove();
        showToast('That picture will not be offered again.');
      });
    };
    picker.querySelector('#pc-pick-close').addEventListener('click', () => picker.remove());
    picker.querySelector('#pc-file').addEventListener('change', (e) => { if (e.target.files[0]) use(e.target.files[0]); });
    // a product picture is opened as it is (it keeps its clear background); a photo at a sensible size
    picker.querySelectorAll('.pc-pick').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.i), kind = b.dataset.kind;
      if (kind === 'product') use(products[i].url);
      else if (kind === 'other') use(supaImageVariant(others[i].url, 1600, 90));
      else lookFirst(installs[i], b);
    }));
  }
  // Takes a picture as the equipment. One with a clear background already goes straight onto the
  // wall; any other opens in the cut out view first. A replacement takes the place and size of the
  // one before it, and the one before it stays until the new one has opened.
  async function setEquipment(source) {
    const img = await composeLoad(source, COMPOSE_WORK);
    const mask = document.createElement('canvas'), cut = document.createElement('canvas');
    mask.width = cut.width = img.width; mask.height = cut.height = img.height;
    const next = { img, mask, cut, box: null, history: [] };
    wholeMask(next); applyCut(next);
    next.box = composeKeptBox(cut);
    if (!next.box) { [img, mask, cut].forEach(composeFree); throw new Error('That picture is empty.'); }
    Object.assign(next, ov ? { cx: ov.cx, cy: ov.cy, w: ov.w } : { cx: crop.x + crop.w / 2, cy: crop.y + crop.h * 0.55, w: crop.w * 0.35 });
    if (ov) [ov.img, ov.mask, ov.cut].forEach(composeFree);
    ov = next;
    dropStroke();
    const clear = next.box.w < img.width - 2 || next.box.h < img.height - 2 || cut.getContext('2d').getImageData(0, 0, 1, 1).data[3] < 200;
    say('');
    if (clear) { mode = 'move'; toolsPlace(); } else { mode = 'trace'; toolsCut(); if (autoCut) say('Press "Cut out automatically", or cut it out by hand.'); }
    redraw();
  }

  // ---------- saving ----------
  async function saveResult() {
    if (busy || !ov || !ov.box) return;
    setBusy(true, 'Saving...');
    try {
      const scale = Math.min(1, COMPOSE_OUT / Math.max(crop.w, crop.h));
      const out = document.createElement('canvas');
      out.width = Math.round(crop.w * scale); out.height = Math.round(crop.h * scale);
      const o = out.getContext('2d');
      o.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
      const p = placed(out.width);
      o.drawImage(ov.cut, ov.box.x, ov.box.y, ov.box.w, ov.box.h, p.x, p.y, p.w, p.h);
      // the same quality uploadPhotos() compresses to, so the picture is not squeezed a second time
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.82));
      composeFree(out);
      if (!blob) throw new Error('The picture could not be made. Try again.');
      const urls = await uploadPhotos([new File([blob], 'indicative-picture.jpg', { type: 'image/jpeg' })], 'reference');
      if (!urls || !urls[0]) throw new Error('The picture did not upload. Check your signal and try again.');
      close();
      if (onSaved) onSaved(urls[0]);
    } catch (err) {
      setBusy(false);
      say(friendlyError(err), true);
    }
  }

  // ---------- finger and mouse ----------
  // A place on the screen as a place on the stage (its own pixels).
  const at = (e) => { const r = stage.getBoundingClientRect(); return [(e.clientX - r.left) * stage.width / r.width, (e.clientY - r.top) * stage.height / r.height]; };
  const boxFrom = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const capture = (e) => { try { stage.setPointerCapture(e.pointerId); } catch (err) { /* an older WebView */ } };

  // The cut in hand ends: applied, or dropped when the phone took the gesture away (cancelled).
  function finish(cancelled) {
    const done = stroke;
    dropStroke();
    if (!done || !base) return;
    if (view === 'place') { // cropping the wall picture
      const b = done.box;
      // the part of the box that is on the picture; under a twentieth of it is a slip of the finger
      const x0 = b ? Math.max(0, b.x) : 0, y0 = b ? Math.max(0, b.y) : 0, x1 = b ? Math.min(stage.width, b.x + b.w) : 0, y1 = b ? Math.min(stage.height, b.y + b.h) : 0;
      if (!cancelled && x1 - x0 > stage.width * 0.05 && y1 - y0 > stage.height * 0.05) {
        const kx = crop.w / stage.width, ky = crop.h / stage.height;
        crop = { x: crop.x + x0 * kx, y: crop.y + y0 * ky, w: (x1 - x0) * kx, h: (y1 - y0) * ky };
        keepOnWall();
        mode = 'move'; toolsPlace(); redraw();
      } else draw();
      return;
    }
    if (mode === 'rub' || mode === 'bring') {
      // a brush stroke the phone cancelled is taken back
      if (cancelled) { restoreLast().then(() => { if (base) { draw(); toolsCut(); } }); return; }
    } else if (!cancelled) {
      const k = ov.img.width / stage.width;
      if (mode === 'box') {
        const b = done.box;
        if (b && b.w > 8 && b.h > 8) { const path = new Path2D(); path.rect(b.x * k, b.y * k, b.w * k, b.h * k); keepInside(path); }
      } else if (done.points && done.points.length > 8) {
        const path = new Path2D();
        done.points.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
        path.closePath();
        keepInside(path);
      }
    }
    draw(); toolsCut();
  }

  stage.addEventListener('pointerdown', (e) => {
    if (busy || !base) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // only the main button draws
    e.preventDefault();
    const p = at(e);
    if (view === 'cut' || mode === 'cropbase') {
      if (strokeId !== null) return; // a second finger does nothing while a cut is being drawn
      strokeId = e.pointerId;
      capture(e);
      if (view === 'place' || mode === 'box') { stroke = { start: p, box: null }; return; }
      const k = ov.img.width / stage.width;
      stroke = { points: [[p[0] * k, p[1] * k]] };
      if (mode === 'rub' || mode === 'bring') { remember(); dab(stroke.points[0], stroke.points[0]); draw(); }
      return;
    }
    if (!ov || pointers.size >= 2) return; // a third finger does nothing
    capture(e);
    pointers.set(e.pointerId, p);
    drag = pointers.size === 2 ? { spread: spread(), w: ov.w } : { from: p, cx: ov.cx, cy: ov.cy };
    stage.style.cursor = 'grabbing';
  });
  stage.addEventListener('pointermove', (e) => {
    const p = at(e);
    if (strokeId !== null) {
      if (e.pointerId !== strokeId || !stroke) return;
      e.preventDefault();
      if (e.pointerType === 'mouse' && e.buttons === 0) { finish(false); return; } // the button came up where the page did not see it
      if (stroke.start) { stroke.box = boxFrom(stroke.start, p); draw(); return; }
      const k = ov.img.width / stage.width;
      const next = [p[0] * k, p[1] * k], last = stroke.points[stroke.points.length - 1];
      if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 2) return;
      stroke.points.push(next);
      if (mode === 'rub' || mode === 'bring') dab(last, next);
      draw();
      return;
    }
    if (!pointers.has(e.pointerId) || !ov) return;
    e.preventDefault();
    if (e.pointerType === 'mouse' && e.buttons === 0) { pointers.delete(e.pointerId); drag = null; stage.style.cursor = 'grab'; return; }
    pointers.set(e.pointerId, p);
    if (!drag) return;
    const k = crop.w / stage.width; // the wall picture's pixels for each of the stage's
    if (drag.spread && pointers.size === 2) {
      ov.w = Math.min(crop.w, Math.max(crop.w * 0.05, drag.w * spread() / drag.spread));
      const s = $('#pc-size'); if (s) s.value = Math.round(ov.w / crop.w * 100);
    } else if (drag.from) {
      ov.cx = drag.cx + (p[0] - drag.from[0]) * k;
      ov.cy = drag.cy + (p[1] - drag.from[1]) * k;
      keepOnWall();
    }
    draw();
  });
  const lift = (e, cancelled) => {
    if (strokeId !== null) { if (e.pointerId === strokeId) finish(cancelled); return; }
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    // one finger left after a pinch carries on as a drag from where it is
    drag = pointers.size === 1 && ov ? { from: [...pointers.values()][0], cx: ov.cx, cy: ov.cy } : null;
    if (!pointers.size) stage.style.cursor = 'grab';
  };
  stage.addEventListener('pointerup', (e) => lift(e, false));
  stage.addEventListener('pointercancel', (e) => lift(e, true));

  // ---------- start ----------
  try {
    base = await composeLoad(supaImageVariant(baseUrl, COMPOSE_OUT, 90), COMPOSE_OUT).catch(() => composeLoad(baseUrl, COMPOSE_OUT));
  } catch (err) {
    hint.textContent = '';
    say(friendlyError(err, 'The picture could not be opened.'), true);
    tools.innerHTML = btn('pc-cancel', 'Close');
    $('#pc-cancel').addEventListener('click', close);
    return;
  }
  if (!document.body.contains(overlay)) { composeFree(base); base = null; return; }
  crop = { x: 0, y: 0, w: base.width, h: base.height };
  toolsPlace(); redraw();
  // is the automatic cut-out set up? (the key lives on the server; a miss just leaves the button out)
  supabaseClient.auth.getSession().then(({ data: { session } }) => (session ? fetch('/.netlify/functions/cut-out-picture', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ check: true }) }) : null))
    .then(res => (res ? res.json() : {})).then(out => { autoCut = !!(out && out.ok && out.available); if (autoCut && view === 'cut' && base && !busy) toolsCut(); }).catch(() => {});
}
