// src/razorpayAdapter.js
//
// ADR-004 in one file: the rest of the app calls getSettlementRecon() and
// never knows whether the data came from a live API call or a fixture file.
// That's what makes fixture-mode "reliability engineering" instead of "a
// shortcut" — swapping modes changes zero downstream code.
//
// CORRECTION vs. the original plan: the master doc assumed a dedicated
// `instance.settlements.settlementRecon({...})` method. Checked against the
// actual razorpay-node SDK docs (github.com/razorpay/razorpay-node) — no such
// method exists on the Node SDK. Node reuses `instance.settlements.reports()`
// for both the monthly settlement report and the day-level recon: pass a
// `day` and you get the recon (payment/refund/transfer/adjustment line
// items); omit it and you get the settlement-batch summary. (The PHP SDK
// does have a separate `settlementRecon()` method — that's likely where the
// mix-up came from.) Fixed here before any code depended on the wrong name.

const Razorpay = require('razorpay');
const fs = require('fs');
const path = require('path');
const { config, assertLiveModeIsConfigured } = require('./config');

/**
 * Fetch the raw Settlement Recon response for the configured day.
 * Shape (real Razorpay schema): { entity: 'collection', count, items: [...] }
 * @returns {Promise<{entity: string, count: number, items: object[]}>}
 */
async function getSettlementRecon() {
  if (config.mode === 'live') {
    return fetchLive();
  }
  return readFixture();
}

async function fetchLive() {
  assertLiveModeIsConfigured();

  const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });

  const { year, month, day } = config.settlementQuery;
  if (!day) {
    throw new Error('SETTLEMENT_DAY must be set for a day-level recon fetch (live mode).');
  }

  // instance.settlements.reports({year, month, day}) === the recon endpoint.
  // TODO (stress-test day): loop on `skip` once a single settlement day has
  // more than `count` records — not needed for day-1 verification.
  const response = await instance.settlements.reports({ year, month, day, count: 100 });
  return response;
}

function readFixture() {
  const fixturePath = path.resolve(process.cwd(), config.fixturePath);
  if (!fs.existsSync(fixturePath)) {
    throw new Error(`Fixture file not found at ${fixturePath}. Check FIXTURE_PATH in .env.`);
  }
  const raw = fs.readFileSync(fixturePath, 'utf-8');
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed.items)) {
    throw new Error(`Fixture at ${fixturePath} is missing an "items" array — not a valid recon response.`);
  }
  return parsed;
}

module.exports = { getSettlementRecon };
