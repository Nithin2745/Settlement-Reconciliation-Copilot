// scripts/verifyDashboard.js
//
// Day 4 regression guard for the read-only dashboard (src/dashboard/server.js).
// Network-free like every other verify script in this project: almost everything
// here drives the exported request handler directly with stub req/res objects, so
// no port is bound and no socket is opened. Section F is the one exception — a
// single loopback round-trip, because a router that is correct in isolation and
// never actually served is not a dashboard.
//
// Seven things get checked, in order:
//   A. it is read-only. Every write verb is refused with 405 + Allow before any
//      routing happens. This is the assert that guards the claim in ADR terms:
//      the viewer cannot alter a reconciliation result.
//   B. the static allowlist. Traversal attempts 404 by the same path as any
//      unknown file, because no request string ever reaches path.join.
//   C. the run API — newest-first listing, parsed summary, and 404 (not an empty
//      run) for an id that is not in the trail.
//   D. JSON columns parsed for the client WITHOUT collapsing null into [], since
//      "not recorded" and "recorded, and empty" are different claims here.
//   E. exports carry the right content type and a download filename, and an
//      unknown run 404s rather than returning an empty CSV with status 200.
//   F. one real bind on 127.0.0.1:0 and two real requests over TCP.
//   G. the loopback predicate and the no-authentication warning that depends on
//      it — a silent non-loopback bind is the failure mode worth a test.

const os = require('os');
const fs = require('fs');
const path = require('path');

const auditDb = require('../src/db/auditDb');
const server = require('../src/dashboard/server');

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    console.log(`FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
    failures += 1;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-dash-'));
const dbPath = path.join(tmpRoot, 'audit.db');
// The handler only ever touches setHeader / writeHead / end, so a stub of three
// methods exercises the real routing with no socket in play. Every auditDb call
// in the handler is synchronous, so `end` has already fired by the time call()
// returns — no promise needed, which keeps the asserts readable.
function call(handler, method, url) {
  const captured = { status: null, headers: {}, body: null, ended: false };
  const res = {
    setHeader(name, value) {
      captured.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers) {
      captured.status = status;
      for (const [name, value] of Object.entries(headers || {})) {
        captured.headers[name.toLowerCase()] = value;
      }
      return res;
    },
    end(body) {
      captured.body = body === undefined ? null : body;
      captured.ended = true;
    },
  };
  handler({ method, url, headers: {} }, res);
  return captured;
}

function json(captured) {
  try {
    return JSON.parse(captured.body);
  } catch {
    return null;
  }
}

const handler = server.createHandler({ dbPath });
// A small trail with every shape the page has to render: two resolution paths, a
// row whose signals were recorded as empty, a row where none were recorded at
// all, and a reason-code pair where the gate dropped one of the model's codes.
function seedTrail() {
  const runId = auditDb.createRun(
    { ingestMode: 'fixture', source: 'synthetic', batchSize: 3, seed: 42 },
    dbPath
  );

  auditDb.logResolution(
    runId,
    {
      entityId: 'pay_DASH0001',
      entityType: 'payment',
      status: 'FULLY_MATCHED',
      confidenceTier: 'HIGH',
      bankMatchId: 'bank_DASH0001',
      bankMatchMethod: 'EXACT_UTR',
      ledgerMatchId: 'ledger_DASH0001',
      ledgerMatchMethod: 'EXACT_ORDER_ID',
      signals: [], // recorded, and there were none -> '[]'
      resolutionPath: 'RULE_ONLY',
      evalCaseType: 'CLEAN',
      evalVerdict: 'CORRECT',
    },
    dbPath
  );

  auditDb.logResolution(
    runId,
    {
      entityId: 'pay_DASH0002',
      entityType: 'payment',
      status: 'PARTIAL_BANK_ONLY',
      confidenceTier: 'LOW',
      bankMatchId: 'bank_DASH0002',
      bankMatchMethod: 'AMOUNT_DATE_PROXIMITY',
      signals: ['NO_LEDGER_CANDIDATE', 'PROXIMITY_ONLY_NO_REFERENCE'],
      resolutionPath: 'LLM_ACCEPTED',
      llmProvider: 'groq',
      llmDecision: 'CONFIRM_MATCH',
      llmCandidateId: 'bank_DASH0002',
      llmConfidence: 0.82,
      llmReasonCodes: ['EXACT_AMOUNT'],
      llmRawReasonCodes: ['EXACT_AMOUNT', 'AMOUNT_WITHIN_TOLERANCE'],
      validationReason: 'OK',
      validationWarnings: ['REDUNDANT_AMOUNT_CODES:AMOUNT_WITHIN_TOLERANCE'],
      evalCaseType: 'BLIND_PAYMENT',
      evalVerdict: 'CORRECT',
    },
    dbPath
  );
  auditDb.logResolution(
    runId,
    {
      entityId: 'pay_DASH0003',
      entityType: 'payment',
      status: 'UNRESOLVED',
      confidenceTier: 'LOW',
      unresolvedReason: 'AMBIGUOUS_CANDIDATES',
      resolutionPath: 'LLM_FLAGGED',
      llmProvider: 'openrouter',
      llmDecision: 'MATCH_CANDIDATE',
      llmCandidateId: 'bank_DASH0003a',
      llmConfidence: 0.55,
      llmReasonCodes: ['AMBIGUOUS_MULTIPLE_CANDIDATES'],
      llmRawReasonCodes: ['AMBIGUOUS_MULTIPLE_CANDIDATES'],
      validationReason: 'BELOW_CONFIDENCE_THRESHOLD',
      // signals deliberately absent -> null, not '[]'
    },
    dbPath
  );

  auditDb.finishRun(
    runId,
    {
      status: 'complete',
      summary: {
        deterministic: { precision: 1, silentMisses: 0, claims: 4, correctClaims: 4 },
        ai: { matchPrecision: 1, falsePositives: 0, namedDecisions: 1 },
        pipeline: { totalRecords: 3, resolvedByRules: 1, endToEndCoverage: 0.6667 },
      },
    },
    dbPath
  );

  // A second run left mid-flight: the page has to render a run with counts but
  // no scorecard, which is the state a live poll actually shows.
  const liveRunId = auditDb.createRun(
    { ingestMode: 'live', source: 'razorpay', batchSize: 50, seed: null },
    dbPath
  );
  auditDb.logResolution(
    liveRunId,
    {
      entityId: 'pay_DASH0100',
      entityType: 'payment',
      status: 'FULLY_MATCHED',
      confidenceTier: 'HIGH',
      signals: [],
      resolutionPath: 'RULE_ONLY',
    },
    dbPath
  );

  return { runId, liveRunId };
}
async function main() {
  const { runId, liveRunId } = seedTrail();

  // ---------------------------------------------------------------------------
  console.log('--- A. read-only by construction ---');
  // ---------------------------------------------------------------------------
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = call(handler, method, '/api/runs');
    check(`${method} is refused with 405`, res.status === 405, String(res.status));
    check(`${method} response names the allowed verbs`, res.headers.allow === 'GET, HEAD', res.headers.allow);
  }
  // The refusal must happen before routing, so even a nonexistent path 405s
  // rather than 404s — that ordering is what makes it a policy, not a per-route
  // omission somebody can forget to repeat.
  const writeToUnknown = call(handler, 'POST', '/api/does-not-exist');
  check('a write verb is refused before routing', writeToUnknown.status === 405, String(writeToUnknown.status));

  const getOk = call(handler, 'GET', '/api/runs');
  check('GET /api/runs is served', getOk.status === 200, String(getOk.status));
  const headOk = call(handler, 'HEAD', '/api/runs');
  check('HEAD /api/runs is served', headOk.status === 200, String(headOk.status));

  // ---------------------------------------------------------------------------
  console.log('\n--- B. static allowlist, not a directory walk ---');
  // ---------------------------------------------------------------------------
  const index = call(handler, 'GET', '/');
  check('GET / serves the page', index.status === 200, String(index.status));
  check(
    'GET / is html',
    String(index.headers['content-type']).startsWith('text/html'),
    index.headers['content-type']
  );
  check('the page loads its own css and js', /app\.css/.test(index.body) && /app\.js/.test(index.body));
  check('GET /app.css is css', call(handler, 'GET', '/app.css').headers['content-type'] === 'text/css; charset=utf-8');
  check(
    'GET /app.js is javascript',
    call(handler, 'GET', '/app.js').headers['content-type'] === 'text/javascript; charset=utf-8'
  );
  const traversals = [
    '/../../.env',
    '/../src/config.js',
    '/..%2f..%2f.env',
    '/%2e%2e/%2e%2e/.env',
    '/public/index.html',
    '/server.js',
    '/nope.css',
  ];
  for (const attempt of traversals) {
    const res = call(handler, 'GET', attempt);
    check(`404 for ${attempt}`, res.status === 404, String(res.status));
  }
  check(
    'the allowlist maps only the three public files',
    new Set([...server.STATIC_ROUTES.values()].map(([file]) => file)).size === 3,
    [...server.STATIC_ROUTES.keys()].join(',')
  );
  for (const [, [file]] of server.STATIC_ROUTES) {
    check(`allowlisted file exists on disk: ${file}`, fs.existsSync(path.join(server.PUBLIC_DIR, file)));
  }

  // ---------------------------------------------------------------------------
  console.log('\n--- C. the run API ---');
  // ---------------------------------------------------------------------------
  const list = json(call(handler, 'GET', '/api/runs'));
  check('two runs listed', list.runs.length === 2, String(list.runs.length));
  check('newest run first', list.runs[0].id === liveRunId, `${list.runs[0].id}`);
  check('the page is told the poll interval', Number.isFinite(list.pollMs), String(list.pollMs));
  check('the page is told the bind host', typeof list.host === 'string' && list.host.length > 0, list.host);
  check(
    'summary_json is handed over parsed, not as a string',
    list.runs[1].summary && list.runs[1].summary.pipeline.totalRecords === 3,
    JSON.stringify(list.runs[1].summary)
  );
  check('the raw summary_json string is not duplicated', !('summary_json' in list.runs[1]));
  check('an unfinished run has a null summary', list.runs[0].summary === null);
  const progress = json(call(handler, 'GET', `/api/runs/${runId}`));
  check('progress reports the row total', progress.total === 3, String(progress.total));
  check(
    'progress partitions by resolution path',
    progress.byResolutionPath.RULE_ONLY === 1 &&
      progress.byResolutionPath.LLM_ACCEPTED === 1 &&
      progress.byResolutionPath.LLM_FLAGGED === 1,
    JSON.stringify(progress.byResolutionPath)
  );
  check(
    'the path counts sum to the record total',
    Object.values(progress.byResolutionPath).reduce((a, b) => a + b, 0) === progress.total
  );
  check('progress carries the ground-truth tally', progress.evalVerdicts.CORRECT === 2, JSON.stringify(progress.evalVerdicts));

  const liveProgress = json(call(handler, 'GET', `/api/runs/${liveRunId}`));
  check('a live run is still running', liveProgress.run.status === 'running', liveProgress.run.status);
  check('a live run has counts but no scorecard', liveProgress.total === 1 && liveProgress.run.summary === null);
  check(
    'an ungraded run reports null verdicts, not an empty object',
    liveProgress.evalVerdicts === null,
    JSON.stringify(liveProgress.evalVerdicts)
  );

  const missing = call(handler, 'GET', '/api/runs/9999');
  check('an unknown run is a 404', missing.status === 404, String(missing.status));
  check('the 404 explains itself', /No run 9999/.test(missing.body), missing.body);
  const notANumber = call(handler, 'GET', '/api/runs/abc');
  check('a non-numeric run id never reaches the query', notANumber.status === 404, String(notANumber.status));
  const withQuery = json(call(handler, 'GET', `/api/runs/${runId}?t=12345`));
  check('a cache-busting query string is ignored', withQuery.total === 3, String(withQuery && withQuery.total));
  check(
    'API responses are never cached',
    call(handler, 'GET', `/api/runs/${runId}`).headers['cache-control'] === 'no-store'
  );
  // ---------------------------------------------------------------------------
  console.log('\n--- D. JSON columns parsed without losing null vs [] ---');
  // ---------------------------------------------------------------------------
  const rows = json(call(handler, 'GET', `/api/runs/${runId}/rows`)).rows;
  check('all three rows returned', rows.length === 3, String(rows.length));
  check('rows come back oldest first', rows[0].entity_id === 'pay_DASH0001', rows[0].entity_id);

  const clean = rows.find((r) => r.entity_id === 'pay_DASH0001');
  const matched = rows.find((r) => r.entity_id === 'pay_DASH0002');
  const flagged = rows.find((r) => r.entity_id === 'pay_DASH0003');

  check('signals arrive as an array', Array.isArray(matched.signals_json) && matched.signals_json.length === 2);
  check('an empty signals list stays an empty array', Array.isArray(clean.signals_json) && clean.signals_json.length === 0);
  // The distinction jsonOrNull exists to preserve: "recorded, and there were
  // none" must not be flattened into "nothing was recorded" on the way out.
  check('unrecorded signals stay null, not []', flagged.signals_json === null, JSON.stringify(flagged.signals_json));
  check('reason codes arrive as arrays', Array.isArray(matched.llm_reason_codes) && Array.isArray(matched.llm_raw_reason_codes));
  check(
    'the dropped reason code is still visible in the raw list',
    matched.llm_raw_reason_codes.length === 2 && matched.llm_reason_codes.length === 1,
    `${matched.llm_raw_reason_codes.length}/${matched.llm_reason_codes.length}`
  );
  check('gate warnings arrive as an array', Array.isArray(matched.validation_warnings));
  check('a rule-only row carries no llm fields', clean.llm_decision === null && clean.llm_confidence === null);
  check('confidence survives as a number', matched.llm_confidence === 0.82, String(matched.llm_confidence));
  const rowsMissing = call(handler, 'GET', '/api/runs/9999/rows');
  check('rows for an unknown run 404 rather than returning []', rowsMissing.status === 404, String(rowsMissing.status));
  // ---------------------------------------------------------------------------
  console.log('\n--- E. exports ---');
  // ---------------------------------------------------------------------------
  const csv = call(handler, 'GET', `/api/runs/${runId}/export.csv`);
  check('csv export is served', csv.status === 200, String(csv.status));
  check('csv is typed as csv', String(csv.headers['content-type']).startsWith('text/csv'), csv.headers['content-type']);
  check(
    'csv downloads under a run-specific filename',
    csv.headers['content-disposition'] === `attachment; filename="audit-run-${runId}.csv"`,
    csv.headers['content-disposition']
  );
  check('csv has a header row plus three records', csv.body.trim().split('\n').length === 4, String(csv.body.trim().split('\n').length));

  const jsonExport = call(handler, 'GET', `/api/runs/${runId}/export.json`);
  check('json export is served', jsonExport.status === 200, String(jsonExport.status));
  const parsedExport = json(jsonExport);
  check('json export carries the run and its rows', parsedExport.run.id === runId && parsedExport.rows.length === 3);
  check(
    'json export downloads under a run-specific filename',
    jsonExport.headers['content-disposition'] === `attachment; filename="audit-run-${runId}.json"`,
    jsonExport.headers['content-disposition']
  );
  // exportAuditCsv returns '' for an unknown run, which as a 200 would look like
  // a run with no records. The route has to answer 404 instead.
  check('csv for an unknown run 404s', call(handler, 'GET', '/api/runs/9999/export.csv').status === 404);
  check('json for an unknown run 404s', call(handler, 'GET', '/api/runs/9999/export.json').status === 404);
  check(
    'responses declare nosniff',
    csv.headers['x-content-type-options'] === 'nosniff' && index.headers['x-content-type-options'] === 'nosniff'
  );
  // ---------------------------------------------------------------------------
  console.log('\n--- F. one real bind, two real requests ---');
  // ---------------------------------------------------------------------------
  // Port 0 lets the OS pick, so this never collides with a dashboard the
  // developer already has running. Loopback only: nothing leaves the machine.
  const started = await server.startDashboard({ port: 0, host: '127.0.0.1', dbPath });
  check('the server binds and reports its port', started.port > 0, String(started.port));
  check('the url it prints is loopback', started.url.startsWith('http://127.0.0.1:'), started.url);

  try {
    const pageRes = await fetch(`${started.url}`);
    const pageBody = await pageRes.text();
    check('the page is served over TCP', pageRes.status === 200, String(pageRes.status));
    check('the page is the dashboard', /Settlement Reconciliation Copilot/.test(pageBody));

    const apiRes = await fetch(`${started.url}api/runs/${runId}`);
    const apiBody = await apiRes.json();
    check('the api answers over TCP', apiRes.status === 200, String(apiRes.status));
    check('the api answers with this run', apiBody.run.id === runId && apiBody.total === 3);

    const refused = await fetch(`${started.url}api/runs`, { method: 'DELETE' });
    check('a write verb is refused over TCP too', refused.status === 405, String(refused.status));
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
  check('the server closed', !started.server.listening);
  // ---------------------------------------------------------------------------
  console.log('\n--- G. the no-authentication posture is loud, not silent ---');
  // ---------------------------------------------------------------------------
  for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', 'LOCALHOST']) {
    check(`${host} counts as loopback`, server.isLoopbackHost(host) === true);
  }
  for (const host of ['0.0.0.0', '192.168.1.20', 'my-laptop.local', '', null, undefined]) {
    check(`${JSON.stringify(host)} does not count as loopback`, server.isLoopbackHost(host) === false);
  }

  // The warning is the only thing standing between "bound to every interface"
  // and "nobody noticed", so assert it actually fires and actually says the two
  // words that matter.
  const originalWarn = console.warn;
  const captured = [];
  console.warn = (...args) => captured.push(args.join(' '));
  let quiet;
  let loud;
  try {
    quiet = server.warnIfHostIsExposed('127.0.0.1', 4000);
    loud = server.warnIfHostIsExposed('0.0.0.0', 4000);
  } finally {
    console.warn = originalWarn;
  }
  check('a loopback bind warns about nothing', quiet === false && captured.length === 1, String(captured.length));
  check('a non-loopback bind warns', loud === true);
  check('the warning names the risk', /NO AUTHENTICATION/.test(captured.join('\n')));
  check('the warning names the host', /0\.0\.0\.0/.test(captured.join('\n')));
  // ---------------------------------------------------------------------------
  console.log('\n--- Day 4 dashboard summary ---');
  console.log(`  runs served         : ${list.runs.length}`);
  console.log(`  rows served         : ${rows.length}`);
  console.log(`  paths in run #${runId}     : ${JSON.stringify(progress.byResolutionPath)}`);
  console.log(`  write verbs accepted: 0`);

  auditDb.closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('temp database cleaned up', !fs.existsSync(tmpRoot));

  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
  }
}

main().catch((err) => {
  console.error('\n[verifyDashboard] fatal error:', err);
  auditDb.closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
