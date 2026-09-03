// scripts/verifyMatcher.js
//
// Day-1 smoke test for the deterministic match engine. Runs the four
// settlement records from fixtures/settlement-recon-sample.json against a
// small hand-built mock bank statement + ledger, deliberately covering all
// four outcomes the engine supports:
//
//   pay_SAMPLE0000001 -> EXACT_UTR bank match + EXACT_ORDER_ID ledger match  => FULLY_MATCHED
//   rfnd_SAMPLE0000002 -> AMOUNT_DATE_PROXIMITY bank match, no ledger entry  => PARTIAL_BANK_ONLY
//   trf_SAMPLE0000003  -> no bank/ledger reference exists at all (internal
//                          transfer, no order_id/receipt)                    => UNRESOLVED
//   adj_SAMPLE0000005  -> ledger has the chargeback-reversal entry, bank
//                          statement line is missing (still pending credit)  => PARTIAL_LEDGER_ONLY
//
// This stays as the engine's unit-level smoke test on a hand-written fixture
// where every expected outcome is asserted by name. The 120-record synthetic
// batch with an internal ground-truth map (Day 2, `npm run verify-synthetic`)
// exercises the same engine at scale behind the same ExternalRecord shape.

const assert = require('assert');
const { getSettlementRecon } = require('../src/razorpayAdapter');
const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay } = require('../src/matcher/matchEngine');

const mockBankLines = [
  {
    externalId: 'bank_line_001',
    source: 'bank',
    amount: 48820, // == settlement netAmount for pay_SAMPLE0000001
    date: '2025-09-01T23:55:00.000Z',
    refs: {
      utr: '1756770600sample1', // exact UTR match
      orderId: null,
      orderReceipt: null,
      narration: 'NEFT CR 1756770600sample1 RAZORPAY SETTLEMENT',
    },
  },
  {
    externalId: 'bank_line_002',
    source: 'bank',
    amount: -15000, // == settlement netAmount for rfnd_SAMPLE0000002 (debit, no UTR echoed)
    date: '2025-09-02T09:00:00.000Z', // 1 day after settledAt -> within 3-day window
    refs: {
      utr: null, // deliberately missing -> forces proximity fallback, not exact match
      orderId: null,
      orderReceipt: null,
      narration: 'DR RAZORPAY REFUND DEBIT',
    },
  },
  // Note: no bank line at all for trf_SAMPLE0000003 (internal transfer) or
  // adj_SAMPLE0000005 (chargeback reversal credit still pending in the bank
  // feed as of statement cut-off) -- deliberate, to exercise PARTIAL_LEDGER_ONLY
  // and UNRESOLVED.
];

const mockLedgerEntries = [
  {
    externalId: 'ledger_entry_001',
    source: 'ledger',
    amount: 50000, // == settlement grossAmount for pay_SAMPLE0000001
    date: '2025-08-30T10:00:00.000Z', // invoice raised before payment -> within 30-day window
    refs: {
      utr: null,
      orderId: 'order_SAMPLE00000A1', // exact order_id match
      orderReceipt: 'INV-1001',
      narration: null,
    },
  },
  {
    externalId: 'ledger_entry_002',
    source: 'ledger',
    amount: 500, // == settlement grossAmount for adj_SAMPLE0000005
    date: '2025-08-25T00:00:00.000Z',
    refs: {
      utr: null,
      orderId: null, // adjustments carry no order_id in the Razorpay recon feed
      orderReceipt: 'CB-REV-2201', // internal ledger still tags it via receipt-like ref
      narration: 'Chargeback reversal — dispute dp_SAMPLE',
    },
  },
  // Note: no ledger entry for rfnd_SAMPLE0000002 (refunds aren't separately
  // invoiced -> legitimately bank-only) or trf_SAMPLE0000003 (internal
  // transfer, no customer-facing invoice at all).
];

// adj_SAMPLE0000005's ledger match above relies on order_receipt, but the
// settlement record's order_receipt is null (adjustments have no receipt in
// the Razorpay feed either) -- so EXACT_ORDER_RECEIPT can't fire. This is
// intentional: it forces the proximity fallback (amount=500 within 30 days),
// proving that path too, and documents a real limitation worth a line in
// DECISIONS.md later: adjustments/chargebacks are the weakest-referenced
// settlement type and are the most likely to need the LLM layer in practice.

async function main() {
  const raw = await getSettlementRecon();
  const { records } = normalizeSettlementRecon(raw);

  const { summary, results } = matchThreeWay(records, mockBankLines, mockLedgerEntries);

  console.log('[verify-matcher] Summary:', summary, '\n');

  for (const r of results) {
    const bankLabel = r.bankMatch
      ? `${r.bankMatch.method} -> ${r.bankMatch.record.externalId}`
      : 'none';
    const ledgerLabel = r.ledgerMatch
      ? `${r.ledgerMatch.method} -> ${r.ledgerMatch.record.externalId}`
      : 'none';
    console.log(
      `  ${r.settlement.entityId.padEnd(20)} ${r.status.padEnd(20)} ` +
        `bank: ${bankLabel.padEnd(38)} ledger: ${ledgerLabel}` +
        (r.unresolvedReason ? `  (${r.unresolvedReason})` : '')
    );
  }

  // Structural assertions -- fail loudly if the engine's behavior drifts.
  const byId = Object.fromEntries(results.map((r) => [r.settlement.entityId, r]));

  assert.strictEqual(byId['pay_SAMPLE0000001'].status, 'FULLY_MATCHED');
  assert.strictEqual(byId['pay_SAMPLE0000001'].bankMatch.method, 'EXACT_UTR');
  assert.strictEqual(byId['pay_SAMPLE0000001'].ledgerMatch.method, 'EXACT_ORDER_ID');

  assert.strictEqual(byId['rfnd_SAMPLE0000002'].status, 'PARTIAL_BANK_ONLY');
  assert.strictEqual(byId['rfnd_SAMPLE0000002'].bankMatch.method, 'AMOUNT_DATE_PROXIMITY');

  assert.strictEqual(byId['trf_SAMPLE0000003'].status, 'UNRESOLVED');

  assert.strictEqual(byId['adj_SAMPLE0000005'].status, 'PARTIAL_LEDGER_ONLY');
  assert.strictEqual(byId['adj_SAMPLE0000005'].ledgerMatch.method, 'AMOUNT_DATE_PROXIMITY');

  console.log('\n[verify-matcher] PASS — all four match outcomes (FULLY_MATCHED, ' +
    'PARTIAL_BANK_ONLY, PARTIAL_LEDGER_ONLY, UNRESOLVED) reproduced correctly.');
}

main().catch((err) => {
  console.error('[verify-matcher] FAIL:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
