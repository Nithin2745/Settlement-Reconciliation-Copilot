// src/db/auditDb.js
//
// Day 4: the SQLite audit trail (master doc §4.3/§6). Every record's
// resolution path is written here, live, as the pipeline runs — this is
// what the Day 4 dashboard reads from. It never talks to the matcher or
// the LLM layer directly.
//
// Two things this file is deliberately NOT:
//   - It does not decide anything. It is a write-behind log of decisions
//     already made by matchThreeWay() / resolveExceptions(). Zero business
//     logic lives here.
//   - It is not the ground-truth source. eval_verdict / eval_case_type are
//     nullable, demo-only columns, populated only when a synthetic
//     ground-truth map is available. A real production run leaves them
//     null — the same schema either way, which is the split ADR-004
//     already makes for ingestion, applied to storage.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH = path.join(__dirname, '..', '..', 'data', 'audit.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
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

CREATE TABLE IF NOT EXISTS audit_log (
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

CREATE INDEX IF NOT EXISTS idx_audit_run ON audit_log(run_id);
CREATE INDEX IF NOT EXISTS idx_audit_status ON audit_log(run_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_path ON audit_log(run_id, resolution_path);
`;

// Cached per resolved path rather than as one global handle: the verification
// suite opens a throwaway db under os.tmpdir(), and a single-slot cache would
// hand it back the real data/audit.db instead — silently writing test rows into
// the demo's audit trail.
const _handles = new Map();

function getDb(dbPath = DEFAULT_DB_PATH) {
  const resolved = path.resolve(dbPath);
  const existing = _handles.get(resolved);
  if (existing && existing.open) return existing;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  // WAL so the dashboard can read a run while the pipeline is still writing it.
  // Without this, every poll would contend with the live writer.
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  _handles.set(resolved, db);
  return db;
}

function closeDb(dbPath) {
  if (dbPath === undefined) {
    for (const db of _handles.values()) if (db.open) db.close();
    _handles.clear();
    return;
  }
  const resolved = path.resolve(dbPath);
  const db = _handles.get(resolved);
  if (db && db.open) db.close();
  _handles.delete(resolved);
}

function createRun({ ingestMode, source, batchSize = null, seed = null }, dbPath) {
  const info = getDb(dbPath)
    .prepare(
      `INSERT INTO runs (started_at, ingest_mode, source, batch_size, seed, status)
       VALUES (@startedAt, @ingestMode, @source, @batchSize, @seed, 'running')`
    )
    .run({ startedAt: new Date().toISOString(), ingestMode, source, batchSize, seed });
  return info.lastInsertRowid;
}

function finishRun(runId, { status = 'complete', summary = null, error = null } = {}, dbPath) {
  getDb(dbPath)
    .prepare(
      `UPDATE runs
          SET finished_at = @finishedAt, status = @status,
              summary_json = @summaryJson, error = @error
        WHERE id = @runId`
    )
    .run({
      runId,
      finishedAt: new Date().toISOString(),
      status,
      summaryJson: summary ? JSON.stringify(summary) : null,
      error,
    });
}

// SQLite has no array type and better-sqlite3 refuses to bind objects, so every
// structured field is stored as JSON text. `null` rather than '[]' when absent,
// so "no signals recorded" and "recorded, and there were none" stay different
// things in the trail.
function jsonOrNull(value) {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

function rowParams(runId, row) {
  return {
    runId,
    entityId: row.entityId,
    entityType: row.entityType || null,
    status: row.status,
    confidenceTier: row.confidenceTier || null,
    bankMatchId: row.bankMatchId || null,
    bankMatchMethod: row.bankMatchMethod || null,
    ledgerMatchId: row.ledgerMatchId || null,
    ledgerMatchMethod: row.ledgerMatchMethod || null,
    signalsJson: jsonOrNull(row.signals),
    unresolvedReason: row.unresolvedReason || null,
    resolutionPath: row.resolutionPath,
    llmProvider: row.llmProvider || null,
    llmDecision: row.llmDecision || null,
    llmCandidateId: row.llmCandidateId || null,
    llmConfidence: row.llmConfidence ?? null,
    llmReasonCodes: jsonOrNull(row.llmReasonCodes),
    // What the model actually said, before the gate sanitized it. The pair is
    // the point: "the decision stood on what survived" is only auditable if the
    // original is still on record next to it.
    llmRawReasonCodes: jsonOrNull(row.llmRawReasonCodes),
    validationReason: row.validationReason || null,
    validationWarnings: jsonOrNull(row.validationWarnings),
    evalCaseType: row.evalCaseType || null,
    evalVerdict: row.evalVerdict || null,
    createdAt: new Date().toISOString(),
  };
}

const INSERT_SQL = `
  INSERT INTO audit_log (
    run_id, entity_id, entity_type, status, confidence_tier,
    bank_match_id, bank_match_method, ledger_match_id, ledger_match_method,
    signals_json, unresolved_reason, resolution_path,
    llm_provider, llm_decision, llm_candidate_id, llm_confidence,
    llm_reason_codes, llm_raw_reason_codes, validation_reason, validation_warnings,
    eval_case_type, eval_verdict, created_at
  ) VALUES (
    @runId, @entityId, @entityType, @status, @confidenceTier,
    @bankMatchId, @bankMatchMethod, @ledgerMatchId, @ledgerMatchMethod,
    @signalsJson, @unresolvedReason, @resolutionPath,
    @llmProvider, @llmDecision, @llmCandidateId, @llmConfidence,
    @llmReasonCodes, @llmRawReasonCodes, @validationReason, @validationWarnings,
    @evalCaseType, @evalVerdict, @createdAt
  )
`;

// One row, written immediately. This is what makes the dashboard live: an insert
// is sub-millisecond and synchronous, so it costs nothing next to the provider
// round-trip it follows.
function logResolution(runId, row, dbPath) {
  getDb(dbPath).prepare(INSERT_SQL).run(rowParams(runId, row));
}

// Bulk insert for the deterministic pass — it finishes instantly, so there is
// no progress to stream, and one transaction beats N implicit ones.
function logResolutionsBulk(runId, rows, dbPath) {
  const db = getDb(dbPath);
  const insert = db.prepare(INSERT_SQL);
  db.transaction((items) => {
    for (const row of items) insert.run(rowParams(runId, row));
  })(rows);
}

function listRuns(dbPath) {
  return getDb(dbPath).prepare(`SELECT * FROM runs ORDER BY id DESC`).all();
}

function getRun(runId, dbPath) {
  return getDb(dbPath).prepare(`SELECT * FROM runs WHERE id = ?`).get(runId);
}

function getAuditRows(runId, dbPath) {
  return getDb(dbPath).prepare(`SELECT * FROM audit_log WHERE run_id = ? ORDER BY id ASC`).all(runId);
}

/**
 * What the dashboard polls while a run is still going. Counts are computed in
 * SQL rather than by pulling rows and reducing in JS, so a poll stays O(index)
 * as the batch grows.
 *
 * `evalVerdicts` is what makes "measured, not claimed" visible live: precision
 * ticking up per record instead of a summary printed after the fact. It is null
 * on a run with no ground truth rather than an empty object, so the dashboard
 * can tell "not a scored run" from "scored, nothing correct yet."
 */
function getRunProgress(runId, dbPath) {
  const db = getDb(dbPath);
  const run = getRun(runId, dbPath);
  if (!run) return null;

  const tally = (rows, key) =>
    rows.reduce((acc, r) => {
      if (r[key] !== null) acc[r[key]] = r.n;
      return acc;
    }, {});

  const byResolutionPath = tally(
    db
      .prepare(
        `SELECT resolution_path, COUNT(*) AS n FROM audit_log
          WHERE run_id = ? GROUP BY resolution_path`
      )
      .all(runId),
    'resolution_path'
  );

  const byStatus = tally(
    db
      .prepare(`SELECT status, COUNT(*) AS n FROM audit_log WHERE run_id = ? GROUP BY status`)
      .all(runId),
    'status'
  );

  const verdictRows = db
    .prepare(
      `SELECT eval_verdict, COUNT(*) AS n FROM audit_log
        WHERE run_id = ? AND eval_verdict IS NOT NULL GROUP BY eval_verdict`
    )
    .all(runId);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE run_id = ?`).get(runId).n;

  return {
    run,
    total,
    byResolutionPath,
    byStatus,
    evalVerdicts: verdictRows.length > 0 ? tally(verdictRows, 'eval_verdict') : null,
  };
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const cols = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => escape(r[c])).join(','))].join('\n');
}

function exportAuditCsv(runId, dbPath) {
  return toCsv(getAuditRows(runId, dbPath));
}

function exportAuditJson(runId, dbPath) {
  return JSON.stringify({ run: getRun(runId, dbPath), rows: getAuditRows(runId, dbPath) }, null, 2);
}

module.exports = {
  getDb,
  closeDb,
  createRun,
  finishRun,
  logResolution,
  logResolutionsBulk,
  listRuns,
  getRun,
  getAuditRows,
  getRunProgress,
  exportAuditCsv,
  exportAuditJson,
  toCsv,
  DEFAULT_DB_PATH,
};
