// POST /.netlify/functions/sync-bugs-to-repo
// Any active logged-in user. Called after every bug/update-idea submission
// or status change on the Bugs & Updates page. Rebuilds BUGS_AND_UPDATES.md
// in full from the current bug_reports table and commits it straight to
// the GitHub repo via the Contents API - so a future Claude Code session
// working in this same repo folder can just read that file, no database
// access needed. Requires GITHUB_TOKEN (a token with contents:write on this
// repo) set as a Netlify environment variable.

const fetch = require('node-fetch');
const { requireActiveUser } = require('./_shared/require-active-user');

const GITHUB_OWNER = 'ThomsonEnergy';
const GITHUB_REPO = 'thomson-projects';
const GITHUB_BRANCH = 'main';
const FILE_PATH = 'BUGS_AND_UPDATES.md';

function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function buildMarkdown(reports, profilesById) {
  const named = (r) => (r.created_by && profilesById[r.created_by]) || 'Someone';
  const groups = {
    open: reports.filter(r => r.status === 'open'),
    in_progress: reports.filter(r => r.status === 'in_progress'),
    resolved: reports.filter(r => r.status === 'resolved'),
  };

  const section = (title, list) => {
    if (!list.length) return `## ${title}\n\nNone.\n`;
    return `## ${title}\n\n` + list.map(r => {
      const lines = [
        `### ${r.report_type === 'bug' ? 'Bug' : 'Update idea'}: ${r.title}`,
        `- **Reported:** ${fmtDate(r.created_at)} by ${named(r)}`,
      ];
      if (r.page_or_feature) lines.push(`- **Page/feature:** ${r.page_or_feature}`);
      lines.push(`- **${r.report_type === 'bug' ? "What's happening" : 'What they want'}:** ${r.description}`);
      if (r.expected_behavior) lines.push(`- **Expected instead:** ${r.expected_behavior}`);
      lines.push(`- **Record id:** ${r.id}`);
      return lines.join('\n');
    }).join('\n\n') + '\n';
  };

  return `# Bugs & System Updates

Auto-generated from the in-app Bugs & Updates page (/bugs.html) - do not
edit this file by hand, it gets fully regenerated on every submission or
status change. Read this when asked to check for bugs or update ideas.

${section('Open', groups.open)}
${section('In Progress', groups.in_progress)}
${section('Resolved', groups.resolved)}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const auth = await requireActiveUser(event);
  if (!auth) {
    return { statusCode: 403, body: JSON.stringify({ ok: false, error: 'Not authorized' }) };
  }

  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: 'GITHUB_TOKEN is not set in Netlify environment variables yet.' }) };
  }

  try {
    const { data: reports, error } = await auth.supabaseAdmin
      .from('bug_reports')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;

    const { data: profiles } = await auth.supabaseAdmin.from('profiles').select('id, full_name');
    const profilesById = {};
    (profiles || []).forEach(p => { profilesById[p.id] = p.full_name; });

    const markdown = buildMarkdown(reports || [], profilesById);
    const contentBase64 = Buffer.from(markdown, 'utf-8').toString('base64');

    const apiBase = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
    const ghHeaders = {
      Authorization: `Bearer ${githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'thomson-projects-bugs-sync',
    };

    // Need the current file's SHA to update it - GitHub's Contents API
    // rejects an update without it. A 404 just means the file doesn't
    // exist yet, which is fine on the very first sync.
    let sha = null;
    const getRes = await fetch(`${apiBase}?ref=${GITHUB_BRANCH}`, { headers: ghHeaders });
    if (getRes.ok) {
      const existing = await getRes.json();
      sha = existing.sha;
    } else if (getRes.status !== 404) {
      const text = await getRes.text().catch(() => '');
      throw new Error(`GitHub API error reading current file: ${getRes.status} ${text}`);
    }

    const putRes = await fetch(apiBase, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Sync BUGS_AND_UPDATES.md from the Bugs & Updates page',
        content: contentBase64,
        branch: GITHUB_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putRes.ok) {
      const text = await putRes.text().catch(() => '');
      throw new Error(`GitHub API error writing file: ${putRes.status} ${text}`);
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
