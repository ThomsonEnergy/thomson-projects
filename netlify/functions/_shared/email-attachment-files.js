// A received email's attachment as a file on a job (backlog items 53 and 81): the file name it
// gets, and the mark on emails.attachments[].saved_to so the chip says "On the job". Used by
// save-email-attachment.js (Save to job) and _shared/supplier-quote-intake.js (a supplier's quote
// filed by itself). Writes: emails.attachments.

const safeName = (s) => String(s || 'file').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 100);
const extOf = (name) => { const m = String(name || '').match(/\.([a-z0-9]{1,6})$/i); return m ? m[1].toLowerCase() : ''; };
// a picture pasted into an email often has no file name (gmail-sync calls it inline-<cid>)
const EXT_BY_MIME = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' };

// The attachment's own name with an extension the file type gives when it has none.
function fileNameWithExt(name, mime) {
  let out = String(name || 'file');
  const m = String(mime || '').toLowerCase();
  if (!extOf(out) && EXT_BY_MIME[m]) out = `${out}.${EXT_BY_MIME[m]}`;
  return out;
}

// saved: { kind: 'photo' | 'document', id, by? }. Read again just before writing, so a save of
// another attachment of the same email is kept.
async function markAttachmentSaved(admin, emailId, partId, projectId, saved) {
  const { data: fresh } = await admin.from('emails').select('attachments').eq('id', emailId).single();
  const list = (fresh && fresh.attachments) || [];
  const entry = list.find(a => String(a.part_id) === String(partId));
  if (!entry) return;
  entry.saved_to = [...(entry.saved_to || []), { project_id: projectId, ...saved, at: new Date().toISOString() }];
  const { error } = await admin.from('emails').update({ attachments: list }).eq('id', emailId);
  if (error) console.error('email attachment saved, but could not mark the email', emailId, error.message);
}

module.exports = { safeName, extOf, fileNameWithExt, markAttachmentSaved };
