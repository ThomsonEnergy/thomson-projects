// The rows of the plan finder's list on a quote's bill card (project.html, "Other plans in this
// area"): one row per retailer, its cheapest plan for this home, with that retailer's other plans
// behind a "more" button. Markup only: project.html owns the clicks (.bc-plan-pick ticks a plan for
// the proposal, .bc-plan-more opens or closes a retailer) and what is ticked. Nothing is saved here.
//
// groups: roiPlansByRetailer(...) from solar-roi.js, already cut to the retailers to show.
// planOf(key): the energy_plans row; chosenIds: Set of ticked plan ids; openBrands: Set of open retailers.
function planFinderRowsHtml({ groups, planOf, chosenIds, openBrands, money }) {
  const diff = (n) => (Math.abs(n) < 5 ? 'about the same' : n < 0 ? `${money(-n)} less` : `${money(n)} more`); // a few dollars either way is rounding
  const things = (p) => [...((p.notes || {}).eligibility || []), ...((p.notes || {}).conditions || [])].slice(0, 3).join('; ');
  const tariffText = (p) => (((p.roi_plan || {}).tariff === 'tou') ? 'time of use' : 'flat rate');
  const row = (r, inner) => {
    const p = planOf(r.key);
    return `<tr${inner ? ' style="background:var(--surface-2);"' : ''}>
      <td><input type="checkbox" class="bc-plan-pick" data-id="${escapeHtml(r.key)}" style="width:auto;" ${chosenIds.has(r.key) ? 'checked' : ''} /></td>
      <td>${escapeHtml(p.brand_name || '')}: ${escapeHtml(p.display_name || '')}<br><span class="subtitle" style="font-size:11px;">${escapeHtml(tariffText(p))}, ${escapeHtml(r.key)}</span></td>
      <td>${money(r.billNow)}</td><td><strong>${money(r.billAfter)}</strong></td><td>${diff(r.vsCurrentAfter)}</td><td>${r.feedIn} c</td>
      <td style="font-size:11.5px;">${escapeHtml(things(p) || '-')}</td></tr>`;
  };
  return groups.map(g => {
    const open = openBrands.has(g.brand);
    const ticked = g.more.filter(r => chosenIds.has(r.key)).length;
    const label = `${open ? 'Hide the' : 'Show'} ${g.more.length} more from ${g.brand}${ticked && !open ? ` (${ticked} ticked)` : ''}`;
    const moreRow = g.more.length ? `<tr><td></td><td colspan="6" style="padding-top:0;"><button type="button" class="link-quiet bc-plan-more" data-brand="${escapeHtml(g.brand)}" style="background:none; border:none; padding:0; font-size:12px; cursor:pointer;">${escapeHtml(label)}</button></td></tr>` : '';
    return row(g.best) + moreRow + (open ? g.more.map(r => row(r, true)).join('') : '');
  }).join('');
}
