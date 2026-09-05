// scripts/verifyAuditDb.js
//
// Day 4 regression guard for the SQLite audit trail. Network-free like every
// other verify script: it drives the real matcher and the real resolveExceptions
// with an injected fake llmCaller, so it needs no Groq/OpenRouter access.
//
// Seven things get checked, in order:
//   A. schema + run lifecycle — a run stays 'running' with no finished_at until
//      finishRun, and carries its summary as JSON afterwards
//   B. one row round-trips: every structured field comes back out as it went in,
//      the money survives as integer paise, and the demo-only eval_* columns stay
//      null on an unscored run
//   C. bulk insert and getRunProgress tallies — what the dashboard polls
//   D. the per-path handle cache. Two db paths must not share one connection, or
//      a test run would silently write into the real data/audit.db
//   E. CSV / JSON export, including a narration carrying a comma, a quote and a
//      newline — the three characters that break naive CSV
//   F. end-to-end: real batch -> real matcher -> real resolveExceptions with a
//      fake caller -> live onResolution writes. The trail must account for every
//      record exactly once, which is the assert that would actually catch a
//      wiring mistake.
//   G. the additive migration, against a db created with the pre-money schema.
//      `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so without
//      migrate() the new columns would exist in auditDb.js and not on disk and
//      the first insert would fail — a break that only shows up on an upgrade,
//      never on a fresh clone, which is exactly the kind a fresh-db test misses.
//
// What a pass here does NOT prove: runFullPipeline.js's own field mapping, since
// that script needs real API keys. `npm run run-pipeline` is what exercises it.

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay } = require('../src/matcher/matchEngine');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');
const { resolveExceptions } = require('../src/llm/resolveExceptions');
const auditDb = require('../src/db/auditDb');

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    console.log(`FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
    failures += 1;
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-audit-'));
const dbPath = path.join(tmpRoot, 'audit.db');
const altDbPath = path.join(tmpRoot, 'other.db');
const legacyDbPath = path.join(tmpRoot, 'legacy.db');

async function main() {
  // ---------------------------------------------------------------------------
  console.log('--- A. schema + run lifecycle ---');
  // ---------------------------------------------------------------------------
  const runId = auditDb.createRun(
    { ingestMode: 'fixture', source: 'synthetic', batchSize: 30, seed: 42 },
    dbPath
  );
  check('createRun returns a row id', typeof runId === 'number' && runId > 0, String(runId));
  check('db file created on first use', fs.existsSync(dbPath));

  const tables = auditDb
    .getDb(dbPath)
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all()
    .map((r) => r.name);
  check('both tables exist', tables.includes('runs') && tables.includes('audit_log'), tables.join(','));

  const indexes = auditDb
    .getDb(dbPath)
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
    .all()
    .map((r) => r.name);
  check('run/status/path indexes created', indexes.length === 3, indexes.join(','));

  const running = auditDb.getRun(runId, dbPath);
  check('a new run is running', running.status === 'running', running.status);
  check('a new run has started_at', typeof running.started_at === 'string' && running.started_at.includes('T'));
  check('a new run has no finished_at', running.finished_at === null);
  check('run records batch_size and seed', running.batch_size === 30 && running.seed === 42);
  check('run records ingest_mode', running.ingest_mode === 'fixture', running.ingest_mode);

  // ---------------------------------------------------------------------------
  console.log('\n--- B. one row round-trips ---');
  // ---------------------------------------------------------------------------
  auditDb.logResolution(
    runId,
    {
      entityId: 'pay_TEST0001',
      entityType: 'payment',
      settlementUtr: 'UTR8842910077',
      status: 'PARTIAL_BANK_ONLY',
      confidenceTier: 'LOW',
      grossAmount: 250000,
      // Zero on purpose. `|| null` would file a genuinely waived fee in the trail
      // as "not recorded", which is the same bug class as the config knobs — so
      // rowParams uses `?? null` and this asserts it.
      fee: 0,
      tax: 900,
      netAmount: 249100,
      bankAmount: 249100,
      ledgerAmount: null,
      bankMatchId: 'bank_001',
      bankMatchMethod: 'EXACT_UTR',
      ledgerMatchId: null,
      ledgerMatchMethod: null,
      signals: ['NO_LEDGER_CANDIDATE', 'AMOUNT_MISMATCH'],
      resolutionPath: 'LLM_ACCEPTED',
      llmProvider: 'groq',
      llmDecision: 'MATCH_CANDIDATE',
      llmCandidateId: 'ledger_007',
      llmConfidence: 0.82,
      llmReasonCodes: ['EXACT_REFERENCE_MATCH'],
      llmRawReasonCodes: ['EXACT_ORDER_ID', 'EXACT_AMOUNT'],
      validationReason: 'OK',
      validationWarnings: ['ALIASED_REASON_CODE:EXACT_ORDER_ID->EXACT_REFERENCE_MATCH'],
    },
    dbPath
  );

  const [row] = auditDb.getAuditRows(runId, dbPath);
  check('row written', !!row);
  check(
    'entity and resolution path preserved',
    row.entity_id === 'pay_TEST0001' && row.resolution_path === 'LLM_ACCEPTED'
  );
  check(
    'match methods preserved, absent side null',
    row.bank_match_method === 'EXACT_UTR' && row.ledger_match_method === null
  );
  check('confidence stored as a real number', row.llm_confidence === 0.82, String(row.llm_confidence));
  check('settlement UTR stored', row.settlement_utr === 'UTR8842910077', row.settlement_utr);
  check(
    'the waterfall round-trips as integer paise',
    row.gross_amount === 250000 && row.tax === 900 && row.net_amount === 249100,
    `${row.gross_amount}/${row.tax}/${row.net_amount}`
  );
  // The distinction the whole money change rests on: a fee of zero was measured,
  // an absent ledger amount was not. Collapsing either into the other would let
  // the dashboard render a number nobody recorded.
  check('a zero amount is stored as 0, not null', row.fee === 0, String(row.fee));
  check('an unmatched side stores null, not 0', row.ledger_amount === null, String(row.ledger_amount));
  check('the matched bank amount is stored', row.bank_amount === 249100, String(row.bank_amount));
  check(
    'signals round-trip through JSON',
    JSON.parse(row.signals_json).join(',') === 'NO_LEDGER_CANDIDATE,AMOUNT_MISMATCH'
  );
  check('sanitized reason codes round-trip', JSON.parse(row.llm_reason_codes)[0] === 'EXACT_REFERENCE_MATCH');
  // The pair is the point: "the decision stood on what survived the gate" is
  // only auditable if what the model originally said is still on record.
  check('raw reason codes kept alongside sanitized', JSON.parse(row.llm_raw_reason_codes).length === 2);
  check('validation warnings round-trip', JSON.parse(row.validation_warnings).length === 1);
  check('eval columns null on an unscored row', row.eval_case_type === null && row.eval_verdict === null);
  check('created_at set', typeof row.created_at === 'string' && row.created_at.includes('T'));

  auditDb.logResolution(
    runId,
    { entityId: 'pay_TEST0002', status: 'UNRESOLVED', resolutionPath: 'LLM_SKIPPED' },
    dbPath
  );
  auditDb.logResolution(
    runId,
    { entityId: 'pay_TEST0003', status: 'FULLY_MATCHED', resolutionPath: 'RULE_ONLY', signals: [] },
    dbPath
  );
  const [, bare, emptySignals] = auditDb.getAuditRows(runId, dbPath);
  check(
    'absent structured fields stay null',
    bare.signals_json === null && bare.llm_reason_codes === null && bare.validation_warnings === null
  );
  // "Nothing recorded" and "recorded, and there was nothing" are different
  // claims in an audit trail, so they must not collapse into the same value.
  check('an empty array is stored as [], not null', emptySignals.signals_json === '[]', String(emptySignals.signals_json));

  // ---------------------------------------------------------------------------
  console.log('\n--- C. bulk insert + dashboard progress ---');
  // ---------------------------------------------------------------------------
  const bulk = [1, 2, 3, 4].map((i) => ({
    entityId: `pay_BULK000${i}`,
    entityType: 'payment',
    status: 'FULLY_MATCHED',
    confidenceTier: 'HIGH',
    resolutionPath: 'RULE_ONLY',
    evalCaseType: 'CLEAN',
    evalVerdict: i === 4 ? 'WRONG' : 'CORRECT',
  }));
  auditDb.logResolutionsBulk(runId, bulk, dbPath);

  const progress = auditDb.getRunProgress(runId, dbPath);
  check('total counts every row', progress.total === 7, String(progress.total));
  check(
    'byResolutionPath tallies correctly',
    progress.byResolutionPath.RULE_ONLY === 5 &&
      progress.byResolutionPath.LLM_ACCEPTED === 1 &&
      progress.byResolutionPath.LLM_SKIPPED === 1,
    JSON.stringify(progress.byResolutionPath)
  );
  check('byStatus tallies correctly', progress.byStatus.FULLY_MATCHED === 5, JSON.stringify(progress.byStatus));
  check(
    'evalVerdicts tallies correctly',
    progress.evalVerdicts.CORRECT === 3 && progress.evalVerdicts.WRONG === 1,
    JSON.stringify(progress.evalVerdicts)
  );
  check('progress carries the run row', progress.run.id === runId);
  check('progress for an unknown run is null', auditDb.getRunProgress(99999, dbPath) === null);

  auditDb.finishRun(runId, { status: 'complete', summary: { endToEndCoverage: 0.833 } }, dbPath);
  const done = auditDb.getRun(runId, dbPath);
  check('finishRun sets status', done.status === 'complete', done.status);
  check('finishRun sets finished_at', typeof done.finished_at === 'string' && done.finished_at.includes('T'));
  check('summary stored as JSON', JSON.parse(done.summary_json).endToEndCoverage === 0.833);
  check('error stays null on success', done.error === null);

  const failedRunId = auditDb.createRun({ ingestMode: 'fixture', source: 'synthetic' }, dbPath);
  auditDb.finishRun(failedRunId, { status: 'failed', error: 'provider exploded' }, dbPath);
  const failedRun = auditDb.getRun(failedRunId, dbPath);
  check('a failed run records its error', failedRun.status === 'failed' && failedRun.error === 'provider exploded');
  check('a failed run still gets finished_at', failedRun.finished_at !== null);

  // A real production run has no synthetic answer key, so the eval columns stay
  // empty and the dashboard must be able to tell that from "scored, all wrong".
  const liveRunId = auditDb.createRun({ ingestMode: 'live', source: 'razorpay' }, dbPath);
  auditDb.logResolution(
    liveRunId,
    { entityId: 'pay_LIVE1', status: 'FULLY_MATCHED', resolutionPath: 'RULE_ONLY' },
    dbPath
  );
  const liveProgress = auditDb.getRunProgress(liveRunId, dbPath);
  check('evalVerdicts is null when there is no ground truth', liveProgress.evalVerdicts === null);
  check('runs are isolated by run_id', liveProgress.total === 1, String(liveProgress.total));
  check('batch_size and seed are nullable on a live run', liveProgress.run.batch_size === null && liveProgress.run.seed === null);
  check('listRuns returns newest first', auditDb.listRuns(dbPath)[0].id === liveRunId);

  // ---------------------------------------------------------------------------
  console.log('\n--- D. one connection per db path ---');
  // ---------------------------------------------------------------------------
  // A single-slot handle cache would hand the throwaway test db back the real
  // data/audit.db — writing test rows into the demo's audit trail with no error.
  const dbA = auditDb.getDb(dbPath);
  const dbB = auditDb.getDb(altDbPath);
  check('different paths get different handles', dbA !== dbB);
  check('the same path is reused, not reopened', auditDb.getDb(dbPath) === dbA);

  const altRunId = auditDb.createRun({ ingestMode: 'fixture', source: 'synthetic' }, altDbPath);
  check('a second db starts its own id sequence', altRunId === 1, String(altRunId));
  check('rows do not leak between dbs', auditDb.getRunProgress(altRunId, altDbPath).total === 0);
  check('the first db is untouched', auditDb.listRuns(dbPath).length === 3, String(auditDb.listRuns(dbPath).length));

  auditDb.closeDb(altDbPath);
  check('closeDb(path) closes only that handle', !dbB.open && dbA.open);
  check('closeDb(path) is idempotent', (auditDb.closeDb(altDbPath), true));

  // ---------------------------------------------------------------------------
  console.log('\n--- E. CSV / JSON export ---');
  // ---------------------------------------------------------------------------
  const csvRunId = auditDb.createRun({ ingestMode: 'fixture', source: 'synthetic' }, dbPath);
  const nastyNarration = 'NEFT CR, "MEGA" traders\nline two';
  auditDb.logResolution(
    csvRunId,
    {
      entityId: 'pay_CSV1',
      status: 'UNRESOLVED',
      resolutionPath: 'LLM_REJECTED',
      unresolvedReason: nastyNarration,
      validationReason: 'HALLUCINATED_CANDIDATE_ID',
    },
    dbPath
  );

  const csv = auditDb.exportAuditCsv(csvRunId, dbPath);
  const header = csv.split('\n')[0];
  const headerCols = header.split(',');
  // Expected width is read from the table rather than hard-coded: toCsv derives
  // its columns from Object.keys(row), so the assert that matters is "the export
  // covers what the table has", and a literal here would only ever be bumped to
  // match whatever the code now does — which is not a test.
  const tableCols = auditDb
    .getDb(dbPath)
    .pragma('table_info(audit_log)')
    .map((c) => c.name);
  check('csv starts with a header row', header.startsWith('id,run_id,entity_id'), header.slice(0, 40));
  check(
    'csv header covers every column',
    headerCols.length === tableCols.length && tableCols.every((c) => headerCols.includes(c)),
    `${headerCols.length} header vs ${tableCols.length} table columns`
  );
  // Named explicitly as well: a set comparison passes if the export and the table
  // are wrong together, and these seven are the ones this change added.
  check(
    'csv header carries the money columns',
    ['settlement_utr', 'gross_amount', 'fee', 'tax', 'net_amount', 'bank_amount', 'ledger_amount'].every(
      (c) => headerCols.includes(c)
    ),
    header
  );
  check('csv quotes a field containing a comma', csv.includes('"NEFT CR, '));
  check('csv doubles embedded quotes', csv.includes('""MEGA""'));
  check('csv of an unknown run is an empty string', auditDb.exportAuditCsv(99999, dbPath) === '');

  const exported = JSON.parse(auditDb.exportAuditJson(csvRunId, dbPath));
  check('json export carries the run and its rows', exported.run.id === csvRunId && exported.rows.length === 1);
  check('json export preserves the value verbatim', exported.rows[0].unresolved_reason === nastyNarration);

  // ---------------------------------------------------------------------------
  console.log('\n--- F. end-to-end: real pipeline, fake caller, live writes ---');
  // ---------------------------------------------------------------------------
  const { settlementRecon, bankStatement, ledger, groundTruth } = generateSyntheticBatch({
    size: 30,
    seed: 42,
  });
  const { records } = normalizeSettlementRecon(settlementRecon);
  const { results, unclaimedBankRecords, unclaimedLedgerRecords } = matchThreeWay(
    records,
    bankStatement,
    ledger
  );

  const e2eRunId = auditDb.createRun(
    { ingestMode: 'fixture', source: 'synthetic', batchSize: 30, seed: 42 },
    dbPath
  );

  // Mirrors auditRowFromResult() in runFullPipeline.js: the deterministic half of
  // a row, shared by the bulk path and the live escalated path, so an escalated
  // record still carries whatever the engine did find and the amounts are
  // exercised off a real batch rather than only the hand-written row in section B.
  const bySettlementId = new Map(results.map((r) => [r.settlement.entityId, r]));
  const deterministicHalf = (r) => ({
    entityId: r.settlement.entityId,
    entityType: r.settlement.type,
    settlementUtr: r.settlement.settlementUtr,
    status: r.status,
    confidenceTier: r.confidenceTier,
    grossAmount: r.settlement.grossAmount,
    fee: r.settlement.fee,
    tax: r.settlement.tax,
    netAmount: r.settlement.netAmount,
    bankAmount: r.bankMatch && r.bankMatch.record ? r.bankMatch.record.amount : null,
    ledgerAmount: r.ledgerMatch && r.ledgerMatch.record ? r.ledgerMatch.record.amount : null,
    bankMatchId: r.bankMatch && r.bankMatch.record ? r.bankMatch.record.externalId : null,
    bankMatchMethod: r.bankMethod,
    ledgerMatchId: r.ledgerMatch && r.ledgerMatch.record ? r.ledgerMatch.record.externalId : null,
    ledgerMatchMethod: r.ledgerMethod,
    signals: r.signals,
    unresolvedReason: r.unresolvedReason,
    evalCaseType: (groundTruth.records[r.settlement.entityId] || {}).caseType || null,
  });

  const ruleRows = results
    .filter((r) => !r.needsReview)
    .map((r) => ({ ...deterministicHalf(r), resolutionPath: 'RULE_ONLY' }));
  auditDb.logResolutionsBulk(e2eRunId, ruleRows, dbPath);

  // An honest fake: declines everything. Always valid against the contract, so
  // every escalated record lands on one path and what is under test here is the
  // trail's completeness, not the model's judgment.
  const fakeCaller = async () => ({
    raw: JSON.stringify({
      candidate_id: null,
      decision: 'NO_MATCH_FOUND',
      confidence: 0.9,
      reason_codes: ['INSUFFICIENT_EVIDENCE'],
    }),
    provider: 'groq',
  });

  const writeOrder = [];
  const { resolutions } = await resolveExceptions({
    results,
    unclaimedBankRecords,
    unclaimedLedgerRecords,
    maxCandidatesPerException: 5,
    llmCaller: fakeCaller,
    onResolution: (res) => {
      writeOrder.push(res.entityId);
      auditDb.logResolution(
        e2eRunId,
        {
          ...deterministicHalf(bySettlementId.get(res.entityId)),
          status: res.status,
          resolutionPath: res.outcome === 'SKIPPED_NO_CANDIDATES' ? 'LLM_SKIPPED' : 'LLM_ACCEPTED',
          llmProvider: res.provider,
          llmDecision: res.decision,
          llmConfidence: res.confidence,
          llmReasonCodes: res.reasonCodes,
          validationReason: res.validationReason,
        },
        dbPath
      );
    },
  });

  check(
    'onResolution fired once per resolution',
    writeOrder.length === resolutions.length,
    `${writeOrder.length} hooks vs ${resolutions.length} resolutions`
  );
  check(
    'onResolution fired in resolution order',
    writeOrder.join(',') === resolutions.map((r) => r.entityId).join(',')
  );

  const e2e = auditDb.getRunProgress(e2eRunId, dbPath);
  const paths = e2e.byResolutionPath;
  const escalatedCount = results.filter((r) => r.needsReview).length;
  check('trail accounts for every record', e2e.total === results.length, `${e2e.total} rows vs ${results.length} records`);
  check(
    'resolution paths partition the batch',
    (paths.RULE_ONLY || 0) + (paths.LLM_ACCEPTED || 0) + (paths.LLM_SKIPPED || 0) === results.length,
    JSON.stringify(paths)
  );
  check('rule-only count matches the matcher', paths.RULE_ONLY === results.length - escalatedCount, JSON.stringify(paths));
  check('escalated count matches the matcher', (paths.LLM_ACCEPTED || 0) + (paths.LLM_SKIPPED || 0) === escalatedCount);

  const loggedIds = new Set(auditDb.getAuditRows(e2eRunId, dbPath).map((r) => r.entity_id));
  check('no record is logged twice', loggedIds.size === results.length, `${loggedIds.size} unique of ${e2e.total} rows`);
  check('every record in the batch appears', results.every((r) => loggedIds.has(r.settlement.entityId)));
  check('the skipped path is exercised at all', (paths.LLM_SKIPPED || 0) > 0, JSON.stringify(paths));

  // The money, tied back to what the matcher concluded about it. These are the
  // asserts that pin which settlement field each counterparty amount is measured
  // against — bank credits against net, ledger entries against gross, exactly as
  // AMOUNT_FIELD_BY_SOURCE in matchEngine.js has it. File a bank amount against
  // gross and the dashboard would show a red delta of fee + tax on every clean
  // record while every other check in this file still passed.
  const e2eRows = auditDb.getAuditRows(e2eRunId, dbPath);
  check(
    'every row carries its waterfall, escalated ones included',
    e2eRows.length > 0 && e2eRows.every((r) => r.gross_amount !== null && r.net_amount !== null),
    `${e2eRows.filter((r) => r.net_amount === null).length} of ${e2eRows.length} missing a net`
  );

  const amountMismatch = (r) => {
    const src = bySettlementId.get(r.entity_id);
    const signals = r.signals_json ? JSON.parse(r.signals_json) : [];
    if (
      r.bank_amount !== null &&
      signals.includes('AMOUNT_DISAGREES_BANK') !== (r.bank_amount !== r.net_amount)
    ) {
      return `${r.entity_id}: bank ${r.bank_amount} vs net ${r.net_amount}, signals ${signals.join('|')}`;
    }
    if (
      r.ledger_amount !== null &&
      signals.includes('AMOUNT_DISAGREES_LEDGER') !== (r.ledger_amount !== r.gross_amount)
    ) {
      return `${r.entity_id}: ledger ${r.ledger_amount} vs gross ${r.gross_amount}, signals ${signals.join('|')}`;
    }
    const matcherBank = src && src.bankMatch && src.bankMatch.record ? src.bankMatch.record.amount : null;
    if (r.bank_amount !== matcherBank) {
      return `${r.entity_id}: trail says bank ${r.bank_amount}, matcher says ${matcherBank}`;
    }
    return null;
  };
  const firstBadAmount = e2eRows.map(amountMismatch).find(Boolean) || null;
  check('stored amounts agree with the signals the matcher raised', firstBadAmount === null, firstBadAmount);

  // A batch with no disagreement in it would let a broken delta pass unnoticed,
  // so assert the fixture actually contains one to measure.
  const disagreements = e2eRows.filter((r) => (r.signals_json || '').includes('AMOUNT_DISAGREES')).length;
  check('the batch contains at least one amount disagreement', disagreements > 0, String(disagreements));
  check(
    'an unmatched side stores null rather than zero end to end',
    e2eRows.some((r) => r.bank_amount === null) && !e2eRows.some((r) => r.bank_amount === 0),
    `${e2eRows.filter((r) => r.bank_amount === null).length} null, ${e2eRows.filter((r) => r.bank_amount === 0).length} zero`
  );

  auditDb.finishRun(e2eRunId, { status: 'complete' }, dbPath);

  // ---------------------------------------------------------------------------
  console.log('\n--- G. the additive migration on a pre-money database ---');
  // ---------------------------------------------------------------------------
  // Everything above this ran against a database this process created, where
  // `CREATE TABLE` did all the work and migrate() had nothing to do. That is the
  // one shape of database this change cannot break. The shape it can break is the
  // one a demo actually has on disk: written before the money columns existed, so
  // `CREATE TABLE IF NOT EXISTS` is a no-op and the columns reach the file only if
  // migrate() puts them there.
  const OLD_SCHEMA = `
CREATE TABLE runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  ingest_mode   TEXT NOT NULL,
  source        TEXT NOT NULL,
  batch_size    INTEGER,
  seed          INTEGER,
  status        TEXT NOT NULL DEFAULT 'running',
  summary_json  TEXT,
  error         TEXT
);
CREATE TABLE audit_log (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               INTEGER NOT NULL REFERENCES runs(id),
  entity_id            TEXT NOT NULL,
  entity_type          TEXT,
  status               TEXT NOT NULL,
  confidence_tier      TEXT,
  bank_match_id        TEXT,
  bank_match_method    TEXT,
  ledger_match_id      TEXT,
  ledger_match_method  TEXT,
  signals_json         TEXT,
  unresolved_reason    TEXT,
  resolution_path      TEXT NOT NULL,
  llm_provider         TEXT,
  llm_decision         TEXT,
  llm_candidate_id     TEXT,
  llm_confidence       REAL,
  llm_reason_codes     TEXT,
  llm_raw_reason_codes TEXT,
  validation_reason    TEXT,
  validation_warnings  TEXT,
  eval_case_type       TEXT,
  eval_verdict         TEXT,
  created_at           TEXT NOT NULL
);
`;

  const legacy = new Database(legacyDbPath);
  legacy.exec(OLD_SCHEMA);
  legacy
    .prepare(
      `INSERT INTO runs (started_at, ingest_mode, source, status)
       VALUES ('2026-09-01T00:00:00.000Z', 'fixture', 'synthetic', 'complete')`
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO audit_log (run_id, entity_id, status, resolution_path, created_at)
       VALUES (1, 'pay_LEGACY1', 'FULLY_MATCHED', 'RULE_ONLY', '2026-09-01T00:00:01.000Z')`
    )
    .run();
  const legacyColumns = legacy.pragma('table_info(audit_log)').map((c) => c.name);
  legacy.close();
  check('the fixture really is a pre-money database', legacyColumns.length === 24, String(legacyColumns.length));
  check(
    'the fixture has none of the new columns',
    auditDb.ADDED_COLUMNS.every(([, column]) => !legacyColumns.includes(column))
  );

  const migrated = auditDb.getDb(legacyDbPath);
  const migratedColumns = migrated.pragma('table_info(audit_log)').map((c) => c.name);
  check(
    'every declared column is added',
    auditDb.ADDED_COLUMNS.every(([, column]) => migratedColumns.includes(column)),
    auditDb.ADDED_COLUMNS.filter(([, c]) => !migratedColumns.includes(c)).map(([, c]) => c).join(',')
  );
  check(
    'the migrated table has the same columns as a fresh one',
    migratedColumns.length === tableCols.length && tableCols.every((c) => migratedColumns.includes(c)),
    `${migratedColumns.length} migrated vs ${tableCols.length} fresh`
  );
  // ADD COLUMN appends, so a migrated database's column ORDER differs from a fresh
  // one's — which is fine only because every reader here addresses columns by name.
  // Anything parsing the CSV by position would need the header, and it has one.
  check(
    'column order is not assumed to be stable',
    migratedColumns.join(',') !== tableCols.join(','),
    'orders match, so this assert no longer proves anything'
  );

  // The whole point of ADD COLUMN over a rebuild: the history is still there.
  const legacyRow = auditDb.getAuditRows(1, legacyDbPath)[0];
  check('the pre-existing row survived', legacyRow && legacyRow.entity_id === 'pay_LEGACY1');
  check(
    'a row written before the addition reads back null, not zero',
    auditDb.ADDED_COLUMNS.every(([, column]) => legacyRow[column] === null),
    auditDb.ADDED_COLUMNS.filter(([, c]) => legacyRow[c] !== null).map(([, c]) => c).join(',')
  );
  check('the old run row survived', auditDb.getRun(1, legacyDbPath).ingest_mode === 'fixture');

  // And the failure this whole section exists to catch: an insert naming a column
  // that only migrate() could have created.
  auditDb.logResolution(
    1,
    {
      entityId: 'pay_AFTER_MIGRATION',
      status: 'FULLY_MATCHED',
      resolutionPath: 'RULE_ONLY',
      settlementUtr: 'UTR0000000001',
      grossAmount: 100000,
      fee: 0,
      tax: 0,
      netAmount: 100000,
      bankAmount: 100000,
      ledgerAmount: null,
    },
    legacyDbPath
  );
  const [, afterRow] = auditDb.getAuditRows(1, legacyDbPath);
  check(
    'an insert with amounts succeeds against a migrated table',
    afterRow && afterRow.entity_id === 'pay_AFTER_MIGRATION'
  );
  check(
    'the amounts round-trip through the added columns',
    afterRow.net_amount === 100000 && afterRow.fee === 0 && afterRow.ledger_amount === null,
    `${afterRow.net_amount}/${afterRow.fee}/${afterRow.ledger_amount}`
  );
  check(
    'the migrated export carries the money headers',
    auditDb.exportAuditCsv(1, legacyDbPath).split('\n')[0].includes('bank_amount')
  );

  // Re-opening must not try to add the columns a second time: ALTER TABLE ADD
  // COLUMN on an existing name throws, so an unguarded migrate() would turn every
  // run after the first into a crash on startup.
  auditDb.closeDb(legacyDbPath);
  let reopened = true;
  try {
    auditDb.getDb(legacyDbPath);
  } catch (err) {
    reopened = err.message;
  }
  check('migrate is idempotent across reopens', reopened === true, String(reopened));
  check('and the migrated rows are still there', auditDb.getAuditRows(1, legacyDbPath).length === 2);

  // ---------------------------------------------------------------------------
  console.log('\n--- Day 4 audit trail summary ---');
  console.log(`  runs recorded       : ${auditDb.listRuns(dbPath).length}`);
  console.log(`  end-to-end rows     : ${e2e.total} of ${results.length} records`);
  console.log(`  by resolution path  : ${JSON.stringify(paths)}`);

  auditDb.closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  check('temp databases cleaned up', !fs.existsSync(tmpRoot));

  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
  }
}

main().catch((err) => {
  console.error('\n[verifyAuditDb] fatal error:', err);
  auditDb.closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exitCode = 1;
});
