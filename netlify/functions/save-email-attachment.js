// POST { email_id, part_id, project_id, to: 'photos' | 'documents', label, folder }
// Saves one attachment of a received email onto a job it is tagged to (backlog item 53):
//   photos    -> site-photos/<job id>/<ts>-<name> + a project_photos row, label as the caption
//   documents -> project-documents/documents/<job id>/<ts>-<name> + a project_documents row in the folder
// The file comes straight from Gmail on the server, so there is no 4 MB limit as there is for
// opening one in the browser. Pictures over 1 MB are squashed to 1920 px (the size compressImage()
// makes in the browser) through Supabase's image tools. The attachment's entry in
// emails.attachments gets saved_to [{ project_id, kind, id, at }] so the chip shows "On the job".
// Called by js/email-job-files.js (job Emails tab and the Inbox). Any active staff member who can
// see the conversation; the conversation must be tagged to that job.

const { requireActiveUser } = require('./_shared/require-active-user');
const { downloadAttachment } = require('./_shared/supplier-bill-intake');
const { threadForUser } = require('./_shared/mailboxes');

const MAX_BYTES = 25 * 1024 * 1024; // Gmail's own limit
const SQUASH_OVER = 1024 * 1024;
const PHOTO_MIMES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRICING_ROLES = ['admin', 'finance', 'sales'];
const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });
const safeName = (s) => String(s || 'file').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 100);
const extOf = (name) => { const m = String(name || '').match(/\.([a-z0-9]{1,6})$/i); return m ? m[1].toLowerCase() : ''; };

// The picture at 1920 px at most, or the original if the image tools cannot do it (it is still saved).
async function squashPhoto(admin, path, mime) {
  try {
    const { data, error } = await admin.storage.from('site-photos').download(path, { transform: { width: 1920, height: 1920, resize: 'contain', quality: 82, format: 'origin' } });
    if (error || !data) return;
    const smaller = Buffer.from(await data.arrayBuffer());
    if (smaller.length) await admin.storage.from('site-photos').upload(path, smaller, { contentType: mime, upsert: true });
  } catch (err) {
    console.error('save-email-attachment: could not squash', path, err.message);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in.' });
  const { supabaseAdmin: admin, user, role } = auth;
  try {
    const { email_id: emailId, part_id: partId, project_id: projectId, to, label, folder } = JSON.parse(event.body || '{}');
    if (!UUID.test(String(emailId || '')) || !UUID.test(String(projectId || '')) || partId === undefined || partId === null) return json(400, { ok: false, error: 'email_id, part_id and project_id are required.' });
    if (to !== 'photos' && to !== 'documents') return json(400, { ok: false, error: 'Choose Site Photos or Documents.' });

    const { data: email } = await admin.from('emails').select('id, thread_id, gmail_message_id, attachments').eq('id', emailId).maybeSingle();
    const seen = email ? await threadForUser(admin, email.thread_id, user.id) : null;
    if (!email || !seen) return json(404, { ok: false, error: 'Email not found.' });
    const { count: tagged } = await admin.from('email_job_links').select('id', { count: 'exact', head: true }).eq('thread_id', email.thread_id).eq('project_id', projectId);
    if (!tagged) return json(403, { ok: false, error: 'This conversation is not tagged to that job. Tag it first.' });
    const listed = (email.attachments || []).find(a => String(a.part_id) === String(partId));
    if (!listed || listed.storage) return json(404, { ok: false, error: 'That attachment is not on this email.' });
    if ((listed.size || 0) > MAX_BYTES) return json(413, { ok: false, error: 'That file is over 25 MB.' });
    const mime = String(listed.mime || 'application/octet-stream').toLowerCase();
    if (to === 'photos' && !PHOTO_MIMES.includes(mime)) return json(400, { ok: false, error: 'Only pictures (JPG, PNG, WebP, GIF) go on Site Photos. Save this one to Documents.' });

    const buf = await downloadAttachment(email.gmail_message_id, partId, seen.mailbox);
    if (!buf.length) return json(404, { ok: false, error: 'Gmail returned an empty file.' });
    if (buf.length > MAX_BYTES) return json(413, { ok: false, error: 'That file is over 25 MB.' });

    const original = String(listed.name || 'file');
    const caption = String(label || '').trim().slice(0, 200);
    let saved;
    if (to === 'photos') {
      const path = `${projectId}/${Date.now()}-${safeName(original)}`;
      const { error: upErr } = await admin.storage.from('site-photos').upload(path, buf, { contentType: mime });
      if (upErr) throw upErr;
      if (buf.length > SQUASH_OVER && mime !== 'image/gif') await squashPhoto(admin, path, mime);
      const { data: pub } = admin.storage.from('site-photos').getPublicUrl(path);
      const { data: row, error } = await admin.from('project_photos')
        .insert({ project_id: projectId, staff_id: user.id, url: pub.publicUrl, caption: caption || original.replace(/\.[^.]+$/, '') })
        .select('id').single();
      if (error) { await admin.storage.from('site-photos').remove([path]); throw error; }
      saved = { kind: 'photo', id: row.id };
    } else {
      const folderName = String(folder || '').trim().slice(0, 60) || 'Emails';
      if (folderName === 'Electricity bill' && !PRICING_ROLES.includes(role)) return json(403, { ok: false, error: 'Only sales, finance and admin can file into Electricity bill.' });
      // the label is the file name; keep the original extension so it still opens
      const ext = extOf(original);
      let fileName = caption || original;
      if (ext && extOf(fileName) !== ext) fileName = `${fileName}.${ext}`;
      const path = `documents/${projectId}/${Date.now()}-${safeName(fileName)}`;
      const { error: upErr } = await admin.storage.from('project-documents').upload(path, buf, { contentType: mime });
      if (upErr) throw upErr;
      const { data: row, error } = await admin.from('project_documents')
        .insert({ project_id: projectId, folder: folderName, file_path: path, file_name: fileName.slice(0, 150), mime_type: mime, uploaded_by: user.id })
        .select('id').single();
      if (error) { await admin.storage.from('project-documents').remove([path]); throw error; }
      saved = { kind: 'document', id: row.id };
    }

    // mark it on the email (read again just before writing, so a save of another attachment is kept)
    const { data: fresh } = await admin.from('emails').select('attachments').eq('id', email.id).single();
    const list = (fresh && fresh.attachments) || [];
    const entry = list.find(a => String(a.part_id) === String(partId));
    if (entry) {
      entry.saved_to = [...(entry.saved_to || []), { project_id: projectId, ...saved, at: new Date().toISOString(), by: user.id }];
      await admin.from('emails').update({ attachments: list }).eq('id', email.id);
    }
    return json(200, { ok: true, ...saved });
  } catch (err) {
    console.error('save-email-attachment failed:', err.message);
    return json(500, { ok: false, error: err.message });
  }
};
