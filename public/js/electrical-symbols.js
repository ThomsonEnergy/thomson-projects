// Electrical plan symbols, cable types and the symbol/cable schedule for the
// markup editor (openPhotoMarkup in supabase-client.js). Loaded only on pages
// that mark up plans - the editor checks `typeof ELECTRICAL_SYMBOLS` and
// simply hides the plan tools when this file isn't there.
//
// Each symbol is a few primitives in a 100x100 box (circle / rect / poly /
// line / text), so one definition draws on the editor's canvas AND onto a
// PDF page as real vector graphics. Add a symbol by adding an entry here.

const ELECTRICAL_SYMBOLS = [
  { id: 'gpo_single', name: 'Power point (single)', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'line', x1: 50, y1: 16, x2: 50, y2: 84 } ] },
  { id: 'gpo_double', name: 'Power point (double)', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'line', x1: 40, y1: 18, x2: 40, y2: 82 }, { t: 'line', x1: 60, y1: 18, x2: 60, y2: 82 } ] },
  { id: 'gpo_weather', name: 'Weatherproof power point', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'line', x1: 34, y1: 24, x2: 34, y2: 76 }, { t: 'text', x: 64, y: 52, size: 26, text: 'WP' } ] },
  { id: 'light', name: 'Light (ceiling)', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'line', x1: 26, y1: 26, x2: 74, y2: 74 }, { t: 'line', x1: 74, y1: 26, x2: 26, y2: 74 } ] },
  { id: 'downlight', name: 'Downlight', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 30 }, { t: 'circle', cx: 50, cy: 50, r: 9, fill: true } ] },
  { id: 'wall_light', name: 'Wall light', prims: [
    { t: 'circle', cx: 50, cy: 42, r: 26 }, { t: 'line', x1: 32, y1: 24, x2: 68, y2: 60 }, { t: 'line', x1: 68, y1: 24, x2: 32, y2: 60 }, { t: 'line', x1: 20, y1: 80, x2: 80, y2: 80 } ] },
  { id: 'batten', name: 'LED batten', prims: [
    { t: 'rect', x: 6, y: 36, w: 88, h: 28 }, { t: 'line', x1: 6, y1: 50, x2: 94, y2: 50 } ] },
  { id: 'switch_1', name: 'Switch (1 gang)', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 30 }, { t: 'text', x: 50, y: 52, size: 40, text: 'S' } ] },
  { id: 'switch_2way', name: 'Switch (2 way)', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 32 }, { t: 'text', x: 50, y: 52, size: 32, text: 'S2' } ] },
  { id: 'dimmer', name: 'Dimmer', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 30 }, { t: 'text', x: 50, y: 52, size: 40, text: 'D' } ] },
  { id: 'ceiling_fan', name: 'Ceiling fan', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'text', x: 50, y: 52, size: 32, text: 'CF' } ] },
  { id: 'exhaust_fan', name: 'Exhaust fan', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'text', x: 50, y: 52, size: 32, text: 'EF' } ] },
  { id: 'smoke_alarm', name: 'Smoke alarm', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 34 }, { t: 'text', x: 50, y: 52, size: 30, text: 'SA' } ] },
  { id: 'data', name: 'Data point', prims: [
    { t: 'poly', pts: [[50, 14], [88, 82], [12, 82]] }, { t: 'text', x: 50, y: 64, size: 30, text: 'D' } ] },
  { id: 'tv', name: 'TV point', prims: [
    { t: 'poly', pts: [[50, 14], [88, 82], [12, 82]] }, { t: 'text', x: 50, y: 64, size: 24, text: 'TV' } ] },
  { id: 'switchboard', name: 'Switchboard', prims: [
    { t: 'rect', x: 14, y: 14, w: 72, h: 72 }, { t: 'text', x: 50, y: 52, size: 34, text: 'SB' } ] },
  { id: 'ev_charger', name: 'EV charger', prims: [
    { t: 'rect', x: 14, y: 14, w: 72, h: 72 }, { t: 'text', x: 50, y: 52, size: 34, text: 'EV' } ] },
  { id: 'inverter', name: 'Solar inverter', prims: [
    { t: 'rect', x: 10, y: 14, w: 80, h: 72 }, { t: 'text', x: 50, y: 52, size: 26, text: 'INV' } ] },
  { id: 'battery', name: 'Battery', prims: [
    { t: 'rect', x: 10, y: 14, w: 80, h: 72 }, { t: 'text', x: 50, y: 52, size: 26, text: 'BAT' } ] },
  { id: 'isolator', name: 'Isolator', prims: [
    { t: 'circle', cx: 50, cy: 50, r: 36 }, { t: 'text', x: 50, y: 52, size: 24, text: 'ISO' } ] },
  { id: 'aircon', name: 'Air conditioner', prims: [
    { t: 'rect', x: 8, y: 26, w: 84, h: 48 }, { t: 'text', x: 50, y: 51, size: 34, text: 'AC' } ] },
  { id: 'oven', name: 'Oven / cooktop', prims: [
    { t: 'rect', x: 14, y: 14, w: 72, h: 72 }, { t: 'text', x: 50, y: 52, size: 30, text: 'OV' } ] },
  { id: 'hot_water', name: 'Hot water system', prims: [
    { t: 'rect', x: 14, y: 14, w: 72, h: 72 }, { t: 'text', x: 50, y: 52, size: 28, text: 'HWS' } ] },
];
const ELECTRICAL_SYMBOL_BY_ID = {};
ELECTRICAL_SYMBOLS.forEach(s => { ELECTRICAL_SYMBOL_BY_ID[s.id] = s; });

// Cable kinds and the sizes that apply to each (the editor shows a kind
// dropdown, then only that kind's sizes). A cable is named "<kind> <size>",
// e.g. "TPS 2.5mm2", and each kind+size is its own line in the schedule.
const CABLE_KINDS = [
  { kind: 'TPS', unit: 'mm2', sizes: ['1', '1.5', '2.5', '4', '6', '10', '16'], def: '2.5' },
  { kind: 'XLPE', unit: 'mm2', sizes: ['6', '10', '16', '25', '35', '50', '70', '95', '120', '150', '185', '240'], def: '16' },
  { kind: 'Orange Circ', unit: 'mm2', sizes: ['1.5', '2.5', '4', '6', '10', '16'], def: '2.5' },
  { kind: 'Solar DC', unit: 'mm2', sizes: ['4', '6', '10'], def: '4' },
  { kind: 'Data', unit: '', sizes: ['Cat5e', 'Cat6', 'Cat6a'], def: 'Cat6' },
];
function cableLabel(kind, size) {
  const k = CABLE_KINDS.find(c => c.kind === kind);
  return k && k.unit ? `${kind} ${size}${k.unit}` : `${kind} ${size}`;
}

// ---------- counting ----------

function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

// Pixels per metre from a markup's scale shape (a line drawn across a known
// real-world length), or null when no scale has been set.
function scalePxPerMetre(shapes) {
  const sc = shapes.find(s => s.type === 'scale');
  if (!sc || !(sc.metres > 0)) return null;
  const px = Math.hypot(sc.x2 - sc.x1, sc.y2 - sc.y1);
  return px > 0 ? px / sc.metres : null;
}

// What's on one marked-up page: symbols by id, and cable runs/metres by type.
function summariseMarkup(shapes) {
  const out = { symbols: {}, cables: {}, circuits: {} };
  const ppm = scalePxPerMetre(shapes);
  shapes.forEach(s => {
    if (s.type === 'symbol') {
      out.symbols[s.symbolId] = (out.symbols[s.symbolId] || 0) + 1;
      const label = (s.label || '').trim();
      if (label) out.circuits[label] = (out.circuits[label] || 0) + 1;
    }
    else if (s.type === 'cable') {
      const c = out.cables[s.cable] || (out.cables[s.cable] = { runs: 0, metres: 0 });
      c.runs += 1;
      if (ppm) c.metres += polylineLength(s.points) / ppm;
    }
  });
  return out;
}

// Combines this page's shapes with the summaries of other pages (a multi-page
// plan) into the rows the schedule shows.
function buildSchedule(shapes, otherSummaries, allowancePercent) {
  const total = summariseMarkup(shapes);
  (otherSummaries || []).forEach(o => {
    Object.entries(o.symbols || {}).forEach(([id, n]) => { total.symbols[id] = (total.symbols[id] || 0) + n; });
    Object.entries(o.circuits || {}).forEach(([label, n]) => { total.circuits[label] = (total.circuits[label] || 0) + n; });
    Object.entries(o.cables || {}).forEach(([name, c]) => {
      const t = total.cables[name] || (total.cables[name] = { runs: 0, metres: 0 });
      t.runs += c.runs; t.metres += c.metres;
    });
  });
  const f = 1 + (Number(allowancePercent) || 0) / 100;
  return {
    allowance: Number(allowancePercent) || 0,
    symbols: ELECTRICAL_SYMBOLS.filter(s => total.symbols[s.id]).map(s => ({ id: s.id, name: s.name, count: total.symbols[s.id] })),
    cables: Object.entries(total.cables).map(([name, c]) => ({ name, runs: c.runs, metres: c.metres, orderMetres: c.metres * f })),
    circuits: Object.entries(total.circuits).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })).map(([label, count]) => ({ label, count })),
  };
}

// ---------- schedule layout (shared by the canvas and PDF renderers) ----------

// Turns a schedule shape + its rows into a flat list of things to draw, in the
// markup editor's pixel coordinates: rect / line / text / symbol items.
function scheduleItems(shape, sched) {
  const u = shape.side;
  const p = u * 0.4, titleH = u * 1.2, rowH = u * 1.3, secH = u * 1.0;
  const width = u * 13.5;
  const symRows = Math.max(sched.symbols.length, 1);
  const hasCables = sched.cables.length > 0;
  const circuits = sched.circuits || [];
  const height = titleH + rowH * symRows + (hasCables ? secH + rowH * sched.cables.length : 0) + (circuits.length ? secH + rowH * circuits.length : 0) + p * 0.6;
  const x = shape.x1, y = shape.y1;
  const items = [];
  items.push({ k: 'rect', x, y, w: width, h: height, bg: true });
  items.push({ k: 'text', x: x + p, y: y + titleH / 2, size: u * 0.62, text: 'Schedule', bold: true });
  items.push({ k: 'line', x1: x, y1: y + titleH, x2: x + width, y2: y + titleH });
  if (!sched.symbols.length) {
    items.push({ k: 'text', x: x + p, y: y + titleH + rowH / 2, size: u * 0.5, text: 'No symbols placed yet' });
  }
  sched.symbols.forEach((r, i) => {
    const ry = y + titleH + i * rowH;
    items.push({ k: 'symbol', id: r.id, x: x + p, y: ry + (rowH - u * 0.95) / 2, side: u * 0.95 });
    items.push({ k: 'text', x: x + p + u * 1.4, y: ry + rowH / 2, size: u * 0.5, text: r.name });
    items.push({ k: 'text', x: x + width - p, y: ry + rowH / 2, size: u * 0.58, text: `x ${r.count}`, bold: true, align: 'right' });
  });
  if (hasCables) {
    const sy = y + titleH + rowH * symRows;
    items.push({ k: 'line', x1: x, y1: sy, x2: x + width, y2: sy });
    items.push({ k: 'text', x: x + p, y: sy + secH / 2, size: u * 0.5, bold: true, text: `Cables - measured (incl. ${sched.allowance}% allowance)` });
    sched.cables.forEach((r, i) => {
      const ry = sy + secH + i * rowH;
      items.push({ k: 'cablesample', x1: x + p, x2: x + p + u * 1.1, y: ry + rowH / 2 });
      items.push({ k: 'text', x: x + p + u * 1.4, y: ry + rowH / 2, size: u * 0.5, text: r.runs > 1 ? `${r.name}  x${r.runs}` : r.name });
      items.push({ k: 'text', x: x + width - p, y: ry + rowH / 2, size: u * 0.5, bold: true, align: 'right', text: `${r.metres.toFixed(1)} m (${r.orderMetres.toFixed(1)} m)` });
    });
  }
  if (circuits.length) {
    const cy0 = y + titleH + rowH * symRows + (hasCables ? secH + rowH * sched.cables.length : 0);
    items.push({ k: 'line', x1: x, y1: cy0, x2: x + width, y2: cy0 });
    items.push({ k: 'text', x: x + p, y: cy0 + secH / 2, size: u * 0.5, bold: true, text: 'Circuits' });
    circuits.forEach((r, i) => {
      const ry = cy0 + secH + i * rowH;
      items.push({ k: 'text', x: x + p, y: ry + rowH / 2, size: u * 0.55, bold: true, text: r.label });
      items.push({ k: 'text', x: x + width - p, y: ry + rowH / 2, size: u * 0.5, align: 'right', text: `${r.count} item${r.count === 1 ? '' : 's'}` });
    });
  }
  return { items, width, height };
}

// ---------- canvas drawing ----------

function drawSymbolCanvas(ctx, id, x, y, side, colour, lineWidth) {
  const sym = ELECTRICAL_SYMBOL_BY_ID[id];
  if (!sym) return;
  const sc = side / 100;
  ctx.save();
  ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = lineWidth;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const shape = (fill) => {
    if (fill) { ctx.fill(); return; }
    ctx.save(); ctx.globalAlpha = 0.85; ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.restore();
    ctx.stroke();
  };
  sym.prims.forEach(p => {
    if (p.t === 'circle') { ctx.beginPath(); ctx.arc(x + p.cx * sc, y + p.cy * sc, p.r * sc, 0, Math.PI * 2); shape(p.fill); }
    else if (p.t === 'rect') { ctx.beginPath(); ctx.rect(x + p.x * sc, y + p.y * sc, p.w * sc, p.h * sc); shape(p.fill); }
    else if (p.t === 'poly') {
      ctx.beginPath();
      p.pts.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * sc, y + py * sc) : ctx.moveTo(x + px * sc, y + py * sc)));
      ctx.closePath(); shape(p.fill);
    } else if (p.t === 'line') { ctx.beginPath(); ctx.moveTo(x + p.x1 * sc, y + p.y1 * sc); ctx.lineTo(x + p.x2 * sc, y + p.y2 * sc); ctx.stroke(); }
    else if (p.t === 'text') {
      ctx.font = `bold ${p.size * sc}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.text, x + p.x * sc, y + p.y * sc);
    }
  });
  ctx.restore();
}

function drawScheduleCanvas(ctx, shape, sched) {
  const { items } = scheduleItems(shape, sched);
  const lw = Math.max(1.5, shape.side * 0.06);
  items.forEach(it => {
    ctx.save();
    if (it.k === 'rect') {
      ctx.globalAlpha = 0.93; ctx.fillStyle = '#ffffff'; ctx.fillRect(it.x, it.y, it.w, it.h);
      ctx.globalAlpha = 1; ctx.strokeStyle = '#000000'; ctx.lineWidth = lw; ctx.strokeRect(it.x, it.y, it.w, it.h);
    } else if (it.k === 'line') {
      ctx.strokeStyle = '#000000'; ctx.lineWidth = lw * 0.6;
      ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(it.x2, it.y2); ctx.stroke();
    } else if (it.k === 'text') {
      ctx.fillStyle = '#000000'; ctx.font = `${it.bold ? 'bold ' : ''}${it.size}px sans-serif`;
      ctx.textAlign = it.align || 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(it.text, it.x, it.y);
    } else if (it.k === 'symbol') {
      drawSymbolCanvas(ctx, it.id, it.x, it.y, it.side, shape.colour, Math.max(1.2, it.side * 0.06));
    } else if (it.k === 'cablesample') {
      ctx.strokeStyle = shape.colour; ctx.lineWidth = lw * 1.4; ctx.setLineDash([it.x2 - it.x1 > 0 ? (it.x2 - it.x1) / 5 : 4, (it.x2 - it.x1) / 8]);
      ctx.beginPath(); ctx.moveTo(it.x1, it.y); ctx.lineTo(it.x2, it.y); ctx.stroke();
    }
    ctx.restore();
  });
}

// ---------- PDF drawing (pdf-lib) ----------

function pdfHexColour(PDFLib, hex) {
  return PDFLib.rgb(parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255);
}

// `map` = { X(x), Y(y), k, ph }: editor pixel -> PDF point conversion.
function drawSymbolPdf(PDFLib, page, font, id, x, y, side, colour, lw, map) {
  const sym = ELECTRICAL_SYMBOL_BY_ID[id];
  if (!sym) return;
  const c = pdfHexColour(PDFLib, colour);
  const white = PDFLib.rgb(1, 1, 1);
  const sc = side / 100;
  const style = (fill) => (fill
    ? { color: c }
    : { color: white, opacity: 0.85, borderColor: c, borderWidth: lw * map.k, borderOpacity: 1 });
  sym.prims.forEach(p => {
    if (p.t === 'circle') {
      page.drawCircle({ x: map.X(x + p.cx * sc), y: map.Y(y + p.cy * sc), size: p.r * sc * map.k, ...style(p.fill) });
    } else if (p.t === 'rect') {
      page.drawRectangle({ x: map.X(x + p.x * sc), y: map.Y(y + (p.y + p.h) * sc), width: p.w * sc * map.k, height: p.h * sc * map.k, ...style(p.fill) });
    } else if (p.t === 'poly') {
      const d = p.pts.map(([px, py], i) => `${i ? 'L' : 'M'} ${x + px * sc} ${y + py * sc}`).join(' ') + ' Z';
      page.drawSvgPath(d, { x: 0, y: map.ph, scale: map.k, ...style(p.fill) });
    } else if (p.t === 'line') {
      page.drawLine({ start: { x: map.X(x + p.x1 * sc), y: map.Y(y + p.y1 * sc) }, end: { x: map.X(x + p.x2 * sc), y: map.Y(y + p.y2 * sc) }, thickness: lw * map.k, color: c, lineCap: PDFLib.LineCapStyle.Round });
    } else if (p.t === 'text') {
      const size = p.size * sc * map.k;
      const w = font.widthOfTextAtSize(p.text, size);
      page.drawText(p.text, { x: map.X(x + p.x * sc) - w / 2, y: map.Y(y + p.y * sc) - size * 0.35, size, font, color: c });
    }
  });
}

function drawSchedulePdf(PDFLib, page, font, shape, sched, map) {
  const { items } = scheduleItems(shape, sched);
  const black = PDFLib.rgb(0, 0, 0);
  const lw = Math.max(1.5, shape.side * 0.06);
  const c = pdfHexColour(PDFLib, shape.colour);
  items.forEach(it => {
    if (it.k === 'rect') {
      page.drawRectangle({ x: map.X(it.x), y: map.Y(it.y + it.h), width: it.w * map.k, height: it.h * map.k, color: PDFLib.rgb(1, 1, 1), opacity: 0.93, borderColor: black, borderWidth: lw * map.k, borderOpacity: 1 });
    } else if (it.k === 'line') {
      page.drawLine({ start: { x: map.X(it.x1), y: map.Y(it.y1) }, end: { x: map.X(it.x2), y: map.Y(it.y2) }, thickness: lw * 0.6 * map.k, color: black });
    } else if (it.k === 'text') {
      const f = it.size * map.k;
      const text = String(it.text).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
      const w = font.widthOfTextAtSize(text, f);
      const x = it.align === 'right' ? map.X(it.x) - w : map.X(it.x);
      page.drawText(text, { x, y: map.Y(it.y) - f * 0.35, size: f, font, color: black });
    } else if (it.k === 'symbol') {
      drawSymbolPdf(PDFLib, page, font, it.id, it.x, it.y, it.side, shape.colour, Math.max(1.2, it.side * 0.06), map);
    } else if (it.k === 'cablesample') {
      const dash = (it.x2 - it.x1) / 5 * map.k;
      page.drawLine({ start: { x: map.X(it.x1), y: map.Y(it.y) }, end: { x: map.X(it.x2), y: map.Y(it.y) }, thickness: lw * 1.4 * map.k, color: c, dashArray: [dash, dash * 0.6] });
    }
  });
}
