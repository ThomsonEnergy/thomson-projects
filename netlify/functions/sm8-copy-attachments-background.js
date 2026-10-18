// POST /.netlify/functions/sm8-copy-attachments-background
// Admin only. Second step of the ServiceM8 move, after sm8-import-jobs.js
// (the import screen starts it on its own once jobs are imported). First
// the labour check-ins and checklists (_shared/sm8-labour.js, a summary of
// each run kept in sm8_copy_runs), then every attachment on the imported
// jobs - pictures into the job's Photos (project_photos, site-photos
// bucket, same as a photo taken on site), everything else into its
// Documents under a "ServiceM8" folder.
//
// A background function (15 minute limit) because downloading a few
// hundred photos takes far longer than a normal call allows. Progress
// lives in sm8_attachment_copies (migration 154), which the import screen
// polls. Safe to run again: a file is queued once, copied files are never
// copied again, failed ones are retried, and if time runs out the rest
// stay pending for the next run. Only reads from ServiceM8.

const fetch = require('node-fetch');
const { requireAdmin } = require('./_shared/require-admin');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { sm8GetAll, SM8_BASE } = require('./_shared/sm8-import');
const { copyLabourAndChecklists, sm8JobGroups, sm8DateToIso } = require('./_shared/sm8-labour');

// Stop picking up new files with time to spare before the 15 minute limit.
const TIME_BUDGET_MS = 13 * 60 * 1000;
const STALE_CLAIM_MS = 16 * 60 * 1000;

// Formats the Photos tab can show (pictures, and videos, which it plays);
// anything else (PDF, Word, HEIC...) goes to Documents, where it can still
// be opened or downloaded. ServiceM8 saves most site photos as AVIF.
const PHOTO_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm',
};
const DOC_MIME = {
  pdf: 'application/pdf', heic: 'image/heic', heif: 'image/heif', txt: 'text/plain', csv: 'text/csv',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  dwg: 'application/acad', zip: 'application/zip',
};

function fileParts(att) {
  const rawName = String(att.attachment_name || '').trim() || 'ServiceM8 file';
  const typeExt = String(att.file_type || '').replace(/^\./, '').toLowerCase();
  const nameExt = (rawName.match(/\.([a-z0-9]{1,5})$/i) || [])[1]?.toLowerCase() || '';
  const ext = typeExt || nameExt || 'bin';
  const fileName = nameExt ? rawName : `${rawName}.${ext}`;
  const kind = PHOTO_EXT[ext] ? 'photo' : 'document';
  const mime = PHOTO_EXT[ext] || DOC_MIME[ext] || 'application/octet-stream';
  return { fileName, ext, kind, mime };
}

const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

// "Photo.avif" / "Video.mp4" are ServiceM8's default names: no caption
// beats a caption that just says Photo.
function captionOf(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  return /^(photo|video|image)$/i.test(base) ? null : base || null;
}

// The real date and person behind a ServiceM8 file: when it was taken or
// attached (timestamp, else the record's create date) and who added it
// (created_by_staff_uuid, through the staff matches). Either can be missing.
function attachmentMeta(att, profileByStaff) {
  return {
    createdAt: (att && (sm8DateToIso(att.timestamp) || sm8DateToIso(att.create_date) || sm8DateToIso(att.edit_date))) || null,
    staffId: (att && profileByStaff.get(att.created_by_staff_uuid)) || null,
  };
}

// groups: project id -> every ServiceM8 job uuid on it (main job plus its
// lettered jobs, sm8JobGroups), so 4515A-D's files land on 4515.
// Returns the imported jobs' ServiceM8 attachment records by uuid.
async function queueAttachments(supabaseAdmin, apiKey, groups) {
  const projectByJob = new Map();
  for (const [projectId, uuids] of groups) uuids.forEach(u => projectByJob.set(u, projectId));
  if (!projectByJob.size) return new Map();

  // One bulk call (ServiceM8's filter has no "in"), then keep only the
  // imported jobs' files.
  const attachments = await sm8GetAll(apiKey, 'attachment', "related_object eq 'job' and active eq 1");
  const rows = attachments
    .filter(a => projectByJob.has(a.related_object_uuid))
    .map(a => {
      const { fileName, kind } = fileParts(a);
      return { project_id: projectByJob.get(a.related_object_uuid), sm8_job_uuid: a.related_object_uuid, sm8_attachment_uuid: a.uuid, file_name: fileName, kind };
    });

  for (let i = 0; i < rows.length; i += 500) {
    const { error: upErr } = await supabaseAdmin
      .from('sm8_attachment_copies')
      .upsert(rows.slice(i, i + 500), { onConflict: 'sm8_attachment_uuid', ignoreDuplicates: true });
    if (upErr) throw upErr;
  }
  return new Map(attachments.filter(a => projectByJob.has(a.related_object_uuid)).map(a => [a.uuid, a]));
}

// Files copied before photos took AVIF and video went into Documents: take
// them out (row and stored file) and queue them again as photos.
async function requeueNewPhotoTypes(supabaseAdmin) {
  const { data: rows, error } = await supabaseAdmin.from('sm8_attachment_copies')
    .select('id, file_name, project_document_id, project_documents(file_path)')
    .eq('kind', 'document');
  if (error) throw error;
  let moved = 0;
  for (const row of rows || []) {
    if (fileParts({ attachment_name: row.file_name }).kind !== 'photo') continue;
    if (row.project_documents?.file_path) await supabaseAdmin.storage.from('project-documents').remove([row.project_documents.file_path]);
    if (row.project_document_id) await supabaseAdmin.from('project_documents').delete().eq('id', row.project_document_id);
    const { error: upErr } = await supabaseAdmin.from('sm8_attachment_copies')
      .update({ kind: 'photo', status: 'pending', project_document_id: null, error: null, meta_synced_at: null }).eq('id', row.id);
    if (upErr) throw upErr;
    moved++;
  }
  return moved;
}

// Files copied before the real date and uploader were carried across get
// them now (from the attachment records just read), once each.
async function syncCopiedMeta(supabaseAdmin, attachments, profileByStaff) {
  const { data: rows, error } = await supabaseAdmin.from('sm8_attachment_copies')
    .select('id, sm8_attachment_uuid, file_name, project_photo_id, project_document_id')
    .eq('status', 'copied').is('meta_synced_at', null);
  if (error) throw error;
  for (const row of rows || []) {
    const { createdAt, staffId } = attachmentMeta(attachments.get(row.sm8_attachment_uuid), profileByStaff);
    if (row.project_photo_id) {
      const fields = { caption: captionOf(row.file_name) };
      if (createdAt) fields.created_at = createdAt;
      if (staffId) fields.staff_id = staffId;
      await supabaseAdmin.from('project_photos').update(fields).eq('id', row.project_photo_id);
    } else if (row.project_document_id) {
      const fields = {};
      if (createdAt) fields.created_at = createdAt;
      if (staffId) fields.uploaded_by = staffId;
      if (Object.keys(fields).length) await supabaseAdmin.from('project_documents').update(fields).eq('id', row.project_document_id);
    }
    await supabaseAdmin.from('sm8_attachment_copies').update({ meta_synced_at: new Date().toISOString() }).eq('id', row.id);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function copyOne(supabaseAdmin, apiKey, userId, row, meta) {
  // ServiceM8 allows about 180 calls a minute. When it says slow down
  // (429), wait and try the same file again rather than failing it.
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(`${SM8_BASE}/Attachment/${row.sm8_attachment_uuid}.file`, {
      headers: { 'X-API-Key': apiKey },
    });
    if (res.status !== 429) break;
    await sleep(20000);
  }
  if (!res.ok) throw new Error(`ServiceM8 download failed: ${res.status}`);
  const bytes = await res.buffer();
  if (!bytes.length) throw new Error('ServiceM8 returned an empty file');

  const { ext, kind, mime } = fileParts({ attachment_name: row.file_name });
  const contentType = res.headers.get('content-type')?.split(';')[0] || mime;

  if (kind === 'photo') {
    const path = `${row.project_id}/sm8-${row.sm8_attachment_uuid}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage.from('site-photos').upload(path, bytes, { contentType: mime, upsert: true });
    if (upErr) throw upErr;
    const { data: pub } = supabaseAdmin.storage.from('site-photos').getPublicUrl(path);
    const { data: photo, error: insErr } = await supabaseAdmin.from('project_photos')
      .insert({ project_id: row.project_id, staff_id: meta.staffId || userId, url: pub.publicUrl, caption: captionOf(row.file_name), ...(meta.createdAt ? { created_at: meta.createdAt } : {}) })
      .select('id').single();
    if (insErr) throw insErr;
    return { project_photo_id: photo.id };
  }

  const path = `documents/${row.project_id}/sm8-${row.sm8_attachment_uuid}-${safe(row.file_name)}`;
  const { error: upErr } = await supabaseAdmin.storage.from('project-documents').upload(path, bytes, { contentType: mime === 'application/octet-stream' ? contentType : mime, upsert: true });
  if (upErr) throw upErr;
  const { data: doc, error: insErr } = await supabaseAdmin.from('project_documents')
    .insert({ project_id: row.project_id, folder: 'ServiceM8', file_path: path, file_name: row.file_name, mime_type: mime === 'application/octet-stream' ? contentType : mime, uploaded_by: meta.staffId || userId, ...(meta.createdAt ? { created_at: meta.createdAt } : {}) })
    .select('id').single();
  if (insErr) throw insErr;
  return { project_document_id: doc.id };
}

exports.handler = async (event) => {
  const auth = await requireAdmin(event);
  if (!auth) return { statusCode: 403, body: '' };
  const { supabaseAdmin, user } = auth;
  const started = Date.now();

  try {
    const apiKey = await getIntegrationKey('servicem8');

    const { data: run } = await supabaseAdmin.from('sm8_copy_runs').insert({}).select('id').single();
    const { data: projects, error: projErr } = await supabaseAdmin
      .from('projects').select('id, sm8_job_uuid, sm8_job_number').not('sm8_job_uuid', 'is', null);
    if (projErr) throw projErr;
    // If the lettered-job lookup fails, still copy each main job's own records.
    let groups = new Map((projects || []).map(p => [p.id, [p.sm8_job_uuid]]));
    const summary = {};
    try {
      groups = await sm8JobGroups(apiKey, projects || []);
      await copyLabourAndChecklists(supabaseAdmin, apiKey, user.id, summary, groups);
    } catch (err) {
      console.error('sm8-copy-attachments labour/checklists error:', err.message);
      summary.error = String(err.message).slice(0, 500);
    }
    if (run) await supabaseAdmin.from('sm8_copy_runs').update({ summary, finished_at: new Date().toISOString() }).eq('id', run.id);

    // A run that crashed mid-file leaves its claim behind - hand it back.
    await supabaseAdmin.from('sm8_attachment_copies')
      .update({ status: 'pending', claimed_at: null })
      .eq('status', 'copying')
      .lt('claimed_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString());
    // Each run retries the previous run's failures once.
    await supabaseAdmin.from('sm8_attachment_copies').update({ status: 'pending' }).eq('status', 'failed');

    const { data: linked } = await supabaseAdmin.from('profiles').select('id, sm8_staff_uuid').not('sm8_staff_uuid', 'is', null);
    const profileByStaff = new Map((linked || []).map(p => [p.sm8_staff_uuid, p.id]));
    const attachments = await queueAttachments(supabaseAdmin, apiKey, groups);
    const moved = await requeueNewPhotoTypes(supabaseAdmin);
    await syncCopiedMeta(supabaseAdmin, attachments, profileByStaff);
    console.log(`sm8-copy-attachments: ${attachments.size} attachments on imported jobs, ${moved} moved from Documents to Photos`);

    let copied = 0, failed = 0;
    while (Date.now() - started < TIME_BUDGET_MS) {
      const { data: batch, error } = await supabaseAdmin
        .from('sm8_attachment_copies')
        .select('id, project_id, sm8_attachment_uuid, file_name')
        .eq('status', 'pending')
        .order('created_at')
        .limit(20);
      if (error) throw error;
      if (!batch.length) break;

      for (const row of batch) {
        if (Date.now() - started >= TIME_BUDGET_MS) break;
        // Claim it; if another run got there first the update matches nothing.
        const { data: claimed } = await supabaseAdmin.from('sm8_attachment_copies')
          .update({ status: 'copying', claimed_at: new Date().toISOString() })
          .eq('id', row.id).eq('status', 'pending')
          .select('id');
        if (!claimed || !claimed.length) continue;
        // About two downloads a second keeps well under ServiceM8's limit.
        await sleep(450);
        try {
          const links = await copyOne(supabaseAdmin, apiKey, user.id, row, attachmentMeta(attachments.get(row.sm8_attachment_uuid), profileByStaff));
          await supabaseAdmin.from('sm8_attachment_copies')
            .update({ status: 'copied', error: null, copied_at: new Date().toISOString(), meta_synced_at: new Date().toISOString(), ...links }).eq('id', row.id);
          copied++;
        } catch (err) {
          console.error('sm8-copy-attachments file error:', row.sm8_attachment_uuid, err.message);
          await supabaseAdmin.from('sm8_attachment_copies')
            .update({ status: 'failed', error: String(err.message).slice(0, 500) }).eq('id', row.id);
          failed++;
        }
      }
    }
    console.log(`sm8-copy-attachments: copied ${copied}, failed ${failed}, ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    console.error('sm8-copy-attachments error:', err.message);
  }
  return { statusCode: 200, body: '' };
};
