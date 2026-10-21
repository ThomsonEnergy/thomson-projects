// POST /.netlify/functions/suggest-stage-prebuilds
// Body: { projectId?, template, stages: [{ name, description }], sow, answersText }
// Pricing roles only (spends the Anthropic key). Reads the scope of works, the pre-quote answers
// and the stage names, and picks prebuilds from the library for each stage with a quantity and
// one line of reasoning. Suggestions only, and only from the library (never invented, never
// priced here): the quote page adds each one tagged "AI added, check" and the ready-to-send gate
// stops the quote until a person confirms or removes them. Each run is written to the activity
// log of the quote (who, how many).

const fetch = require('node-fetch');
const { getIntegrationKey } = require('./_shared/get-integration-key');
const { requirePricingRole } = require('./_shared/require-pricing-role');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requirePricingRole(event);
  if (!auth) return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };

  try {
    const { projectId = null, template = '', stages = [], sow = '', answersText = '' } = JSON.parse(event.body || '{}');
    const named = (Array.isArray(stages) ? stages : []).map((s, i) => ({ index: i, name: String(s?.name || '').trim(), description: String(s?.description || '').trim() })).filter((s) => s.name);
    if (!named.length) return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Name at least one stage first' }) };
    if (!String(sow).trim() && !String(answersText).trim()) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'Write or generate the scope of works first (or answer the pre-quote questions)' }) };
    }

    const { supabaseAdmin, user } = auth;
    const { data: prebuilds, error: pbErr } = await supabaseAdmin
      .from('prebuilds').select('id, name, category, subcategory, client_description, prebuild_components(id, item_type, description, quantity, unit_cost, sort_order)')
      .order('category').order('name');
    if (pbErr) throw pbErr;
    if (!prebuilds || !prebuilds.length) return { statusCode: 200, body: JSON.stringify({ ok: true, suggestions: [], note: 'The prebuild library is empty.' }) };

    const apiKey = await getIntegrationKey('anthropic');
    const library = prebuilds.map((p, i) => {
      const desc = String(p.client_description || '').replace(/\s+/g, ' ').slice(0, 220);
      return `${i + 1}. ${p.name} [${p.category}${p.subcategory ? ' / ' + p.subcategory : ''}] (${(p.prebuild_components || []).length} parts)${desc ? ': ' + desc : ''}`;
    }).join('\n');
    const stageList = named.map((s) => `${s.index + 1}. ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n');

    const prompt = `You are helping an Australian electrical and solar contractor price a quote. The quote is split into stages; each stage is priced from "prebuilds" (reusable supply-and-install packages from the library below) plus odd parts.

Type of job: ${template || 'electrical'}
Stages (number. name: description):
${stageList}

Scope of works:
${String(sow).trim() || '(none written yet)'}
${String(answersText).trim() ? `\nPre-quote information from the client:\n${answersText}\n` : ''}
Prebuild library (number. name [category] (parts): client description):
${library}

For each stage, pick the prebuilds from the library that the scope says will be installed in that stage, with a quantity (how many of the package: 1 for a switchboard upgrade, 8 for eight downlights if the package is per light, metres if the package is per metre). Only pick a prebuild when the scope or the stage description clearly calls for it; leave a stage empty rather than guess. Never invent a prebuild that is not in the library. Give one short reason per pick (under 15 words) naming what in the scope called for it.

Respond with ONLY a JSON array, no other text, no markdown fences:
[{"stage": 1, "prebuild": 12, "quantity": 1, "reason": "..."}]`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text().catch(() => '')}`);
    const data = await res.json();
    const raw = data.content.map((b) => b.text || '').join('').trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('The AI did not return a list. Try again.');

    const suggestions = [];
    parsed.slice(0, 40).forEach((s) => {
      const stageNo = Number(s.stage);
      const pbNo = Number(s.prebuild);
      const stage = named.find((n) => n.index + 1 === stageNo);
      const prebuild = pbNo >= 1 && pbNo <= prebuilds.length ? prebuilds[pbNo - 1] : null;
      if (!stage || !prebuild) return;
      suggestions.push({
        stageIndex: stage.index,
        prebuild,
        quantity: Math.max(0.01, Number(s.quantity) || 1),
        reason: String(s.reason || '').trim().slice(0, 160),
      });
    });

    if (projectId) {
      await supabaseAdmin.from('activity_log').insert({
        entity_type: 'project', entity_id: projectId, action: 'ai_prebuilds_suggested', changed_by: user.id,
        description: `AI suggested ${suggestions.length} prebuild${suggestions.length === 1 ? '' : 's'} across ${named.length} stage${named.length === 1 ? '' : 's'} (tagged for a person to confirm)`,
      });
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, suggestions }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
