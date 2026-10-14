// Keeps the overhead lines live from Xero's Profit and Loss report.
//
// The P&L is read for the last N months, every expense account on it (not cost of sales, which is
// the materials and direct costs already counted per job) is listed with its amount, and the
// mapping in overhead_xero_map says which account belongs to the employee bucket, the company
// bucket, or is ignored. applyMapping() then rewrites the 'xero' overhead lines from the report,
// scaled up to a full year, so the rates follow the books as the company changes.
//
// Needs the Xero custom connection to have the accounting.reports.read scope. If it does not,
// Xero answers 401/403 and the error says so plainly (see friendlyXeroError).

const { xeroRequest } = require('./xero-client');

const isoDate = (d) => d.toISOString().slice(0, 10);

function periodFor(months, now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to);
  from.setUTCMonth(from.getUTCMonth() - months);
  from.setUTCDate(from.getUTCDate() + 1);
  return { from: isoDate(from), to: isoDate(to) };
}

// Pulls every expense account (and its amount for the period) out of a Xero P&L report.
function parsePnlAccounts(report) {
  const rows = (report && report.Reports && report.Reports[0] && report.Reports[0].Rows) || [];
  const accounts = [];
  rows.forEach((section) => {
    if (section.RowType !== 'Section') return;
    const title = String(section.Title || '');
    if (!/expense/i.test(title)) return; // Income, Cost of Sales and the like are not overheads
    (section.Rows || []).forEach((row) => {
      if (row.RowType !== 'Row') return;
      const cells = row.Cells || [];
      const first = cells[0] || {};
      const attr = (first.Attributes || []).find((a) => String(a.Id).toLowerCase() === 'account');
      if (!attr || !attr.Value) return;
      const amount = parseFloat(String((cells[1] || {}).Value || '0').replace(/,/g, ''));
      accounts.push({ id: attr.Value, name: String(first.Value || '').trim(), amount: Number.isFinite(amount) ? amount : 0, section: title });
    });
  });
  return accounts;
}

function friendlyXeroError(err) {
  const msg = String((err && err.message) || err || '');
  if (/403|401|scope|forbidden|unauthori[sz]ed/i.test(msg)) {
    return 'Xero would not give us the Profit and Loss report. In the Xero developer portal, open this app\'s custom connection and add the "accounting.reports.read" scope, then try again. (' + msg + ')';
  }
  return msg;
}

async function fetchPnlAccounts(months) {
  const { from, to } = periodFor(months);
  const report = await xeroRequest('accounting', `Reports/ProfitAndLoss?fromDate=${from}&toDate=${to}`);
  return { from, to, months, accounts: parsePnlAccounts(report) };
}

// Rewrites the xero-sourced overhead lines from the report using the saved mapping.
async function applyMapping(admin) {
  const { data: settings } = await admin.from('overhead_settings').select('*').eq('id', 1).single();
  const months = (settings && settings.xero_months) || 12;
  try {
    const { data: map } = await admin.from('overhead_xero_map').select('*').in('bucket', ['employee', 'company']);
    if (!map || !map.length) {
      await admin.from('overhead_settings').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', 1);
      await admin.from('overhead_lines').delete().eq('source', 'xero');
      return { ok: true, updated: 0, removed: 0, months };
    }
    const report = await fetchPnlAccounts(months);
    const byId = new Map(report.accounts.map((a) => [a.id, a]));
    const scale = 12 / months;
    let updated = 0;
    const keep = [];
    for (const m of map) {
      const acc = byId.get(m.account_id);
      if (!acc) continue; // not on this period's report (no spend): any older line is removed below
      keep.push(m.account_id);
      const row = {
        bucket: m.bucket, name: acc.name || m.account_name, annual_amount: Math.round(acc.amount * scale * 100) / 100,
        source: 'xero', xero_account_id: m.account_id, xero_account_code: m.account_code || null, updated_at: new Date().toISOString(),
      };
      const { data: existing } = await admin.from('overhead_lines').select('id').eq('xero_account_id', m.account_id).maybeSingle();
      if (existing) await admin.from('overhead_lines').update(row).eq('id', existing.id);
      else await admin.from('overhead_lines').insert(row);
      updated++;
    }
    const { data: stale } = await admin.from('overhead_lines').select('id, xero_account_id').eq('source', 'xero');
    const staleIds = (stale || []).filter((l) => !keep.includes(l.xero_account_id)).map((l) => l.id);
    if (staleIds.length) await admin.from('overhead_lines').delete().in('id', staleIds);
    await admin.from('overhead_settings').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', 1);
    return { ok: true, updated, removed: staleIds.length, months, from: report.from, to: report.to };
  } catch (err) {
    const message = friendlyXeroError(err);
    await admin.from('overhead_settings').update({ last_sync_error: message.slice(0, 500) }).eq('id', 1);
    return { ok: false, error: message };
  }
}

module.exports = { periodFor, parsePnlAccounts, fetchPnlAccounts, applyMapping, friendlyXeroError };
