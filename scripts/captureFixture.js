// scripts/captureFixture.js
//
// Run this once real Razorpay test-mode keys are in .env, to capture one
// genuine Settlement Recon response and freeze it as a fixture. From then on
// the whole app can develop/demo against real shape + real edge cases,
// without depending on a live API call every time (ADR-004).
//
// Usage:
//   1. In .env: SETTLEMENT_SOURCE_MODE=live, fill in RAZORPAY_KEY_ID/SECRET,
//      set SETTLEMENT_YEAR/MONTH/DAY to a date with settlement activity.
//   2. npm run capture-fixture
//   3. Output written to fixtures/settlement-recon-captured.json
//   4. Optionally point FIXTURE_PATH at it, or just keep both: sample for
//      quick iteration, captured for "this is real Razorpay data" proof.

const fs = require('fs');
const path = require('path');
const { config } = require('../src/config');
const { getSettlementRecon } = require('../src/razorpayAdapter');

async function main() {
  if (config.mode !== 'live') {
    console.error(
      '[capture-fixture] SETTLEMENT_SOURCE_MODE is "' +
        config.mode +
        '", not "live". Set SETTLEMENT_SOURCE_MODE=live in .env (with real ' +
        'test-mode keys) before running this script — otherwise there is ' +
        'nothing new to capture.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `[capture-fixture] Fetching settlement recon for ${config.settlementQuery.year}-` +
      `${String(config.settlementQuery.month).padStart(2, '0')}-` +
      `${String(config.settlementQuery.day).padStart(2, '0')} ...`
  );

  const response = await getSettlementRecon();

  const outPath = path.resolve(process.cwd(), 'fixtures/settlement-recon-captured.json');
  fs.writeFileSync(outPath, JSON.stringify(response, null, 2));

  console.log(`[capture-fixture] Captured ${response.count} record(s) -> ${outPath}`);
  console.log(
    '[capture-fixture] Note: test-mode accounts often have zero settlement ' +
      'history. An empty items[] is a valid, real response — it just means ' +
      'no test payments have settled for that day yet. Create a test payment ' +
      'and wait for it to settle, or try a different day.'
  );
}

main().catch((err) => {
  console.error('[capture-fixture] Failed:', err.message);
  process.exitCode = 1;
});
