// Formbay battery (BSTC) forms and the job they belong to (item 101). How it works, in one place:
//   syncForm        reads one form from Formbay, keeps it in formbay_forms and brings the job up to date
//   fileFormDocs    files the form's photos and documents on the job (photos, Documents, the CCEW card)
//   findForms       Formbay forms not yet on a job, the ones at this job's address first
//   createOptions   what the Create Formbay form panel needs: people, brands, the job's details
//   createForm      makes the form in Formbay as a draft and links it to the job
// Called by formbay-sync.js, formbay-create-form.js (a person, pricing roles) and
// formbay-poll-background.js (every 15 minutes). Service role throughout.
// Writes: formbay_forms, job_stcs (the Formbay number and status), projects (NMI, Formbay status,
// inverter serials, the CCEW), customer_assets, project_photos, project_documents, storage.
// Never writes money: a sale's price comes from the payment advice import on the STCs page.
// Signing and Submit stay in Formbay's own app: they are the installer's declaration.

const { formbayCall, formbayFile } = require('./formbay');

// Formbay's form status -> the STC line status the rest of the app uses (STC_STATUSES).
const STC_STATUS = {
  new: 'pending_installer_action', in_progress: 'pending_installer_action', installed: 'pending_retailer_action',
  submitted: 'pending_cer_audit', uploaded: 'pending_cer_audit', approved: 'approved_for_sale', rejected: 'pending_retailer_action',
};
const STC_ORDER = ['not_lodged', 'pending_installer_action', 'pending_retailer_action', 'pending_cer_audit', 'approved_for_sale', 'sold', 'paid'];
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

// formId: Formbay's number. projectId is needed only the first time (it links the form to the job).
// Returns { ok, row } or { ok: false, error }.
// confirmed: a person said yes to a form whose address is not the job's (linking only).
async function syncForm(db, token, { formId, projectId = null, userId = null, confirmed = false }) {
  const id = String(formId).trim();
  const r = await formbayCall(token, `bstc_form?formid=${encodeURIComponent(id)}`);
  const form = r.status === 200 && r.json && !Array.isArray(r.json) && STC_STATUS[r.json.status] ? r.json : null;

  const { data: existing, error: exErr } = await db.from('formbay_forms').select('*').eq('ftype', 'bstc').eq('formbay_job_id', id).maybeSingle();
  if (exErr) return { ok: false, error: exErr.message };
  if (!form) {
    const error = r.status === 404 ? `Formbay has no battery form ${id}.` : `Formbay did not answer (${r.status || r.text}).`;
    if (existing) await db.from('formbay_forms').update({ sync_error: error }).eq('id', existing.id);
    return { ok: false, error };
  }
  if (!existing && !projectId) return { ok: false, error: 'This Formbay form is not linked to a job yet.' };
  if (existing && projectId && existing.project_id !== projectId) return { ok: false, error: 'This Formbay form is already linked to another job.' };
  // The poll, the tab opening and Check now can land together: one read in 15 seconds is enough.
  if (existing && existing.synced_at && !existing.sync_error && Date.now() - new Date(existing.synced_at).getTime() < 15000) return { ok: true, row: existing };
  if (!existing && !confirmed) {
    const { data: job } = await db.from('projects').select('client_address').eq('id', projectId).maybeSingle();
    if (!job) return { ok: false, error: 'Job not found.' };
    if (!sameAddress(form, job.client_address)) return { ok: false, confirm: true, error: `Formbay form ${id} is at ${formAddress(form)}, which is not this job's address.` };
  }

  const docsRes = await formbayCall(token, 'bstc_docs_list', { form: { formid: id, group_id: form.group_id || '' } });
  const patch = { job_status: form.sold_date ? 'sold' : form.status, form, synced_at: new Date().toISOString(), sync_error: null };
  if (Array.isArray(docsRes.json)) patch.docs = docsRes.json;

  const write = existing
    ? db.from('formbay_forms').update(patch).eq('id', existing.id)
    : db.from('formbay_forms').insert({ ...patch, project_id: projectId, ftype: 'bstc', formbay_job_id: id, created_by: userId });
  const { data: row, error } = await write.select('*').single();
  if (error) return { ok: false, error: error.message };

  try { await applyToJob(db, row); } catch (err) {
    await db.from('formbay_forms').update({ sync_error: String(err.message || err) }).eq('id', row.id);
    return { ok: false, error: String(err.message || err), row };
  }
  return { ok: true, row };
}

// The job side of a form: its STC line, the job's NMI and Formbay status, and (once the installer
// has signed) the equipment with its serial numbers.
async function applyToJob(db, row) {
  const form = row.form;
  const { data: project, error: pErr } = await db.from('projects')
    .select('id, client_id, client_address, nmi, formbay_lodgement_id, bstc_quantity, bstc_price_per_certificate, inverter_serial_numbers, clients(name)')
    .eq('id', row.project_id).single();
  if (pErr) throw pErr;

  // The STC line: the one this form already has, else the job's battery line with no Formbay number, else a new one.
  const { data: stcs, error: sErr } = await db.from('job_stcs').select('id, stc_type, status, formbay_job_id, sold_on').eq('project_id', project.id).order('created_at');
  if (sErr) throw sErr;
  let line = stcs.find(s => s.id === row.job_stc_id) || stcs.find(s => s.formbay_job_id === row.formbay_job_id)
    || stcs.find(s => s.stc_type === 'bstc' && !s.formbay_job_id);
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
    const count = Math.round(Number(project.bstc_quantity)) || Math.round(Number(form.calbstc)) || 0;
    const insert = { ...linePatch, project_id: project.id, stc_type: 'bstc', stc_count: count, created_by: row.created_by };
    if (Number(project.bstc_price_per_certificate) > 0) insert.booked_price = Number(project.bstc_price_per_certificate);
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
    const inverterSerials = await makeEquipment(db, row, project);
    const merged = unique([...lines(project.inverter_serial_numbers), ...inverterSerials]);
    if (merged.length > lines(project.inverter_serial_numbers).length) projectPatch.inverter_serial_numbers = merged.join('\n');
  }
  const { error: upErr } = await db.from('projects').update(projectPatch).eq('id', project.id);
  if (upErr) throw upErr;
}

// One Customer equipment row for the battery and one per inverter model on the form. A row this
// form already made is updated; a row typed by hand on the job (same kind, a shared serial number or
// the only one of its kind) is taken over and never doubled; typed values are kept.
// Returns the inverter serial numbers (the job's handover field carries them too).
async function makeEquipment(db, row, project) {
  const form = row.form;
  const installed = isoDate(form.idate);
  const battery = (form.batteries || [])[0];
  const wanted = [];
  if (battery) {
    wanted.push({
      asset_type: 'battery', make: battery.brand_short_name || battery.brand, model: battery.model, quantity: Number(battery.quantity) || 1,
      serials: unique([...(form.battery_serials || []), ...(form.serialnumbersname || [])]),
      notes: `${Number(battery.usable_capacity) || ''} kWh usable. From Formbay form ${row.formbay_job_id}.`,
    });
  }
  const inverterSerials = unique(form.inverterserialnumbersname || []);
  (form.inverters || []).forEach((inv, i) => wanted.push({
    asset_type: 'inverter', make: inv.brand_short_name || inv.brand, model: inv.model, quantity: Number(inv.quantity) || 1,
    serials: i === 0 ? inverterSerials : [], notes: `From Formbay form ${row.formbay_job_id}.`,
  }));
  if (!wanted.length) return inverterSerials;

  const { data: onJob, error } = await db.from('customer_assets').select('*').eq('project_id', project.id).neq('status', 'decommissioned').order('created_at');
  if (error) throw error;
  const taken = new Set();
  for (const w of wanted) {
    // This form's own rows are matched by kind and order (never by model, which a person may retype).
    const sameKind = onJob.filter(a => a.asset_type === w.asset_type && !taken.has(a.id));
    const mine = sameKind.find(a => a.formbay_form_id === row.id)
      || sameKind.find(a => !a.formbay_form_id && lines(a.serial_numbers).some(s => w.serials.includes(s)))
      || (sameKind.length === 1 && !sameKind[0].formbay_form_id ? sameKind[0] : null);
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
        site_address: project.client_address, asset_type: w.asset_type, name: [w.make, w.model].filter(Boolean).join(' ') || 'Battery',
        make: w.make, model: w.model, serial_numbers: w.serials.join('\n'), quantity: w.quantity, installed_at: installed,
        notes: w.notes, formbay_form_id: row.id, created_by: row.created_by, ...(await warrantyFor(db, w, installed)),
      });
      if (e) throw e;
    }
  }
  if (!row.equipment_made_at) await db.from('formbay_forms').update({ equipment_made_at: new Date().toISOString() }).eq('id', row.id);
  return inverterSerials;
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
      const file = await formbayFile(token, doc.fileid);
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

// Formbay battery forms not on any job yet (newest 12), the ones at this job's address first.
async function findForms(db, token, projectId) {
  const { data: project, error } = await db.from('projects').select('client_address').eq('id', projectId).single();
  if (error) return { ok: false, error: error.message };
  const list = await formbayCall(token, 'bstc_form_list');
  if (!Array.isArray(list.json)) return { ok: false, error: `Formbay did not answer (${list.status || list.text}).` };
  const { data: linked } = await db.from('formbay_forms').select('formbay_job_id').eq('ftype', 'bstc');
  const taken = new Set((linked || []).map(l => l.formbay_job_id));
  const forms = [];
  for (const id of list.json.map(String).filter(i => !taken.has(i)).slice(-12).reverse()) {
    const r = await formbayCall(token, `bstc_form?formid=${encodeURIComponent(id)}`);
    const f = r.json;
    if (!f || !f.status) continue;
    forms.push({
      formId: id, address: formAddress(f), owner: [f.ofname, f.osname].filter(Boolean).join(' '), status: f.status,
      installDate: isoDate(f.idate), model: f.model || '', match: sameAddress(f, project.client_address),
    });
  }
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
    out.street_name = words.join(' ');
  }
  return out;
}

async function createOptions(db, token, projectId) {
  const { data: project, error } = await db.from('projects')
    .select('id, job_number, client_address, nmi, clients(name, email, phone, client_type)').eq('id', projectId).single();
  if (error) return { ok: false, error: error.message };
  const [installers, brands, streetTypes, lines2, last] = await Promise.all([
    formbayCall(token, 'pv_installers'), formbayCall(token, 'pv_inverter_battery_brands?bstc=1'), formbayCall(token, 'street_types'),
    db.from('cost_centre_line_items').select('description, cost_centres!inner(project_id)').eq('cost_centres.project_id', projectId).limit(300),
    db.from('formbay_forms').select('form').order('created_at', { ascending: false }).limit(1),
  ]);
  if (!Array.isArray(installers.json)) return { ok: false, error: `Formbay did not answer (${installers.status || installers.text}).` };
  const types = streetTypes.json && !Array.isArray(streetTypes.json) ? streetTypes.json : {};
  const brandList = (Array.isArray(brands.json) ? brands.json : []).map(b => (typeof b === 'string' ? b : (b.brand || b.name || ''))).filter(Boolean);
  // The brand whose first word is on one of the quote's lines ("Sungrow SBH 25kW ..." -> Sungrow ...).
  const quoteText = ` ${((lines2.data || []).map(l => l.description).join(' ')).toLowerCase()} `;
  const brand = brandList.find(b => { const w = b.toLowerCase().split(/\s+/)[0]; return w.length > 3 && quoteText.includes(` ${w}`); }) || '';
  const client = project.clients || {};
  const names = String(client.name || '').trim().split(/\s+/);
  const lastForm = last.data && last.data[0] ? last.data[0].form : null;
  return {
    ok: true,
    installers: installers.json.map(i => ({ id: String(i.iid), name: [i.ifname, i.isname].filter(Boolean).join(' ') })),
    brands: brandList, streetTypes: types,
    prefill: {
      fname: names[0] || '', sname: names.slice(1).join(' '), email: client.email || '', phone: String(client.phone || '').replace(/\s+/g, ''),
      ...parseAddress(project.client_address, types), nmi: project.nmi || '', brand,
      installer: lastForm ? String(lastForm.iid || '') : '', commercial: client.client_type === 'company',
    },
  };
}

// f: the Create panel's fields. Makes the form in Formbay (a draft: nothing is signed or submitted),
// links it to the job and reads it straight back. A refusal comes back with Formbay's own words.
async function createForm(db, token, { projectId, userId, f }) {
  const { data: already } = await db.from('formbay_forms').select('formbay_job_id').eq('project_id', projectId).eq('ftype', 'bstc').limit(1);
  if (already && already.length) return { ok: false, error: `This job already has Formbay form ${already[0].formbay_job_id}.` };
  const clean = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(f.date));
  const need = { 'First name': f.fname, 'Last name': f.sname, 'Street number': f.street_number, 'Street name': f.street_name, Suburb: f.city, State: f.state, Postcode: f.postcode, Installer: f.installer, 'Battery brand': f.brand, 'Battery model': f.model, 'Install date': date };
  const missing = Object.keys(need).filter(k => !need[k] || !clean(need[k]));
  if (missing.length) return { ok: false, error: `Still needed: ${missing.join(', ')}.` };

  const person = Number(clean(f.installer));
  const body = {
    v: 2, type: 'bstc', date: `${date[3]}/${date[2]}/${date[1]}`,
    grid: { nmi: clean(f.nmi, 11).replace(/\D/g, ''), type: 2, meter_no: '' },   // 2: on the grid with a battery, as on our forms so far
    team: { designer: person, installer: person, electrician: person },
    address: {
      city: clean(f.city).toUpperCase(), state: clean(f.state, 3).toUpperCase(), postcode: clean(f.postcode, 4),
      unit_type: clean(f.unit_number) ? 'UNIT' : '', unit_number: clean(f.unit_number, 10),
      street_number: clean(f.street_number, 12), street_name: clean(f.street_name).toUpperCase(), street_type: clean(f.street_type, 8).toUpperCase(),
    },
    customers: { owner: { fname: clean(f.fname), sname: clean(f.sname), email: clean(f.email), phone: clean(f.phone, 20).replace(/[^\d+]/g, '') } },
    equipment: [{
      type: 3, brand: clean(f.brand), series: clean(f.series), model: clean(f.model), count: Math.max(1, Math.round(Number(f.count)) || 1),
      setting: 0, aggregated: 0, existing_model: '', existing_modules: 0, number_of_modules: Math.max(0, Math.round(Number(f.modules)) || 0),
    }],
    commercial: f.commercial ? 1 : 0,
  };
  // NSW: Formbay makes the CCEW with the form, under the company's contractor licence.
  if (body.address.state === 'NSW') {
    const groups = await formbayCall(token, 'clients');
    const group = Array.isArray(groups.json) ? groups.json[0] : null;
    const cc = group ? await formbayCall(token, `ccew_contractors?group_id=${encodeURIComponent(group)}`) : null;
    const c = cc && Array.isArray(cc.json) ? cc.json.find(x => String(x.is_deleted) !== '1') : null;
    if (c) body.ccew = { licence_id: c.licence_id, associated_person_id: Number(c.associated_person_id), special_conditions: { generator: 0, high_voltage: 0, over_100_amps: 0, hazardous_area: 0, unmetered_supply: 0 } };
  }

  const r = await formbayCall(token, 'create_form?version=2', { json: body, timeout: 25000 });
  // Kept so a refusal can be read later (finance roles): what Formbay was sent and what it said.
  await db.from('formbay_webhook_events').insert({ event_type: 'create.attempt', formbay_job_id: `project ${projectId}`, payload: { status: r.status, sent: body, answer: r.json || r.text } });
  const formId = r.json && (r.json.bstc_formid || r.json.formid);
  if (!formId) {
    const fields = r.json && (r.json.fields || r.json.errors);
    const detail = fields && typeof fields === 'object' ? Object.entries(fields).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('; ') : '';
    const said = (r.json && (r.json.error || r.json.error_message || r.json.message)) || r.text || 'no answer';
    return { ok: false, error: `Formbay did not make the form: ${said}${detail ? ` (${detail})` : ''}` };
  }
  const synced = await syncForm(db, token, { formId, projectId, userId, confirmed: true });
  if (synced.ok) return synced;
  // Formbay made the form but reading it back failed: keep the link, the 15 minute check fills it in.
  if (!synced.row) await db.from('formbay_forms').insert({ project_id: projectId, ftype: 'bstc', formbay_job_id: String(formId), created_by: userId, sync_error: synced.error });
  return { ok: true, formId: String(formId), warning: `Formbay made form ${formId}. Its details will show here within 15 minutes.` };
}

module.exports = { syncForm, fileFormDocs, findForms, createOptions, createForm, isoDate };
