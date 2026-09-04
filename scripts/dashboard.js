// scripts/dashboard.js
//
// Day 4: starts the read-only dashboard over the audit trail.
//
//   npm run dashboard              # http://127.0.0.1:4000
//   npm run dashboard -- 4100      # a different port
//
// All the logic is in src/dashboard/server.js; this file is the thin CLI wrapper
// the rest of scripts/ is also written as. It exists to parse one argument, print
// the security posture in plain words, and shut the SQLite handle down cleanly on
// Ctrl-C so WAL does not sit with an open reader.

const { config } = require('../src/config');
const { startDashboard, isLoopbackHost } = require('../src/dashboard/server');
const { closeDb, DEFAULT_DB_PATH } = require('../src/db/auditDb');

const port = process.argv[2] ? Number(process.argv[2]) : config.dashboard.port;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Usage: node scripts/dashboard.js [port]   (got "${process.argv[2]}")`);
  process.exit(1);
}

async function main() {
  const { server, url, host } = await startDashboard({ port });

  console.log('');
  console.log('  Settlement Reconciliation Copilot — audit trail');
  console.log(`  ${url}`);
  console.log('');
  console.log(`  reading   ${DEFAULT_DB_PATH}`);
  console.log('  method    GET and HEAD only — the server has no write path at all');
  console.log(
    isLoopbackHost(host)
      ? '  access    no authentication, so it is bound to loopback only'
      : '  access    NO AUTHENTICATION and NOT loopback — see the warning above'
  );
  console.log('');
  console.log('  Ctrl-C to stop.');
  console.log('');

  const shutdown = () => {
    console.log('\n[dashboard] shutting down');
    server.close();
    closeDb();
    // The listener is the only thing holding the loop open, so this exits on its
    // own — but be explicit rather than relying on that.
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use. Try: npm run dashboard -- ${port + 1}\n`);
    process.exit(1);
  }
  console.error('\n[dashboard] failed to start:', err);
  process.exit(1);
});
