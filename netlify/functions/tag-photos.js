// POST /.netlify/functions/tag-photos
// Body: { next: 1 to 2, save: true | false, after?: "<created_at of the last one tried>" }
// Admin only (Settings > Company Details > Picture tags, js/settings-photo-tags.js). Reads the next
// few job pictures that have no tags yet (oldest first) with _shared/photo-tagger.js and answers
// { ok, results: [{ id, url, tags, caption, ok_for_proposals, error }], usage, remaining, after }.
// save false is the dry run: nothing is written, and the page passes "after" back so the same
// pictures are not read twice. save true writes project_photos (tags, ai_caption,
// ok_for_proposals, tagged_at, tag_note), and only once tagging has been switched on
// (company_settings.photo_tagging_on). Two pictures a call keeps it inside the function's time
// limit; the page calls again until remaining is 0. New uploads are tagged by
// tag-photos-background.js, not here.

const { requireAdmin } = require('./_shared/require-admin');
const { tagPhotos } = require('./_shared/photo-tagger');

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireAdmin(event);
  if (!auth) return json(403, { ok: false, error: 'Not authorized' });
  try {
    const body = JSON.parse(event.body || '{}');
    const next = Math.min(2, Math.max(1, Number(body.next) || 2));
    const save = body.save === true;
    const admin = auth.supabaseAdmin;
    if (save) {
      const { data: settings } = await admin.from('company_settings').select('photo_tagging_on').eq('id', 1).maybeSingle();
      if (!settings || !settings.photo_tagging_on) return json(400, { ok: false, error: 'Picture tagging is switched off. Switch it on in Settings first.' });
    }
    let q = admin.from('project_photos').select('id, url, project_id, created_at', { count: 'exact' }).is('tagged_at', null).order('created_at').limit(next);
    if (!save && body.after) q = q.gt('created_at', body.after);
    const { data: photos, count, error } = await q;
    if (error) throw new Error(error.message);
    if (!photos || !photos.length) return json(200, { ok: true, results: [], usage: { input_tokens: 0, output_tokens: 0 }, remaining: 0, after: body.after || null });
    const { results, usage } = await tagPhotos(admin, photos, { save, together: 2 });
    return json(200, { ok: true, results, usage, remaining: Math.max(0, (count || 0) - photos.length), after: photos[photos.length - 1].created_at });
  } catch (err) {
    console.error('tag-photos failed:', err.message);
    return json(500, { ok: false, error: 'The pictures could not be read just now. Try again.' });
  }
};
