// Scheduled every 15 minutes (netlify.toml). Keeps every job's Formbay form up to date by itself
// (item 101): the stage, what it is waiting on, the NMI and serial numbers, the equipment once the
// installer has signed, and the form's photos and documents (a few each run, so a big form arrives
// over a run or two). A sold form is checked once a day. The how is in _shared/formbay-sync.js.
// Reads from Formbay only.

const { getAdminClient } = require('./_shared/require-admin');
const { formbayLogin } = require('./_shared/formbay');
const { syncForm, fileFormDocs, isoDate } = require('./_shared/formbay-sync');

const FILES_PER_RUN = 12;

exports.handler = async () => {
  const db = getAdminClient();
  const { data: rows, error } = await db.from('formbay_forms').select('formbay_job_id, job_status, synced_at').order('synced_at', { ascending: true, nullsFirst: true }).limit(200);
  if (error) { console.error('Formbay poll:', error.message); return { statusCode: 500 }; }
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const due = rows.filter(r => r.job_status !== 'sold' || !r.synced_at || new Date(r.synced_at).getTime() < dayAgo);
  if (!due.length) return { statusCode: 200 };

  let token;
  try { token = await formbayLogin(); } catch (err) { console.error('Formbay poll:', err.message); return { statusCode: 200 }; }
  let files = 0, failed = 0;
  for (const r of due) {
    const res = await syncForm(db, token, { formId: r.formbay_job_id });
    if (!res.ok) { failed++; console.error(`Formbay poll: form ${r.formbay_job_id}: ${res.error}`); continue; }
    // Photos once the on site work is signed off by the installer; documents are filed in the same pass.
    if (files < FILES_PER_RUN && isoDate(res.row.form.installer_signee_date)) files += await fileFormDocs(db, token, res.row, { limit: FILES_PER_RUN - files });
  }
  console.log(`Formbay poll: ${due.length} forms read, ${failed} failed, ${files} files filed`);
  return { statusCode: 200 };
};
