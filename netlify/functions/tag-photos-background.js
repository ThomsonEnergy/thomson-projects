// Background: tags the pictures just added to a job (backlog item 73b). Called by the browser
// right after job pictures upload (js/photo-tags.js, requestPhotoTags), with { project_id }. Any
// active logged-in user (everyone adds site photos). Claims up to 40 of that job's pictures that
// have not been read yet (newest first; a picture another run is on is left alone), reads them
// with _shared/photo-tagger.js and saves each (project_photos: tags, ai_caption,
// ok_for_proposals, tagged_at, tag_note, tag_tries). A background function, as a batch takes
// longer than the 10 second limit. Reports to the ops manager as "photo-tagger" (runs, AI use, a
// failure alert). Does nothing until tagging is switched on in Settings
// (company_settings.photo_tagging_on). Pictures already in the app are tagged from Settings
// (tag-photos.js).

const { requireActiveUser } = require('./_shared/require-active-user');
const { runAgent } = require('./_shared/agent-log');
const { tagPhotos, claimPhotos } = require('./_shared/photo-tagger');

const PER_RUN = 40;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return { statusCode: 403, body: '' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 202, body: '' }; }
  if (!/^[0-9a-f-]{36}$/i.test(String(body.project_id || ''))) return { statusCode: 202, body: '' };
  return runAgent('photo-tagger', async () => {
    const admin = auth.supabaseAdmin;
    const { data: settings } = await admin.from('company_settings').select('photo_tagging_on').eq('id', 1).maybeSingle();
    if (!settings || !settings.photo_tagging_on) return { quiet: true };
    const { data: todo, error } = await admin.from('project_photos').select('id').eq('project_id', body.project_id).is('tagged_at', null).order('created_at', { ascending: false }).limit(PER_RUN);
    if (error) throw new Error(error.message);
    const photos = await claimPhotos(admin, todo || []);
    if (!photos.length) return { quiet: true };
    const { results, usage, failed } = await tagPhotos(admin, photos, { save: true, together: 3 });
    // every read failing is the AI being down or out of credit, not bad pictures: say so (they stay on the list)
    if (failed === results.length) throw new Error(`None of ${results.length} picture${results.length === 1 ? '' : 's'} could be read: ${results[0].error}`);
    return { summary: `Tagged ${results.length - failed} picture${results.length - failed === 1 ? '' : 's'}${failed ? `, ${failed} could not be read` : ''}`, usage };
  });
};
