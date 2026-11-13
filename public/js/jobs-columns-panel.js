// The Jobs list's Columns panel (backlog item 85): tick, untick and reorder the columns. Loaded by
// projects.html when the Columns button is pressed. Needs js/jobs-columns.js (JOBS_COLUMNS,
// jobsColumn, jobsColumnsDefault, saveJobsColumns) and openModal, escapeHtml from supabase-client.js.

// The Columns panel. visible: the keys showing now. onChange(keys) runs on every tick, move and
// reset, so the list behind redraws straight away; the save follows by itself.
function openJobsColumnsPanel(visible, onChange) {
  let order = [...visible, ...JOBS_COLUMNS.map((c) => c.key).filter((k) => !visible.includes(k))];
  let on = new Set(visible);
  const overlay = openModal(`
    <h2>Columns</h2>
    <p class="subtitle" style="margin-bottom:8px;">Tick what to show. Drag a row, or use the arrows, to change the order. Saved for you on every device.</p>
    <div id="jc-list"></div>
    <div id="jc-msg"></div>
    <div style="display:flex; gap:8px; margin-top:12px;">
      <button type="button" id="jc-done">Done</button>
      <button type="button" class="secondary" id="jc-reset">Reset to default</button>
    </div>`, { maxWidth: 400, closeOnBackdrop: true });
  const list = overlay.querySelector('#jc-list');
  const msg = overlay.querySelector('#jc-msg');
  function draw() {
    list.innerHTML = order.map((k, i) => `
      <div class="jc-row" draggable="true" data-i="${i}" style="display:flex; align-items:center; gap:8px; padding:3px 0; border-bottom:1px solid var(--border);">
        <span aria-hidden="true" style="cursor:grab; color:var(--muted);">&#8942;&#8942;</span>
        <label style="flex:1; display:flex; align-items:center; gap:8px; margin:0; font-weight:400; cursor:pointer;"><input type="checkbox" data-k="${k}" style="width:auto; margin:0;" ${on.has(k) ? 'checked' : ''} /> ${escapeHtml(jobsColumn(k).label)}</label>
        <button type="button" class="secondary btn-sm" data-move="-1" title="Move up" ${i ? '' : 'disabled'}>&uarr;</button>
        <button type="button" class="secondary btn-sm" data-move="1" title="Move down" ${i < order.length - 1 ? '' : 'disabled'}>&darr;</button>
      </div>`).join('');
  }
  function apply() {
    const keys = order.filter((k) => on.has(k));
    onChange(keys);
    saveJobsColumns(keys, (error) => {
      if (!msg.isConnected) return;
      msg.innerHTML = error ? '<div class="error-box">Saved on this device. Your profile could not be reached, so other devices keep their own columns until this one opens Jobs again.</div>' : '';
    });
  }
  function move(from, to) {
    if (to < 0 || to >= order.length || to === from) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    draw();
    apply();
  }
  list.addEventListener('change', (e) => {
    const k = e.target.dataset.k;
    if (!k) return;
    if (e.target.checked) on.add(k); else on.delete(k);
    apply();
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-move]');
    if (!btn) return;
    const i = Number(btn.closest('.jc-row').dataset.i);
    move(i, i + Number(btn.dataset.move));
  });
  // Drag with a mouse; the arrows do the same job on a touch screen.
  let dragFrom = null;
  const mark = (row) => list.querySelectorAll('.jc-row').forEach((r) => { r.style.boxShadow = r === row ? 'inset 0 2px 0 var(--accent)' : ''; });
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.jc-row');
    if (!row) return;
    dragFrom = Number(row.dataset.i);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  list.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    mark(e.target.closest('.jc-row'));
  });
  list.addEventListener('drop', (e) => {
    e.preventDefault();
    const row = e.target.closest('.jc-row');
    const from = dragFrom;
    dragFrom = null;
    mark(null);
    if (row && from !== null) move(from, Number(row.dataset.i));
  });
  list.addEventListener('dragend', () => { dragFrom = null; mark(null); });
  overlay.querySelector('#jc-reset').addEventListener('click', () => {
    const def = jobsColumnsDefault();
    order = [...def, ...JOBS_COLUMNS.map((c) => c.key).filter((k) => !def.includes(k))];
    on = new Set(def);
    draw();
    apply();
  });
  overlay.querySelector('#jc-done').addEventListener('click', () => overlay.remove());
  draw();
}
