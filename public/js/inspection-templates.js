// Settings > Inspection Checklists (settings.html, pricing roles). Moved out of the page for item 112.
//
// Three kinds of checklist share two tables (inspection_checklist_templates, inspection_checklist_items):
//   site_inspection   suggested photos and questions for a site visit, one list per proposal type
//                     (proposal_types). Nothing on it is required. A question can be Yes or No, a
//                     choice or a short answer, can suggest a task (task_when, task_text) and can
//                     fill a pre-quote answer on the quote (fills_answer). site-inspection.html.
//   quote_compliance  the documents to gather on a solar quote (project.html). Required items and
//                     "only show when" a Yes or No question is answered a certain way.
//   job_sheet         the crew's photo list on a price list job (job-sheet.html). Same shape.
//
// settings.html downloads this file and calls loadInspectionTemplates() once for a pricing role.
// Needs supabase-client.js (supabaseClient, escapeHtml, loadJsOnce); it downloads
// template-questions.js itself (TEMPLATE_INFO and the question lists, for the "fills" picker).

let inspTemplatesCache = [];
let inspItemsCache = {}; // template_id -> items[]
let expandedTemplateId = null;

const INSP_GROUPS = [
  { type: 'site_inspection', heading: 'Site inspection checklists' },
  { type: 'quote_compliance', heading: 'Quote compliance checklists' },
  { type: 'job_sheet', heading: 'Job sheets' },
];
const INSP_KIND_LABELS = { photo: 'Photo', yes_no: 'Yes/No', choice: 'Choice', text: 'Short answer' };

// The proposal types a site inspection checklist can be for, plus the off-grid extra list.
function inspProposalTypes() {
  const info = typeof TEMPLATE_INFO === 'object' ? TEMPLATE_INFO : {};
  return [...Object.keys(info).map(key => ({ key, label: info[key].label })), { key: 'off_grid', label: 'Off-grid (joins a Solar inspection)' }];
}

// Every pre-quote question an inspection answer can fill: [{ id, label }].
function inspFillChoices() {
  const lists = [
    typeof SOLAR_QUESTIONS !== 'undefined' ? SOLAR_QUESTIONS : [],
    typeof BATTERY_QUESTIONS !== 'undefined' ? BATTERY_QUESTIONS : [],
    ...(typeof TEMPLATE_QUESTIONS === 'object' ? Object.values(TEMPLATE_QUESTIONS) : []),
  ];
  const seen = new Set();
  return lists.flat().filter(q => q && q.id && !seen.has(q.id) && seen.add(q.id)).map(q => ({ id: q.id, label: q.label }));
}

async function loadInspectionTemplates() {
  const listEl = document.getElementById('insp-templates-list');
  // the quote's question lists, for the proposal type boxes and the "fills" picker
  await loadJsOnce('/js/template-questions.js?v=9', () => typeof TEMPLATE_INFO === 'object').catch(() => {});
  const { data: templates, error } = await supabaseClient.from('inspection_checklist_templates').select('*').order('sort_order');
  if (error) { listEl.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
  inspTemplatesCache = templates || [];
  if (!inspTemplatesCache.length) { listEl.innerHTML = '<p class="subtitle">No templates yet - add one below.</p>'; return; }

  const { data: allItems } = await supabaseClient.from('inspection_checklist_items').select('*').order('sort_order');
  inspItemsCache = {};
  (allItems || []).forEach(it => { (inspItemsCache[it.template_id] = inspItemsCache[it.template_id] || []).push(it); });

  renderInspTemplatesList();
}

function renderInspTemplatesList() {
  const listEl = document.getElementById('insp-templates-list');
  listEl.innerHTML = INSP_GROUPS.map(g => {
    const templates = inspTemplatesCache.filter(t => (t.checklist_type || 'site_inspection') === g.type);
    if (!templates.length && g.type === 'job_sheet') return '';
    return `
    <div style="margin-bottom:18px;">
      <h3 style="font-size:13px; margin:0 0 8px;">${g.heading}</h3>
      ${templates.length ? templates.map(inspTemplateRowHtml).join('') : '<p class="subtitle">None yet.</p>'}
    </div>`;
  }).join('');
  wireInspTemplateRows();
}

function inspItemRowHtml(it, i, items, isSite) {
  const parent = it.parent_item_id ? items.find(p => p.id === it.parent_item_id) : null;
  const fill = it.fills_answer ? inspFillChoices().find(q => q.id === it.fills_answer) : null;
  const lines = [
    it.description ? escapeHtml(it.description) : '',
    it.item_type === 'choice' && Array.isArray(it.options) ? 'Choices: ' + escapeHtml(it.options.join(', ')) : '',
    it.task_text ? `Suggests a task ${it.task_when === 'answered' ? 'when answered' : `on "${escapeHtml(it.task_when || '')}"`}: ${escapeHtml(it.task_text)}` : '',
    it.fills_answer ? `Fills the quote's answer: ${escapeHtml(fill ? fill.label : it.fills_answer)}` : '',
    parent ? `Shown when "${escapeHtml(parent.label)}" = ${it.show_when_parent_answer ? 'Yes' : 'No'}` : '',
  ].filter(Boolean);
  return `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; padding:6px 0; ${i > 0 ? 'border-top:1px solid var(--border);' : ''}">
      <div>
        <span class="badge ${it.item_type === 'photo' ? 'info' : 'draft'}">${INSP_KIND_LABELS[it.item_type] || escapeHtml(it.item_type)}</span>
        <strong style="margin-left:6px;">${escapeHtml(it.label)}</strong> ${!isSite && !it.required ? '<span class="subtitle">(optional)</span>' : ''}
        ${lines.map(l => `<p class="subtitle" style="margin:2px 0 0; font-size:12px;">${l}</p>`).join('')}
      </div>
      <div style="display:flex; gap:4px; flex-shrink:0;">
        <button type="button" class="secondary rename-item-btn" data-id="${it.id}" style="font-size:11px; padding:4px 8px;">Rename</button>
        <button type="button" class="secondary move-item-btn" data-id="${it.id}" data-dir="up" style="font-size:11px; padding:4px 8px;" ${i === 0 ? 'disabled' : ''}>&uarr;</button>
        <button type="button" class="secondary move-item-btn" data-id="${it.id}" data-dir="down" style="font-size:11px; padding:4px 8px;" ${i === items.length - 1 ? 'disabled' : ''}>&darr;</button>
        <button type="button" class="secondary delete-item-btn" data-id="${it.id}" style="font-size:11px; padding:4px 8px;">Delete</button>
      </div>
    </div>`;
}

function inspAddItemHtml(t, items, isSite) {
  const d = `data-template="${t.id}"`;
  return `
    <div style="margin-top:12px; padding:12px; background:var(--surface-2); border-radius:8px;">
      <p class="subtitle" style="margin:0 0 8px; font-weight:600;">Add item</p>
      <div class="grid cols-2">
        <div>
          <label style="margin-top:0">Type</label>
          <select class="new-item-type" ${d}>
            <option value="photo">Photo</option>
            <option value="yes_no">Yes/No question</option>
            ${isSite ? '<option value="choice">Choice question</option><option value="text">Short answer</option>' : ''}
          </select>
        </div>
        <div>
          <label style="margin-top:0">Label</label>
          <input class="new-item-label" ${d} placeholder="e.g. Switchboard" />
        </div>
      </div>
      <label>Description / instructions (optional)</label>
      <input class="new-item-desc" ${d} placeholder="e.g. Clear photo of the main switchboard with all breakers visible." />
      ${isSite ? `
        <div class="new-item-question" ${d} style="display:none;">
          <div class="new-item-choices-wrap" ${d} style="display:none;">
            <label>Choices, separated by commas</label>
            <input class="new-item-choices" ${d} placeholder="e.g. Tile, Tin, Other" />
          </div>
          <div class="grid cols-2">
            <div>
              <label>Task it suggests (optional)</label>
              <input class="new-item-task" ${d} placeholder="e.g. Apply for the meter upgrade" />
            </div>
            <div>
              <label>Suggest it when the answer is</label>
              <input class="new-item-task-when" ${d} placeholder="Yes, No, a choice, or leave blank for any answer" />
            </div>
          </div>
          <label>Fills this pre-quote answer on the quote (optional)</label>
          <select class="new-item-fills" ${d}>
            <option value="">Nothing</option>
            ${inspFillChoices().map(q => `<option value="${escapeHtml(q.id)}">${escapeHtml(q.label)}</option>`).join('')}
          </select>
        </div>` : `
        <label>Only show when...</label>
        <select class="new-item-parent" ${d}>
          <option value="">Always shown</option>
          ${items.filter(it => it.item_type === 'yes_no').map(it => `
            <option value="${it.id}|true">"${escapeHtml(it.label)}" = Yes</option>
            <option value="${it.id}|false">"${escapeHtml(it.label)}" = No</option>`).join('')}
        </select>
        <label style="display:flex; align-items:center; gap:6px; margin-top:8px; font-weight:400;">
          <input type="checkbox" class="new-item-required" ${d} checked style="width:auto;" /> Required
        </label>`}
      <button type="button" class="secondary add-item-btn" ${d} style="margin-top:10px;">Add item</button>
      <div class="add-item-msg" ${d}></div>
    </div>`;
}

function inspTemplateRowHtml(t) {
  const items = inspItemsCache[t.id] || [];
  const expanded = expandedTemplateId === t.id;
  const isSite = (t.checklist_type || 'site_inspection') === 'site_inspection';
  const types = t.proposal_types || [];
  const usedFor = inspProposalTypes().filter(p => types.includes(p.key)).map(p => p.label).join(', ');
  return `
    <div style="border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div>
          <strong>${escapeHtml(t.name)}</strong> ${!t.active ? '<span class="badge draft">Inactive</span>' : ''}
          <span class="subtitle" style="margin-left:6px;">${items.length} item${items.length === 1 ? '' : 's'}${isSite ? ` &middot; ${usedFor ? 'for ' + escapeHtml(usedFor) : 'not tied to a proposal type (picked by hand on a lead)'}` : ''}</span>
        </div>
        <div>
          <button type="button" class="secondary toggle-template-btn" data-id="${t.id}" style="font-size:12px; padding:6px 10px;">${expanded ? 'Hide items' : 'Manage items'}</button>
          <button type="button" class="secondary toggle-active-btn" data-id="${t.id}" data-active="${t.active}" style="font-size:12px; padding:6px 10px;">${t.active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" class="secondary delete-template-btn" data-id="${t.id}" style="font-size:12px; padding:6px 10px;">Delete</button>
        </div>
      </div>
      ${expanded ? `
        <div style="margin-top:10px; padding-top:10px; border-top:1px solid var(--border);">
          ${isSite ? `
            <div style="display:flex; flex-wrap:wrap; gap:4px 14px; margin-bottom:10px;">
              <span class="subtitle" style="font-size:12px; width:100%;">Used for inspections on these proposal types:</span>
              ${inspProposalTypes().map(p => `<label style="display:flex; align-items:center; gap:5px; margin:0; font-weight:400; font-size:13px;"><input type="checkbox" class="template-type-box" data-id="${t.id}" value="${p.key}" ${types.includes(p.key) ? 'checked' : ''} style="width:auto;" /> ${escapeHtml(p.label)}</label>`).join('')}
            </div>` : ''}
          ${items.length ? items.map((it, i) => inspItemRowHtml(it, i, items, isSite)).join('') : '<p class="subtitle">No items yet.</p>'}
          ${inspAddItemHtml(t, items, isSite)}
        </div>` : ''}
    </div>`;
}

function wireInspTemplateRows() {
  const listEl = document.getElementById('insp-templates-list');
  const on = (selector, event, handler) => listEl.querySelectorAll(selector).forEach(el => el.addEventListener(event, () => handler(el)));
  const run = async (query) => {
    const { error } = await query;
    if (error) { alert(error.message); return false; }
    await loadInspectionTemplates();
    return true;
  };

  on('.toggle-template-btn', 'click', btn => {
    expandedTemplateId = expandedTemplateId === btn.dataset.id ? null : btn.dataset.id;
    renderInspTemplatesList();
  });
  on('.toggle-active-btn', 'click', btn => run(supabaseClient.from('inspection_checklist_templates').update({ active: btn.dataset.active !== 'true' }).eq('id', btn.dataset.id)));
  on('.delete-template-btn', 'click', async btn => {
    if (!confirm('Delete this template? Only possible if no inspection has ever used it.')) return;
    const { error } = await supabaseClient.from('inspection_checklist_templates').delete().eq('id', btn.dataset.id);
    if (error) { alert('Could not delete - ' + (error.message.includes('violates foreign key') ? 'this template has already been used by a scheduled inspection.' : error.message)); return; }
    await loadInspectionTemplates();
  });
  on('.template-type-box', 'change', box => {
    const types = [...listEl.querySelectorAll(`.template-type-box[data-id="${box.dataset.id}"]:checked`)].map(b => b.value);
    run(supabaseClient.from('inspection_checklist_templates').update({ proposal_types: types }).eq('id', box.dataset.id));
  });
  on('.rename-item-btn', 'click', btn => {
    const item = Object.values(inspItemsCache).flat().find(it => it.id === btn.dataset.id);
    const label = (prompt('Label', item.label) || '').trim();
    if (label && label !== item.label) run(supabaseClient.from('inspection_checklist_items').update({ label }).eq('id', item.id));
  });
  on('.move-item-btn', 'click', btn => moveInspItem(btn.dataset.id, btn.dataset.dir));
  on('.delete-item-btn', 'click', btn => {
    if (!confirm('Delete this item? Any answers already recorded for it on past inspections go with it; photos stay.')) return;
    run(supabaseClient.from('inspection_checklist_items').delete().eq('id', btn.dataset.id));
  });
  on('.add-item-btn', 'click', btn => addInspItem(btn.dataset.template));
  // the question boxes show for a question, the choices box for a choice
  on('.new-item-type', 'change', sel => {
    const of = cls => listEl.querySelector(`.${cls}[data-template="${sel.dataset.template}"]`);
    if (of('new-item-question')) of('new-item-question').style.display = sel.value === 'photo' ? 'none' : '';
    if (of('new-item-choices-wrap')) of('new-item-choices-wrap').style.display = sel.value === 'choice' ? '' : 'none';
  });
}

async function moveInspItem(itemId, dir) {
  const templateId = Object.keys(inspItemsCache).find(tid => inspItemsCache[tid].some(it => it.id === itemId));
  const items = inspItemsCache[templateId];
  const i = items.findIndex(it => it.id === itemId);
  const swapWith = dir === 'up' ? i - 1 : i + 1;
  if (swapWith < 0 || swapWith >= items.length) return;
  const a = items[i], b = items[swapWith];
  const { error } = await supabaseClient.from('inspection_checklist_items').update({ sort_order: b.sort_order }).eq('id', a.id);
  if (!error) await supabaseClient.from('inspection_checklist_items').update({ sort_order: a.sort_order }).eq('id', b.id);
  await loadInspectionTemplates();
}

async function addInspItem(templateId) {
  const of = cls => document.querySelector(`.${cls}[data-template="${templateId}"]`);
  const val = cls => (of(cls) ? of(cls).value.trim() : '');
  const msgEl = of('add-item-msg');
  const template = inspTemplatesCache.find(t => t.id === templateId);
  const isSite = (template.checklist_type || 'site_inspection') === 'site_inspection';
  const itemType = val('new-item-type');
  const label = val('new-item-label');
  if (!label) { msgEl.innerHTML = '<div class="error-box">Enter a label.</div>'; return; }
  const options = itemType === 'choice' ? val('new-item-choices').split(',').map(o => o.trim()).filter(Boolean) : null;
  if (itemType === 'choice' && options.length < 2) { msgEl.innerHTML = '<div class="error-box">Give at least two choices, separated by commas.</div>'; return; }

  const isQuestion = isSite && itemType !== 'photo';
  const taskText = isQuestion ? val('new-item-task') : '';
  const [parentItemId, showWhen] = val('new-item-parent') ? val('new-item-parent').split('|') : [null, null];
  const existing = inspItemsCache[templateId] || [];
  const { error } = await supabaseClient.from('inspection_checklist_items').insert({
    template_id: templateId, item_type: itemType, label, description: val('new-item-desc') || null,
    required: isSite ? false : of('new-item-required').checked,
    parent_item_id: parentItemId || null, show_when_parent_answer: parentItemId ? showWhen === 'true' : null,
    options,
    task_text: taskText || null,
    task_when: taskText ? (val('new-item-task-when') || (itemType === 'yes_no' ? 'Yes' : 'answered')) : null,
    fills_answer: isQuestion ? (val('new-item-fills') || null) : null,
    sort_order: existing.length ? Math.max(...existing.map(it => it.sort_order)) + 1 : 1,
  });
  if (error) { msgEl.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
  await loadInspectionTemplates();
}

document.getElementById('add-template-btn').addEventListener('click', async () => {
  const msg = document.getElementById('insp-templates-msg');
  const name = document.getElementById('new-template-name').value.trim();
  const checklistType = document.getElementById('new-template-type').value;
  if (!name) { msg.innerHTML = '<div class="error-box">Enter a template name.</div>'; return; }
  const sameType = inspTemplatesCache.filter(t => (t.checklist_type || 'site_inspection') === checklistType);
  const nextSort = sameType.length ? Math.max(...sameType.map(t => t.sort_order)) + 1 : 1;
  const { error } = await supabaseClient.from('inspection_checklist_templates').insert({ name, sort_order: nextSort, checklist_type: checklistType });
  if (error) { msg.innerHTML = `<div class="error-box">${escapeHtml(error.message)}</div>`; return; }
  document.getElementById('new-template-name').value = '';
  msg.innerHTML = '';
  await loadInspectionTemplates();
});
