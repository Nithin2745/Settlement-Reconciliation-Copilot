// scripts/verifyAdapter.js
//
// Day-1 smoke test: pull settlement recon data through the adapter (fixture
// mode by default), normalize it, and print a readable summary. Exits with a
// non-zero code if anything structural is wrong, so this can sit in a CI
// step later without modification.

const assert = require('assert');
const { config } = require('../src/config');
const { getSettlementRecon } = require('../src/razorpayAdapter');
const { normalizeSettlementRecon } = require('../src/normalizeSettlement');

async function main() {
  console.log(`[verify] mode = ${config.mode}, fixture = ${config.fixturePath}\n`);

  const raw = await getSettlementRecon();
  assert.ok(Array.isArray(raw.items), 'raw response must have an items[] array');

  const { count, records } = normalizeSettlementRecon(raw);
  assert.strictEqual(count, raw.items.length, 'normalized count must match raw item count');

  console.log(`Records ingested: ${count}\n`);

  let waterfallFailures = 0;
  for (const r of records) {
    const status = r.waterfallOk === false ? 'MISMATCH' : r.waterfallOk === true ? 'ok' : 'skipped';
    if (r.waterfallOk === false) waterfallFailures += 1;
    console.log(
      `  ${r.entityId.padEnd(20)} ${r.type.padEnd(10)} ` +
        `gross=${String(r.grossAmount).padStart(7)} fee=${String(r.fee).padStart(5)} ` +
        `tax=${String(r.tax).padStart(4)} net=${String(r.netAmount).padStart(7)}  ` +
        `waterfall=${status}` +
        (r.waterfallNote ? `  (${r.waterfallNote})` : '')
    );
  }

  console.log(`\nWaterfall check: ${records.length - waterfallFailures}/${records.length} records reconcile cleanly.`);

  if (waterfallFailures > 0) {
    console.log(
      `${waterfallFailures} record(s) failed the amount/fee/tax waterfall check — ` +
        `these are exactly the kind of thing the deterministic engine (Day 1) should surface, not hide.`
    );
  }

  console.log('\n[verify] PASS — adapter and normalizer are working end to end.');
}

main().catch((err) => {
  console.error('[verify] FAIL:', err.message);
  process.exitCode = 1;
});
