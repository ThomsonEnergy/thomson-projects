// The move off ServiceM8 in one run (item 111). Started from Settings > ServiceM8 Import by
// sm8-run-background.js, which also carries it on until it is finished.
//
// A run (sm8_runs) goes through these steps; each can stop when time is up and pick up where it
// left off, and each can be run again without doubling anything:
//   1. list     read all of ServiceM8 (sm8-import.js loadSm8Everything) and queue every client
//               (sm8_run_clients) and every Quote, Work Order and Completed job (sm8_run_jobs,
//               with its full ServiceM8 record: the raw copy). A dry run stops here.
//   2. clients  each ServiceM8 client becomes, or is linked to, a TEops client, with its contacts.
//   3. jobs     each queued job is written (sm8-job-writer.js), then its check-ins and checklist
//               (sm8-labour.js) and its file list (sm8-files.js). No call to ServiceM8.
//   4. files    the files are downloaded from ServiceM8, one call each.
// Unsuccessful and deleted jobs are never listed, so they stay behind.
//
// One run at a time (a unique index on sm8_runs) and one worker on it at a time: each go takes the
// run (worker_id) and every write to the run row checks it still holds it. A worker whose
// heartbeat has stopped for four minutes can be taken over; the one that lost the run stops.
//
// Nothing here sends anything to anyone: no email, text or notification, no invoice, nothing to
// Xero or payroll. Tables written: sm8_runs, sm8_run_clients, sm8_run_jobs, clients,
// client_contacts, and through the helpers projects, cost_centres, cost_centre_line_items,
// client_sites, time_entries, job_tasks, sm8_attachment_copies, project_photos, project_documents.

const crypto = require('crypto');
const { getIntegrationKey } = require('./get-integration-key');
const { loadSm8Everything, shapeSm8Job, matchClient, r2 } = require('./sm8-import');
const { writeSm8Job } = require('./sm8-job-writer');
const { copyJobRecords } = require('./sm8-labour');
const { queueJobFiles, copyPendingFiles, retryFailedFiles, wantedFiles } = require('./sm8-files');

// A dry run's list is good for this long: Bring everything across pressed after it starts from
// that list instead of reading ServiceM8 again.
const LIST_FRESH_MS = 60 * 60 * 1000;
// ServiceM8 said no more for now (its daily limit): try again after this long.
const RATE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const ERROR_WAIT_MS = 5 * 60 * 1000;
const MAX_STRIKES = 6;
// Reading ServiceM8 cannot stop part way: a read that dies this many times stops the run.
const MAX_LIST_TRIES = 3;
const TAKE_OVER_AFTER_MS = 4 * 60 * 1000;
const ACTIVE = ['listing', 'running', 'paused'];

const nowIso = () => new Date().toISOString();

async function all(query) {
  // Supabase hands back 1000 rows at a time.
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await query().range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

class LostRun extends Error {
  constructor() { super('Another worker has taken over this run'); this.lostRun = true; }
}

// Writes to the run row, and proves this worker still holds it: if another worker has taken the
// run over, nothing is written and this one stops (LostRun).
async function patchRun(db, run, fields) {
  let q = db.from('sm8_runs').update({ heartbeat_at: nowIso(), ...fields }).eq('id', run.id);
  if (run.worker) q = q.eq('worker_id', run.worker);
  const { data, error } = await q.select('id');
  if (error) throw error;
  if (run.worker && !data.length) throw new LostRun();
}

// A heartbeat no more than every 15 seconds, so the sweep can tell a live run from a dead one.
function heartbeat(db, run) {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < 15000) return;
    last = Date.now();
    await patchRun(db, run, {});
  };
}

// The newest run, or null.
async function latestRun(db) {
  const { data, error } = await db.from('sm8_runs').select('*').order('started_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data;
}

// Starts a run for the person who pressed the button. mode: 'dry_run' or 'full'. If one is
// already going it is returned instead ({ run, already: true }), except that a full run may take
// over from a dry run that is still listing.
async function startRun(db, userId, mode) {
  const last = await latestRun(db);
  if (last && ACTIVE.includes(last.status)) {
    if (mode === 'full' && last.mode === 'dry_run') {
      await patchRun(db, { id: last.id }, { mode: 'full' });
      return { run: { ...last, mode: 'full' }, already: true };
    }
    return { run: last, already: true };
  }
  // Straight after a dry run there is nothing new to read.
  const listed = last && last.status === 'listed' && Date.now() - new Date(last.finished_at || last.started_at).getTime() < LIST_FRESH_MS;
  const reuse = mode === 'full' && listed;
  const { data: run, error } = await db.from('sm8_runs')
    .insert({ mode, status: reuse ? 'running' : 'listing', started_by: userId, counts: reuse ? { ...last.counts, strikes: 0, requeued: false } : {} })
    .select('*').single();
  // two presses at once: the unique index lets one run start, the other press joins it
  if (error && error.code === '23505') return { run: await latestRun(db), already: true };
  if (error) throw error;
  if (mode === 'full') await retryFailedFiles(db);
  return { run, already: false };
}

// ---- 1. list ----------------------------------------------------------------

async function knownKeys(db, table, key) {
  const rows = await all(() => db.from(table).select(key).order(key));
  return new Set(rows.map(r => r[key]));
}

async function listEverything(db, run) {
  const apiKey = await getIntegrationKey('servicem8');
  const listStart = nowIso();
  const beat = heartbeat(db, run);
  const { companies, jobs, left } = await loadSm8Everything(apiKey, beat);

  // A row already on the list keeps its status and figures (a dry run after a finished run must
  // not make the report read "missing"): only what ServiceM8 says is refreshed. New rows wait.
  const knownClients = await knownKeys(db, 'sm8_run_clients', 'sm8_company_uuid');
  const knownJobs = await knownKeys(db, 'sm8_run_jobs', 'sm8_job_uuid');
  const upsert = async (table, key, rows) => {
    if (!rows.length) return;
    const { error } = await db.from(table).upsert(rows, { onConflict: key });
    if (error) throw error;
  };
  for (let i = 0; i < companies.length; i += 200) {
    const rows = companies.slice(i, i + 200).map(c => ({ sm8_company_uuid: c.uuid, name: c.name, payload: c, updated_at: nowIso() }));
    await upsert('sm8_run_clients', 'sm8_company_uuid', rows.filter(r => knownClients.has(r.sm8_company_uuid)));
    await upsert('sm8_run_clients', 'sm8_company_uuid', rows.filter(r => !knownClients.has(r.sm8_company_uuid)));
    await beat();
  }
  let files = 0;
  for (let i = 0; i < jobs.length; i += 25) {
    const rows = jobs.slice(i, i + 25).map(j => {
      const n = wantedFiles(j.payload.attachments).length;
      files += n;
      return { sm8_job_uuid: j.uuid, sm8_job_number: j.number, kind: j.kind, payload: j.payload, updated_at: nowIso(), files: n };
    });
    await upsert('sm8_run_jobs', 'sm8_job_uuid', rows.filter(r => knownJobs.has(r.sm8_job_uuid)).map(({ files: _n, ...r }) => r));
    await upsert('sm8_run_jobs', 'sm8_job_uuid', rows.filter(r => !knownJobs.has(r.sm8_job_uuid)).map(({ files: n, ...r }) => ({ ...r, stats: { files: n } })));
    await beat();
  }
  // Listed on an earlier run, gone from ServiceM8 since (marked Unsuccessful, deleted) and not
  // brought across yet: off the list.
  const { error: jErr } = await db.from('sm8_run_jobs').delete().lt('updated_at', listStart).is('project_id', null);
  if (jErr) throw jErr;
  const { error: cErr } = await db.from('sm8_run_clients').delete().lt('updated_at', listStart).is('client_id', null);
  if (cErr) throw cErr;

  const { count: alreadyIn } = await db.from('sm8_run_jobs').select('sm8_job_uuid', { count: 'exact', head: true }).not('project_id', 'is', null);
  return {
    listedAt: nowIso(),
    clients: companies.length,
    quotes: jobs.filter(j => j.kind === 'quote').length,
    jobs: jobs.filter(j => j.kind === 'job').length,
    completed: jobs.filter(j => j.kind === 'completed').length,
    files,
    alreadyIn: alreadyIn || 0,
    left,
    strikes: 0,
  };
}

// A full run goes over everything again, the rows done before included: time by newly matched
// staff, files added since, a deposit paid since. Nothing is made twice.
async function requeueAll(db) {
  const { error: jErr } = await db.from('sm8_run_jobs').update({ status: 'pending', error: null }).neq('status', 'pending');
  if (jErr) throw jErr;
  const { error: cErr } = await db.from('sm8_run_clients').update({ status: 'pending', error: null }).neq('status', 'pending');
  if (cErr) throw cErr;
}

// ---- 2. clients -------------------------------------------------------------

// Every TEops client, plus a second listing of a kept client under the ServiceM8 company of each
// client merged into it (item 110), so that company still lands on it.
async function loadClients(db) {
  const clients = await all(() => db.from('clients').select('id, name, email, phone, address, sm8_company_uuid').order('id'));
  const merged = await all(() => db.from('client_merges').select('into_client_id, from_sm8_company_uuid').not('from_sm8_company_uuid', 'is', null).order('into_client_id'));
  merged.forEach((m) => {
    const kept = clients.find(c => c.id === m.into_client_id);
    if (kept && kept.sm8_company_uuid !== m.from_sm8_company_uuid) clients.push({ ...kept, sm8_company_uuid: m.from_sm8_company_uuid, mergedAlias: true });
  });
  return clients;
}

const CONTACT_TYPES = { BILLING: 'accounts', ACCOUNTS: 'accounts', JOB: 'job', PROPERTY: 'site', SITE: 'site' };
const cut = (v, max) => String(v || '').trim().slice(0, max);

async function createClient(db, company) {
  const { data: created, error } = await db.from('clients').insert({
    name: cut(company.name, 300) || 'Unknown client',
    email: cut(company.email, 300) || null,
    phone: cut(company.phone, 100) || null,
    address: cut(company.address, 500) || null,
    sm8_company_uuid: company.uuid || null,
  }).select('id, name, email, phone, address, sm8_company_uuid').single();
  if (error) throw error;
  const seen = new Set();
  const contacts = (company.contacts || [])
    .filter(c => c.name || c.email || c.phone)
    .filter(c => { const k = `${c.name}|${c.email}|${c.phone}`.toLowerCase(); return seen.has(k) ? false : seen.add(k); })
    .slice(0, 30)
    .map((c, i) => ({ client_id: created.id, contact_type: CONTACT_TYPES[c.type] || 'job', name: cut(c.name, 200) || null, email: cut(c.email, 300) || null, phone: cut(c.phone, 100) || null, sort_order: i }));
  if (contacts.length) {
    const { error: cErr } = await db.from('client_contacts').insert(contacts);
    if (cErr) throw cErr;
  }
  return created;
}

async function syncClients(db, run, deadline) {
  const beat = heartbeat(db, run);
  const clients = await loadClients(db);
  const byId = new Map(clients.filter(c => !c.mergedAlias).map(c => [c.id, c]));
  while (Date.now() < deadline) {
    const { data: rows, error } = await db.from('sm8_run_clients').select('sm8_company_uuid, payload, client_id').eq('status', 'pending').order('sm8_company_uuid').limit(200);
    if (error) throw error;
    if (!rows.length) return true;
    for (const row of rows) {
      if (Date.now() >= deadline) return false;
      const done = async (fields) => {
        const { error: upErr } = await db.from('sm8_run_clients').update({ status: 'done', error: null, updated_at: nowIso(), ...fields }).eq('sm8_company_uuid', row.sm8_company_uuid);
        if (upErr) throw upErr;
      };
      try {
        const company = row.payload;
        if (row.client_id && byId.has(row.client_id)) {
          await done({}); // settled on an earlier run: who it is, and why, stays as it was
        } else {
          const m = matchClient(company, company.contacts || [], clients);
          if (m.clientId) {
            const hit = byId.get(m.clientId);
            // Remember the link so the next run matches straight to this client.
            if (hit && !hit.sm8_company_uuid) {
              await db.from('clients').update({ sm8_company_uuid: company.uuid }).eq('id', hit.id).is('sm8_company_uuid', null);
              hit.sm8_company_uuid = company.uuid;
            }
            await done({ client_id: m.clientId, made_new: false, reason: m.reason });
          } else {
            const created = await createClient(db, company);
            clients.push(created);
            byId.set(created.id, created);
            await done({ client_id: created.id, made_new: true, reason: m.lookalike });
          }
        }
      } catch (err) {
        console.error('sm8-run client error:', row.sm8_company_uuid, err.message);
        await db.from('sm8_run_clients').update({ status: 'failed', error: String(err.message).slice(0, 500), updated_at: nowIso() }).eq('sm8_company_uuid', row.sm8_company_uuid);
      }
      await beat();
    }
  }
  return false;
}

// ---- 3. jobs ----------------------------------------------------------------

// The TEops client a queued job belongs to. A client merged away since its row was settled is
// followed to the client it was merged into. A job with no ServiceM8 company gets a new client
// named after its contact: a name alone is never enough to put a job on an existing client (the
// Clients page offers the merge if it is one).
async function clientForJob(db, payload, contactName) {
  const pickClient = async (id) => {
    const { data } = await db.from('clients').select('id, name, email, phone, address').eq('id', id).maybeSingle();
    if (data) return data;
    const { data: merge } = await db.from('client_merges').select('into_client_id').eq('from_client_id', id).maybeSingle();
    return merge ? pickClient(merge.into_client_id) : null;
  };
  const companyUuid = payload.job.company_uuid;
  if (companyUuid) {
    const { data: row, error } = await db.from('sm8_run_clients').select('client_id, status, error').eq('sm8_company_uuid', companyUuid).maybeSingle();
    if (error) throw error;
    if (row && row.client_id) {
      const client = await pickClient(row.client_id);
      if (client) return client;
    }
    throw new Error(`Its client was not brought across${row && row.error ? `: ${row.error}` : ''}`);
  }
  return createClient(db, { name: cut(contactName, 300) || 'ServiceM8 job with no client' });
}

const hoursText = (h) => `${Math.round(h * 10) / 10} h`;

async function processJob(db, userId, row, ctx) {
  const { payload } = row;
  const shaped = shapeSm8Job(row.kind, payload, ctx.tierNames);
  // A job already in the app needs no client worked out (and must not have one made for it again).
  const { data: prior, error: priorErr } = await db.from('projects').select('id').eq('sm8_job_uuid', row.sm8_job_uuid).maybeSingle();
  if (priorErr) throw priorErr;
  const client = prior ? null : await clientForJob(db, payload, shaped.row.contactName);
  if (client) shaped.row.name = `${client.name} - ${shaped.row.name}`;
  const res = await writeSm8Job(db, userId, shaped.row, client, ctx.tierIds);
  const labour = await copyJobRecords(db, userId, res.projectId, payload, ctx.profileByStaff);
  const files = await queueJobFiles(db, res.projectId, payload.attachments);

  // Hours by people with no TEops login cannot become time entries: say so on the job, once.
  const noLogin = Object.entries(labour.unmatchedStaff).map(([uuid, hours]) => [(payload.staffNames || {})[uuid] || 'Unknown ServiceM8 staff', hours]);
  if (noLogin.length && !res.skipped) {
    const { data: p } = await db.from('projects').select('notes').eq('id', res.projectId).maybeSingle();
    const line = `ServiceM8 time by people with no TEops login when this came across (not in the Time tab): ${noLogin.map(([n, h]) => `${n} ${hoursText(h)}`).join(', ')}.`;
    await db.from('projects').update({ notes: [p && p.notes, line].filter(Boolean).join('\n\n') }).eq('id', res.projectId);
  }
  return {
    projectId: res.projectId,
    warnings: [...shaped.warnings, ...(res.overValue || []).map(nm => `ServiceM8 has a payment "${nm}" that is not on this job and would take invoiced to date past its value: left off, check it`)],
    stats: {
      files,
      hoursSeen: r2(labour.hoursSeen), hoursMatched: r2(labour.hoursMatched), hoursUnmatched: r2(labour.hoursUnmatched),
      noLogin: Object.fromEntries(noLogin.map(([n, h]) => [n, r2(h)])),
      checklist: labour.checklistSeen,
      owing: shaped.owing,
      alreadyIn: !!res.skipped,
      depositsAdded: (res.added || []).length,
    },
  };
}

async function processJobs(db, run, deadline) {
  const beat = heartbeat(db, run);
  const userId = run.started_by;
  const [{ data: tiers, error: tierErr }, { data: linked, error: linkErr }] = await Promise.all([
    db.from('billable_rate_tiers').select('id, name'),
    db.from('profiles').select('id, sm8_staff_uuid').not('sm8_staff_uuid', 'is', null),
  ]);
  if (tierErr) throw tierErr;
  if (linkErr) throw linkErr;
  const ctx = {
    tierNames: (tiers || []).map(t => String(t.name).trim()),
    tierIds: new Map((tiers || []).map(t => [String(t.name).trim().toLowerCase(), t.id])),
    profileByStaff: new Map((linked || []).map(p => [p.sm8_staff_uuid, p.id])),
  };
  // Open jobs first, then quotes, then the finished ones: what the crew needs tomorrow lands first.
  for (const kind of ['job', 'quote', 'completed']) {
    while (Date.now() < deadline) {
      const { data: rows, error } = await db.from('sm8_run_jobs').select('sm8_job_uuid, kind, payload').eq('status', 'pending').eq('kind', kind).order('sm8_job_number').limit(10);
      if (error) throw error;
      if (!rows.length) break;
      // One at a time: two jobs on one new site must not both create it.
      for (const row of rows) {
        if (Date.now() >= deadline) return false;
        try {
          const out = await processJob(db, userId, row, ctx);
          const { error: upErr } = await db.from('sm8_run_jobs')
            .update({ status: 'done', error: null, project_id: out.projectId, stats: out.stats, warnings: out.warnings, updated_at: nowIso() }).eq('sm8_job_uuid', row.sm8_job_uuid);
          if (upErr) throw upErr;
        } catch (err) {
          console.error('sm8-run job error:', row.sm8_job_uuid, err.message);
          await db.from('sm8_run_jobs').update({ status: 'failed', error: String(err.message).slice(0, 500), updated_at: nowIso() }).eq('sm8_job_uuid', row.sm8_job_uuid);
        }
        await beat();
      }
    }
    if (Date.now() >= deadline) return false;
  }
  return true;
}

// ---- the run ----------------------------------------------------------------

// Takes the run for this worker: free (the last worker handed it back), or its worker has gone
// quiet. Returns the run, or null when someone else is on it.
async function takeRun(db, runId) {
  const worker = crypto.randomUUID();
  const quiet = new Date(Date.now() - TAKE_OVER_AFTER_MS).toISOString();
  const { data, error } = await db.from('sm8_runs').update({ worker_id: worker, heartbeat_at: nowIso() })
    .eq('id', runId).in('status', ACTIVE).or(`worker_id.is.null,heartbeat_at.lt.${quiet}`).select('*');
  if (error) throw error;
  return data.length ? { ...data[0], worker } : null;
}

// Does as much of the run as fits before the deadline (a Date.now() value).
// Returns { more }: true when there is work left and the caller should start another go now.
async function runStep(db, runId, deadline) {
  const run = await takeRun(db, runId);
  if (!run) return { more: false };
  try {
    if (run.status === 'paused') {
      if (run.resume_after && new Date(run.resume_after).getTime() > Date.now()) {
        await patchRun(db, run, { worker_id: null });
        return { more: false };
      }
      run.status = run.counts && run.counts.listedAt ? 'running' : 'listing';
      await patchRun(db, run, { status: run.status, resume_after: null, error: null });
    }
    if (run.status === 'listing') {
      const tries = ((run.counts && run.counts.listTries) || 0) + 1;
      if (tries > MAX_LIST_TRIES) {
        await patchRun(db, run, { status: 'failed', finished_at: nowIso(), worker_id: null, error: `Reading ServiceM8 did not finish in ${MAX_LIST_TRIES} tries` });
        return { more: false };
      }
      run.counts = { ...run.counts, listTries: tries };
      await patchRun(db, run, { counts: run.counts });
      const counts = await listEverything(db, run);
      // the mode may have changed while listing: Bring everything across pressed during a dry run
      const { data: fresh } = await db.from('sm8_runs').select('mode').eq('id', run.id).maybeSingle();
      run.mode = (fresh && fresh.mode) || run.mode;
      if (run.mode === 'dry_run') {
        await patchRun(db, run, { status: 'listed', counts, finished_at: nowIso(), worker_id: null });
        return { more: false };
      }
      run.counts = { ...counts, requeued: true };
      await requeueAll(db);
      await patchRun(db, run, { status: 'running', counts: run.counts });
    } else if (!run.counts.requeued) {
      // started from a dry run's list: the same going over, once
      await requeueAll(db);
      run.counts = { ...run.counts, requeued: true };
      await patchRun(db, run, { counts: run.counts });
    }
    const clientsDone = await syncClients(db, run, deadline);
    const jobsDone = clientsDone && await processJobs(db, run, deadline);
    if (jobsDone) {
      const apiKey = await getIntegrationKey('servicem8');
      const { left } = await copyPendingFiles(db, apiKey, run.started_by, deadline, heartbeat(db, run));
      if (!left) {
        await patchRun(db, run, { status: 'done', finished_at: nowIso(), worker_id: null, counts: { ...run.counts, strikes: 0 } });
        return { more: false };
      }
    }
    await patchRun(db, run, { worker_id: null, counts: { ...run.counts, strikes: 0 } });
    return { more: true };
  } catch (err) {
    // Another worker has the run now: this one stops and touches nothing.
    if (err.lostRun) return { more: false };
    console.error('sm8-run error:', err.message);
    // ServiceM8's limit, or a hiccup: wait and carry on (sm8-run-sweep.js restarts it). The same
    // failure six times in a row stops the run with the reason on screen.
    const strikes = err.rateLimited ? 0 : ((run.counts && run.counts.strikes) || 0) + 1;
    const stop = strikes >= MAX_STRIKES;
    try {
      await patchRun(db, run, {
        status: stop ? 'failed' : 'paused',
        worker_id: null,
        error: String(err.message).slice(0, 500),
        resume_after: stop ? null : new Date(Date.now() + (err.rateLimited ? RATE_LIMIT_WAIT_MS : ERROR_WAIT_MS)).toISOString(),
        counts: { ...run.counts, strikes },
        ...(stop ? { finished_at: nowIso() } : {}),
      });
    } catch (again) {
      if (!again.lostRun) console.error('sm8-run could not record the stop:', again.message);
    }
    return { more: false };
  }
}

// The run the sweep should restart, if any: one whose worker has gone quiet, or a paused one
// whose wait is over.
async function runToResume(db) {
  const run = await latestRun(db);
  if (!run) return null;
  const quietFor = Date.now() - new Date(run.heartbeat_at).getTime();
  if (['listing', 'running'].includes(run.status) && quietFor > TAKE_OVER_AFTER_MS + 60 * 1000) return run;
  if (run.status === 'paused' && run.resume_after && new Date(run.resume_after).getTime() <= Date.now()) return run;
  return null;
}

module.exports = { startRun, runStep, runToResume };
