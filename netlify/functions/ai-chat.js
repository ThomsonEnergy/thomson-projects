const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { getIntegrationKey } = require('./_shared/get-integration-key');

// Safe to hardcode - same public anon key already embedded in the browser
// at /js/supabase-client.js. RLS is what actually protects data.
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InppYWtwa2xuemtiYmpqbnFna216Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTg2OTIsImV4cCI6MjEwMjY3NDY5Mn0.xuEorSGdx9rI_ySM6V4MOxoQLOTD1OCWdrSXKMKnFAE';
const SERVER_CLIENT_OPTS = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };

// Deliberately excludes: api_keys, company_credentials, employee_contracts,
// onboarding_documents/signatures, xero_account_mapping, ai_extraction_jobs
// - secrets, HR-sensitive documents, or plumbing tables with nothing a
// staff Q&A chat should be surfacing, regardless of what RLS would allow.
const QUERYABLE_TABLES = [
  'projects', 'cost_centres', 'cost_centre_line_items', 'cost_centre_photo_groups',
  'purchase_orders', 'purchase_order_line_items', 'profiles', 'prebuilds', 'prebuild_components',
  'leads', 'clients', 'client_contacts', 'time_entries', 'leave_requests', 'schedule_assignments',
  'invoices', 'invoice_claims', 'feed_posts', 'feed_comments', 'materials', 'fleet_vehicles',
  'supplier_bills', 'supplier_bill_line_items', 'suppliers', 'supplier_payments',
  'job_material_usage', 'material_stock_by_location', 'activity_log', 'job_tasks', 'variations',
  'payment_milestones', 'project_photos', 'project_field_notes', 'billable_rate_tiers',
  'public_holidays', 'bug_reports', 'bug_report_comments', 'dnsp_records', 'supplier_statements',
  'daily_greetings', 'profile_licences',
];

const QUERY_TOOL = {
  name: 'query_database',
  description: `Run a read-only query against the Thomson Projects database to answer with real data instead of guessing. Only these tables are queryable: ${QUERYABLE_TABLES.join(', ')}. Queries run as the staff member you're talking to, so you see exactly what they're allowed to see in the app - nothing more. An empty result or an error is real information, not a reason to make something up - report it plainly, or adjust the query (e.g. fix a column name after an error) and try again. Call this as many times as you need, including to join information from two tables with separate calls, before giving your final answer.`,
  input_schema: {
    type: 'object',
    properties: {
      table: { type: 'string', enum: QUERYABLE_TABLES },
      select: { type: 'string', description: 'Comma-separated column list, or "*". Keep it to what you actually need.' },
      filters: {
        type: 'array',
        description: 'Optional filters, ANDed together.',
        items: {
          type: 'object',
          properties: {
            column: { type: 'string' },
            operator: { type: 'string', enum: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'ilike', 'in'] },
            value: {},
          },
          required: ['column', 'operator', 'value'],
        },
      },
      order_by: {
        type: 'object',
        properties: { column: { type: 'string' }, ascending: { type: 'boolean' } },
      },
      limit: { type: 'number', description: 'Max rows to return. Default 20, hard cap 100.' },
    },
    required: ['table', 'select'],
  },
};

async function runQuery(userClient, input) {
  const { table, select, filters = [], order_by, limit } = input || {};
  if (!QUERYABLE_TABLES.includes(table)) {
    return { error: { message: `Table "${table}" isn't queryable. Allowed tables: ${QUERYABLE_TABLES.join(', ')}` } };
  }
  let q = userClient.from(table).select(select || '*');
  for (const f of (filters || [])) {
    if (!f || !f.column || !f.operator || typeof q[f.operator] !== 'function') continue;
    q = q[f.operator](f.column, f.value);
  }
  if (order_by && order_by.column) q = q.order(order_by.column, { ascending: order_by.ascending !== false });
  q = q.limit(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100));
  return q;
}

const KB_TOOL = {
  name: 'search_knowledge_base',
  description: 'Search the internal Knowledge Base - install guides, best practices, AUS standards, and other reference material staff have added (pasted text, linked websites, or uploaded PDFs/images/spreadsheets). Use this for "how do I...", "what does the standard say about...", procedure/reference questions - as opposed to query_database, which is for live business records like jobs and invoices. Returns matching entries (with an id) and, for a long document, short excerpts around your search words rather than the whole thing - use read_knowledge_entry with that id to dig further into one specific document, e.g. re-searching it for a more specific clause/term once you know which document has what you need.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Keywords to search for in the entry title and content.' } },
    required: ['query'],
  },
};

const READ_ENTRY_TOOL = {
  name: 'read_knowledge_entry',
  description: 'Read more of one specific Knowledge Base entry by id (the id comes from a search_knowledge_base result). Use this to dig into a large document - e.g. a full AUS standard - that search_knowledge_base only returned a short excerpt of. Pass search_term to get excerpts from within that entry around a more specific clause/topic than your original search; omit it to read from the start of the document instead.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The knowledge_entries id from a search_knowledge_base result.' },
      search_term: { type: 'string', description: 'Optional - narrows to excerpts around this term within the entry, instead of reading from the start.' },
    },
    required: ['id'],
  },
};

const KB_CONTENT_CHAR_LIMIT = 4000;
const READ_ENTRY_CHAR_LIMIT = 8000;

// A large document (a full AUS standard can run to 1MB+ of text) can't be
// handed to the model whole, and truncating from character 0 only ever
// surfaces the cover page - useless for "what does clause X say". Instead,
// find where the search words actually appear and return windows of text
// around each match, so a deep clause several hundred pages in is still
// reachable.
function extractExcerpts(content, words, { windowSize = 1200, maxExcerpts = 4, maxMatchesPerWord = 3 } = {}) {
  if (!content) return '';
  const lower = content.toLowerCase();
  const windows = [];
  for (const w of words) {
    const wl = w.toLowerCase();
    if (!wl) continue;
    let searchFrom = 0;
    for (let found = 0; found < maxMatchesPerWord; found++) {
      const pos = lower.indexOf(wl, searchFrom);
      if (pos === -1) break;
      windows.push([Math.max(0, pos - windowSize / 2), Math.min(content.length, pos + wl.length + windowSize / 2)]);
      searchFrom = pos + wl.length;
    }
  }
  if (!windows.length) return content.slice(0, 2000);

  windows.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w[0] <= last[1] + 200) last[1] = Math.max(last[1], w[1]);
    else merged.push(w);
  }

  return merged.slice(0, maxExcerpts).map(([start, end]) => {
    const prefix = start > 0 ? '...' : '';
    const suffix = end < content.length ? '...' : '';
    return prefix + content.slice(start, end).trim() + suffix;
  }).join('\n\n[...]\n\n');
}

async function searchKnowledgeBase(userClient, input) {
  const query = ((input && input.query) || '').trim();
  if (!query) return { error: { message: 'query is required' } };

  // AND together "this word appears in title OR content", one OR-group per
  // word, rather than requiring the whole phrase as one contiguous
  // substring - a plain ilike on the full query fails on a search like
  // "downlight torque" against text that reads "...torque the terminal
  // screws..." (the words aren't contiguous, "torque" isn't next to
  // "downlight" in the source text at all).
  const words = query.split(/\s+/).map((w) => w.replace(/[%,()]/g, '')).filter(Boolean).slice(0, 6);
  let q = userClient.from('knowledge_entries').select('id, title, category, content, source_url, file_name');
  for (const w of words) {
    q = q.or(`title.ilike.%${w}%,content.ilike.%${w}%`);
  }
  const { data, error } = await q.limit(5);
  if (error) return { error };
  const trimmed = (data || []).map((row) => ({
    ...row,
    content: row.content && row.content.length > KB_CONTENT_CHAR_LIMIT
      ? extractExcerpts(row.content, words)
      : row.content,
  }));
  return { data: trimmed, error: null };
}

async function readKnowledgeEntry(userClient, input) {
  const id = ((input && input.id) || '').trim();
  if (!id) return { error: { message: 'id is required' } };
  const { data, error } = await userClient
    .from('knowledge_entries')
    .select('id, title, category, content, source_url, file_name')
    .eq('id', id)
    .maybeSingle();
  if (error) return { error };
  if (!data) return { data: null, error: null };

  const searchTerm = ((input && input.search_term) || '').trim();
  let content = data.content || '';
  if (content.length > READ_ENTRY_CHAR_LIMIT) {
    if (searchTerm) {
      const words = searchTerm.split(/\s+/).map((w) => w.replace(/[%,()]/g, '')).filter(Boolean).slice(0, 4);
      content = extractExcerpts(content, words, { windowSize: 2500, maxExcerpts: 4 });
    } else {
      content = content.slice(0, READ_ENTRY_CHAR_LIMIT) + '... (truncated - pass search_term to find a specific section instead)';
    }
  }
  return { data: { ...data, content }, error: null };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Not logged in.' }) };

    // Built with the ANON key plus the caller's own access token, not the
    // service-role key - every query below runs under RLS exactly as if
    // the browser had made it directly, so this can't see anything the
    // staff member couldn't already see in the app itself.
    const userClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, {
      ...SERVER_CLIENT_OPTS,
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser(token);
    if (userErr || !userData || !userData.user) {
      return { statusCode: 401, body: JSON.stringify({ ok: false, error: 'Session expired - refresh the page and log in again.' }) };
    }

    const { data: profile } = await userClient.from('profiles').select('full_name, role').eq('id', userData.user.id).maybeSingle();

    const { messages } = JSON.parse(event.body || '{}');
    if (!Array.isArray(messages) || !messages.length) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'No message.' }) };
    }

    const apiKey = await getIntegrationKey('anthropic');
    const today = new Date().toISOString().slice(0, 10);

    const systemPrompt = `You are the AI assistant built into Thomson Projects, Thomson Energy's internal job management app for their electrical/solar contracting business. You're talking to ${profile && profile.full_name ? profile.full_name : 'a staff member'} (role: ${profile && profile.role ? profile.role : 'unknown'}). Today's date is ${today}.

Use the query_database tool to look up real data - jobs/quotes, cost centres, invoices, purchase orders, stock/materials, prebuilds, clients, suppliers, timesheets, tasks, and more - rather than guessing or estimating numbers. Use search_knowledge_base for install guides, best practices, AUS standards, and other reference material staff have added - a big document (a full AUS standard can run hundreds of pages) only comes back as short excerpts around your search words, not the whole thing, so if the first search finds the right document but not the exact clause/detail you need, call read_knowledge_entry with that entry's id and a more specific search_term to dig further into it, rather than answering from the short excerpt alone or falling back to general knowledge. If a query or search comes back empty or errors, say so plainly instead of making something up - and for anything safety- or compliance-critical (clearances, ratings, labelling requirements), don't state a figure from general knowledge as if it were the standard's actual wording unless you've actually found and read it in the knowledge base.

You are read-only - you cannot create, edit, or delete anything in the app. If asked to change something, say you can only look things up right now and point to the right page to do it.

Keep answers short and practical - this is someone checking something quickly during their workday, not a long conversation.`;

    const anthropicMessages = messages.map((m) => ({ role: m.role, content: m.content }));

    let finalText = '';
    for (let i = 0; i < 8 && !finalText; i++) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 1024,
          system: systemPrompt,
          tools: [QUERY_TOOL, KB_TOOL, READ_ENTRY_TOOL],
          messages: anthropicMessages,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Anthropic API error: ${res.status} ${errText}`);
      }
      const data = await res.json();
      anthropicMessages.push({ role: 'assistant', content: data.content });

      const toolUses = data.content.filter((b) => b.type === 'tool_use');
      if (!toolUses.length) {
        finalText = data.content.map((b) => b.text || '').join('').trim();
        break;
      }

      const toolResults = [];
      for (const tu of toolUses) {
        let resultContent;
        try {
          const { data: rows, error } = tu.name === 'search_knowledge_base' ? await searchKnowledgeBase(userClient, tu.input)
            : tu.name === 'read_knowledge_entry' ? await readKnowledgeEntry(userClient, tu.input)
            : await runQuery(userClient, tu.input);
          resultContent = error ? `Error: ${error.message}` : JSON.stringify(rows);
        } catch (err) {
          resultContent = `Error: ${err.message}`;
        }
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent });
      }
      anthropicMessages.push({ role: 'user', content: toolResults });
    }

    if (!finalText) finalText = "Sorry, I couldn't finish looking that up - try asking again, maybe a bit more specifically.";

    return { statusCode: 200, body: JSON.stringify({ ok: true, text: finalText }) };
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
