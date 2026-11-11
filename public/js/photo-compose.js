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
// What it writes: one picture into the proposal's own folder (uploadPhotos, 'reference').
//
// Two views. Place: the wall picture with the equipment on it (drag it, size it with the slider or
// two fingers, crop the wall picture). Cut out: the equipment's own picture, where it is cut out
// automatically (one tap, when the service is set up) or by hand: Trace (draw around it and
// everything outside the line goes), Box (a rectangle), Rub out and Bring back (a brush to tidy the
// edge). Undo steps back one cut at a time. Works with a finger and with a mouse.

const COMPOSE_WORK = 1200; // the equipment picture is worked on at up to this many pixels on its long side
const COMPOSE_OUT = 1920;  // the saved picture's long side, at most
const COMPOSE_UNDO = 15;   // cuts kept for Undo

// A picture as a canvas no bigger than max on its long side. Fetched as a file first, so drawing
// it never locks the canvas (a picture from another address drawn straight in would).
async function composeLoad(source, max) {
  let blob = source;
  if (typeof source === 'string') {
    const res = await fetch(source);
    if (!res.ok) throw new Error('That picture could not be opened. Try again.');
    blob = await res.blob();
  }
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas;
}

// The part of a mask that is kept, as { x, y, w, h } in its own pixels (null when nothing is).
function composeKeptBox(mask) {
  const { width, height } = mask;
  const data = mask.getContext('2d').getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

async function openPhotoComposer({ project, baseUrl, others, onSaved }) {
  const overlay = openModal(`
      <h2 style="margin-bottom:4px;">Put the equipment on this picture</h2>
      <p class="subtitle" id="pc-hint" style="margin:0 0 8px; font-size:12.5px;">Opening the picture...</p>
      <div id="pc-wrap" style="background:repeating-conic-gradient(#d9d9d9 0% 25%, #f4f4f4 0% 50%) 50% / 20px 20px; border-radius:8px; overflow:hidden; touch-action:none; text-align:center; line-height:0;">
        <canvas id="pc-stage" style="max-width:100%; touch-action:none; cursor:grab;"></canvas>
      </div>
      <div id="pc-tools" style="margin-top:10px;"></div>
      <div id="pc-msg" style="font-size:12.5px; min-height:18px; margin-top:6px;"></div>`, { maxWidth: 860, zIndex: 110 });
  const $ = (sel) => overlay.querySelector(sel);
  const stage = $('#pc-stage'), wrap = $('#pc-wrap'), tools = $('#pc-tools'), hint = $('#pc-hint'), msg = $('#pc-msg');
  const ctx = stage.getContext('2d');
  const say = (text, bad) => { msg.innerHTML = text ? `<span ${bad ? 'style="color:var(--red);"' : 'class="subtitle"'}>${escapeHtml(text)}</span>` : ''; };
  const btn = (id, label, kind = 'secondary') => `<button type="button" id="${id}" class="${kind}" style="font-size:13px; padding:7px 11px;">${escapeHtml(label)}</button>`;

  let base = null;          // the wall picture, a canvas
  let crop = null;          // the part of it in use: { x, y, w, h } in its pixels
  let ov = null;            // the equipment: { img, mask, cut, box, cx, cy, size, history }
  let view = 'place';       // 'place' or 'cut'
  let mode = 'move';        // place: 'move' or 'cropbase'; cut: 'trace', 'box', 'rub' or 'bring'
  let brush = 0.05;         // brush width as a share of the equipment picture's long side
  let autoCut = false;      // the automatic cut-out is set up
  let stroke = null;        // the cut being drawn: { points: [[x, y]] } in the equipment picture's pixels, or a box in the stage's
  let busy = false;
  const pointers = new Map();

  // ---------- drawing ----------
  // The picture on the stage in this view, and its size on the screen.
  const shown = () => (view === 'cut' ? { w: ov.img.width, h: ov.img.height } : { w: crop.w, h: crop.h });
  function fit() {
    const { w, h } = shown();
    const maxW = wrap.clientWidth || 600, maxH = Math.max(240, Math.round(window.innerHeight * 0.55));
    const scale = Math.min(maxW / w, maxH / h);
    const cssW = Math.max(40, Math.round(w * scale)), cssH = Math.max(40, Math.round(h * scale));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    stage.style.width = `${cssW}px`; stage.style.height = `${cssH}px`;
    stage.width = Math.round(cssW * dpr); stage.height = Math.round(cssH * dpr);
  }
  // The equipment with its cut applied (what the mask keeps of the picture).
  function applyCut() {
    const c = ov.cut.getContext('2d');
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, ov.cut.width, ov.cut.height);
    c.drawImage(ov.img, 0, 0);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(ov.mask, 0, 0);
    c.globalCompositeOperation = 'source-over';
  }
  // Where the equipment sits on a picture W by H: its kept part, centred on (cx, cy), size wide.
  const placed = (W, H) => { const w = ov.size * W, h = w * ov.box.h / ov.box.w; return { x: ov.cx * W - w / 2, y: ov.cy * H - h / 2, w, h }; };
  function draw() {
    const W = stage.width, H = stage.height;
    ctx.clearRect(0, 0, W, H);
    if (view === 'place') {
      ctx.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);
      if (ov && ov.box) {
        const p = placed(W, H);
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
    else if (mode === 'trace' && stroke.points.length > 1) { ctx.beginPath(); stroke.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * k, y * k) : ctx.moveTo(x * k, y * k))); ctx.stroke(); }
    ctx.restore();
  }
  const redraw = () => { fit(); draw(); };

  // ---------- the cut (the mask), with Undo ----------
  // The mask as it stands, taken before a cut so Undo can put it back. Kept as a small file.
  function remember() {
    const copy = document.createElement('canvas');
    copy.width = ov.mask.width; copy.height = ov.mask.height;
    copy.getContext('2d').drawImage(ov.mask, 0, 0);
    ov.history.push(new Promise((resolve) => copy.toBlob(resolve, 'image/png')));
    if (ov.history.length > COMPOSE_UNDO) ov.history.shift();
  }
  async function undo() {
    if (!ov || !ov.history.length || busy) return;
    const blob = await ov.history.pop();
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    const m = ov.mask.getContext('2d');
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, ov.mask.width, ov.mask.height);
    m.drawImage(bitmap, 0, 0);
    bitmap.close();
    applyCut(); draw(); toolsCut();
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
  // The whole picture back, less anything that was see-through to begin with (a product picture).
  function wholeMask() {
    const m = ov.mask.getContext('2d');
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, ov.mask.width, ov.mask.height);
    m.drawImage(ov.img, 0, 0);
  }

  async function cutAutomatically() {
    if (busy) return;
    busy = true; say('Cutting it out...');
    try {
      const jpeg = document.createElement('canvas');
      jpeg.width = ov.img.width; jpeg.height = ov.img.height;
      const j = jpeg.getContext('2d');
      j.fillStyle = '#fff'; j.fillRect(0, 0, jpeg.width, jpeg.height); j.drawImage(ov.img, 0, 0);
      const image = jpeg.toDataURL('image/jpeg', 0.9).split(',')[1];
      const { data: { session } } = await supabaseClient.auth.getSession();
      const res = await fetch('/.netlify/functions/cut-out-picture', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ image }) });
      const out = await res.json().catch(() => ({}));
      if (!out.ok || !out.png) throw new Error(out.error || 'The automatic cut-out did not answer. Cut it out by hand with Trace.');
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${out.png}`)).blob());
      remember();
      const m = ov.mask.getContext('2d');
      m.globalCompositeOperation = 'source-over';
      m.clearRect(0, 0, ov.mask.width, ov.mask.height);
      m.drawImage(bitmap, 0, 0, ov.mask.width, ov.mask.height);
      bitmap.close();
      if (!composeKeptBox(ov.mask)) { await undoQuietly(); throw new Error('It found nothing to cut out in this picture. Cut it out by hand with Trace.'); }
      applyCut(); draw(); toolsCut();
      say('Cut out. Tidy the edge with Rub out and Bring back if it needs it, then press Done.');
    } catch (err) {
      say(err.message || 'The automatic cut-out failed.', true);
    } finally { busy = false; }
  }
  // puts the last remembered mask back without touching the screen (a cut that came back empty)
  async function undoQuietly() {
    const blob = await ov.history.pop();
    if (!blob) return;
    const bitmap = await createImageBitmap(blob);
    const m = ov.mask.getContext('2d');
    m.clearRect(0, 0, ov.mask.width, ov.mask.height);
    m.drawImage(bitmap, 0, 0);
    bitmap.close();
  }

  // ---------- the two toolbars ----------
  function toolsPlace() {
    view = 'place'; if (mode !== 'cropbase') mode = 'move';
    stage.style.cursor = mode === 'cropbase' ? 'crosshair' : 'grab';
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
      ${ov ? `<label style="margin:10px 0 0; font-size:12.5px;">Size<input type="range" id="pc-size" min="5" max="100" step="1" value="${Math.round(ov.size * 100)}" style="width:100%; margin:4px 0 0;" /></label>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
        ${ov ? btn('pc-save', 'Save as a new picture', '') : ''}
        ${btn('pc-cancel', 'Cancel')}
      </div>`;
    $('#pc-choose').addEventListener('click', chooseEquipment);
    $('#pc-cancel').addEventListener('click', () => overlay.remove());
    $('#pc-cropbase').addEventListener('click', () => { mode = mode === 'cropbase' ? 'move' : 'cropbase'; stroke = null; toolsPlace(); draw(); });
    if (cropped) $('#pc-uncrop').addEventListener('click', () => { crop = { x: 0, y: 0, w: base.width, h: base.height }; mode = 'move'; toolsPlace(); redraw(); });
    if (!ov) return;
    $('#pc-tidy').addEventListener('click', () => { mode = 'trace'; toolsCut(); redraw(); });
    $('#pc-size').addEventListener('input', (e) => { ov.size = Number(e.target.value) / 100; draw(); });
    $('#pc-save').addEventListener('click', saveResult);
  }
  function toolsCut() {
    view = 'cut'; if (!['trace', 'box', 'rub', 'bring'].includes(mode)) mode = 'trace';
    stage.style.cursor = 'crosshair';
    hint.textContent = { trace: 'Trace: draw around the equipment. Everything outside your line goes.', box: 'Box: drag a rectangle around the equipment. Everything outside it goes.', rub: 'Rub out: brush away what should not be there.', bring: 'Bring back: brush over a piece that was taken by mistake.' }[mode];
    const pick = (id, label) => btn(id, label, mode === id.slice(3) ? '' : 'secondary');
    tools.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        ${autoCut ? btn('pc-auto', 'Cut out automatically') : ''}
        ${pick('pc-trace', 'Trace')}${pick('pc-box', 'Box')}${pick('pc-rub', 'Rub out')}${pick('pc-bring', 'Bring back')}
      </div>
      ${mode === 'rub' || mode === 'bring' ? `<label style="margin:10px 0 0; font-size:12.5px;">Brush size<input type="range" id="pc-brush" min="1" max="20" step="1" value="${Math.round(brush * 100)}" style="width:100%; margin:4px 0 0;" /></label>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px;">
        ${btn('pc-done', 'Done', '')}
        <button type="button" id="pc-undo" class="secondary" style="font-size:13px; padding:7px 11px;" ${ov.history.length ? '' : 'disabled'}>Undo</button>
        ${btn('pc-whole', 'Start again')}
      </div>`;
    ['trace', 'box', 'rub', 'bring'].forEach(m => $(`#pc-${m}`).addEventListener('click', () => { mode = m; stroke = null; toolsCut(); draw(); }));
    if (autoCut) $('#pc-auto').addEventListener('click', cutAutomatically);
    const b = $('#pc-brush'); if (b) b.addEventListener('input', () => { brush = Number(b.value) / 100; });
    $('#pc-undo').addEventListener('click', undo);
    $('#pc-whole').addEventListener('click', () => { remember(); wholeMask(); applyCut(); draw(); toolsCut(); });
    $('#pc-done').addEventListener('click', () => {
      const box = composeKeptBox(ov.mask);
      if (!box) { say('Nothing is left of the picture. Press Undo or Start again.', true); return; }
      ov.box = box; say(''); mode = 'move'; toolsPlace(); redraw();
    });
  }

  // ---------- choosing the equipment's picture ----------
  async function chooseEquipment() {
    const brands = typeof quoteBrands === 'function' ? quoteBrands(project) : [];
    const [products, installs] = await Promise.all([
      supabaseClient.from('product_pictures').select('id, brand, model, url').order('brand').order('model').then(({ data }) => data || []).catch(() => []),
      typeof recentInstallPhotos === 'function' && brands.length ? recentInstallPhotos({ brands, excludeProjectId: project.id }).catch(() => []) : [],
    ]);
    // the quote's own makes first
    const mine = (p) => brands.some(b => String(p.brand || '').toLowerCase().includes(b) || String(p.model || '').toLowerCase().includes(b));
    products.sort((a, b) => Number(mine(b)) - Number(mine(a)));
    const tile = (kind, i, url, label, onLight) => `<button type="button" class="pc-pick" data-kind="${kind}" data-i="${i}" title="${escapeHtml(label)}" style="padding:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:${onLight ? '#f4f4f4' : 'none'}; cursor:pointer;"><img src="${escapeHtml(supaImageVariant(url, 200, 60))}" alt="${escapeHtml(label)}" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:${onLight ? 'contain' : 'cover'}; display:block;" /><span style="display:block; font-size:11px; padding:3px 4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.3;">${escapeHtml(label)}</span></button>`;
    const grid = (html) => `<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(96px, 1fr)); gap:8px;">${html}</div>`;
    const picker = openModal(`
        <h2 style="margin-bottom:4px;">Choose the equipment</h2>
        <p class="subtitle" style="margin:0 0 10px; font-size:12.5px;">A product picture is already cut out. Any other picture is cut out on the next screen.</p>
        <div style="max-height:60vh; overflow:auto;">
          <label style="margin-top:0; font-weight:600;">Product pictures</label>
          ${products.length ? grid(products.map((p, i) => tile('product', i, p.url, [p.brand, p.model].filter(Boolean).join(' ') || 'Product picture', true)).join('')) : '<p class="subtitle" style="margin:2px 0 0; font-size:12.5px;">None yet. Add them once in Settings, Company Details, Product pictures.</p>'}
          ${installs.length ? `<label style="margin-top:14px; font-weight:600;">Recent installs with this gear</label>${grid(installs.map((p, i) => tile('install', i, p.url, p.ai_caption || 'Install picture')).join(''))}` : ''}
          ${(others || []).length ? `<label style="margin-top:14px; font-weight:600;">Pictures on this quote</label>${grid(others.map((p, i) => tile('other', i, p.url, p.caption || 'Picture')).join(''))}` : ''}
        </div>
        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <label style="margin:0; font-weight:600; font-size:13px; padding:8px 12px; border:1px solid var(--border); border-radius:8px; cursor:pointer;">From your phone or computer<input type="file" id="pc-file" accept="image/*" style="display:none;" /></label>
          <button type="button" class="secondary" id="pc-pick-close" style="font-size:13px; padding:7px 11px;">Cancel</button>
        </div>
        <div id="pc-pick-msg" style="font-size:12.5px; min-height:18px; margin-top:6px;"></div>`, { maxWidth: 640, zIndex: 120 });
    const use = async (source) => {
      const note = picker.querySelector('#pc-pick-msg');
      note.innerHTML = '<span class="subtitle">Opening the picture...</span>';
      try { await setEquipment(source); picker.remove(); }
      catch (err) { note.innerHTML = `<span style="color:var(--red);">${escapeHtml(err.message || 'That picture could not be opened.')}</span>`; }
    };
    picker.querySelector('#pc-pick-close').addEventListener('click', () => picker.remove());
    picker.querySelector('#pc-file').addEventListener('change', (e) => { if (e.target.files[0]) use(e.target.files[0]); });
    // a product picture is opened as it is (it keeps its clear background); a photo at a sensible size
    picker.querySelectorAll('.pc-pick').forEach(b => b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      use(b.dataset.kind === 'product' ? products[i].url : supaImageVariant((b.dataset.kind === 'install' ? installs : others)[i].url, 1600, 85));
    }));
  }
  // Takes a picture as the equipment. One with a clear background already goes straight onto the
  // wall; any other opens in the cut out view first.
  async function setEquipment(source) {
    const img = await composeLoad(source, COMPOSE_WORK);
    const mask = document.createElement('canvas'), cut = document.createElement('canvas');
    mask.width = cut.width = img.width; mask.height = cut.height = img.height;
    ov = { img, mask, cut, box: null, cx: 0.5, cy: 0.55, size: 0.35, history: [] };
    wholeMask(); applyCut();
    ov.box = composeKeptBox(mask);
    if (!ov.box) { ov = null; throw new Error('That picture is empty.'); }
    const clear = ov.box.w < img.width - 2 || ov.box.h < img.height - 2 || mask.getContext('2d').getImageData(0, 0, 1, 1).data[3] < 200;
    say('');
    if (clear) { mode = 'move'; toolsPlace(); } else { mode = 'trace'; toolsCut(); if (autoCut) say('Press "Cut out automatically", or cut it out by hand.'); }
    redraw();
  }

  // ---------- saving ----------
  async function saveResult() {
    if (busy || !ov || !ov.box) return;
    busy = true;
    const saveBtn = $('#pc-save'); saveBtn.disabled = true; saveBtn.textContent = 'Saving...';
    try {
      const scale = Math.min(1, COMPOSE_OUT / Math.max(crop.w, crop.h));
      const out = document.createElement('canvas');
      out.width = Math.round(crop.w * scale); out.height = Math.round(crop.h * scale);
      const o = out.getContext('2d');
      o.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
      const p = placed(out.width, out.height);
      o.drawImage(ov.cut, ov.box.x, ov.box.y, ov.box.w, ov.box.h, p.x, p.y, p.w, p.h);
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.88));
      if (!blob) throw new Error('The picture could not be made. Try again.');
      const urls = await uploadPhotos([new File([blob], 'indicative-picture.jpg', { type: 'image/jpeg' })], 'reference');
      if (!urls || !urls[0]) throw new Error('The picture did not upload. Check your signal and try again.');
      overlay.remove();
      if (onSaved) onSaved(urls[0]);
    } catch (err) {
      say(typeof friendlyError === 'function' ? friendlyError(err) : err.message, true);
      saveBtn.disabled = false; saveBtn.textContent = 'Save as a new picture';
    } finally { busy = false; }
  }

  // ---------- finger and mouse ----------
  // A place on the screen as a place on the stage (its own pixels).
  const at = (e) => { const r = stage.getBoundingClientRect(); return [(e.clientX - r.left) * stage.width / r.width, (e.clientY - r.top) * stage.height / r.height]; };
  const boxFrom = (a, b) => ({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) });
  const spread = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  let drag = null; // place view: { from, cx, cy } for one finger, { spread, size } for two

  stage.addEventListener('pointerdown', (e) => {
    if (busy || !base) return;
    e.preventDefault();
    try { stage.setPointerCapture(e.pointerId); } catch (err) { /* an older WebView */ }
    const p = at(e);
    pointers.set(e.pointerId, p);
    if (view === 'place') {
      if (mode === 'cropbase') { stroke = { start: p, box: null }; return; }
      if (!ov) return;
      drag = pointers.size === 2 ? { spread: spread(), size: ov.size } : { from: p, cx: ov.cx, cy: ov.cy };
      stage.style.cursor = 'grabbing';
      return;
    }
    const k = ov.img.width / stage.width;
    if (mode === 'box') { stroke = { start: p, box: null }; return; }
    stroke = { points: [[p[0] * k, p[1] * k]] };
    if (mode === 'rub' || mode === 'bring') { remember(); dab(stroke.points[0], stroke.points[0]); draw(); }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    e.preventDefault();
    const p = at(e);
    pointers.set(e.pointerId, p);
    if (view === 'place') {
      if (mode === 'cropbase') { if (stroke) { stroke.box = boxFrom(stroke.start, p); draw(); } return; }
      if (!drag || !ov) return;
      if (drag.spread && pointers.size === 2) {
        ov.size = Math.min(1, Math.max(0.05, drag.size * spread() / drag.spread));
        const s = $('#pc-size'); if (s) s.value = Math.round(ov.size * 100);
      } else if (drag.from) {
        ov.cx = Math.min(1.2, Math.max(-0.2, drag.cx + (p[0] - drag.from[0]) / stage.width));
        ov.cy = Math.min(1.2, Math.max(-0.2, drag.cy + (p[1] - drag.from[1]) / stage.height));
      }
      draw();
      return;
    }
    if (!stroke) return;
    if (mode === 'box') { stroke.box = boxFrom(stroke.start, p); draw(); return; }
    const k = ov.img.width / stage.width;
    const next = [p[0] * k, p[1] * k], last = stroke.points[stroke.points.length - 1];
    if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 2) return;
    stroke.points.push(next);
    if (mode === 'rub' || mode === 'bring') dab(last, next);
    draw();
  });
  const lift = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (view === 'place') {
      if (mode === 'cropbase' && stroke) {
        const b = stroke.box; stroke = null;
        // a box under a twentieth of the picture is a slip of the finger, not a crop
        if (b && b.w > stage.width * 0.05 && b.h > stage.height * 0.05) {
          const kx = crop.w / stage.width, ky = crop.h / stage.height;
          const x = Math.max(0, b.x), y = Math.max(0, b.y);
          crop = { x: crop.x + x * kx, y: crop.y + y * ky, w: Math.min(stage.width - x, b.w) * kx, h: Math.min(stage.height - y, b.h) * ky };
          mode = 'move'; toolsPlace(); redraw();
        } else draw();
        return;
      }
      // one finger left after a pinch carries on as a drag from where it is
      drag = pointers.size === 1 && ov ? { from: [...pointers.values()][0], cx: ov.cx, cy: ov.cy } : null;
      if (!pointers.size) stage.style.cursor = 'grab';
      return;
    }
    const done = stroke; stroke = null;
    if (!done) return;
    const k = ov.img.width / stage.width;
    if (mode === 'box') {
      const b = done.box;
      if (b && b.w > 8 && b.h > 8) { const path = new Path2D(); path.rect(b.x * k, b.y * k, b.w * k, b.h * k); keepInside(path); }
    } else if (mode === 'trace' && done.points.length > 8) {
      const path = new Path2D();
      done.points.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
      path.closePath();
      keepInside(path);
    }
    draw(); toolsCut();
  };
  stage.addEventListener('pointerup', lift);
  stage.addEventListener('pointercancel', lift);
  const onResize = () => { if (document.body.contains(overlay)) { if (base) redraw(); } else window.removeEventListener('resize', onResize); };
  window.addEventListener('resize', onResize);

  // ---------- start ----------
  try {
    base = await composeLoad(supaImageVariant(baseUrl, COMPOSE_OUT, 85), COMPOSE_OUT).catch(() => composeLoad(baseUrl, COMPOSE_OUT));
  } catch (err) {
    hint.textContent = '';
    say(err.message || 'The picture could not be opened.', true);
    tools.innerHTML = btn('pc-cancel', 'Close');
    $('#pc-cancel').addEventListener('click', () => overlay.remove());
    return;
  }
  crop = { x: 0, y: 0, w: base.width, h: base.height };
  toolsPlace(); redraw();
  // is the automatic cut-out set up? (the key lives on the server; a miss just leaves the button out)
  supabaseClient.auth.getSession().then(({ data: { session } }) => (session ? fetch('/.netlify/functions/cut-out-picture', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ check: true }) }) : null))
    .then(res => (res ? res.json() : {})).then(out => { autoCut = !!(out && out.ok && out.available); if (autoCut && view === 'cut') toolsCut(); }).catch(() => {});
}
