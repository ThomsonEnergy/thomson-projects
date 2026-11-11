// The picture tagger (backlog item 73b): reads one job photo with Claude and returns the tags it
// is found by (brands, what it shows, models read off a label, the kind of picture), a one line
// caption, and whether it is fine to show another customer as an example of a finished install.
// Used by tag-photos.js (Settings: the dry run and the backlog) and tag-photos-background.js
// (new uploads). The prompt is agents/prompts/photo-tagger.js; the eval set is
// agents/evals/photo-tagger. Reading only: the callers decide whether anything is saved, through
// savePhotoTags() here, which writes project_photos (tags, ai_caption, ok_for_proposals,
// tagged_at, tag_note) and nothing else.

const { callClaude } = require('./price-list-ai');
const { PHOTO_TAGGER_PROMPT } = require('../../../agents/prompts/photo-tagger.js');

const KINDS = ['finished install', 'in progress', 'before', 'damage', 'label', 'paperwork', 'site', 'other'];
const THINGS = ['inverter', 'battery', 'solar panels', 'switchboard', 'meter box', 'isolator', 'ev charger', 'hot water', 'air conditioner',
  'lighting', 'cabling', 'conduit', 'mounting', 'roof', 'wall', 'trench', 'generator', 'tools', 'vehicle', 'people', 'paperwork', 'screen'];
const VIDEO = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i;

// The picture as the model is given it: Supabase's resized copy (1,024 px on the long side is
// plenty to read a logo or a label, and keeps the cost of a picture small).
function tagImageUrl(url) {
  const marker = '/storage/v1/object/public/';
  const i = String(url || '').indexOf(marker);
  if (i === -1) return url;
  return `${url.slice(0, i)}/storage/v1/render/image/public/${url.slice(i + marker.length).split('?')[0]}?width=1024&height=1024&resize=contain&quality=75`;
}

// The job's own equipment, as lines for the prompt: the Pylon design's panels, inverters and
// batteries. A hint only (the prompt says so).
function jobEquipment(project) {
  const pd = (project && project.pylon_data) || {};
  return [...(pd.module_types || []), ...(pd.inverter_types || []), ...(pd.storage_types || [])]
    .map(m => m && m.description).filter(Boolean).map(d => String(d).slice(0, 120)).slice(0, 12);
}

// What the model answered, made safe to store: lower case tags with no duplicates, only the
// things and kinds on the lists, short strings, and "fine for proposals" only for a finished
// install with nobody and nothing identifying in it (checked here, not left to the model).
function cleanReading(parsed) {
  const p = parsed && typeof parsed === 'object' ? parsed : {};
  if (p.unreadable) return { unreadable: true, tags: [], caption: null, kind: null, okForProposals: false };
  const words = (list, max) => (Array.isArray(list) ? list : []).map(v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(v => v && v.length <= max);
  const kind = KINDS.includes(p.kind) ? p.kind : 'other';
  const things = words(p.things, 30).filter(t => THINGS.includes(t));
  const tags = [...new Set([...words(p.brands, 30), ...things, ...words(p.models, 40), kind])].slice(0, 20);
  const okForProposals = p.fine_for_proposals === true && kind === 'finished install' && p.people !== true && p.identifying !== true && !things.includes('people') && !things.includes('paperwork');
  return { tags, caption: p.caption ? String(p.caption).replace(/\s+/g, ' ').trim().slice(0, 200) : null, kind, okForProposals };
}

// Reads one picture. equipment: jobEquipment() lines. call: the model call (callClaude; the eval
// and the tests pass their own). Returns { tags, caption, kind, okForProposals, unreadable, usage };
// throws when the picture cannot be fetched or the answer is not JSON (the callers record that as
// the picture's note and move on).
async function tagPhoto({ url, equipment = [], call = callClaude }) {
  if (VIDEO.test(String(url || ''))) return { skipped: 'video', tags: ['video'], caption: null, kind: 'other', okForProposals: false, usage: {} };
  const prompt = PHOTO_TAGGER_PROMPT.replace('{{equipment}}', equipment.length ? equipment.map(e => `- ${e}`).join('\n') : '(none recorded)');
  const { raw, usage } = await call([{ type: 'image', source: { type: 'url', url: tagImageUrl(url) } }, { type: 'text', text: prompt }], 2000, { effort: 'low' });
  if (!raw) throw new Error('The picture reader gave no answer.');
  let parsed;
  try { parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch (_) { throw new Error('The picture reader answer could not be read.'); }
  return { ...cleanReading(parsed), usage };
}

// Saves one reading, or the reason there is none. A picture is read once (tagged_at marks it), so
// tags a person adds or takes off by hand afterwards are never overwritten.
async function savePhotoTags(admin, id, reading, note) {
  const fields = reading
    ? { tags: reading.tags, ai_caption: reading.caption, ok_for_proposals: !!reading.okForProposals, tagged_at: new Date().toISOString(), tag_note: reading.unreadable ? 'Could not make the picture out' : null }
    : { tagged_at: new Date().toISOString(), tag_note: String(note || 'Could not be read').slice(0, 300) };
  const { error } = await admin.from('project_photos').update(fields).eq('id', id);
  if (error) throw new Error(error.message);
}

// Reads a list of project_photos rows ({ id, url, project_id }), a few at a time, and saves each
// (unless save is false: a dry run). Returns one result per picture and the tokens used.
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
        if (save) await savePhotoTags(admin, photo.id, reading);
        return { id: photo.id, url: photo.url, tags: reading.tags, caption: reading.caption, ok_for_proposals: !!reading.okForProposals, unreadable: !!reading.unreadable };
      } catch (err) {
        if (save) await savePhotoTags(admin, photo.id, null, err.message).catch(() => {});
        return { id: photo.id, url: photo.url, tags: [], error: String(err.message || err).slice(0, 200) };
      }
    }));
    results.push(...batch);
  }
  return { results, usage };
}

module.exports = { tagPhoto, tagPhotos, cleanReading, jobEquipment, tagImageUrl, KINDS, THINGS };
