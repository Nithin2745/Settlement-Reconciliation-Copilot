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

// Razorpay's maximum page size for the recon endpoint. Requesting more is
// silently clamped, which is why the loop below trusts the returned length
// rather than the requested one.
const PAGE_SIZE = 100;
// Refuse to spin forever if the API ever ignores `skip`. 200 pages is ~20k line
// items in one settlement day — far beyond anything this tool is scoped for, so
// hitting it means something is wrong, not that the merchant is busy.
const MAX_PAGES = 200;

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
  //
  // Paginated on `skip`, because a single busy settlement day exceeds one page
  // and a silently truncated fetch is the worst possible failure here: the
  // missing line items don't show up as unresolved, they just don't exist, so
  // the batch reconciles clean while real money goes unaccounted for. Better
  // to make the page boundary explicit than to cap at 100 and hope.
  const items = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await instance.settlements.reports({
      year,
      month,
      day,
      count: PAGE_SIZE,
      skip: page * PAGE_SIZE,
    });

    const pageItems = response && Array.isArray(response.items) ? response.items : [];
    items.push(...pageItems);

    // A short page is the last page. Trust the returned count, not the
    // requested one.
    if (pageItems.length < PAGE_SIZE) {
      return { entity: 'collection', count: items.length, items };
    }
  }

  throw new Error(
    `Settlement recon fetch exceeded ${MAX_PAGES} pages (${items.length} items) for ` +
      `${year}-${month}-${day}. Refusing to continue: the API may be ignoring \`skip\`, ` +
      'and a partial day would reconcile clean with records missing.'
  );
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
