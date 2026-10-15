// Faint wiring diagram behind a page, fixed to the viewport at z-index -1 so
// it sits under all the page content and never takes clicks. Drawn in the
// theme's accent colour (navy in the light theme, blue in dark).
//
// The wiring is a set of routes that run right across the screen at a slight
// angle, turning corners like a maze, with their ends always off-screen. Each
// one has switches, resistors, diodes, lamps, fuses and inductors wired in
// series (IEC symbols, as used on Australian drawings). Every few seconds a burst of current runs along
// one route, chosen at random but away from the last one: its switches close,
// a bright dot with a speed streak behind it races along the wire, the lamps
// on it light as it passes, then the switches open again. A switch is only
// ever closed while current is on its route. Soft bands of light also ripple
// slowly down the screen over the whole diagram.
//
// Touching a wire with the mouse (or dragging a finger across one) throws
// sparks off the contact point for as long as you stay on it.
//
// The diagram is redrawn to fit if the window is resized. Anyone with "reduce
// motion" turned on gets the still diagram, switches open.
const CURRENT_SPEED = 1100;      // px per second for the current dot
const CURRENT_GAP = [1.8, 3.6];  // seconds between bursts (random within this range)
const STREAK = [45, 120, 240];   // streak lengths behind the dot, brightest/shortest first
const LANE_HEIGHT = 120;         // roughly one route per this many px of screen height
const SPARK_REACH = 7;           // how close (px) the pointer has to be to a wire to spark it
const SPARK_MAX = 160;           // most sparks on screen at once
const SPARK_COLOUR = { dark: '#FFD66B', light: '#E8930C' };
const RIPPLES = 4;
const RIPPLE_SECONDS = 3;
const RIPPLE_TILT = 8;            // the ripple bands lean this way on screen...
const WIRING_TILT = -8;           // ...and the wiring leans the other way

const SVG_NS = 'http://www.w3.org/2000/svg';
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const between = (lo, hi) => lo + Math.random() * (hi - lo);
const snap = (v) => Math.round(v / 20) * 20;

// One route across the drawing (x0 to x1): horizontal runs joined by short
// vertical jogs that stay inside its own lane, so routes never cross. Half
// the routes run right-to-left, so current flows both ways. Parts go on the
// horizontal runs, spaced out, every one of them something that passes DC
// in series: the first is always a switch, then resistors, diodes (always
// pointing the way the current flows, so forward-biased), lamps, fuses and
// inductors.
const CIRCUIT_PARTS = ['resistor', 'resistor', 'resistor', 'diode', 'diode', 'diode', 'lamp', 'lamp', 'fuse', 'inductor', 'switch'];
function circuitRoute(x0, x1, laneTop, laneH) {
  const mid = laneTop + laneH / 2;
  const amp = Math.max(20, Math.min(40, snap(laneH * 0.3)));
  const ys = [];
  for (let v = -amp; v <= amp; v += 20) ys.push(snap(mid + v));
  let x = snap(x0), y = pick(ys);
  const pts = [[x, y]];
  const runs = [];
  while (x < x1) {
    const nx = Math.min(x + snap(between(100, 280)), snap(x1) + 20);
    runs.push({ x1: x, x2: nx, y });
    x = nx; pts.push([x, y]);
    if (x < x1) {
      let ny = pick(ys);
      if (ny === y) ny = ys[(ys.indexOf(y) + 1) % ys.length];
      y = ny; pts.push([x, y]);
    }
  }
  const reversed = Math.random() < 0.5;
  const dir = reversed ? -1 : 1;
  const symbols = [];
  let haveSwitch = false;
  runs.forEach((r) => {
    // Room for one part per ~90px of run, kept clear of the corners
    const slots = Math.min(3, Math.floor((r.x2 - r.x1 - 40) / 90));
    for (let k = 0; k < slots; k++) {
      const cx = snap(r.x1 + (r.x2 - r.x1) * (k + 1) / (slots + 1));
      if (!haveSwitch) { symbols.push({ kind: 'switch', cx, y: r.y, dir }); haveSwitch = true; continue; }
      if (Math.random() < 0.75) symbols.push({ kind: pick(CIRCUIT_PARTS), cx, y: r.y, dir });
    }
  });
  if (reversed) pts.reverse();
  return { d: 'M' + pts.map(p => p.join(' ')).join(' L'), symbols, mid, pts };
}

// A part sitting on a horizontal wire at (cx, y). The bg-coloured stroke cuts
// the wire under it, the way the symbol breaks the line on a drawing.
function circuitSymbol(s) {
  const { cx, y, dir } = s;
  const cut = (half) => `<path d="M${cx - half} ${y} H${cx + half}" style="stroke:var(--bg, #000)" stroke-width="6" stroke-linecap="butt"/>`;
  if (s.kind === 'lamp') return cut(12) + `<circle cx="${cx}" cy="${y}" r="12"/><path d="M${cx - 8.5} ${y - 8.5} L${cx + 8.5} ${y + 8.5} M${cx + 8.5} ${y - 8.5} L${cx - 8.5} ${y + 8.5}"/>`;
  if (s.kind === 'resistor') return cut(16) + `<rect x="${cx - 16}" y="${y - 6}" width="32" height="12" rx="1"/>`;
  if (s.kind === 'fuse') return `<rect x="${cx - 14}" y="${y - 6}" width="28" height="12" rx="1"/>`;
  if (s.kind === 'diode') {
    // triangle points the way current flows, bar (cathode) at its tip
    const b = cx - 9 * dir, t = cx + 9 * dir;
    return cut(9) + `<path d="M${b} ${y - 9} L${b} ${y + 9} L${t} ${y} Z" stroke-linejoin="round"/><path d="M${t} ${y - 9} V${y + 9}"/>`;
  }
  if (s.kind === 'inductor') return cut(20) + `<path d="M${cx - 20} ${y} a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0 a5 5 0 0 1 10 0"/>`;
  // switch: two contacts and a blade hinged on the left one (opened/closed by the animation)
  return cut(14) + `<circle cx="${cx - 14}" cy="${y}" r="2.5"/><circle cx="${cx + 14}" cy="${y}" r="2.5"/>` +
    `<path class="te-sw" d="M${cx - 12} ${y} L${cx + 12} ${y}" transform="rotate(-30 ${cx - 12} ${y})" data-px="${cx - 12}" data-py="${y}"/>`;
}

let _circuitBgCount = 0;
// opts.still: just the drawing, nothing moving (no ripples, current or
// sparks). Used on every staff page except login and home.
function addCircuitBackground(opacity = 0.06, opts = {}) {
  const animate = !opts.still && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  let svg = null, frame = null;
  const scale = opacity / 0.06; // the current is a touch dimmer where the background is fainter

  function build() {
    const id = `te-circuit-${++_circuitBgCount}`;
    const W = window.innerWidth, H = window.innerHeight;
    // The drawing is tilted, so it covers a bigger area than the screen to leave no bare corners
    const pad = Math.ceil(Math.max(W, H) * Math.abs(Math.sin(WIRING_TILT * Math.PI / 180)) / 2) + 80;
    const lanes = Math.max(3, Math.round((H + 2 * pad) / LANE_HEIGHT));
    const laneH = (H + 2 * pad) / lanes;
    const routes = Array.from({ length: lanes }, (_, i) => circuitRoute(-pad, W + pad, -pad + i * laneH, laneH));
    const box = `x="${-pad}" y="${-pad}" width="${W + 2 * pad}" height="${H + 2 * pad}"`;
    const period = Math.round(H / RIPPLES);
    const stroke = `fill="none" stroke="#36379A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--accent, #36379A); color:var(--accent, #36379A)"`;

    const html = `<svg id="${id}-svg" aria-hidden="true" focusable="false" style="position:fixed; inset:0; width:100%; height:100%; pointer-events:none; z-index:-1;">
      <style>@media print { #${id}-svg { display: none; } }</style>
      <defs>
        <g id="${id}-diagram">${routes.map((r, i) => `<g data-route="${i}" data-mid="${r.mid}"><path class="te-wire" d="${r.d}"/>${r.symbols.map(circuitSymbol).join('')}</g>`).join('')}</g>
        ${animate ? `
        <linearGradient id="${id}-band" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${period}" spreadMethod="repeat" gradientTransform="rotate(${RIPPLE_TILT - WIRING_TILT})">
          <stop offset="0" stop-color="#000"/><stop offset="0.3" stop-color="#000"/><stop offset="0.44" stop-color="#555"/>
          <stop offset="0.5" stop-color="#fff"/>
          <stop offset="0.56" stop-color="#555"/><stop offset="0.7" stop-color="#000"/><stop offset="1" stop-color="#000"/>
          <!-- Moving down exactly one band spacing per loop makes the repeat seamless; additive keeps the tilt -->
          <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="0 ${period}" dur="${RIPPLE_SECONDS}s" repeatCount="indefinite" additive="sum"/>
        </linearGradient>
        <mask id="${id}-mask" maskUnits="userSpaceOnUse" ${box}><rect ${box} fill="url(#${id}-band)"/></mask>` : ''}
      </defs>
      <g ${stroke} transform="rotate(${WIRING_TILT} ${W / 2} ${H / 2})">
        <g opacity="${opacity}"><use href="#${id}-diagram"/></g>
        ${animate ? `
        <g opacity="${Math.min(1, opacity * 5)}" mask="url(#${id}-mask)"><use href="#${id}-diagram"/></g>
        <g class="te-live" style="display:none">
          ${STREAK.slice().reverse().map((len, i) => `<path class="te-streak" data-len="${len}" stroke-width="${[1.5, 3, 5][i]}" opacity="${Math.min(1, [0.3, 0.55, 0.9][i] * scale)}"/>`).join('')}
          <circle class="te-head-glow" r="9" fill="currentColor" stroke="none" opacity="${Math.min(1, 0.25 * scale)}"/>
          <circle class="te-head" r="4.5" fill="currentColor" stroke="none" opacity="${Math.min(1, 0.95 * scale)}"/>
        </g>
        <g class="te-lamps"></g>` : ''}
      </g>
      ${animate ? `<g class="te-sparks" fill="none" stroke-linecap="round"><circle class="te-flash" r="0" stroke="none" opacity="0"/></g>` : ''}
    </svg>`;
    document.body.insertAdjacentHTML('afterbegin', html);
    svg = document.getElementById(`${id}-svg`);
    geo = { routes, W, H };
    sparks.length = 0;
    return routes.length;
  }

  // ---------- sparks where the pointer touches a wire ----------
  // The drawing is rotated about the screen centre; these move a point
  // between screen space and the drawing's own (unrotated) space.
  let geo = null, contact = null, lastBurst = 0;
  const sparks = [];
  const rad = WIRING_TILT * Math.PI / 180;
  const rotate = (x, y, a) => {
    const cx = geo.W / 2, cy = geo.H / 2, c = Math.cos(a), s = Math.sin(a);
    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  };
  // Nearest point on any wire within SPARK_REACH px of (x, y) on screen, or null
  function wireAt(x, y) {
    if (!geo) return null;
    const [lx, ly] = rotate(x, y, -rad);
    let best = null, bestD = SPARK_REACH;
    for (const r of geo.routes) {
      for (let i = 1; i < r.pts.length; i++) {
        const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i];
        const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
        const k = Math.max(0, Math.min(1, ((lx - ax) * dx + (ly - ay) * dy) / len2));
        const px = ax + k * dx, py = ay + k * dy, d = Math.hypot(lx - px, ly - py);
        if (d < bestD) { bestD = d; best = [px, py]; }
      }
    }
    return best && rotate(best[0], best[1], rad);
  }
  function burst(x, y, count) {
    for (let i = 0; i < count && sparks.length < SPARK_MAX; i++) {
      const a = Math.random() * Math.PI * 2, v = between(160, 480);
      const life = between(0.25, 0.6);
      sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 140, life, max: life, el: null });
    }
    const flash = svg && svg.querySelector('.te-flash');
    if (flash) { flash.setAttribute('cx', x); flash.setAttribute('cy', y); flash.dataset.t = String(now()); }
  }
  function updateSparks(t, dt) {
    if (!svg) return;
    const layer = svg.querySelector('.te-sparks');
    if (!layer) return;
    const colour = document.documentElement.getAttribute('data-theme') === 'navy' ? SPARK_COLOUR.light : SPARK_COLOUR.dark;
    // Keep sparking for as long as the pointer stays on the wire
    if (contact && t - lastBurst > 0.07) { burst(contact[0], contact[1], 3 + Math.floor(Math.random() * 3)); lastBurst = t; }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const s = sparks[i];
      s.life -= dt;
      if (s.life <= 0) { if (s.el) s.el.remove(); sparks.splice(i, 1); continue; }
      s.vy += 1100 * dt;                       // gravity
      s.vx *= 1 - 1.5 * dt; s.vy *= 1 - 0.6 * dt; // drag
      s.x += s.vx * dt; s.y += s.vy * dt;
      if (!s.el) {
        s.el = document.createElementNS(SVG_NS, 'line');
        s.el.setAttribute('stroke-width', between(1.2, 2.2).toFixed(1));
        layer.appendChild(s.el);
      }
      s.el.setAttribute('stroke', colour);
      s.el.setAttribute('x1', s.x); s.el.setAttribute('y1', s.y);
      s.el.setAttribute('x2', s.x - s.vx * 0.03); s.el.setAttribute('y2', s.y - s.vy * 0.03);
      s.el.setAttribute('opacity', (s.life / s.max).toFixed(2));
    }
    const flash = layer.querySelector('.te-flash');
    const ft = flash.dataset.t ? t - +flash.dataset.t : 1;
    if (ft < 0.18) {
      flash.setAttribute('fill', colour);
      flash.setAttribute('r', (4 + ft * 60).toFixed(1));
      flash.setAttribute('opacity', (0.7 * (1 - ft / 0.18)).toFixed(2));
    } else if (flash.getAttribute('opacity') !== '0') flash.setAttribute('opacity', '0');
  }
  function onPointer(e) {
    const hit = wireAt(e.clientX, e.clientY);
    // A fresh touch on the wire gets a bigger first burst
    if (hit && !contact) { burst(hit[0], hit[1], 14); lastBurst = now(); }
    contact = hit;
  }

  // ---------- the current ----------
  let run = null, nextAt = 0, lastRoute = -1, lastTick = 0;
  const now = () => performance.now() / 1000;

  function setSwitches(group, angle) {
    group.querySelectorAll('.te-sw').forEach(sw => sw.setAttribute('transform', `rotate(${angle} ${sw.dataset.px} ${sw.dataset.py})`));
  }

  function startRun(t) {
    const groups = svg.querySelectorAll(`defs [data-route]`);
    // Only routes that cross the visible screen, somewhere away from the last one (a different third when there's room)
    const H = window.innerHeight;
    const onScreen = [...groups.keys()].filter(i => +groups[i].dataset.mid > 20 && +groups[i].dataset.mid < H - 20);
    const n = onScreen.length;
    const far = onScreen.filter(i => lastRoute < 0 || Math.abs(i - lastRoute) >= Math.max(1, Math.floor(n / 3)));
    const i = pick(far.length ? far : onScreen);
    lastRoute = i;
    const group = groups[i];
    const wire = group.querySelector('.te-wire');
    const length = wire.getTotalLength();
    const live = svg.querySelector('.te-live');
    live.querySelectorAll('.te-streak').forEach(p => {
      p.setAttribute('d', wire.getAttribute('d'));
      p.setAttribute('stroke-dasharray', `${p.dataset.len} ${length + 400}`);
    });
    // Lamps on this route, and how far along the wire each one is (so it lights as the current reaches it)
    const lampLayer = svg.querySelector('.te-lamps');
    lampLayer.innerHTML = '';
    const lamps = [...group.querySelectorAll('circle[r="12"]')].map(c => {
      const cx = +c.getAttribute('cx'), cy = +c.getAttribute('cy');
      let best = 0, bestD = Infinity;
      for (let s = 0; s <= length; s += 10) {
        const p = wire.getPointAtLength(s);
        const d = Math.hypot(p.x - cx, p.y - cy);
        if (d < bestD) { bestD = d; best = s; }
      }
      const glow = document.createElementNS(SVG_NS, 'circle');
      glow.setAttribute('cx', cx); glow.setAttribute('cy', cy); glow.setAttribute('r', '9');
      glow.setAttribute('fill', 'currentColor'); glow.setAttribute('stroke', 'none'); glow.setAttribute('opacity', '0');
      lampLayer.appendChild(glow);
      return { at: best, glow };
    });
    const travel = (length + STREAK[STREAK.length - 1]) / CURRENT_SPEED;
    run = { group, wire, length, live, lamps, t0: t, close: 0.25, travel, open: 0.25 };
  }

  function tick() {
    frame = requestAnimationFrame(tick);
    const t = now();
    if (t - lastTick > 1) { run = null; nextAt = t + 0.8; lastTick = t; } // came back to a hidden tab: start afresh
    updateSparks(t, Math.min(0.05, t - lastTick));
    lastTick = t;
    if (!run) {
      if (t >= nextAt) startRun(t);
      else return;
    }
    const r = run, e = t - r.t0;
    const ease = (k) => k * k * (3 - 2 * k);
    if (e < r.close) {                                   // switches swinging shut
      setSwitches(r.group, -30 * (1 - ease(e / r.close)));
      return;
    }
    const k = e - r.close;
    if (k < r.travel) {                                  // current running
      setSwitches(r.group, 0);
      const head = k * CURRENT_SPEED;
      r.live.style.display = '';
      r.live.querySelectorAll('.te-streak').forEach(p => p.setAttribute('stroke-dashoffset', String(+p.dataset.len - head)));
      const p = r.wire.getPointAtLength(Math.min(head, r.length));
      ['.te-head', '.te-head-glow'].forEach(sel => {
        const c = r.live.querySelector(sel);
        c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
        c.setAttribute('visibility', head > r.length ? 'hidden' : 'visible');
      });
      r.lamps.forEach(l => l.glow.setAttribute('opacity', head >= l.at ? String(Math.min(1, 0.55 * scale)) : '0'));
      return;
    }
    r.live.style.display = 'none';                       // current gone: lamps out, switches open
    r.lamps.forEach(l => l.glow.setAttribute('opacity', '0'));
    const o = k - r.travel;
    if (o < r.open) { setSwitches(r.group, -30 * ease(o / r.open)); return; }
    setSwitches(r.group, -30);
    run = null;
    nextAt = t + between(CURRENT_GAP[0], CURRENT_GAP[1]);
  }

  build();
  if (animate) {
    nextAt = now() + 0.8; lastTick = now(); frame = requestAnimationFrame(tick);
    window.addEventListener('pointermove', onPointer, { passive: true });
    window.addEventListener('pointerdown', onPointer, { passive: true });
    const lift = () => { contact = null; };
    window.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') lift(); }, { passive: true });
    window.addEventListener('pointercancel', lift, { passive: true });
    document.addEventListener('pointerleave', lift);
    window.addEventListener('blur', lift);
  }

  // Redraw to fit when the window size changes (e.g. a phone is turned)
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (svg) svg.remove();
      run = null; lastRoute = -1;
      build();
    }, 250);
  });
}
