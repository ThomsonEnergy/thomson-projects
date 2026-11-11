// The picture tagger (backlog item 73b): reads one job photo with Claude and returns the tags it
// is found by (brands, what it shows, models read off a label, the kind of picture), a one line
// caption, and whether it is fine to show another customer as an example of a finished install.
// Used by tag-photos.js (Settings: the dry run and the backlog) and tag-photos-background.js
// (new uploads). The prompt is agents/prompts/photo-tagger.js; the eval set is
// agents/evals/photo-tagger. Reading only: the callers decide whether anything is saved, through
// tagPhotos({ save }) here, which writes project_photos (tags, ai_caption, ok_for_proposals,
// tagged_at, tag_note, tag_tries, tag_claimed_at) and nothing else.

const { callClaude } = require('./price-list-ai');
const { PHOTO_TAGGER_PROMPT } = require('../../../agents/prompts/photo-tagger.js');

const KINDS = ['finished install', 'in progress', 'before', 'damage', 'label', 'paperwork', 'site', 'other'];
const THINGS = ['inverter', 'battery', 'solar panels', 'switchboard', 'meter box', 'isolator', 'ev charger', 'hot water', 'air conditioner',
  'lighting', 'cabling', 'conduit', 'mounting', 'roof', 'wall', 'trench', 'generator', 'tools', 'vehicle', 'people', 'paperwork', 'screen'];
// never shown to another customer, whatever else the reading says
const NOT_FOR_OTHERS = ['people', 'paperwork', 'vehicle', 'screen'];
const VIDEO = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i;
const STORAGE = '/storage/v1/object/public/';
const MAX_TRIES = 3;        // failed reads before the tagger gives up on a picture
const CLAIM_MINUTES = 10;   // how long a run holds the pictures it is reading

// The picture as the model is given it: Supabase's resized copy (1,024 px on the long side is
// plenty to read a logo or a label, and keeps the cost of a picture small).
function tagImageUrl(url) {
  const i = String(url || '').indexOf(STORAGE);
  if (i === -1) return url;
  return `${url.slice(0, i)}/storage/v1/render/image/public/${url.slice(i + STORAGE.length).split('?')[0]}?width=1024&height=1024&resize=contain&quality=75`;
}

// The job's own equipment, as lines for the prompt: the Pylon design's panels, inverters and
// batteries, each said with its kind. A hint only (the prompt says how far it may be trusted).
function jobEquipment(project) {
  const pd = (project && project.pylon_data) || {};
  const lines = (list, kind) => (list || []).map(m => m && m.description).filter(Boolean).map(d => `${kind}: ${String(d).slice(0, 120)}`);
  return [...lines(pd.module_types, 'solar panels'), ...lines(pd.inverter_types, 'inverter'), ...lines(pd.storage_types, 'battery')].slice(0, 12);
}

// What the model answered, made safe to store: lower case tags with no duplicates, only the
// things and kinds on the lists, short strings, and "fine for proposals" only when the model
// said so AND said there is nobody and nothing identifying in a finished install (each flag has
// to be there and false: a missing flag is a no).
function cleanReading(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  if (p.unreadable) return { unreadable: true, tags: [], caption: null, kind: null, okForProposals: false };
  const words = (list, max) => (Array.isArray(list) ? list : []).map(v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(v => v && v.length <= max);
  const kind = KINDS.includes(p.kind) ? p.kind : 'other';
  const things = words(p.things, 30).filter(t => THINGS.includes(t));
  const tags = [...new Set([...words(p.brands, 30), ...things, ...words(p.models, 40), kind])].slice(0, 20);
  const okForProposals = p.fine_for_proposals === true && kind === 'finished install' && p.people === false && p.identifying === false && !things.some(t => NOT_FOR_OTHERS.includes(t));
  return { tags, caption: p.caption ? String(p.caption).replace(/\s+/g, ' ').trim().slice(0, 200) : null, kind, okForProposals };
}

// Reads one picture. equipment: jobEquipment() lines. call: the model call (callClaude; the eval
// and the tests pass their own). anyUrl: the eval reads pictures that ship with the app; the app
// itself only ever reads pictures in its own storage. Returns { tags, caption, kind,
// okForProposals, unreadable, usage }, or { permanent: 'why' } for a picture there is no point
// trying again. Throws when the model call fails or its answer is not JSON (worth another try).
async function tagPhoto({ url, equipment = [], call = callClaude, anyUrl = false }) {
  if (VIDEO.test(String(url || ''))) return { permanent: 'A video, not a picture', tags: ['video'], usage: {} };
  if (!anyUrl && !String(url || '').includes(STORAGE)) return { permanent: 'Not a picture in the app\'s own storage', tags: [], usage: {} };
  const hint = equipment.length ? equipment.map(e => `- ${e}`).join('\n') : '(none recorded)';
  const prompt = PHOTO_TAGGER_PROMPT.replace('{{equipment}}', () => hint); // a function, so "$" in a model name is not read as a pattern
  const { raw, usage } = await call([{ type: 'image', source: { type: 'url', url: tagImageUrl(url) } }, { type: 'text', text: prompt }], 2000, { effort: 'low' });
  if (!raw) throw new Error('The picture reader gave no answer.');
  let parsed;
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch (_) { throw new Error('The picture reader answer could not be read.'); }
  return { ...cleanReading(parsed), usage };
}

// Marks pictures as being read by this run and returns the ones it got: a picture another run
// claimed in the last few minutes, or that is already done, is left out. rows: [{ id }].
async function claimPhotos(admin, rows) {
  if (!rows.length) return [];
  const stale = new Date(Date.now() - CLAIM_MINUTES * 60000).toISOString();
  const { data, error } = await admin.from('project_photos').update({ tag_claimed_at: new Date().toISOString() })
    .in('id', rows.map(r => r.id)).is('tagged_at', null).or(`tag_claimed_at.is.null,tag_claimed_at.lt.${stale}`)
    .select('id, url, project_id, tags, tag_tries');
  if (error) throw new Error(error.message);
  return data || [];
}

// Saves what happened to one claimed picture ({ id, tags, tag_tries }).
//  - read: its tags join any a person already put on it, and it is done;
//  - no point trying again (a video, unreadable): done, with the reason;
//  - the read failed: one more try counted; after MAX_TRIES it is done, with the reason, so one
//    bad picture cannot be read (and paid for) for ever. Until then it stays on the list.
async function savePhotoOutcome(admin, photo, reading, failure) {
  const now = new Date().toISOString();
  let fields;
  if (reading && !reading.permanent) {
    fields = { tags: [...new Set([...(photo.tags || []), ...reading.tags])], ai_caption: reading.caption, ok_for_proposals: !!reading.okForProposals, tagged_at: now, tag_note: reading.unreadable ? 'Could not make the picture out' : null, tag_claimed_at: null };
  } else if (reading) {
    fields = { tagged_at: now, tag_note: reading.permanent, tag_claimed_at: null };
  } else {
    const tries = (photo.tag_tries || 0) + 1;
    fields = { tag_tries: tries, tag_note: String(failure || 'Could not be read').slice(0, 300), tag_claimed_at: null, ...(tries >= MAX_TRIES ? { tagged_at: now } : {}) };
  }
  const { error } = await admin.from('project_photos').update(fields).eq('id', photo.id).is('tagged_at', null);
  if (error) throw new Error(error.message);
}

// Reads a list of project_photos rows ({ id, url, project_id, tags, tag_tries }), a few at a
// time, and with save true records each outcome (the rows must have been claimed first). Returns
// one result per picture, the tokens used and how many reads failed.
async function tagPhotos(admin, photos, { save = true, together = 2, call } = {}) {
  const usage = { input_tokens: 0, output_tokens: 0 };
  const equipmentBy = {};
  const projectIds = [...new Set(photos.map(p => p.project_id).filter(Boolean))];
  if (projectIds.length) {
    const { data } = await admin.from('projects').select('id, pylon_data').in('id', projectIds);
    (data || []).forEach(p => { equipmentBy[p.id] = jobEquipment(p); });
  }
  const results = [];
  for (let i = 0; i < photos.length; i += together) {
    const batch = await Promise.all(photos.slice(i, i + together).map(async (photo) => {
      try {
        const reading = await tagPhoto({ url: photo.url, equipment: equipmentBy[photo.project_id] || [], ...(call ? { call } : {}) });
        usage.input_tokens += (reading.usage || {}).input_tokens || 0;
        usage.output_tokens += (reading.usage || {}).output_tokens || 0;
        if (save) await savePhotoOutcome(admin, photo, reading);
        if (reading.permanent) return { id: photo.id, url: photo.url, tags: reading.tags || [], skipped: reading.permanent };
        return { id: photo.id, url: photo.url, tags: reading.tags, caption: reading.caption, ok_for_proposals: !!reading.okForProposals, unreadable: !!reading.unreadable };
      } catch (err) {
        if (save) await savePhotoOutcome(admin, photo, null, err.message).catch(() => {});
        return { id: photo.id, url: photo.url, tags: [], error: String(err.message || err).slice(0, 200) };
      }
    }));
    results.push(...batch);
  }
  return { results, usage, failed: results.filter(r => r.error).length };
}

module.exports = { tagPhoto, tagPhotos, claimPhotos, cleanReading, jobEquipment, tagImageUrl, KINDS, THINGS };
