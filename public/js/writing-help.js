// Spell check and Polish on every multi-line text box (docs/PROJECT_SPEC.md A33).
// Loaded by supabase-client.js on every page; does nothing until someone is signed in.
//
// - Spelling: with the person's setting on Automatic (profiles.spellcheck_mode, the default),
//   a box they typed in is checked after a short pause and when they leave it. Spelling and
//   obvious typos only (polish-text.js, Claude Haiku 5.5). "Spelling fixed, Undo" shows under
//   the box; Undo also remembers the words it changed so they are left alone from then on.
// - Polish: a button under any box with 5+ words while it has focus. Restructures the
//   sentences in the company voice (or the person's own, Settings > Email Agent).
// - Only "Fix spelling" mode: a Fix spelling button instead of the automatic check. Off: nothing.
// Single-line inputs (names, addresses, amounts) are never touched. Boxes whose id, name or
// class looks like keys, serials, codes or data are skipped, as is anything inside an element
// with data-no-writing-help. A box with data-wh-anchor on a parent gets its bar after that parent.
// Only the text in the box changes (with input and change events, so the page saves it as usual).
(function () {
  if (window.teWriting) return;
  const PAUSE_MS = 2500;
  const MSG_MS = 8000;
  const MAX_CHARS = 8000;
  const SKIP_RE = /key|serial|secret|token|json|csv|sql|html|signature|vin|password|code|sm8|abn|bsb/i;
  const KEEP_KEY = 'te-spell-keep';
  const MODE_KEY = 'te-spellcheck-mode';
  let mode = 'auto';
  try { mode = localStorage.getItem(MODE_KEY) || 'auto'; } catch (e) { /* private mode */ }
  const boxes = new WeakMap();
  const live = new Set();

  const words = (s) => (String(s).trim().match(/\S+/g) || []).length;
  const keepList = () => { try { return JSON.parse(localStorage.getItem(KEEP_KEY) || '[]'); } catch (e) { return []; } };
  function remember(prev, next) {
    const after = new Set(String(next).toLowerCase().match(/[\p{L}'-]+/gu) || []);
    const gone = [...new Set(String(prev).match(/[\p{L}'-]+/gu) || [])].filter((w) => !after.has(w.toLowerCase()));
    if (!gone.length) return;
    try { localStorage.setItem(KEEP_KEY, JSON.stringify([...new Set([...gone, ...keepList()])].slice(0, 200))); } catch (e) { /* private mode */ }
  }

  function addStyles() {
    const css = document.createElement('style');
    css.textContent = `
      .twh-bar{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;margin:3px 0 0;font-size:12px;line-height:1.4;color:var(--muted)}
      .twh-bar .twh-msg{margin-right:auto}
      .twh-bar button{all:unset;box-sizing:border-box;cursor:pointer;font-size:12px;line-height:1.4;color:var(--text);border:1px solid var(--border);border-radius:6px;padding:2px 10px;background:var(--surface-2)}
      .twh-bar button.twh-undo{border:none;background:none;padding:0;color:var(--link);text-decoration:underline}
      .twh-bar button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
      .twh-bar button[aria-busy="true"]{opacity:.6;cursor:default}`;
    document.head.appendChild(css);
  }

  function skip(ta) {
    if (ta.closest('[data-no-writing-help]') || ta.closest('#panel-apikeys')) return true;
    return SKIP_RE.test([ta.id, ta.name, typeof ta.className === 'string' ? ta.className : ''].join(' '));
  }

  async function call(kind, text) {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) throw new Error('Not signed in.');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), kind === 'polish' ? 60000 : 20000);
    try {
      const res = await fetch('/.netlify/functions/polish-text', {
        method: 'POST', signal: ctrl.signal,
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: kind, text, keep: kind === 'spell' ? keepList() : undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || `Failed (${res.status})`);
      return data;
    } finally { clearTimeout(timer); }
  }

  function usable(ta) { return ta.isConnected && !ta.readOnly && !ta.disabled; }

  function refresh(ta, st) {
    const n = words(ta.value);
    const show = mode !== 'off' && st.focused && usable(ta);
    st.fixBtn.style.display = show && mode === 'button' && n >= 1 ? '' : 'none';
    st.polishBtn.style.display = show && n >= 5 ? '' : 'none';
    st.bar.style.display = (st.fixBtn.style.display === 'none' && st.polishBtn.style.display === 'none' && !st.msgOn) ? 'none' : 'flex';
  }

  function showMsg(ta, st, text, withUndo) {
    st.msg.textContent = text;
    st.undoBtn.style.display = withUndo ? '' : 'none';
    st.msgOn = true;
    clearTimeout(st.msgTimer);
    st.msgTimer = setTimeout(() => { st.msgOn = false; st.msg.textContent = ''; st.undoBtn.style.display = 'none'; refresh(ta, st); }, MSG_MS);
    refresh(ta, st);
  }

  function setValue(ta, st, value) {
    const focused = document.activeElement === ta;
    const fromEnd = focused ? ta.value.length - ta.selectionEnd : 0;
    st.checked = value;
    st.dirty = false;
    ta.value = value;
    if (focused) { const p = Math.max(0, value.length - fromEnd); try { ta.setSelectionRange(p, p); } catch (e) { /* not selectable */ } }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function spell(ta, st, { pressed = false } = {}) {
    clearTimeout(st.timer);
    const text = ta.value;
    if (st.polishing || !usable(ta)) return;
    if (!pressed && (!st.dirty || text === st.checked)) return;
    if (words(text) < (pressed ? 1 : 2) || text.length > MAX_CHARS || !navigator.onLine) { st.checked = text; st.dirty = false; return; }
    const seq = ++st.seq;
    st.checked = text;
    st.dirty = false;
    if (pressed) st.fixBtn.setAttribute('aria-busy', 'true');
    let out;
    try { out = await call('spell', text); } catch (err) {
      if (pressed) showMsg(ta, st, err.message, false);
      return;
    } finally { st.fixBtn.removeAttribute('aria-busy'); }
    if (seq !== st.seq || ta.value !== text || !ta.isConnected) return;
    if (!out.changed) { if (pressed) showMsg(ta, st, 'No spelling mistakes found', false); return; }
    st.undo = text;
    st.undoIsPolish = false;
    setValue(ta, st, out.text);
    showMsg(ta, st, 'Spelling fixed', true);
  }

  async function polish(ta, st) {
    const text = ta.value;
    if (st.polishing || !usable(ta) || words(text) < 5) return;
    if (text.length > MAX_CHARS) { showMsg(ta, st, 'Too long to polish', false); return; }
    clearTimeout(st.timer);
    const seq = ++st.seq;
    st.polishing = true;
    st.polishBtn.setAttribute('aria-busy', 'true');
    st.polishBtn.textContent = 'Polishing...';
    let out;
    try { out = await call('polish', text); } catch (err) {
      showMsg(ta, st, `Polish failed: ${err.message}`, false);
      return;
    } finally {
      st.polishing = false;
      st.polishBtn.removeAttribute('aria-busy');
      st.polishBtn.textContent = 'Polish';
    }
    if (seq !== st.seq || ta.value !== text) { showMsg(ta, st, 'The text changed while polishing, press Polish again', false); return; }
    if (!out.changed) { showMsg(ta, st, 'Already reads well', false); return; }
    st.undo = text;
    st.undoIsPolish = true;
    setValue(ta, st, out.text);
    showMsg(ta, st, 'Polished', true);
  }

  function attach(ta) {
    if (boxes.has(ta) || skip(ta)) return;
    const bar = document.createElement('div');
    bar.className = 'twh-bar';
    bar.style.display = 'none';
    bar.innerHTML = '<span class="twh-msg"></span><button type="button" class="twh-undo" style="display:none">Undo</button><button type="button" class="twh-fix" style="display:none">Fix spelling</button><button type="button" class="twh-polish" style="display:none">Polish</button>';
    (ta.closest('[data-wh-anchor]') || ta).insertAdjacentElement('afterend', bar);
    const st = {
      bar, msg: bar.querySelector('.twh-msg'), undoBtn: bar.querySelector('.twh-undo'),
      fixBtn: bar.querySelector('.twh-fix'), polishBtn: bar.querySelector('.twh-polish'),
      checked: ta.value, dirty: false, focused: false, seq: 0, timer: null, msgTimer: null, msgOn: false, polishing: false, undo: null, undoIsPolish: false,
    };
    boxes.set(ta, st);
    live.add(ta);
    // keep the focus in the box when a button is pressed (so leaving it does not run a check too)
    bar.addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
    ta.addEventListener('focus', () => { st.focused = true; refresh(ta, st); });
    ta.addEventListener('blur', () => {
      st.focused = false;
      setTimeout(() => refresh(ta, st), 250); // let a tap on Polish land first
      if (mode === 'auto') spell(ta, st);
    });
    ta.addEventListener('input', (e) => {
      if (!e.isTrusted) return; // our own replacements, or the page filling the box
      st.dirty = true;
      st.seq += 1; // a check already on its way is now out of date
      clearTimeout(st.timer);
      if (mode === 'auto') st.timer = setTimeout(() => spell(ta, st), PAUSE_MS);
      refresh(ta, st);
    });
    st.fixBtn.addEventListener('click', () => spell(ta, st, { pressed: true }));
    st.polishBtn.addEventListener('click', () => polish(ta, st));
    st.undoBtn.addEventListener('click', () => {
      if (st.undo == null) return;
      const back = st.undo;
      const wasPolish = st.undoIsPolish;
      if (!wasPolish) remember(back, ta.value);
      st.undo = null;
      st.undoIsPolish = false;
      st.seq += 1;
      setValue(ta, st, back);
      showMsg(ta, st, wasPolish ? 'Undone' : 'Undone, those words will be left alone from now on', false);
    });
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.tagName === 'TEXTAREA') attach(root);
    else root.querySelectorAll && root.querySelectorAll('textarea').forEach(attach);
  }

  window.teWriting = {
    get mode() { return mode; },
    setMode(m) {
      mode = ['auto', 'button', 'off'].includes(m) ? m : 'auto';
      try { localStorage.setItem(MODE_KEY, mode); } catch (e) { /* private mode */ }
      live.forEach((ta) => { const st = boxes.get(ta); if (st && ta.isConnected) refresh(ta, st); else live.delete(ta); });
    },
    // Chat sends on Enter: fix the spelling first, but never hold a message up for long.
    async beforeSend(ta) {
      const st = boxes.get(ta);
      if (!st || mode !== 'auto' || !navigator.onLine) return;
      st.dirty = true;
      await Promise.race([spell(ta, st), new Promise((r) => setTimeout(r, 1500))]);
    },
  };

  async function start() {
    if (typeof supabaseClient === 'undefined') return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) return;
    addStyles();
    scan(document.body);
    new MutationObserver((list) => list.forEach((m) => m.addedNodes.forEach(scan))).observe(document.body, { childList: true, subtree: true });
    const { data } = await supabaseClient.from('profiles').select('spellcheck_mode').eq('id', session.user.id).maybeSingle();
    if (data && data.spellcheck_mode) window.teWriting.setMode(data.spellcheck_mode);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
