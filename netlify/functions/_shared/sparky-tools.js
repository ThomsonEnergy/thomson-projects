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
  'supplier_bill_inbox', 'agent_runs', 'agent_heartbeats', 'agent_tasks',
  'price_list_imports', 'price_changes', 'supplier_price_items', 'material_supplier_links',
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
  description: 'Search the internal Knowledge Base - install guides, best practices, AUS standards, and other reference material staff have added (pasted text, linked websites, uploaded PDFs/images/spreadsheets). Use this for "how do I...", "what does the standard say about...", procedure/reference questions - as opposed to query_database, which is for live business records like jobs and invoices. Every document is stored page by page (a PDF\'s real page numbers; other text in parts). Returns the best matching pages: the entry id, title, page number, how the page was read (text or ocr = as printed; notes = a write-up of the page, not its exact wording, say so if you quote it) and an excerpt with the matched words in [brackets]. Plain words work best (e.g. "switchboard clearance" or "cable in roof space"); clause or table numbers like 2.5.4.2 or "Table 3.4" also work. Use read_knowledge_entry with the id and page number to read a whole page or the pages around it.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'What to look for: a few plain words, a clause number or a table number.' } },
    required: ['query'],
  },
};

const READ_ENTRY_TOOL = {
  name: 'read_knowledge_entry',
  description: 'Read one Knowledge Base entry by id (the id comes from a search_knowledge_base result). Give page_from (and optionally page_to, up to 6 pages at once) to read whole pages, e.g. the page a search matched on and the next one when a table or clause runs over. Give search_term instead to find the pages inside this one entry that match a more specific term. With neither, it reads from the start of the document.',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The knowledge_entries id from a search_knowledge_base result.' },
      page_from: { type: 'integer', description: 'First page to read in full (as numbered in search results).' },
      page_to: { type: 'integer', description: 'Last page to read in full (at most 5 after page_from).' },
      search_term: { type: 'string', description: 'Find pages within this entry matching this term, instead of reading pages in full.' },
    },
    required: ['id'],
  },
};

const PAGE_CHARS = 12000;
const READ_ENTRY_CHAR_LIMIT = 8000;

function pageLabel(row) {
  const isPdf = row.entry_type === 'file' && /\.pdf$/i.test(row.file_name || '');
  return isPdf ? 'page' : 'part';
}

function clip(text, max) {
  text = text || '';
  return text.length > max ? text.slice(0, max) + '... (cut, read fewer pages at once)' : text;
}

// Full text search over knowledge_pages (migration 20261104010000). Falls back to a plain substring match
// for things the word search cannot do, like a clause number.
async function searchKnowledgePages(userClient, query, entryId, limit) {
  const { data, error } = await userClient.rpc('search_knowledge_pages', { p_query: query, p_entry_id: entryId || null, p_limit: limit });
  if (error) return { error };
  if (data && data.length) {
    return { data: data.map((r) => ({ id: r.entry_id, title: r.title, category: r.category, [pageLabel(r)]: r.page_no, read_as: r.read_as, excerpt: r.snippet })), error: null };
  }
  const needle = query.trim().replace(/[%_,()]/g, ' ').trim().slice(0, 80);
  if (!needle) return { data: [], error: null };
  let q = userClient.from('knowledge_pages').select('entry_id, page_no, read_as, text, knowledge_entries!inner(title, category, entry_type, file_name)')
    .neq('read_as', 'failed').ilike('text', `%${needle}%`).order('page_no').limit(limit);
  if (entryId) q = q.eq('entry_id', entryId);
  const { data: rows, error: err2 } = await q;
  if (err2) return { error: err2 };
  return {
    data: (rows || []).map((r) => {
      const e = r.knowledge_entries || {};
      const pos = (r.text || '').toLowerCase().indexOf(needle.toLowerCase());
      const from = Math.max(0, pos - 500);
      return { id: r.entry_id, title: e.title, category: e.category, [pageLabel(e)]: r.page_no, read_as: r.read_as, excerpt: (from > 0 ? '...' : '') + (r.text || '').slice(from, pos + needle.length + 700) + '...' };
    }),
    error: null,
  };
}

async function searchKnowledgeBase(userClient, input) {
  const query = ((input && input.query) || '').trim();
  if (!query) return { error: { message: 'query is required' } };
  const pages = await searchKnowledgePages(userClient, query, null, 8);
  if (pages.error) return pages;
  // Titles too, so "what do we have on generators" finds the AS 3010 entry even before its pages match.
  const words = query.split(/\s+/).map((w) => w.replace(/[%_,()]/g, '')).filter((w) => w.length > 2).slice(0, 4);
  if (words.length) {
    const seen = new Set(pages.data.map((p) => p.id));
    let q = userClient.from('knowledge_entries').select('id, title, category, entry_type, file_name');
    q = q.or(words.map((w) => `title.ilike.%${w}%`).join(','));
    const { data: titles } = await q.limit(5);
    for (const t of titles || []) if (!seen.has(t.id)) pages.data.push({ id: t.id, title: t.title, category: t.category, excerpt: '(title match, search inside it with read_knowledge_entry and a search_term)' });
  }
  return pages;
}

async function readKnowledgeEntry(userClient, input) {
  const id = ((input && input.id) || '').trim();
  if (!id) return { error: { message: 'id is required' } };
  const { data: entry, error } = await userClient
    .from('knowledge_entries')
    .select('id, title, category, entry_type, file_name, source_url, extraction_error')
    .eq('id', id)
    .maybeSingle();
  if (error) return { error };
  if (!entry) return { data: null, error: null };
  const label = pageLabel(entry);

  const searchTerm = ((input && input.search_term) || '').trim();
  if (searchTerm) {
    const found = await searchKnowledgePages(userClient, searchTerm, id, 6);
    if (found.error) return found;
    return { data: { ...entry, matches: found.data }, error: null };
  }

  const from = parseInt(input && input.page_from, 10);
  if (from > 0) {
    const to = Math.min(Math.max(parseInt(input && input.page_to, 10) || from, from), from + 5);
    const { data: rows, error: pErr } = await userClient.from('knowledge_pages').select('page_no, read_as, text, error')
      .eq('entry_id', id).gte('page_no', from).lte('page_no', to).order('page_no');
    if (pErr) return { error: pErr };
    const pages = (rows || []).map((r) => ({ [label]: r.page_no, read_as: r.read_as, text: r.read_as === 'failed' ? `(could not be read: ${r.error || 'unknown'})` : r.text }));
    let total = 0;
    for (const p of pages) { p.text = clip(p.text, Math.max(1000, PAGE_CHARS - total)); total += (p.text || '').length; }
    return { data: { ...entry, pages, note: pages.length ? undefined : `No ${label} ${from} to ${to} stored for this entry.` }, error: null };
  }

  const { data: rows, error: pErr } = await userClient.from('knowledge_pages').select('page_no, read_as, text')
    .eq('entry_id', id).neq('read_as', 'failed').order('page_no').limit(4);
  if (pErr) return { error: pErr };
  const { count } = await userClient.from('knowledge_pages').select('id', { count: 'exact', head: true }).eq('entry_id', id);
  let text = (rows || []).map((r) => `--- ${label} ${r.page_no} (${r.read_as}) ---\n${r.text || ''}`).join('\n\n');
  if (text.length > READ_ENTRY_CHAR_LIMIT) text = text.slice(0, READ_ENTRY_CHAR_LIMIT) + `... (cut: this entry has ${count || '?'} ${label}s, pass search_term or page_from to get to the right one)`;
  return { data: { ...entry, [label + 's']: count, text }, error: null };
}

module.exports = {
  CALC_TOOL, WEB_SEARCH_TOOL, QUERYABLE_TABLES, QUERY_TOOL, queryTool, KB_TOOL, READ_ENTRY_TOOL,
  runQuery, searchKnowledgeBase, readKnowledgeEntry, evaluate,
};
