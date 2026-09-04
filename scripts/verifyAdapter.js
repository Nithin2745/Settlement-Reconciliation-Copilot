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

// The three settlement-query knobs are dates, and a date is where
// `Number(x) || fallback` does the most damage: SETTLEMENT_MONTH=0 and a typo'd
// SETTLEMENT_YEAR were both falsy, so both silently became *today* and a live
// fetch would have reconciled against the wrong day while looking healthy. They
// go through numberFromEnv now, like every other knob in config.js. Every assert
// below passed silently before that change — which is the point of writing them.
//
// Re-requiring config with a cleared cache is how a module that reads process.env
// once at load time gets tested at all. Env is restored either way.
function configWith(overrides) {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  delete require.cache[require.resolve('../src/config')];
  try {
    return require('../src/config').config;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve('../src/config')];
  }
}

function verifySettlementQueryContract() {
  const mustThrow = [
    [{ SETTLEMENT_YEAR: 'twentytwentysix' }, 'a typo\'d SETTLEMENT_YEAR must throw, not become this year'],
    [{ SETTLEMENT_MONTH: 'septmber' }, 'a typo\'d SETTLEMENT_MONTH must throw, not become this month'],
    [{ SETTLEMENT_MONTH: '0' }, 'SETTLEMENT_MONTH=0 must throw — months are 1-indexed here'],
    [{ SETTLEMENT_MONTH: '13' }, 'SETTLEMENT_MONTH=13 must throw'],
    [{ SETTLEMENT_DAY: '32' }, 'SETTLEMENT_DAY=32 must throw'],
    [{ SETTLEMENT_YEAR: '1999' }, 'SETTLEMENT_YEAR=1999 must throw — outside the plausible range'],
  ];
  for (const [overrides, label] of mustThrow) {
    assert.throws(() => configWith(overrides), /must be/, label);
  }

  // Blank must stay undefined rather than defaulting to a real day: the adapter
  // reads a missing day as "no day-level recon fetch" and throws in live mode,
  // which is the correct failure. A defaulted day fetches the wrong date instead.
  // (Blank rather than deleted, because dotenv would repopulate a deleted key
  // from .env and we would be testing the file, not the contract.)
  const blankDay = configWith({ SETTLEMENT_DAY: '' });
  assert.strictEqual(blankDay.settlementQuery.day, undefined, 'a blank SETTLEMENT_DAY must stay undefined');

  const valid = configWith({ SETTLEMENT_YEAR: '2026', SETTLEMENT_MONTH: '9', SETTLEMENT_DAY: '1' });
  assert.deepStrictEqual(
    valid.settlementQuery,
    { year: 2026, month: 9, day: 1 },
    'a valid date triple must parse to numbers, not strings'
  );
}

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

  verifySettlementQueryContract();
  console.log('[verify] PASS — settlement-query config knobs fail early on a bad value (8 assertions).');
}

main().catch((err) => {
  console.error('[verify] FAIL:', err.message);
  process.exitCode = 1;
});
