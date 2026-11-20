// Formbay forms (solar PV, battery BSTC, and the two together) and the job they belong to (item 101).
// How it works, in one place:
//   syncForm        reads one form from Formbay, keeps it in formbay_forms and brings the job up to date
//   fileFormDocs    files the form's photos and documents on the job (photos, Documents, the CCEW card)
//   findForms       Formbay forms not yet on a job, the ones at this job's address first
//   createOptions   what the Create Formbay form panel needs: people, brands, the job's details
//   createForm      makes the form in Formbay as a draft and links it to the job
//   equipmentList   Formbay's own panel, inverter and battery lists for the panel's pick lists
// Called by formbay-sync.js, formbay-create-form.js (a person, pricing roles) and
// formbay-poll-background.js (every 15 minutes). Service role throughout.
// Writes: formbay_forms, job_stcs (the Formbay number and status), projects (NMI, Formbay status,
// inverter serials, the CCEW), customer_assets, project_photos, project_documents, storage.
// Never writes money: a sale's price comes from the payment advice import on the STCs page.
// Signing and Submit stay in Formbay's own app: they are the installer's declaration.

const { formbayCall, formbayPatch, formbayFile } = require('./formbay');

// Formbay's form status -> the STC line status the rest of the app uses (STC_STATUSES).
const STC_STATUS = {
  new: 'pending_installer_action', in_progress: 'pending_installer_action', installed: 'pending_retailer_action',
  submitted: 'pending_cer_audit', uploaded: 'pending_cer_audit', approved: 'approved_for_sale', rejected: 'pending_retailer_action',
};
const STC_ORDER = ['not_lodged', 'pending_installer_action', 'pending_retailer_action', 'pending_cer_audit', 'approved_for_sale', 'sold', 'paid'];
// The two kinds of form: Formbay's addresses for each, the STC line it feeds and the job's own figures.
const KINDS = {
  bstc: { label: 'battery', form: 'bstc_form', list: 'bstc_form_list', docsList: 'bstc_docs_list', count: 'calbstc', jobCount: 'bstc_quantity', jobPrice: 'bstc_price_per_certificate' },
  pv: { label: 'solar', form: 'pv_form', list: 'pv_form_list', docsList: 'pv_docs_list', count: 'calrec', jobCount: 'stc_quantity', jobPrice: 'stc_price_per_certificate' },
};
const NOT_FILED = /selfie|installer photo/i;         // photos of the installer, no use on the job
const IS_CCEW = /certificate of testing|ccew|compliance.*electrical/i;
const MAX_PHOTO = 1920;

// 'dd/mm/yyyy' -> 'yyyy-mm-dd'; anything else (Formbay sends 'NA') -> null.
function isoDate(v) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(v || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
const lines = (v) => String(v || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
const unique = (list) => Array.from(new Set(list.filter(Boolean)));
const formAddress = (f) => [[f.punitnum, f.pstreetnum].filter(Boolean).join('/'), f.pstreetname, f.pstreettype, f.pcity, f.pstate, f.ppostalcode].filter(Boolean).join(' ');

// ---------- read one form, bring the job up to date ----------

// formId: Formbay's number; ftype: 'pv' or 'bstc' (worked out from Formbay's lists when not given).
// projectId is needed only the first time (it links the form to the job).
// Returns { ok, row } or { ok: false, error }.
// confirmed: a person said yes to a form whose address is not the job's (linking only).
async function syncForm(db, token, { formId, ftype = null, projectId = null, userId = null, confirmed = false }) {
  const id = String(formId).trim();
  if (!ftype) {
    let unanswered = false;
    for (const t of Object.keys(KINDS)) {
      const list = await formbayCall(token, KINDS[t].list);
      if (!Array.isArray(list.json)) unanswered = true;
      else if (list.json.map(String).includes(id)) { ftype = t; break; }
    }
    if (!ftype) return { ok: false, error: unanswered ? 'Formbay did not answer. Try again.' : `Formbay has no solar or battery form ${id}.` };
  }
  const kind = KINDS[ftype];
  if (!kind) return { ok: false, error: 'Unknown kind of Formbay form.' };
  const r = await formbayCall(token, `${kind.form}?formid=${encodeURIComponent(id)}`);
  const form = r.status === 200 && r.json && !Array.isArray(r.json) && STC_STATUS[r.json.status] ? r.json : null;

  const { data: existing, error: exErr } = await db.from('formbay_forms').select('*').eq('ftype', ftype).eq('formbay_job_id', id).maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (!form) {
    const error = r.status === 404 ? `Formbay has no ${kind.label} form ${id}.` : `Formbay did not answer (${r.status || r.text}).`;
    if (existing) await db.from('formbay_forms').update({ sync_error: error }).eq('id', existing.id);
    return { ok: false, error };
  }
  if (!existing && !projectId) return { ok: false, error: 'This Formbay form is not linked to a job yet.' };
  if (existing && projectId && existing.project_id !== projectId) return { ok: false, error: 'This Formbay form is already linked to another job.' };
  // The poll, the tab opening and Check now can land together: one read in 15 seconds is enough.
  if (existing && existing.synced_at && !existing.sync_error && Date.now() - new Date(existing.synced_at).getTime() < 15000) return { ok: true, row: existing };
  if (!existing) {
    // One form of each kind per job: a second would add a second STC line at the job's full count.
    const { data: sameKind } = await db.from('formbay_forms').select('formbay_job_id').eq('project_id', projectId).eq('ftype', ftype).limit(1);
    if (sameKind && sameKind.length) return { ok: false, error: `This job already has Formbay ${kind.label} form ${sameKind[0].formbay_job_id}.` };
  }
  if (!existing && !confirmed) {
    const { data: job } = await db.from('projects').select('client_address').eq('id', projectId).maybeSingle();
    if (!job) return { ok: false, error: 'Job not found.' };
    if (!sameAddress(form, job.client_address)) return { ok: false, confirm: true, error: `Formbay form ${id} is at ${formAddress(form)}, which is not this job's address.` };
  }

  const docsRes = await formbayCall(token, kind.docsList, { form: { formid: id, group_id: form.group_id || '' } });
  const patch = { job_status: form.sold_date ? 'sold' : form.status, form, synced_at: new Date().toISOString(), sync_error: null };
  if (Array.isArray(docsRes.json)) patch.docs = docsRes.json;

  const write = existing
    ? db.from('formbay_forms').update(patch).eq('id', existing.id)
    : db.from('formbay_forms').insert({ ...patch, project_id: projectId, ftype, formbay_job_id: id, created_by: userId });
  const { data: row, error } = await write.select('*').single();
  if (error) return { ok: false, error: error.message };

  // A form the Clean Energy Regulator rejects needs a person: say so once, when it happens.
  if (existing && form.status === 'rejected' && existing.job_status !== 'rejected') {
    await needsYou(db, row, `Formbay ${kind.label} form ${id} was rejected by the Clean Energy Regulator. Open Formbay to see why and fix it.`, 'rejected');
  }
  try { await applyToJob(db, row); } catch (err) {
    await db.from('formbay_forms').update({ sync_error: String(err.message || err) }).eq('id', row.id);
    return { ok: false, error: String(err.message || err), row };
  }
  return { ok: true, row };
}

// Something only a person in Formbay can do (the app aims for there to be none): a task on the job
// for whoever made or linked the form, and a notification to their phone. `key` keeps it to once.
async function needsYou(db, row, words, key) {
  try {
    const { data: job } = await db.from('projects').select('job_number').eq('id', row.project_id).maybeSingle();
    await db.from('job_tasks').insert({ project_id: row.project_id, description: words, assigned_to_user_id: row.created_by, created_by: row.created_by, task_type: 'prejob' });
    if (row.created_by) {
      await db.rpc('create_notification', {
        p_user: row.created_by, p_kind: 'formbay', p_title: `${job && job.job_number ? `J${job.job_number}: ` : ''}Formbay needs you`,
        p_body: words, p_link: `/project.html?id=${row.project_id}`, p_actor: null, p_dedupe: `formbay:${row.formbay_job_id}:${key}`,
      });
    }
  } catch (err) { console.error('Formbay needsYou:', err.message || err); }
}

// The job side of a form: its STC line, the job's NMI and Formbay status, and (once the installer
// has signed) the equipment with its serial numbers.
async function applyToJob(db, row) {
  const form = row.form;
  const { data: project, error: pErr } = await db.from('projects')
    .select('id, client_id, client_address, nmi, formbay_lodgement_id, stc_quantity, stc_price_per_certificate, bstc_quantity, bstc_price_per_certificate, panel_serial_numbers, inverter_serial_numbers, clients(name)')
    .eq('id', row.project_id).single();
  if (pErr) throw pErr;

  // The STC line: the one this form already has, else the job's line of this kind with no Formbay number, else a new one.
  const kind = KINDS[row.ftype];
  const { data: stcs, error: sErr } = await db.from('job_stcs').select('id, stc_type, status, formbay_job_id, sold_on').eq('project_id', project.id).order('created_at');
  if (sErr) throw sErr;
  let line = stcs.find(s => s.id === row.job_stc_id) || stcs.find(s => s.stc_type === row.ftype && s.formbay_job_id === row.formbay_job_id)
    || stcs.find(s => s.stc_type === row.ftype && !s.formbay_job_id);
  const status = row.job_status === 'sold' ? 'sold' : STC_STATUS[form.status];
  const linePatch = { formbay_job_id: row.formbay_job_id, commercial: String(form.commercial) === '1', updated_at: new Date().toISOString() };
  // The line follows the form forwards only (a status typed ahead of Formbay, and Paid from the
  // payment advice, stay), except a rejection, which sends it back to the retailer.
  if (!line || form.status === 'rejected' || STC_ORDER.indexOf(status) > STC_ORDER.indexOf(line.status)) linePatch.status = status;
  if (form.sold_date && !(line && line.sold_on)) linePatch.sold_on = isoDate(form.sold_date) || String(form.sold_date).slice(0, 10);
  if (line) {
    const { error } = await db.from('job_stcs').update(linePatch).eq('id', line.id);
    if (error) throw error;
  } else {
    const count = Math.round(Number(project[kind.jobCount])) || Math.round(Number(form[kind.count])) || 0;
    const insert = { ...linePatch, project_id: project.id, stc_type: row.ftype, stc_count: count, created_by: row.created_by };
    if (Number(project[kind.jobPrice]) > 0) insert.booked_price = Number(project[kind.jobPrice]);
    const { data, error } = await db.from('job_stcs').insert(insert).select('id, status').single();
    if (error) throw error;
    line = data;
  }
  if (row.job_stc_id !== line.id) await db.from('formbay_forms').update({ job_stc_id: line.id }).eq('id', row.id);

  // The job: NMI when it has none, and the Formbay status the handover check reads (the least
  // advanced STC line wins, paid counts as sold; the same rule as the job page).
  const all = stcs.filter(s => s.id !== line.id).map(s => s.status).concat(linePatch.status || line.status);
  const least = all.sort((a, b) => STC_ORDER.indexOf(a) - STC_ORDER.indexOf(b))[0];
  const projectPatch = { formbay_lodgement_status: least === 'not_lodged' ? null : least === 'paid' ? 'sold' : least };
  if (!String(project.nmi || '').trim() && String(form.nmi || '').trim()) projectPatch.nmi = String(form.nmi).trim();
  if (!project.formbay_lodgement_id) projectPatch.formbay_lodgement_id = row.formbay_job_id;

  if (isoDate(form.installer_signee_date)) {
    // The job's own serial boxes (the handover check reads them) take the form's serials too, added to what is there.
    const serials = await makeEquipment(db, row, project);
    for (const [column, found] of [['panel_serial_numbers', serials.panels], ['inverter_serial_numbers', serials.inverters]]) {
      const merged = unique([...lines(project[column]), ...found]);
      if (merged.length > lines(project[column]).length) projectPatch[column] = merged.join('\n');
    }
  }
  const { error: upErr } = await db.from('projects').update(projectPatch).eq('id', project.id);
  if (upErr) throw upErr;
}

// One Customer equipment row for each thing on the form: the battery and its inverters (a battery
// form), the panels and the inverter (a solar form). A row this form already made is updated; a row
// typed by hand on the job (same kind, a shared serial number or the only one of its kind) is taken
// over and never doubled; typed values are kept.
// Returns { panels, inverters }: the serial numbers the job's handover fields carry too.
async function makeEquipment(db, row, project) {
  const form = row.form;
  const installed = isoDate(form.idate);
  const from = `From Formbay form ${row.formbay_job_id}.`;
  const inverterSerials = unique(form.inverterserialnumbersname || []);
  const wanted = [];
  let panelSerials = [];
  if (row.ftype === 'pv') {
    panelSerials = unique(form.serialnumbersname || []);
    if (form.model) wanted.push({ asset_type: 'solar', make: form.brand, model: form.model, quantity: Number(form.npanels) || 1, serials: panelSerials, notes: `${Number(form.ratedpower) || ''} kW. ${from}` });
    if (form.modeli) wanted.push({ asset_type: 'inverter', make: form.brandi, model: form.modeli, quantity: 1, serials: inverterSerials, notes: from });
  } else {
    // Each battery model on the form is its own row; Formbay lists the serial numbers for the form as
    // a whole, so they sit on the first.
    (form.batteries || []).forEach((battery, i) => wanted.push({
      asset_type: 'battery', make: battery.brand_short_name || battery.brand, model: battery.model, quantity: Number(battery.quantity) || 1,
      serials: i === 0 ? unique([...(form.battery_serials || []), ...(form.serialnumbersname || [])]) : [],
      notes: `${Number(battery.usable_capacity) || ''} kWh usable. ${from}`,
    }));
    (form.inverters || []).forEach((inv, i) => wanted.push({
      asset_type: 'inverter', make: inv.brand_short_name || inv.brand, model: inv.model, quantity: Number(inv.quantity) || 1,
      serials: i === 0 ? inverterSerials : [], notes: from,
    }));
  }
  const found = { panels: panelSerials, inverters: inverterSerials };
  if (!wanted.length) return found;

  const { data: onJob, error } = await db.from('customer_assets').select('*').eq('project_id', project.id).neq('status', 'decommissioned').order('created_at');
  if (error) throw error;
  const taken = new Set();
  for (const w of wanted) {
    // This form's own rows are matched by kind and order (never by model, which a person may retype).
    const sameKind = onJob.filter(a => a.asset_type === w.asset_type && !taken.has(a.id));
    const mine = sameKind.find(a => a.formbay_form_id === row.id)
      || sameKind.find(a => !a.formbay_form_id && lines(a.serial_numbers).some(s => w.serials.includes(s)))
      || (sameKind.length === 1 && !sameKind[0].formbay_form_id ? sameKind[0] : null);
    // A hybrid inverter is on both a job's solar form and its battery form: the row the other form
    // made (a shared serial number, or the same model) gets this form's serials and stays one row.
    const shared = mine ? null : onJob.find(a => a.asset_type === w.asset_type && a.formbay_form_id && a.formbay_form_id !== row.id
      && (lines(a.serial_numbers).some(x => w.serials.includes(x)) || (!!w.model && a.model === w.model)));
    if (shared) {
      const merged = unique([...lines(shared.serial_numbers), ...w.serials]);
      if (merged.length > lines(shared.serial_numbers).length) {
        const { error: e } = await db.from('customer_assets').update({ serial_numbers: merged.join('\n') }).eq('id', shared.id);
        if (e) throw e;
      }
      continue;
    }
    if (mine) taken.add(mine.id);
    if (mine) {
      const patch = { formbay_form_id: row.id, serial_numbers: unique([...lines(mine.serial_numbers), ...w.serials]).join('\n') };
      if (!mine.make) patch.make = w.make;
      if (!mine.model) patch.model = w.model;
      if (!mine.installed_at && installed) patch.installed_at = installed;
      if (!mine.warranty_expires) Object.assign(patch, await warrantyFor(db, w, mine.installed_at || installed));
      const { error: e } = await db.from('customer_assets').update(patch).eq('id', mine.id);
      if (e) throw e;
    } else {
      const { error: e } = await db.from('customer_assets').insert({
        client_id: project.client_id, project_id: project.id, client_name: project.clients ? project.clients.name : null,
        site_address: project.client_address, asset_type: w.asset_type, name: [w.make, w.model].filter(Boolean).join(' ') || w.asset_type,
        make: w.make, model: w.model, serial_numbers: w.serials.join('\n'), quantity: w.quantity, installed_at: installed,
        notes: w.notes, formbay_form_id: row.id, created_by: row.created_by, ...(await warrantyFor(db, w, installed)),
      });
      if (e) throw e;
    }
  }
  if (!row.equipment_made_at) await db.from('formbay_forms').update({ equipment_made_at: new Date().toISOString() }).eq('id', row.id);
  return found;
}

// The warranty for a model is asked once (on the first one, on the job's Formbay card) and
// remembered: the next one of the same model gets the same number of years from its install date.
async function warrantyFor(db, w, installed) {
  if (!installed || !w.model) return {};
  const { data } = await db.from('customer_assets').select('installed_at, warranty_expires, warranty_notes')
    .eq('asset_type', w.asset_type).eq('model', w.model).not('warranty_expires', 'is', null).not('installed_at', 'is', null)
    .order('created_at', { ascending: false }).limit(1);
  const last = data && data[0];
  if (!last) return {};
  const years = Math.round((new Date(last.warranty_expires) - new Date(last.installed_at)) / (365.25 * 86400000));
  if (!(years > 0)) return {};
  const d = new Date(`${installed}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return { warranty_expires: d.toISOString().slice(0, 10), warranty_notes: last.warranty_notes };
}

// ---------- photos and documents ----------

// Files up to `limit` of the form's photos and documents not yet on the job. Photos go to the job's
// Photos (made smaller first, the Formbay name as the caption), PDFs to Documents > Formbay, and a
// certificate of testing to the job's CCEW card when the job has none. Returns how many were filed.
async function fileFormDocs(db, token, row, { limit = 8 } = {}) {
  const filed = { ...(row.filed || {}) };
  // A file that failed is tried again on later runs, three times in all.
  const todo = (row.docs || []).filter(d => d.fileid && (!filed[d.fileid] || (filed[d.fileid].failed && filed[d.fileid].tries < 3)
    || (filed[d.fileid].claimed && Date.now() - filed[d.fileid].claimed > 30 * 60 * 1000)));   // a claim left by a run that died
  let done = 0;
  for (const doc of todo) {
    if (done >= limit) break;
    try {
      if (NOT_FILED.test(doc.name || '')) { filed[doc.fileid] = { skipped: true }; continue; }
      // Claimed before the download, so a second run that overlaps this one leaves it alone.
      filed[doc.fileid] = { claimed: Date.now() };
      await db.from('formbay_forms').update({ filed }).eq('id', row.id);
      const file = await formbayFile(token, row.ftype, doc.fileid);
      const isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(doc.filename || '');
      filed[doc.fileid] = isPdf ? await filePdf(db, row, doc, file.bytes) : await filePhoto(db, row, doc, file.bytes);
      done++;
    } catch (err) {
      console.error(`Formbay file ${doc.fileid} on form ${row.formbay_job_id}:`, err.message || err);
      filed[doc.fileid] = { failed: String(err.message || err).slice(0, 200), tries: (((row.filed || {})[doc.fileid] || {}).tries || 0) + 1 };
      done++;
    }
    await db.from('formbay_forms').update({ filed }).eq('id', row.id);
  }
  await db.from('formbay_forms').update({ filed }).eq('id', row.id);
  return done;
}

async function filePhoto(db, row, doc, bytes) {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const img = await loadImage(bytes);
  const scale = Math.min(1, MAX_PHOTO / Math.max(img.width, img.height));
  const canvas = createCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const jpeg = await canvas.encode('jpeg', 82);
  const path = `${row.project_id}/formbay-${row.formbay_job_id}-${doc.fileid}.jpg`;
  const { error: upErr } = await db.storage.from('site-photos').upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
  if (upErr) throw upErr;
  const url = db.storage.from('site-photos').getPublicUrl(path).data.publicUrl;
  const { error } = await db.from('project_photos').insert({ project_id: row.project_id, url, caption: String(doc.name || 'Formbay photo').slice(0, 200) });
  if (error) throw error;
  return { photo: url };
}

async function filePdf(db, row, doc, bytes) {
  const name = `${String(doc.name || 'Formbay document').replace(/[^a-zA-Z0-9 ._-]/g, '').trim() || 'Formbay document'}.pdf`;
  if (IS_CCEW.test(doc.name || '')) {
    const path = `ccew/${row.project_id}/formbay-${doc.fileid}.pdf`;
    const { error: upErr } = await db.storage.from('project-documents').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw upErr;
    // Never replaces a certificate someone uploaded on the job.
    const { data, error } = await db.from('projects').update({ ccew_file_path: path, ccew_not_required_reason: null })
      .eq('id', row.project_id).is('ccew_file_path', null).select('id');
    if (error) throw error;
    if (data && data.length) return { ccew: path };
  }
  const path = `${row.project_id}/formbay/${doc.fileid}-${name.replace(/\s+/g, '_')}`;
  const { error: upErr } = await db.storage.from('project-documents').upload(path, bytes, { contentType: 'application/pdf', upsert: true });
  if (upErr) throw upErr;
  const { error } = await db.from('project_documents').insert({ project_id: row.project_id, folder: 'Formbay', file_path: path, file_name: name, mime_type: 'application/pdf' });
  if (error) throw error;
  return { document: path };
}

// ---------- find a form made in Formbay ----------

// Does the form sit at this job's address? Street number, the first word of the street and the
// postcode must all be in the job's address (suburbs differ too often to use).
function sameAddress(form, jobAddress) {
  const a = ` ${String(jobAddress || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ')} `;
  const word = String(form.pstreetname || '').toUpperCase().split(/\s+/).filter(w => w.length > 2)[0] || String(form.pstreetname || '').toUpperCase();
  return !!(form.pstreetnum && form.ppostalcode && word)
    && a.includes(` ${String(form.pstreetnum).toUpperCase()} `) && a.includes(` ${form.ppostalcode} `) && a.includes(` ${word} `);
}

// Formbay solar and battery forms not on any job yet (newest 10 of each), the ones at this job's address first.
async function findForms(db, token, projectId) {
  const { data: project, error } = await db.from('projects').select('client_address').eq('id', projectId).single();
  if (error) return { ok: false, error: error.message };
  const { data: linked } = await db.from('formbay_forms').select('project_id, ftype, formbay_job_id');
  const taken = new Set((linked || []).map(l => `${l.ftype} ${l.formbay_job_id}`));
  // A job takes one form of each kind, so a kind it already has is left out.
  const has = new Set((linked || []).filter(l => l.project_id === projectId).map(l => l.ftype));
  const kinds = Object.keys(KINDS).filter(t => !has.has(t));
  const lists = await Promise.all(kinds.map(t => formbayCall(token, KINDS[t].list)));
  const bad = lists.find(l => !Array.isArray(l.json));
  if (bad) return { ok: false, error: `Formbay did not answer (${bad.status || bad.text}).` };
  const wanted = kinds.flatMap((ftype, i) => lists[i].json.map(String).filter(id => !taken.has(`${ftype} ${id}`)).slice(-10).reverse().map(id => ({ ftype, id })));
  const read = await Promise.all(wanted.map(w => formbayCall(token, `${KINDS[w.ftype].form}?formid=${encodeURIComponent(w.id)}`)));
  const forms = wanted.map((w, i) => ({ ...w, f: read[i].json })).filter(x => x.f && x.f.status).map(({ ftype, id, f }) => ({
    formId: id, ftype, kind: KINDS[ftype].label, address: formAddress(f), owner: [f.ofname, f.osname].filter(Boolean).join(' '),
    status: f.status, installDate: isoDate(f.idate), model: f.model || '', match: sameAddress(f, project.client_address),
  }));
  forms.sort((x, y) => Number(y.match) - Number(x.match));
  return { ok: true, forms };
}

// ---------- create a form ----------

// Splits a job's free text address ("21 Kendall St, Byron Bay NSW 2481, Australia" or two lines) into
// Formbay's parts. streetTypes is Formbay's { ST: 'STREET', ... }. A best guess a person checks.
function parseAddress(text, streetTypes = {}) {
  const parts = String(text || '').replace(/,?\s*Australia\s*$/i, '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  const out = { unit_number: '', street_number: '', street_name: '', street_type: '', city: '', state: '', postcode: '' };
  const tail = /^(.*?)\s*\b(NSW|QLD|VIC|ACT|TAS|SA|WA|NT)\b\s*(\d{4})?$/i.exec(parts[parts.length - 1] || '');
  if (tail) {
    out.state = tail[2].toUpperCase(); out.postcode = tail[3] || '';
    out.city = (tail[1] || (parts.length > 2 ? parts[parts.length - 2] : '')).toUpperCase();
    if (!tail[1] && parts.length === 2) out.city = '';
  }
  const street = /^(?:(\S+)\s*\/\s*)?(\d+[A-Za-z]?(?:-\d+)?)\s+(.+)$/.exec(parts[0] || '');
  if (street) {
    out.unit_number = street[1] || ''; out.street_number = street[2];
    const words = street[3].toUpperCase().split(/\s+/);
    const last = words[words.length - 1].replace(/\./g, '');
    const code = Object.keys(streetTypes).find(k => k === last || String(streetTypes[k]).toUpperCase() === last);
    if (code && words.length > 1) { out.street_type = code; words.pop(); }
    // Some saved addresses have lost the break after the street ("328 Back Creek RoadPumpenbil"): a
    // last word that starts with a street type is split into the type and the suburb.
    if (!code && words.length > 1) {
      const glued = Object.keys(streetTypes).map(k => [k, String(streetTypes[k]).toUpperCase()])
        .filter(([, name]) => name.length >= 4 && last.startsWith(name) && last.length > name.length + 2).sort((x, y) => y[1].length - x[1].length)[0];
      if (glued) { out.street_type = glued[0]; words.pop(); if (!out.city) out.city = last.slice(glued[1].length); }
    }
    out.street_name = words.join(' ');
  }
  return out;
}

// Formbay's own equipment lists, by the panel's name for each (brand and series narrow the next one).
const LISTS = {
  battery_series: (q) => `pv_inverter_battery_series?${new URLSearchParams({ b_brand: q.brand, bstc: 1 })}`,
  battery_models: (q) => `pv_inverter_battery_models?${new URLSearchParams({ b_brand: q.brand, b_series: q.series, bstc: 1 })}`,
  panel_models: (q) => `pv_panel_models?${new URLSearchParams({ brand: q.brand })}`,
  inverter_series: (q) => `pv_inverter_series?${new URLSearchParams({ brand: q.brand })}`,
  inverter_models: (q) => `pv_inverter_models?${new URLSearchParams({ brand: q.brand, series: q.series })}`,
  // With a battery on the form Formbay lists only the inverters it accepts for battery STCs.
  battery_inverter_series: (q) => `pv_inverter_series?${new URLSearchParams({ brand: q.brand, bstc: 1 })}`,
  battery_inverter_models: (q) => `pv_inverter_models?${new URLSearchParams({ brand: q.brand, series: q.series, bstc: 1 })}`,
};
const names = (json) => (Array.isArray(json) ? json : []).map(b => (typeof b === 'string' ? b : (b && (b.model || b.series || b.brand || b.name)) || '')).filter(Boolean);
async function equipmentList(token, list, q) {
  if (!LISTS[list]) return { ok: false, error: 'Unknown list' };
  const r = await formbayCall(token, LISTS[list]({ brand: String(q.brand || ''), series: String(q.series || '') }));
  return Array.isArray(r.json) ? { ok: true, list: names(r.json) } : { ok: false, error: 'Formbay did not send its list. Try again.' };
}

// Who may be put on a form, from Formbay's own list of the company's people. Formbay shows each
// person's accreditations: grid connected, stand-alone (off-grid) and the battery endorsement.
// A battery on the grid needs the battery endorsement; anything off-grid needs the stand-alone one.
function people(json) {
  return (Array.isArray(json) ? json : []).map(i => ({
    id: String(i.iid), name: [i.ifname, i.isname].filter(Boolean).join(' '),
    grid: String(i.grid_connected_install) === '1', gridDesign: String(i.grid_connected_design) === '1',
    offGrid: String(i.sps_install) === '1', offGridDesign: String(i.sps_design) === '1',
    battery: /battery/i.test(String(i.endorsement || '')),
  }));
}
// role: 'installer' or 'designer'. The same rule the panel uses to offer people.
function mayDo(person, role, { offGrid, battery }) {
  if (offGrid) return role === 'designer' ? person.offGridDesign : person.offGrid;
  if (battery) return person.battery && (role === 'designer' ? person.gridDesign : person.grid);
  return role === 'designer' ? person.gridDesign : person.grid;
}

// What the Create panel opens with: who can be the installer, Formbay's brand lists, and the job's
// own details. `what` is the kind of form the job looks like: 'pv' (solar), 'pv_bstc' (solar and
// battery) or 'bstc' (battery), from the quote's STC and battery STC counts and its template.
async function createOptions(db, token, projectId) {
  const { data: project, error } = await db.from('projects')
    .select('id, job_number, client_address, nmi, proposal_template, stc_quantity, bstc_quantity, clients(name, email, phone, client_type)').eq('id', projectId).single();
  if (error) return { ok: false, error: error.message };
  const [installers, batteryBrands, panelBrands, inverterBrands, streetTypes, lines2, last] = await Promise.all([
    formbayCall(token, 'pv_installers'), formbayCall(token, 'pv_inverter_battery_brands?bstc=1'), formbayCall(token, 'pv_panel_brands'),
    formbayCall(token, 'pv_inverter_brands'), formbayCall(token, 'street_types'),
    db.from('cost_centre_line_items').select('description, cost_centres!inner(project_id)').eq('cost_centres.project_id', projectId).limit(300),
    db.from('formbay_forms').select('form').order('created_at', { ascending: false }).limit(1),
  ]);
  if (!Array.isArray(installers.json)) return { ok: false, error: `Formbay did not answer (${installers.status || installers.text}).` };
  const types = streetTypes.json && !Array.isArray(streetTypes.json) ? streetTypes.json : {};
  // The brand whose first word is on one of the quote's lines ("Sungrow SBH 25kW ..." -> Sungrow ...).
  const quoteText = ` ${((lines2.data || []).map(l => l.description).join(' ')).toLowerCase()} `;
  const guess = (list) => list.find(b => { const w = b.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, ''); return w.length > 2 && new RegExp(`\\b${w}\\b`).test(quoteText); }) || '';
  const lists = { battery: names(batteryBrands.json), panel: names(panelBrands.json), inverter: names(inverterBrands.json) };
  const client = project.clients || {};
  const person = String(client.name || '').trim().split(/\s+/);
  const lastForm = last.data && last.data[0] ? last.data[0].form : null;
  // A kind of form the job already has is not offered again ("Add a battery form" on a job with a solar one).
  const { data: has } = await db.from('formbay_forms').select('ftype').eq('project_id', projectId);
  const got = new Set((has || []).map(h => h.ftype));
  const solar = !got.has('pv') && (got.has('bstc') || Number(project.stc_quantity) > 0 || project.proposal_template === 'solar');
  const battery = !got.has('bstc') && (got.has('pv') || Number(project.bstc_quantity) > 0 || project.proposal_template === 'battery');
  return {
    ok: true,
    installers: people(installers.json),
    brands: lists, streetTypes: types,
    prefill: {
      what: solar && battery ? 'pv_bstc' : solar ? 'pv' : 'bstc', has: Array.from(got),
      fname: person[0] || '', sname: person.slice(1).join(' '), email: client.email || '', phone: String(client.phone || '').replace(/\s+/g, ''),
      ...parseAddress(project.client_address, types), nmi: project.nmi || '',
      battery_brand: guess(lists.battery), panel_brand: guess(lists.panel), inverter_brand: guess(lists.inverter),
      installer: lastForm ? String(lastForm.iid || '') : '', commercial: client.client_type === 'company',
    },
  };
}

// f: the Create panel's fields; f.what is 'pv', 'pv_bstc' or 'bstc'. Makes the form in Formbay (a
// draft: nothing is signed or submitted), links it to the job and reads it straight back. Solar with
// a battery comes back as two linked forms, and both go on the job. A refusal comes back with
// Formbay's own words.
async function createForm(db, token, { projectId, userId, f }) {
  const what = ['pv', 'pv_bstc', 'bstc'].includes(f.what) ? f.what : 'bstc';
  const solar = what !== 'bstc';
  const battery = what !== 'pv';
  const { data: already } = await db.from('formbay_forms').select('ftype, formbay_job_id').eq('project_id', projectId);
  const clash = (already || []).find(x => (x.ftype === 'pv' && solar) || (x.ftype === 'bstc' && battery));
  if (clash) return { ok: false, error: `This job already has Formbay ${KINDS[clash.ftype].label} form ${clash.formbay_job_id}.` };
  const clean = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
  const whole = (v, min) => Math.max(min, Math.round(Number(v)) || min);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(f.date));
  const need = { 'First name': f.fname, 'Last name': f.sname, 'Street number': f.street_number, 'Street name': f.street_name, Suburb: f.city, State: f.state, Postcode: f.postcode, Installer: f.installer, 'Install date': date };
  // The inverter goes on every form, a battery one too, even when it is already on site (owner,
  // 20 Nov 2026; Formbay refuses a battery form without one: "At least one of Battery or Inverter must be smart").
  Object.assign(need, { 'Inverter brand': f.inverter_brand, 'Inverter model': f.inverter_model });
  if (solar) Object.assign(need, { 'Panel brand': f.panel_brand, 'Panel model': f.panel_model, 'Number of panels': Number(f.panel_count) > 0 });
  if (battery) Object.assign(need, { 'Battery brand': f.battery_brand, 'Battery model': f.battery_model });
  // Formbay's battery STC questions, answered by the person making the form (owner, 20 Nov 2026:
  // "we didn't answer these questions with the form"). Never answered by the app itself.
  if (battery) Object.assign(need, { 'Solar is commissioned before or with the battery': f.pv_first });
  if (what === 'bstc') Object.assign(need, { 'First time, additional or replacement battery': f.battery_install, 'Solar already at this address': f.pv_working, 'Total solar 100 kW or less': f.pv_limit });
  const missing = Object.keys(need).filter(k => !need[k] || !clean(need[k]));
  if (missing.length) return { ok: false, error: `Still needed: ${missing.join(', ')}.` };

  // The people on the form must hold the accreditation for this kind of job (owner, 20 Nov 2026):
  // checked here against Formbay's list, not only in the panel.
  const offGrid = f.off_grid === true || f.off_grid === 'yes';
  const staff = people((await formbayCall(token, 'pv_installers')).json);
  const team = { installer: clean(f.installer), designer: clean(f.designer) || clean(f.installer), electrician: clean(f.electrician) || clean(f.installer) };
  for (const role of ['installer', 'designer']) {
    const who = staff.find(x => x.id === team[role]);
    if (!who) return { ok: false, error: `Pick the ${role} from the list.` };
    if (!mayDo(who, role, { offGrid, battery })) {
      return { ok: false, error: `${who.name} is not accredited in Formbay as the ${role} for ${offGrid ? 'an off-grid' : battery ? 'a grid connected battery' : 'a grid connected'} job. Pick someone else.` };
    }
  }
  if (!staff.some(x => x.id === team.electrician)) return { ok: false, error: 'Pick the electrician from the list.' };
  const equipment = [];
  if (solar) equipment.push({ type: 0, brand: clean(f.panel_brand), model: clean(f.panel_model), count: whole(f.panel_count, 1) });
  // Up to four inverters and four batteries (the panel's Add another): the first has no number, then 2, 3, 4.
  // An added row counts once its model is picked.
  for (const n of ['', '2', '3', '4']) {
    if (clean(f[`inverter${n}_model`])) equipment.push({ type: 1, brand: clean(f[`inverter${n}_brand`]), series: clean(f[`inverter${n}_series`]), model: clean(f[`inverter${n}_model`]), count: whole(f[`inverter${n}_count`], 1) });
  }
  for (const n of ['', '2', '3', '4']) {
    if (battery && clean(f[`battery${n}_model`])) {
      equipment.push({
        type: 3, brand: clean(f[`battery${n}_brand`]), series: clean(f[`battery${n}_series`]), model: clean(f[`battery${n}_model`]), count: whole(f[`battery${n}_count`], 1),
        setting: 0, aggregated: 0, existing_model: '', existing_modules: 0, number_of_modules: 0,
      });
    }
  }
  const body = {
    v: 2, type: solar ? 'pv' : 'bstc', date: `${date[3]}/${date[2]}/${date[1]}`,
    // Formbay's grid codes, read off the forms made in its own app: 0 on the grid with no battery
    // (J7088), 2 on the grid with a battery (J7009, J7081). 1 is taken to be off-grid: not yet seen on a real form.
    grid: { nmi: clean(f.nmi, 11).replace(/\D/g, ''), type: offGrid ? 1 : battery ? 2 : 0, meter_no: '' },
    team: { designer: Number(team.designer), installer: Number(team.installer), electrician: Number(team.electrician) },
    address: {
      city: clean(f.city).toUpperCase(), state: clean(f.state, 3).toUpperCase(), postcode: clean(f.postcode, 4),
      unit_type: clean(f.unit_number) ? 'UNIT' : '', unit_number: clean(f.unit_number, 10),
      street_number: clean(f.street_number, 12), street_name: clean(f.street_name).toUpperCase(), street_type: clean(f.street_type, 8).toUpperCase(),
    },
    customers: { owner: { fname: clean(f.fname), sname: clean(f.sname), email: clean(f.email), phone: clean(f.phone, 20).replace(/[^\d+]/g, '') } },
    equipment,
    commercial: f.commercial ? 1 : 0,
  };
  if (solar) body.installation = Math.min(3, Math.max(0, Math.round(Number(f.installation)) || 0));   // 0 new, 1 replacement, 2 additional, 3 extension
  if (battery) {
    if (f.pv_first !== 'yes') return { ok: false, error: 'Battery STCs need the solar commissioned before or with the battery. Formbay will not take the form otherwise.' };
    body.isPvInstalledBeforeBattery = true;
  }
  if (what === 'bstc') {
    if (f.pv_limit !== 'yes') return { ok: false, error: 'Battery STCs need the total solar at the address to be 100 kW or less. Formbay will not take the form otherwise.' };
    body.isPvCapacityWithinLimit = true;
    body.installation = { first: 0, replacement: 1, additional: 2 }[f.battery_install] || 0;
    // Formbay asks one of these two, depending on whether it already knows of solar at the address;
    // both are sent and the one it does not want is dropped if it says so (see the retry below).
    body.isExistingSolarPvWorking = f.pv_working !== 'replacing';
    if (f.pv_working !== 'replacing') body.existingPvSystem = true;
  } else if (what === 'pv_bstc' && body.installation > 0 && f.pv_limit === 'yes') {
    body.isPvCapacityWithinLimit = true;
  }
  if (what === 'pv_bstc') { body.is_bstc = 1; body.battery_installation = { type: 0, comment: '', additional_wattage: '' }; }
  // NSW: Formbay makes the CCEW with the form, under the company's contractor licence.
  if (body.address.state === 'NSW') {
    const groups = await formbayCall(token, 'clients');
    const group = Array.isArray(groups.json) ? groups.json[0] : null;
    const cc = group ? await formbayCall(token, `ccew_contractors?group_id=${encodeURIComponent(group)}`) : null;
    const c = cc && Array.isArray(cc.json) ? cc.json.find(x => String(x.is_deleted) !== '1') : null;
    if (c) body.ccew = { licence_id: c.licence_id, associated_person_id: Number(c.associated_person_id), special_conditions: { generator: 0, high_voltage: 0, over_100_amps: 0, hazardous_area: 0, unmetered_supply: 0 } };
  }

  // Formbay asks one of the two existing-solar questions, not both: if it refuses the form naming one,
  // the form is made without that one rather than not at all (it is then answered in Formbay).
  // (Formbay refuses a job reference on this call, and the owner does not need one: 20 Nov 2026.)
  let r = await formbayCall(token, 'create_form?version=2', { json: body, timeout: 25000 });
  const dropped = [];
  if (r.status === 400) {
    const said = JSON.stringify(r.json || r.text || '');
    for (const key of ['existingPvSystem', 'isExistingSolarPvWorking']) if (key in body && said.includes(key)) { delete body[key]; dropped.push(key); }
    if (dropped.length) r = await formbayCall(token, 'create_form?version=2', { json: body, timeout: 25000 });
  }
  // Kept so a refusal can be read later (finance roles): what Formbay was sent and what it said.
  await db.from('formbay_webhook_events').insert({ event_type: 'create.attempt', formbay_job_id: `project ${projectId}`, payload: { status: r.status, sent: body, answer: r.json || r.text } });
  const made = [];
  if (r.json && solar && (r.json.pv_formid || r.json.formid)) made.push(['pv', String(r.json.pv_formid || r.json.formid)]);
  if (r.json && battery && (r.json.bstc_formid || (!solar && r.json.formid))) made.push(['bstc', String(r.json.bstc_formid || r.json.formid)]);
  if (!made.length) {
    const fields = r.json && (r.json.fields || r.json.errors);
    const detail = fields && typeof fields === 'object' ? Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ') : '';
    const said = (r.json && (r.json.error || r.json.error_message || r.json.message)) || r.text || 'no answer';
    return { ok: false, error: `Formbay did not make the form: ${said}${detail ? ` (${detail})` : ''}` };
  }
  let warning = what === 'pv_bstc' && made.length < 2 ? 'Formbay made the solar form but did not say which battery form goes with it. Use Add a battery form to find it.' : '';
  const read = await Promise.all(made.map(([ftype, formId]) => syncForm(db, token, { formId, ftype, projectId, userId, confirmed: true })));
  for (let i = 0; i < made.length; i++) {
    if (read[i].ok) continue;
    const [ftype, formId] = made[i];
    // Formbay made the form but reading it back failed: keep the link, the 15 minute check fills it in.
    if (!read[i].row) {
      const { error: linkErr } = await db.from('formbay_forms').insert({ project_id: projectId, ftype, formbay_job_id: formId, created_by: userId, sync_error: read[i].error });
      if (linkErr) { warning = `Formbay made ${KINDS[ftype].label} form ${formId}, but it could not be put on this job. Use Find this job in Formbay, do not create it again.`; continue; }
    }
    warning = warning || `Formbay made form ${formId}. Its details will show here within 15 minutes.`;
  }
  // Answers Formbay takes only once the form exists (plan 101b): where the battery is, and optimisers.
  // Each is sent as an edit, kept for reading later, and checked by reading the form back.
  const notes = [];
  const idOf = (t) => (made.find(m => m[0] === t) || [])[1];
  const edit = async (path, mediaType, change) => {
    const e = await formbayPatch(token, path, mediaType, change);
    await db.from('formbay_webhook_events').insert({ event_type: 'patch.attempt', formbay_job_id: path, payload: { status: e.status, sent: change, answer: e.json || e.text } });
    return e.status >= 200 && e.status < 300;
  };
  if (battery && idOf('bstc') && ['indoor', 'outdoor'].includes(f.battery_location)) {
    const code = f.battery_location === 'outdoor' ? 1 : 0;   // as Formbay's own page orders them: Indoor, Outdoor
    await edit(`job_details_prcs/${idOf('bstc')}`, 'application/vnd.fb.patch_job_details_prcs+json;v=1', { battery_location: code });
    const back = await formbayCall(token, `bstc_form?formid=${idOf('bstc')}`);
    if (!back.json || String(back.json.battery_location) !== String(code)) notes.push(`the battery location (${f.battery_location})`);
  }
  if (solar && idOf('pv') && ['yes', 'no'].includes(f.optimisers)) {
    const took = await edit(`job_details/${idOf('pv')}`, 'application/vnd.fb.patch_job_details+json;v=1', { optimiserInstalled: f.optimisers === 'yes' });
    if (!took && f.optimisers === 'yes') notes.push('that optimisers are installed');
  }

  // What Formbay kept is checked against what was asked for, so a question it did not take is not missed.
  const kept = read.find((x, i) => x.ok && made[i][0] === 'bstc');
  if (dropped.includes('existingPvSystem') || dropped.includes('isExistingSolarPvWorking')) notes.push('the existing solar question');
  if (what === 'bstc' && f.battery_install !== 'first' && kept && String(kept.row.form.install_type) === '0') notes.push(`the battery installation type (Formbay shows First time, you picked ${f.battery_install})`);
  if (notes.length) {
    const words = `Formbay form ${made[0][1]}: Formbay did not take ${notes.join(', ')} from the app. Set it in Formbay.`;
    await needsYou(db, { project_id: projectId, created_by: userId, formbay_job_id: made[0][1] }, words, 'create');
    warning = `${warning ? `${warning} ` : ''}The form is made. ${words.replace(/^Formbay form \d+: /, '')} A task is on the job.`;
  }
  return warning ? { ok: true, warning } : { ok: true };
}

module.exports = { syncForm, fileFormDocs, findForms, createOptions, createForm, equipmentList, isoDate };
