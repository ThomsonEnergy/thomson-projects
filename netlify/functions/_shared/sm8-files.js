// ServiceM8 files for the move off ServiceM8 (item 111), called by _shared/sm8-run.js.
// queueJobFiles() lists a job's ServiceM8 files in sm8_attachment_copies (from its raw record, no
// call to ServiceM8); copyPendingFiles() downloads the waiting ones, one ServiceM8 call each:
// pictures and videos into the job's Photos (project_photos, site-photos bucket, same as a photo
// taken on site), everything else into its Documents under a "ServiceM8" folder, each with
// ServiceM8's own date and the matched person who added it. Only reads from ServiceM8.
//
// Safe to run again: a file is queued once, copied files are never copied again, failed ones are
// retried on the next run, and whatever is left when time runs out stays waiting.
// Photos on an archived job are not sent to the picture tagger (thousands of old photos would
// each cost an AI read): they are marked as looked at, with a note saying why.
// Nothing here is shared with the client: photos and documents arrive with the share tick off.

const fetch = require('node-fetch');
const { SM8_BASE, Sm8RateLimit } = require('./sm8-import');
const { sm8DateToIso } = require('./sm8-labour');

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

// ServiceM8's own invoice PDFs ("Thomson Energy Invoice #4515B") are listed
// on the job's Invoices tab, not in Documents. "Partial Invoice #4515A"
// PDFs are ServiceM8's internal copy of each claim line on the main job,
// not what the client got, so they are not brought across at all.
const isPartialInvoice = (fileName) => /\bpartial\s+invoice\b/i.test(String(fileName || ''));
// A quote's own PDF ("Quote #4600", "Proposal") goes to its own folder.
const docFolder = (fileName) => (/\binvoice\b/i.test(fileName) ? 'ServiceM8 invoices'
  : /\b(quote|quotation|proposal)\b/i.test(fileName) ? 'ServiceM8 proposal' : 'ServiceM8');

const safe = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);

// "Photo.avif" / "Video.mp4" are ServiceM8's default names: no caption
// beats a caption that just says Photo.
function captionOf(fileName) {
  const base = String(fileName || '').replace(/\.[^.]+$/, '').trim();
  return /^(photo|video|image)$/i.test(base) ? null : base || null;
}

// The files a job's raw record lists, less ServiceM8's internal "Partial Invoice" PDFs.
const wantedFiles = (attachments) => (attachments || []).filter(a => a && a.uuid && (a.active === undefined || a.active === 1 || a.active === '1' || a.active === true) && !isPartialInvoice(fileParts(a).fileName));

// Lists a job's files to copy. Returns how many the job has (the check report's expected count).
async function queueJobFiles(supabaseAdmin, projectId, attachments) {
  const rows = wantedFiles(attachments).map(a => {
    const { fileName, kind } = fileParts(a);
    return {
      project_id: projectId, sm8_job_uuid: a.related_object_uuid, sm8_attachment_uuid: a.uuid, file_name: fileName, kind,
      // when it was taken or attached, and who added it (matched to a TEops person at copy time)
      sm8_created_at: sm8DateToIso(a.timestamp) || sm8DateToIso(a.create_date) || sm8DateToIso(a.edit_date) || null,
      sm8_staff_uuid: a.created_by_staff_uuid || null,
    };
  });
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin.from('sm8_attachment_copies')
      .upsert(rows.slice(i, i + 500), { onConflict: 'sm8_attachment_uuid', ignoreDuplicates: true });
    if (error) throw error;
  }
  return rows.length;
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
  if (res.status === 429) throw new Sm8RateLimit('a file download');
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
      .insert({ project_id: row.project_id, staff_id: meta.staffId || userId, url: pub.publicUrl, caption: captionOf(row.file_name), ...(meta.createdAt ? { created_at: meta.createdAt } : {}), ...(meta.archived ? { tagged_at: new Date().toISOString(), tag_note: 'ServiceM8 archive: not sent to the picture tagger' } : {}) })
      .select('id').single();
    if (insErr) throw insErr;
    return { project_photo_id: photo.id };
  }

  const path = `documents/${row.project_id}/sm8-${row.sm8_attachment_uuid}-${safe(row.file_name)}`;
  const { error: upErr } = await supabaseAdmin.storage.from('project-documents').upload(path, bytes, { contentType: mime === 'application/octet-stream' ? contentType : mime, upsert: true });
  if (upErr) throw upErr;
  const { data: doc, error: insErr } = await supabaseAdmin.from('project_documents')
    .insert({ project_id: row.project_id, folder: docFolder(row.file_name), file_path: path, file_name: row.file_name, mime_type: mime === 'application/octet-stream' ? contentType : mime, uploaded_by: meta.staffId || userId, ...(meta.createdAt ? { created_at: meta.createdAt } : {}) })
    .select('id').single();
  if (insErr) throw insErr;
  return { project_document_id: doc.id };
}

// Copies waiting files until the deadline (a Date.now() value) or until none are left.
// Returns { copied, failed, left }. Throws Sm8RateLimit when ServiceM8 will take no more today:
// the file it was on goes back to waiting. beat: called after each file (the run's heartbeat).
async function copyPendingFiles(supabaseAdmin, apiKey, userId, deadline, beat) {
  // A run that crashed mid-file leaves its claim behind: hand it back.
  await supabaseAdmin.from('sm8_attachment_copies')
    .update({ status: 'pending', claimed_at: null })
    .eq('status', 'copying')
    .lt('claimed_at', new Date(Date.now() - STALE_CLAIM_MS).toISOString());

  const { data: linked, error: linkErr } = await supabaseAdmin.from('profiles').select('id, sm8_staff_uuid').not('sm8_staff_uuid', 'is', null);
  if (linkErr) throw linkErr;
  const profileByStaff = new Map((linked || []).map(p => [p.sm8_staff_uuid, p.id]));

  let copied = 0, failed = 0;
  while (Date.now() < deadline) {
    const { data: batch, error } = await supabaseAdmin
      .from('sm8_attachment_copies')
      .select('id, project_id, sm8_attachment_uuid, file_name, sm8_created_at, sm8_staff_uuid, projects(pipeline_stage)')
      .eq('status', 'pending')
      .order('created_at')
      .limit(20);
    if (error) throw error;
    if (!batch.length) break;

    for (const row of batch) {
      if (Date.now() >= deadline) break;
      // Claim it; if another run got there first the update matches nothing.
      const { data: claimed } = await supabaseAdmin.from('sm8_attachment_copies')
        .update({ status: 'copying', claimed_at: new Date().toISOString() })
        .eq('id', row.id).eq('status', 'pending')
        .select('id');
      if (!claimed || !claimed.length) continue;
      // About two downloads a second keeps well under ServiceM8's limit.
      await sleep(450);
      try {
        const meta = { createdAt: row.sm8_created_at, staffId: profileByStaff.get(row.sm8_staff_uuid) || null, archived: row.projects && row.projects.pipeline_stage === 'archived' };
        const links = await copyOne(supabaseAdmin, apiKey, userId, row, meta);
        await supabaseAdmin.from('sm8_attachment_copies')
          .update({ status: 'copied', error: null, copied_at: new Date().toISOString(), meta_synced_at: new Date().toISOString(), ...links }).eq('id', row.id);
        copied++;
        if (beat) await beat();
      } catch (err) {
        if (err.rateLimited) {
          await supabaseAdmin.from('sm8_attachment_copies').update({ status: 'pending', claimed_at: null }).eq('id', row.id);
          throw err;
        }
        console.error('sm8-files file error:', row.sm8_attachment_uuid, err.message);
        await supabaseAdmin.from('sm8_attachment_copies')
          .update({ status: 'failed', error: String(err.message).slice(0, 500) }).eq('id', row.id);
        failed++;
      }
    }
  }
  const { count } = await supabaseAdmin.from('sm8_attachment_copies').select('id', { count: 'exact', head: true }).eq('status', 'pending');
  return { copied, failed, left: count || 0 };
}

// The files that failed last time get one more go on the next run.
async function retryFailedFiles(supabaseAdmin) {
  const { error } = await supabaseAdmin.from('sm8_attachment_copies').update({ status: 'pending', claimed_at: null }).eq('status', 'failed');
  if (error) throw error;
}

module.exports = { queueJobFiles, copyPendingFiles, retryFailedFiles, wantedFiles };
