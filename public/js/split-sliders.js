// Waterfall sliders that split time across a few rows: the stages at clock-out (My Day, Home, the
// job page), the stages inside one Timesheets block, and the blocks of a whole day in Timesheets.
// Moving one row takes the difference from the rows after it, in proportion, and the rows before
// it stay as they were (the last row takes from the rows above it). A locked row never moves.
//
// Who calls it: openClockOutModal in js/supabase-client.js (loaded on demand through
// loadSplitSliders) and timesheets.html (a script tag). It needs only escapeHtml, so it draws the
// same on every page: before 20 Nov 2026 the clock-out copy leaned on a helper only Timesheets had,
// so on every other page ticking a second stage failed and the shift was saved split in half.
// Writes nothing: the caller saves the percentages.
//
//   mountSplitSliders(section, { rows, percentages, totalMin, intro, onChange })
//     rows: [{ number, name, locked }]; percentages: whole numbers adding to 100, changed in
//     place; totalMin: the minutes being split (for the "2h 30m" beside each row); intro: the
//     line on top (HTML); onChange(percentages): after every move.

function splitSegmentColor(i) {
  return `hsl(${(i * 137.5) % 360}, 55%, 55%)`;
}
function splitMinutesText(min) {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
function mountSplitSliders(section, { rows, percentages, totalMin, intro, onChange }) {
  section.style.display = 'block';
  section.innerHTML = `
    ${intro ? `<p class="subtitle" style="margin:0 0 8px;">${intro}</p>` : ''}
    <div style="display:flex; height:18px; border-radius:6px; overflow:hidden; margin-bottom:10px;">
      ${rows.map((r, i) => `<div class="split-bar-seg" style="width:${percentages[i]}%; background:${splitSegmentColor(i)};"></div>`).join('')}
    </div>
    ${rows.map((r, i) => `
      <div style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12px; margin-bottom:3px; gap:8px;">
          <span><span style="display:inline-block; width:9px; height:9px; border-radius:3px; background:${splitSegmentColor(i)}; margin-right:5px;"></span>${r.number ? `<strong>${escapeHtml(r.number)}</strong> ` : ''}${escapeHtml(r.name)}${r.locked ? ' <span class="subtitle">(in Xero, locked)</span>' : ''}</span>
          <span style="display:flex; align-items:center; gap:4px;">
            <input type="number" min="0" max="100" value="${percentages[i]}" class="split-number" data-index="${i}" style="width:50px; padding:3px 5px; text-align:right;" ${r.locked ? 'disabled' : ''} />%
            <span class="split-label subtitle" style="min-width:60px; text-align:right;">${splitMinutesText(totalMin * percentages[i] / 100)}</span>
          </span>
        </div>
        <input type="range" min="0" max="100" value="${percentages[i]}" class="split-slider" data-index="${i}" style="width:100%; touch-action:none;" ${r.locked ? 'disabled' : ''} />
      </div>`).join('')}`;
  const sliders = [...section.querySelectorAll('.split-slider')];
  const numbers = [...section.querySelectorAll('.split-number')];
  const labels = [...section.querySelectorAll('.split-label')];
  const segs = [...section.querySelectorAll('.split-bar-seg')];
  // typing: every box but the one being typed in follows (it keeps what was typed until it is left)
  const paint = (typing = -1) => rows.forEach((_, i) => {
    sliders[i].value = percentages[i];
    if (i !== typing) numbers[i].value = percentages[i];
    labels[i].textContent = splitMinutesText(totalMin * percentages[i] / 100);
    segs[i].style.width = `${percentages[i]}%`;
  });
  const all = rows.map((_, i) => i);
  function rebalance(idx, value, typing = -1) {
    // the rows that give and take: those after this one, or (for the last free row) those before it
    const later = all.filter(i => i > idx && !rows[i].locked);
    const flex = later.length ? later : all.filter(i => i < idx && !rows[i].locked);
    if (!flex.length) { paint(typing); return; }
    const fixed = all.filter(i => i !== idx && !flex.includes(i)).reduce((sum, i) => sum + percentages[i], 0);
    const v = Math.max(0, Math.min(100 - fixed, Math.round(value)));
    percentages[idx] = v;
    const remaining = 100 - fixed - v;
    const flexOld = flex.reduce((sum, i) => sum + percentages[i], 0);
    let given = 0;
    flex.forEach((i, n) => {
      const share = n === flex.length - 1 ? remaining - given
        : Math.round(flexOld > 0 ? (percentages[i] / flexOld) * remaining : remaining / flex.length);
      percentages[i] = Math.max(0, share);
      given += percentages[i];
    });
    paint(typing);
    if (onChange) onChange(percentages);
  }
  sliders.forEach(el => el.addEventListener('input', () => rebalance(Number(el.dataset.index), Number(el.value))));
  numbers.forEach(el => {
    el.addEventListener('input', () => { const v = parseInt(el.value, 10); if (!isNaN(v)) rebalance(Number(el.dataset.index), v, Number(el.dataset.index)); });
    el.addEventListener('change', () => paint()); // left the box: it shows what was kept (a number too big is cut back)
  });
}

// Even whole-number shares that add to exactly 100 (the first takes what rounding leaves).
function splitEvenly(n) {
  const out = Array.from({ length: n }, () => Math.round(100 / n));
  out[0] += 100 - out.reduce((a, b) => a + b, 0);
  return out;
}
