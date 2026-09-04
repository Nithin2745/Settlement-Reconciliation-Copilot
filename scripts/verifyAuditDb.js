// scripts/verifyAuditDb.js
//
// Day 4 regression guard for the SQLite audit trail. Network-free like every
// other verify script: it drives the real matcher and the real resolveExceptions
// with an injected fake llmCaller, so it needs no Groq/OpenRouter access.
//
// Six things get checked, in order:
//   A. schema + run lifecycle — a run stays 'running' with no finished_at until
//      finishRun, and carries its summary as JSON afterwards
//   B. one row round-trips: every structured field comes back out as it went in,
//      and the demo-only eval_* columns stay null on an unscored run
//   C. bulk insert and getRunProgress tallies — what the dashboard polls
//   D. the per-path handle cache. Two db paths must not share one connection, or
//      a test run would silently write into the real data/audit.db
//   E. CSV / JSON export, including a narration carrying a comma, a quote and a
//      newline — the three characters that break naive CSV
//   F. end-to-end: real batch -> real matcher -> real resolveExceptions with a
//      fake caller -> live onResolution writes. The trail must account for every
//      record exactly once, which is the assert that would actually catch a
//      wiring mistake.
//
// What a pass here does NOT prove: runFullPipeline.js's own field mapping, since
// that script needs real API keys. `npm run run-pipeline` is what exercises it.

process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const os = require('os');
const fs = require('fs');
const path = require('path');

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
      status: 'PARTIAL_BANK_ONLY',
      confidenceTier: 'LOW',
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
  check('csv starts with a header row', header.startsWith('id,run_id,entity_id'), header.slice(0, 40));
  check('csv header covers every column', header.split(',').length === 24, String(header.split(',').length));
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

  const ruleRows = results
    .filter((r) => !r.needsReview)
    .map((r) => ({
      entityId: r.settlement.entityId,
      entityType: r.settlement.type,
      status: r.status,
      confidenceTier: r.confidenceTier,
      bankMatchId: r.bankMatch && r.bankMatch.record ? r.bankMatch.record.externalId : null,
      bankMatchMethod: r.bankMethod,
      ledgerMatchId: r.ledgerMatch && r.ledgerMatch.record ? r.ledgerMatch.record.externalId : null,
      ledgerMatchMethod: r.ledgerMethod,
      signals: r.signals,
      unresolvedReason: r.unresolvedReason,
      resolutionPath: 'RULE_ONLY',
      evalCaseType: groundTruth.records[r.settlement.entityId].caseType,
    }));
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
          entityId: res.entityId,
          status: res.status,
          resolutionPath: res.outcome === 'SKIPPED_NO_CANDIDATES' ? 'LLM_SKIPPED' : 'LLM_ACCEPTED',
          llmProvider: res.provider,
          llmDecision: res.decision,
          llmConfidence: res.confidence,
          llmReasonCodes: res.reasonCodes,
          validationReason: res.validationReason,
          evalCaseType: (groundTruth.records[res.entityId] || {}).caseType || null,
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

  auditDb.finishRun(e2eRunId, { status: 'complete' }, dbPath);

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
