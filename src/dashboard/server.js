// src/dashboard/server.js
//
// Day 4: the audit trail made visible. A zero-dependency read-only HTTP server
// (node:http — Express would have been the only new runtime dependency in the
// whole project, to save about forty lines) over src/db/auditDb.js.
//
// Two properties here are structural rather than promised:
//
//   1. It is read-only BY CONSTRUCTION, not by convention. There is no
//      POST/PUT/PATCH/DELETE handler to reach: anything that is not GET or HEAD
//      is answered 405 before routing happens, and every route below calls one
//      of auditDb's read functions. The dashboard cannot alter a reconciliation
//      result, which is what makes it safe to point at a run in progress.
//
//   2. Static files come from a fixed allowlist, never from path.join() on a
//      request path. No request-controlled string ever reaches the filesystem,
//      so `GET /../../.env` 404s by the same mechanism that makes `GET /nope.css`
//      404 — there is no traversal to defend against, so there is no traversal
//      defence to get wrong.
//
// It polls rather than streams. auditDb opens SQLite in WAL mode, which is what
// lets a reader watch a run while the pipeline writes it, and getRunProgress()
// does its counting in SQL against the two composite indexes — so a 2s poll is
// three indexed aggregates, not a table scan. Server-sent events would be the
// better fit at 100k records; at this size polling is fewer moving parts.
//
// SECURITY: there is NO AUTHENTICATION. Anyone who can reach the port can read
// the entire audit trail, including every matched amount and reference. That is
// an accepted trade-off for a local demo tool, and it is why the default bind is
// 127.0.0.1 and why warnIfHostIsExposed() exists.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { config } = require('../config');
const auditDb = require('../db/auditDb');

const PUBLIC_DIR = path.join(__dirname, 'public');

// The allowlist from header note 2. Adding a file to the dashboard means adding
// a line here, which is the intended amount of friction.
const STATIC_ROUTES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

// Digits only. An id that is not a number never becomes a query — it 404s at the
// router, one layer before the (already parameterised) SQL.
const RUN_ROUTE = /^\/api\/runs\/(\d+)(\/rows|\/export\.csv|\/export\.json)?$/;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']);

function isLoopbackHost(host) {
  return Boolean(host) && LOOPBACK_HOSTS.has(String(host).trim().toLowerCase());
}

// These columns hold JSON text, and in this schema `null` and `'[]'` are
// different claims — "nothing was recorded" versus "it was recorded, and there
// was nothing" (see jsonOrNull in auditDb.js). Parsing has to preserve that, so
// a null column stays null instead of being helpfully turned into [].
const JSON_COLUMNS = [
  'signals_json',
  'llm_reason_codes',
  'llm_raw_reason_codes',
  'validation_warnings',
];

function parseJsonColumns(row) {
  const out = { ...row };
  for (const column of JSON_COLUMNS) {
    if (out[column] === null || out[column] === undefined) {
      out[column] = null;
      continue;
    }
    try {
      out[column] = JSON.parse(out[column]);
    } catch {
      // Leave the raw text in place. A malformed audit cell is something a
      // reviewer should see, not something the viewer should quietly swallow.
    }
  }
  return out;
}

// runs.summary_json holds the entire evaluateRun() output. Hand the client real
// JSON instead of JSON inside a string. Null while a run is still going, which
// the page has to render for — a live run has counts but no scorecard yet.
function withParsedSummary(run) {
  if (!run) return run;
  const { summary_json: raw, ...rest } = run;
  let summary = null;
  if (raw) {
    try {
      summary = JSON.parse(raw);
    } catch {
      summary = null;
    }
  }
  return { ...rest, summary };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    // A cached poll response is a frozen dashboard.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  // Node drops the body for HEAD itself (_hasBody), so this needs no branch.
  res.end(body);
}

function sendText(res, statusCode, contentType, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function serveStatic(res, pathname) {
  const entry = STATIC_ROUTES.get(pathname);
  if (!entry) return false;
  const [file, contentType] = entry;
  // Synchronous and re-read per request on purpose: four small files, one local
  // reader, and editing app.js mid-demo should need a reload, not a restart.
  const body = fs.readFileSync(path.join(PUBLIC_DIR, file));
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

/**
 * The whole router, as a plain (req, res) function so it can be tested without
 * binding a port — verifyDashboard.js drives it with stub req/res objects for
 * most of its asserts and binds loopback exactly once, to prove the wiring.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.dbPath] - passed through to every auditDb call, so a
 *   test can point the entire dashboard at a throwaway database.
 */
function createHandler({ dbPath } = {}) {
  return function handle(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('Allow', 'GET, HEAD');
        return sendJson(res, 405, {
          error: 'This dashboard is read-only: only GET and HEAD are served.',
        });
      }

      // Base is a placeholder to satisfy the URL parser; only the path is used.
      const { pathname } = new URL(req.url, 'http://dashboard.invalid');

      if (serveStatic(res, pathname)) return undefined;

      if (pathname === '/api/runs') {
        // Newest first, straight from auditDb.listRuns(). `pollMs` and `host`
        // ride along so the static page never has to hardcode a setting that
        // config.js already owns — there is no template step to inject them.
        return sendJson(res, 200, {
          runs: auditDb.listRuns(dbPath).map(withParsedSummary),
          pollMs: config.dashboard.pollMs,
          host: config.dashboard.host,
        });
      }

      const route = RUN_ROUTE.exec(pathname);
      if (route) {
        const runId = Number(route[1]);
        const suffix = route[2] || '';

        if (suffix === '') {
          const progress = auditDb.getRunProgress(runId, dbPath);
          // getRunProgress returns null for an unknown run, which is a 404 and
          // not an empty run — those are different answers.
          if (!progress) return sendJson(res, 404, { error: `No run ${runId} in the audit trail.` });
          return sendJson(res, 200, { ...progress, run: withParsedSummary(progress.run) });
        }

        // The export and row routes answer '' / [] for an unknown run, so the
        // existence check has to happen here rather than being inferred from an
        // empty result.
        if (!auditDb.getRun(runId, dbPath)) {
          return sendJson(res, 404, { error: `No run ${runId} in the audit trail.` });
        }

        if (suffix === '/rows') {
          return sendJson(res, 200, {
            rows: auditDb.getAuditRows(runId, dbPath).map(parseJsonColumns),
          });
        }
        if (suffix === '/export.csv') {
          return sendText(res, 200, 'text/csv; charset=utf-8', auditDb.exportAuditCsv(runId, dbPath), {
            'Content-Disposition': `attachment; filename="audit-run-${runId}.csv"`,
          });
        }
        if (suffix === '/export.json') {
          return sendText(
            res,
            200,
            'application/json; charset=utf-8',
            auditDb.exportAuditJson(runId, dbPath),
            { 'Content-Disposition': `attachment; filename="audit-run-${runId}.json"` }
          );
        }
      }

      return sendJson(res, 404, { error: `Not found: ${pathname}` });
    } catch (err) {
      // A viewer bug must never look like a reconciliation failure. Log it in
      // full here; answer with the message only, not a stack trace.
      console.error('[dashboard] request failed:', err);
      return sendJson(res, 500, { error: err.message });
    }
  };
}

// The security note the header promises, at the moment it becomes true. Silent
// exposure is the failure mode worth spending eight lines of console output on.
function warnIfHostIsExposed(host, port) {
  if (isLoopbackHost(host)) return false;
  console.warn(
    [
      '',
      '  ******************************************************************',
      '  *  WARNING: the dashboard is bound to a NON-LOOPBACK address.     *',
      `  *  Host: ${String(host).padEnd(55)}*`,
      '  *                                                                *',
      '  *  This server has NO AUTHENTICATION. Anyone who can reach       *',
      `  *  http://${host}:${port}/ can read the entire audit trail,`,
      '  *  including every settlement amount, UTR and match decision.    *',
      '  *                                                                *',
      '  *  Unset DASHBOARD_HOST to go back to 127.0.0.1.                 *',
      '  ******************************************************************',
      '',
    ].join('\n')
  );
  return true;
}

/**
 * Bind and start serving. Resolves once the socket is listening so a caller
 * (script or test) never races the first request against startup.
 */
function startDashboard({
  port = config.dashboard.port,
  host = config.dashboard.host,
  dbPath,
} = {}) {
  warnIfHostIsExposed(host, port);
  const server = http.createServer(createHandler({ dbPath }));
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      // port 0 means the OS chose; report what it actually chose.
      const actualPort = server.address().port;
      resolve({ server, port: actualPort, host, url: `http://${host}:${actualPort}/` });
    });
  });
}

module.exports = {
  createHandler,
  startDashboard,
  warnIfHostIsExposed,
  isLoopbackHost,
  parseJsonColumns,
  withParsedSummary,
  STATIC_ROUTES,
  PUBLIC_DIR,
};
