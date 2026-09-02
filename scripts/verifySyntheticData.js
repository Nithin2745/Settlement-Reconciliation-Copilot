// scripts/verifySyntheticData.js
//
// Day 3 smoke test. Loads (or generates) the synthetic batch, runs it
// through the real Day 1 normalizer and Day 2 matcher, and checks
// structural sanity per case type — e.g. "every AMOUNT_MISMATCH record
// ends up PARTIAL_LEDGER_ONLY with waterfallOk:false", not "the AI got
// 94% precision" (that's Day 5's job, once ground truth is used as an
// actual scoring answer key rather than a structural sanity check).
//
// This is intentionally NOT the evaluation layer. It answers: "did the
// generator + Day 1 + Day 2 pipeline behave the way the generator's own
// design says it should?" — a regression guard, not a metrics report.

const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay } = require('../src/matcher/matchEngine');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');

const SIZE = parseInt(process.argv[2], 10) || 120;
const SEED = parseInt(process.argv[3], 10) || 42;

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    console.log(`FAIL ${label}`);
    failures += 1;
  }
}

console.log(`Generating synthetic batch: size=${SIZE}, seed=${SEED}\n`);
const { settlementRecon, bankStatement, ledger, groundTruth } = generateSyntheticBatch({
  size: SIZE,
  seed: SEED,
});

const normalized = normalizeSettlementRecon(settlementRecon);
const { summary, results } = matchThreeWay(normalized.records, bankStatement, ledger);

console.log('--- Batch composition ---');
console.log(groundTruth.caseTypeCounts);
console.log('\n--- matchThreeWay summary ---');
console.log(summary);

const byEntity = new Map(results.map((r) => [r.settlement.entityId, r]));
const c = groundTruth.caseTypeCounts;

console.log('\n--- Structural checks ---');
check('total settlements === requested size', settlementRecon.items.length === SIZE);
check('summary.total === requested size', summary.total === SIZE);
check('all 7 case types present in this batch', Object.keys(c).length === 7);

function countWhere(caseType, statusPred) {
  let n = 0;
  for (const [entityId, gt] of Object.entries(groundTruth.records)) {
    if (gt.caseType !== caseType) continue;
    const r = byEntity.get(entityId);
    if (r && statusPred(r)) n += 1;
  }
  return n;
}

check(
  'all CLEAN records are FULLY_MATCHED',
  countWhere('CLEAN', (r) => r.status === 'FULLY_MATCHED') === c.CLEAN
);
check(
  'all TIMING_LAG records are FULLY_MATCHED (via proximity)',
  countWhere('TIMING_LAG', (r) => r.status === 'FULLY_MATCHED') === c.TIMING_LAG
);
check(
  'all BLIND_PAYMENT records are PARTIAL_BANK_ONLY',
  countWhere('BLIND_PAYMENT', (r) => r.status === 'PARTIAL_BANK_ONLY') === c.BLIND_PAYMENT
);
check(
  'all AMOUNT_MISMATCH records are PARTIAL_LEDGER_ONLY with waterfallOk:false',
  countWhere(
    'AMOUNT_MISMATCH',
    (r) => r.status === 'PARTIAL_LEDGER_ONLY' && r.waterfallOk === false
  ) === c.AMOUNT_MISMATCH
);
check(
  'all AMBIGUOUS records are UNRESOLVED/AMBIGUOUS_CANDIDATES',
  countWhere(
    'AMBIGUOUS',
    (r) => r.status === 'UNRESOLVED' && r.unresolvedReason === 'AMBIGUOUS_CANDIDATES'
  ) === c.AMBIGUOUS
);
check(
  'all ORPHAN records are UNRESOLVED/NO_CANDIDATE_FOUND',
  countWhere(
    'ORPHAN',
    (r) => r.status === 'UNRESOLVED' && r.unresolvedReason === 'NO_CANDIDATE_FOUND'
  ) === c.ORPHAN
);
check(
  'BULK_SETTLEMENT: exactly 1 per group of 3 is FULLY_MATCHED, rest PARTIAL_LEDGER_ONLY',
  countWhere('BULK_SETTLEMENT', (r) => r.status === 'FULLY_MATCHED') === c.BULK_SETTLEMENT / 3 &&
    countWhere('BULK_SETTLEMENT', (r) => r.status === 'PARTIAL_LEDGER_ONLY') ===
      (c.BULK_SETTLEMENT / 3) * 2
);
check(
  'summary.waterfallMismatches === AMOUNT_MISMATCH count',
  summary.waterfallMismatches === c.AMOUNT_MISMATCH
);
check(
  'unclaimed bank pool === AMOUNT_MISMATCH + AMBIGUOUS (each contributes 1 stray bank line)',
  summary.unclaimedBankLines === c.AMOUNT_MISMATCH + c.AMBIGUOUS
);
check(
  'unclaimed ledger pool === AMBIGUOUS count',
  summary.unclaimedLedgerEntries === c.AMBIGUOUS
);

// needsAiReview coverage: every non-CLEAN, non-TIMING_LAG, non-ORPHAN case
// should be flagged for the LLM layer per the generator's own design.
const expectedAiReview =
  c.BLIND_PAYMENT + c.BULK_SETTLEMENT + c.AMOUNT_MISMATCH + c.AMBIGUOUS;
const actualAiReview = Object.values(groundTruth.records).filter((g) => g.needsAiReview).length;
check(
  'needsAiReview count matches design (blind+bulk+mismatch+ambiguous)',
  actualAiReview === expectedAiReview
);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
