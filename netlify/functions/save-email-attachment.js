// POST { email_id, part_id, project_id, to: 'photos' | 'documents', label, folder }
// Saves one attachment of a received email onto a job it is tagged to (backlog item 53):
//   photos    -> site-photos/<job id>/<ts>-<name> + a project_photos row, label as the caption
//   documents -> project-documents/documents/<job id>/<ts>-<name> + a project_documents row in the folder
// The file comes straight from Gmail on the server, so there is no 4 MB limit as there is for
// opening one in the browser. Pictures over 1 MB are squashed to 1920 px (the size compressImage()
// makes in the browser) through Supabase's image tools. The attachment's entry in
// emails.attachments gets saved_to [{ project_id, kind, id, at }] so the chip shows "On the job".
// Called by js/email-job-files.js (job Emails tab and the Inbox). Any active staff member who can
// see the conversation; the conversation must be tagged to that job. The job rows are written as
// that person, so the same rules apply as an upload in the browser (a document is filed as
// yourself, only pricing roles file into Electricity bill: guard_project_documents_writes).
// supplier_quote_request_id (pricing roles, item 81): the file is a supplier's quote for that
// request: it goes into Documents > Supplier quotes with a supplier_quotes row, and the mailbox
// worker reads it with Tally (_shared/supplier-quote-intake.js).

const { requireActiveUser } = require('./_shared/require-active-user');
const { downloadAttachment } = require('./_shared/google-client');
const { threadForUser } = require('./_shared/mailboxes');
const { getUserClient } = require('./_shared/require-admin');
const { PRICING_ROLES } = require('./_shared/require-pricing-role');
const { safeName, extOf, fileNameWithExt, markAttachmentSaved } = require('./_shared/email-attachment-files');
const { FOLDER: SUPPLIER_QUOTES_FOLDER } = require('./_shared/supplier-quote-intake');
const { startMailboxWork } = require('./_shared/gmail-sync');

const MAX_BYTES = 25 * 1024 * 1024; // Gmail's own limit
const SQUASH_OVER = 1024 * 1024;
const PHOTO_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

// The picture at 1920 px at most: put up for a moment under a temporary name, read back through
// the image tools, then removed. The original comes back if the image tools cannot do it.
async function squashPhoto(admin, buf, mime, projectId) {
  const tmp = `${projectId}/tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { error: upErr } = await admin.storage.from('site-photos').upload(tmp, buf, { contentType: mime });
    if (upErr) return buf;
    const { data, error } = await admin.storage.from('site-photos').download(tmp, { transform: { width: 1920, height: 1920, resize: 'contain', quality: 82, format: 'origin' } });
    const smaller = !error && data ? Buffer.from(await data.arrayBuffer()) : null;
    return smaller && smaller.length && smaller.length < buf.length ? smaller : buf;
  } catch (err) {
    console.error('save-email-attachment: could not squash', err.message);
    return buf;
  } finally {
    await admin.storage.from('site-photos').remove([tmp]).catch(() => {});
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  const { supabaseAdmin: admin, user } = auth;
  const asUser = getUserClient(String(event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, ''));
  try {
    const body = JSON.parse(event.body || '{}');
    const { email_id: emailId, part_id: partId, project_id: projectId, to, label, supplier_quote_request_id: requestId } = body;
    let folder = body.folder;
    if (!UUID.test(String(emailId || '')) || !UUID.test(String(projectId || '')) || partId === undefined || partId === null) return json(400, { ok: false, error: 'email_id, part_id and project_id are required.' });
    if (to !== 'photos' && to !== 'documents') return json(400, { ok: false, error: 'Choose Site Photos or Documents.' });
    let request = null;
    if (requestId) {
      if (to !== 'documents' || !UUID.test(String(requestId)) || !PRICING_ROLES.includes(auth.role)) return json(400, { ok: false, error: 'A supplier quote is filed in Documents by Admin, Finance or Sales.' });
      const { data: r } = await admin.from('supplier_quote_requests').select('id, project_id, supplier_id').eq('id', requestId).maybeSingle();
      if (!r || r.project_id !== projectId) return json(404, { ok: false, error: 'That price request is not on this job.' });
      request = r;
      folder = SUPPLIER_QUOTES_FOLDER;
    }

    const { data: email } = await admin.from('emails').select('id, thread_id, gmail_message_id, attachments').eq('id', emailId).maybeSingle();
    if (!email) return json(404, { ok: false, error: 'Email not found.' });
    const [seen, { count: tagged }] = await Promise.all([
      threadForUser(admin, email.thread_id, user.id),
      admin.from('email_job_links').select('id', { count: 'exact', head: true }).eq('thread_id', email.thread_id).eq('project_id', projectId),
    ]);
    if (!seen) return json(404, { ok: false, error: 'Email not found.' });
    if (!tagged) return json(403, { ok: false, error: 'This conversation is not tagged to that job. Tag it first.' });
    const listed = (email.attachments || []).find(a => String(a.part_id) === String(partId));
    if (!listed || listed.storage) return json(404, { ok: false, error: 'That attachment is not on this email.' });
    if ((listed.size || 0) > MAX_BYTES) return json(413, { ok: false, error: 'That file is over 25 MB.' });
    const mime = String(listed.mime || 'application/octet-stream').toLowerCase();
    if (to === 'photos' && !PHOTO_MIMES.includes(mime)) return json(400, { ok: false, error: 'Only pictures (JPG, PNG, WebP, GIF) go on Site Photos. Save this one to Documents.' });

    let buf = await downloadAttachment(email.gmail_message_id, partId, seen.mailbox);
    if (buf.length > MAX_BYTES) return json(413, { ok: false, error: 'That file is over 25 MB.' });

    const original = fileNameWithExt(listed.name, mime);
    const caption = String(label || '').trim().slice(0, 200);
    let bucket, path, table, row;
    if (to === 'photos') {
      bucket = 'site-photos'; table = 'project_photos';
      path = `${projectId}/${Date.now()}-${safeName(original)}`;
      row = { project_id: projectId, staff_id: user.id, url: admin.storage.from(bucket).getPublicUrl(path).data.publicUrl, caption: caption || original.replace(/\.[^.]+$/, '') };
    } else {
      // the label is the file name; keep the original extension so it still opens
      const ext = extOf(original);
      let fileName = (caption || original).slice(0, 140);
      if (ext && extOf(fileName) !== ext) fileName = `${fileName}.${ext}`;
      bucket = 'project-documents'; table = 'project_documents';
      path = `documents/${projectId}/${Date.now()}-${safeName(fileName)}`;
      row = { project_id: projectId, folder: String(folder || '').trim().slice(0, 60) || 'Emails', file_path: path, file_name: fileName, mime_type: mime, uploaded_by: user.id };
    }
    if (to === 'photos' && buf.length > SQUASH_OVER && mime !== 'image/gif') buf = await squashPhoto(admin, buf, mime, projectId);
    // uploaded as the person, so the file is theirs to delete later like any upload of their own
    const { error: upErr } = await asUser.storage.from(bucket).upload(path, buf, { contentType: mime });
    if (upErr) throw upErr;
    const { data: made, error } = await asUser.from(table).insert(row).select('id').single();
    if (error) { await admin.storage.from(bucket).remove([path]); return json(403, { ok: false, error: error.message }); }
    const saved = { kind: to === 'photos' ? 'photo' : 'document', id: made.id };
    await markAttachmentSaved(admin, email.id, partId, projectId, { ...saved, by: user.id });

    if (request) {
      // the supplier's quote: a row the mailbox worker reads next (it is started now)
      const { error: sqErr } = await admin.from('supplier_quotes').insert({
        project_id: projectId, supplier_id: request.supplier_id, request_id: request.id, document_id: made.id,
        file_path: path, file_name: row.file_name, mime_type: mime, email_id: email.id, attachment_part_id: String(partId), status: 'reading', created_by: user.id,
      });
      if (sqErr && !/duplicate|unique/i.test(sqErr.message)) throw sqErr;
      startMailboxWork().catch(err => console.error('save-email-attachment: could not start the mailbox worker', err.message));
    }
    return json(200, { ok: true, ...saved });
  } catch (err) {
    console.error('save-email-attachment failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
