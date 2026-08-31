// src/config.js
// Single place that reads process.env so the rest of the app never touches
// process.env directly. Makes it obvious what the app depends on, and makes
// testing/fixture-mode trivial (just don't set the Razorpay keys).

require('dotenv').config();

const VALID_MODES = ['live', 'fixture'];

const mode = (process.env.SETTLEMENT_SOURCE_MODE || 'fixture').toLowerCase();

if (!VALID_MODES.includes(mode)) {
  throw new Error(
    `SETTLEMENT_SOURCE_MODE must be one of ${VALID_MODES.join(', ')}, got "${mode}"`
  );
}

const config = {
  mode, // 'live' | 'fixture'

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  },

  settlementQuery: {
    year: Number(process.env.SETTLEMENT_YEAR) || new Date().getFullYear(),
    month: Number(process.env.SETTLEMENT_MONTH) || new Date().getMonth() + 1,
    day: process.env.SETTLEMENT_DAY ? Number(process.env.SETTLEMENT_DAY) : undefined,
  },

  fixturePath: process.env.FIXTURE_PATH || 'fixtures/settlement-recon-sample.json',
};

// Fail loudly and early rather than making a confusing API call with empty keys.
function assertLiveModeIsConfigured() {
  if (config.mode !== 'live') return;
  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new Error(
      'SETTLEMENT_SOURCE_MODE=live but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing. ' +
        'Set them in .env, or switch to SETTLEMENT_SOURCE_MODE=fixture.'
    );
  }
}

module.exports = { config, assertLiveModeIsConfigured };
