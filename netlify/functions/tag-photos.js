// POST /.netlify/functions/tag-photos
// Body: { photo_id, save: true | false }
// Admin only (Settings > Company Details > Picture tags, js/settings-photo-tags.js). Reads one job
// picture with _shared/photo-tagger.js and answers
// { ok, result: { id, url, tags, caption, ok_for_proposals, unreadable, error }, usage }.
// save false is the dry run: nothing is written. save true writes project_photos (tags,
// ai_caption, ok_for_proposals, tagged_at, tag_note), only once tagging has been switched on
// (company_settings.photo_tagging_on), and only for a picture not read before. One picture a call
// keeps it inside the function's time limit; the page works through its list a few at a time.
// New uploads are tagged by tag-photos-background.js, not here.

const { requireAdmin } = require('./_shared/require-admin');
const { tagPhotos } = require('./_shared/photo-tagger');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireAdmin(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  try {
    const body = JSON.parse(event.body || '{}');
    const save = body.save === true;
    if (!/^[0-9a-f-]{36}$/i.test(String(body.photo_id || ''))) return json(400, { ok: false, error: 'Which picture?' });
    const admin = auth.supabaseAdmin;
    if (save) {
      const { data: settings } = await admin.from('company_settings').select('photo_tagging_on').eq('id', 1).maybeSingle();
      if (!settings || !settings.photo_tagging_on) return json(400, { ok: false, error: 'Picture tagging is switched off. Switch it on first.' });
    }
    const { data: photo, error } = await admin.from('project_photos').select('id, url, project_id, tagged_at').eq('id', body.photo_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!photo) return json(404, { ok: false, error: 'That picture is gone.' });
    if (save && photo.tagged_at) return json(200, { ok: true, result: { id: photo.id, url: photo.url, already: true }, usage: { input_tokens: 0, output_tokens: 0 } });
    const { results, usage } = await tagPhotos(admin, [photo], { save });
    return json(200, { ok: true, result: results[0], usage });
  } catch (err) {
    console.error('tag-photos failed:', err.message);
    return json(500, { ok: false, error: 'The picture could not be read just now.' });
  }
};
