const crypto = require('crypto');
const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// POST { projectId, onlyIfStale?, force? }   (any signed-in staff member)
//
// Cooper's suggestion (Bugs & Updates board, "Installer job card quote
// summary"): once a quote's scope of works is written, the installer on site
// shouldn't have to read the whole prose document - a short, plain
// inclusions/exclusions punch list is what they actually need. Distinct from
// generate-sow.js (writes the client-facing document from scratch) - this
// reads an EXISTING scope of works and condenses it, staff-facing.
//
// It reads the scope and stage list straight from the project (so the page
// cannot send it something different), and saves the result on the project.
// A hash of exactly what it read is saved alongside, so with onlyIfStale the
// summary is only rewritten when the scope or stages have really changed - the
// quote/job save calls it that way, so the summary stays current by itself.

function buildPrompt(projectName, stages, sowText) {
  const stageList = stages.map((s) => `- ${s.name}${s.description ? ': ' + s.description : ''}`).join('\n');
  return `You're condensing a client-facing scope of works into a short on-site reference for the installer/tradesperson actually doing the job - not the client, not a sales document. They need to glance at this on their phone before/during the job and know exactly what's in scope and what isn't, without wading through the full document's formal language.

Job: ${projectName || 'This job'}

${stageList ? `Stages quoted:\n${stageList}\n\n` : ''}Full scope of works document:
${sowText}

Write a short summary, plain trade language, no marketing/reassurance filler, no repeating the standards citations verbatim (just note compliance requirements briefly if genuinely important on site). Never mention prices, costs, margins, deposits or payment terms - the installer does not need them. Format:

INCLUDED
- short bullet points, grouped by stage/area if the job has multiple stages, otherwise just a flat list

NOT INCLUDED / EXCLUDED
- anything the document explicitly excludes or that a reasonable installer might otherwise assume is included but isn't - skip this section if the document doesn't mention any exclusions

WATCH FOR
- only include this section if the document mentions a genuine site-specific note, constraint, or thing to double-check before starting (an access issue, an existing defect, a condition affecting the work) - omit entirely if there's nothing like that

Keep it tight - a busy tradesperson reading this on site, not a report. Plain text, no markdown headers/asterisks beyond the section labels above exactly as written. Do not use em dashes.`;
}

const json = (statusCode, body) => ({ statusCode, body: JSON.stringify(body) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  const auth = await requireActiveUser(event);
  if (!auth) return json(403, { ok: false, error: 'Not signed in' });
  const { supabaseAdmin } = auth;

  try {
    const { projectId, onlyIfStale, force } = JSON.parse(event.body || '{}');
    if (!projectId) return json(400, { ok: false, error: 'projectId is required' });

    const { data: project, error } = await supabaseAdmin.from('projects')
      .select('id, name, sow_text, installer_summary, installer_summary_hash, cost_centres(name, description, sort_order)')
      .eq('id', projectId).maybeSingle();
    if (error || !project) return json(404, { ok: false, error: 'Job not found' });
    if (!project.sow_text || !project.sow_text.trim()) {
      return json(400, { ok: false, error: 'This job has no scope of works to summarise yet.' });
    }

    const stages = (project.cost_centres || []).slice().sort((a, b) => a.sort_order - b.sort_order).filter((s) => s.name);
    const hash = crypto.createHash('sha1').update(project.sow_text.trim() + '\n' + stages.map((s) => `${s.name}|${s.description || ''}`).join('\n')).digest('hex');
    if (onlyIfStale && !force && project.installer_summary && project.installer_summary_hash === hash) {
      return json(200, { ok: true, skipped: true, summary: project.installer_summary });
    }

    const apiKey = await getIntegrationKey('anthropic');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 900,
        messages: [{ role: 'user', content: buildPrompt(project.name, stages, project.sow_text) }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic API error: ${res.status} ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const summary = data.content.map((b) => b.text || '').join('').trim();
    if (!summary) throw new Error('The AI returned an empty summary');

    const generatedAt = new Date().toISOString();
    const { error: updErr } = await supabaseAdmin.from('projects')
      .update({ installer_summary: summary, installer_summary_generated_at: generatedAt, installer_summary_hash: hash }).eq('id', projectId);
    if (updErr) throw updErr;

    return json(200, { ok: true, summary, generated_at: generatedAt });
  } catch (err) {
    console.error(err);
    return json(500, { ok: false, error: err.message });
  }
};

exports.buildPrompt = buildPrompt;
