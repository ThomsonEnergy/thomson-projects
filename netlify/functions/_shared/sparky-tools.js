// Sparky's read-only lookup tools (database, Knowledge Base, calculator, web
// search), shared by the Ask AI widget (ai-chat-background.js) and Sparky in
// team chat (_shared/chat-ai.js). Every query runs with the asking person's
// own login, so RLS applies exactly as in the app.
const { evaluate } = require('./calc');

// Maths the model should not do in its head. Parsed by our own small calculator (no eval).
const CALC_TOOL = {
  name: 'calculate',
  description: 'Calculate a maths expression exactly. Use it for any arithmetic that matters (quote totals, margins, GST, percentages, cable lengths, voltage drop, kW and kWh, STC numbers) instead of working it out yourself. Supports + - * / ^ ( ), postfix %, pi, e, and sqrt abs round(x,places) ceil floor min max pow mod ln log10 exp sin cos tan (radians, use rad(degrees)). Use * to multiply and write numbers without commas.',
  input_schema: { type: 'object', properties: { expression: { type: 'string', description: 'e.g. 3 * 230 * sqrt(3)  or  (12500 + 4200) * 1.1' } }, required: ['expression'] },
};

// Anthropic's own web search, run on their side. Not available on every account, so a
// request that is refused for it is retried without it (see the loops that use it).
const WEB_SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 4, user_location: { type: 'approximate', country: 'AU', region: 'New South Wales', city: 'Sydney', timezone: 'Australia/Sydney' } };

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

// Team chat passes a longer list (adds emails and chat) to queryTool / runQuery.
function queryTool(tables = QUERYABLE_TABLES) {
  return {
    name: 'query_database',
    description: `Run a read-only query against the Thomson Projects database to answer with real data instead of guessing. Only these tables are queryable: ${tables.join(', ')}. Queries run as the staff member you're talking to, so you see exactly what they're allowed to see in the app - nothing more. An empty result or an error is real information, not a reason to make something up - report it plainly, or adjust the query (e.g. fix a column name after an error) and try again. Call this as many times as you need, including to join information from two tables with separate calls, before giving your final answer.`,
    input_schema: {
      type: 'object',
      properties: {
        table: { type: 'string', enum: tables },
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
}
const QUERY_TOOL = queryTool();

async function runQuery(userClient, input, tables = QUERYABLE_TABLES) {
  const { table, select, filters = [], order_by, limit } = input || {};
  if (!tables.includes(table)) {
    return { error: { message: `Table "${table}" isn't queryable. Allowed tables: ${tables.join(', ')}` } };
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

module.exports = {
  CALC_TOOL, WEB_SEARCH_TOOL, QUERYABLE_TABLES, QUERY_TOOL, queryTool, KB_TOOL, READ_ENTRY_TOOL,
  runQuery, searchKnowledgeBase, readKnowledgeEntry, evaluate,
};
