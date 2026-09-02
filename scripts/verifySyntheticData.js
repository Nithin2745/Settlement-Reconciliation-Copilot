// scripts/verifySyntheticData.js
//
// Day 2 regression guard. Loads (or generates) the synthetic batch, runs it
// through the real Day 1 normalizer and Day 2 matcher, and checks structural
// sanity per case type — e.g. "every AMOUNT_MISMATCH record ends up
// PARTIAL_LEDGER_ONLY with waterfallOk:false", not "the AI got 94% precision"
// (that's Day 3's evaluation layer, once ground truth is used as an actual
// scoring answer key rather than a structural sanity check).
//
// This is intentionally NOT the evaluation layer. It answers: "did the
// generator + Day 1 + Day 2 pipeline behave the way the generator's own design
// says it should?"
//
// The one place it does touch ground truth as an answer key is the silent-miss
// check, and that is deliberate: a record the generator marked needsAiReview
// that the engine does NOT escalate is the single failure mode that can't be
// caught structurally, and it is the failure mode that would matter in
// production. It is asserted at zero, and treated as a build break.

const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay, SIGNALS } = require('../src/matcher/matchEngine');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');

const SIZE = parseInt(process.argv[2], 10) || 120;
const SEED = parseInt(process.argv[3], 10) || 42;
const BANK_WINDOW_DAYS = 3; // matchEngine DEFAULT_OPTS.bankDateWindowDays
const EXACT_METHODS = new Set(['EXACT_UTR', 'EXACT_ORDER_ID', 'EXACT_ORDER_RECEIPT']);

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    console.log(`FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
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

function countWhere(caseType, pred) {
  let n = 0;
  for (const [entityId, gt] of Object.entries(groundTruth.records)) {
    if (gt.caseType !== caseType) continue;
    const r = byEntity.get(entityId);
    if (r && pred(r, gt)) n += 1;
  }
  return n;
}

function daysApart(isoA, isoB) {
  return Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / (24 * 60 * 60 * 1000);
}

console.log('\n--- A. Batch composition ---');
check('total settlements === requested size', settlementRecon.items.length === SIZE);
check('summary.total === requested size', summary.total === SIZE);
check('all 7 case types present in this batch', Object.keys(c).length === 7);

console.log('\n--- B. Per-case-type match status ---');
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
  summary.unclaimedBankLines === c.AMOUNT_MISMATCH + c.AMBIGUOUS,
  `got ${summary.unclaimedBankLines}, expected ${c.AMOUNT_MISMATCH + c.AMBIGUOUS}`
);
check(
  'unclaimed ledger pool === AMBIGUOUS count',
  summary.unclaimedLedgerEntries === c.AMBIGUOUS,
  `got ${summary.unclaimedLedgerEntries}, expected ${c.AMBIGUOUS}`
);

console.log('\n--- C. Exception routing (needsReview) ---');

// The headline safety invariant. A record the generator KNOWS needs a human or
// an LLM, that the engine reports as clean, is a silent miss: money reconciled
// wrongly with nobody told. Before the amount cross-check was added, the three
// bulk-settlement "winners" sat here at FULLY_MATCHED/HIGH while their bank
// credit was ~3x their own net.
const silentMisses = Object.entries(groundTruth.records).filter(
  ([id, gt]) => gt.needsAiReview && !byEntity.get(id).needsReview
);
check(
  'ZERO silent misses (every needsAiReview record is escalated)',
  silentMisses.length === 0,
  silentMisses.map(([id, gt]) => `${id}/${gt.caseType}`).join(', ')
);

// Escalating a true orphan is the accepted cost of never missing one: no
// deterministic rule can distinguish "no counterpart exists" from "the
// counterpart is missing". Anything BEYOND the orphans is unintended
// over-escalation and would be wasted inference on Day 3.
const overFlagged = Object.entries(groundTruth.records).filter(
  ([id, gt]) => !gt.needsAiReview && byEntity.get(id).needsReview
);
check(
  'over-escalation is confined to true ORPHANs',
  overFlagged.every(([, gt]) => gt.caseType === 'ORPHAN'),
  overFlagged
    .filter(([, gt]) => gt.caseType !== 'ORPHAN')
    .map(([id, gt]) => `${id}/${gt.caseType}`)
    .join(', ')
);
check(
  'summary.needsReview === needsAiReview + ORPHAN count',
  summary.needsReview ===
    c.BLIND_PAYMENT + c.BULK_SETTLEMENT + c.AMOUNT_MISMATCH + c.AMBIGUOUS + c.ORPHAN,
  `got ${summary.needsReview}`
);
check(
  'summary.cleanlyReconciled === CLEAN + TIMING_LAG',
  summary.cleanlyReconciled === c.CLEAN + c.TIMING_LAG,
  `got ${summary.cleanlyReconciled}, expected ${c.CLEAN + c.TIMING_LAG}`
);

// TIMING_LAG is the case that proves the routing rule is a rule and not a
// blanket "escalate anything inexact": the bank line matched on proximity
// alone, but the ledger corroborated it with an exact order reference, so the
// deterministic engine genuinely resolved it and must NOT spend an LLM call.
check(
  'no TIMING_LAG record is escalated (proximity corroborated by an exact ledger ref)',
  countWhere('TIMING_LAG', (r) => r.needsReview) === 0
);
check(
  'no CLEAN record is escalated',
  countWhere('CLEAN', (r) => r.needsReview) === 0
);

console.log('\n--- D. Confidence tiers ---');
check(
  'all CLEAN records are HIGH (both sides matched on an exact reference)',
  countWhere('CLEAN', (r) => r.confidenceTier === 'HIGH') === c.CLEAN
);
check(
  'all TIMING_LAG records are MEDIUM (one side inexact, nothing degrading)',
  countWhere('TIMING_LAG', (r) => r.confidenceTier === 'MEDIUM') === c.TIMING_LAG
);
check(
  'every LOW record is escalated (LOW must imply needsReview)',
  results.filter((r) => r.confidenceTier === 'LOW').every((r) => r.needsReview)
);
check(
  'no escalated record is reported HIGH',
  results.filter((r) => r.needsReview).every((r) => r.confidenceTier !== 'HIGH')
);
check(
  'summary tier counts sum to total',
  summary.byConfidenceTier.HIGH + summary.byConfidenceTier.MEDIUM + summary.byConfidenceTier.LOW ===
    SIZE
);

console.log('\n--- E. Amount cross-check (the bug that caused the silent misses) ---');
const amountDisagreements = results.filter(
  (r) => r.bankAmountAgrees === false || r.ledgerAmountAgrees === false
);
check(
  'every matched-but-amount-disagreeing record is escalated',
  amountDisagreements.every((r) => r.needsReview),
  amountDisagreements
    .filter((r) => !r.needsReview)
    .map((r) => r.settlement.entityId)
    .join(', ')
);
check(
  'AMOUNT_DISAGREES_BANK fires exactly on the bulk-settlement winners',
  (summary.signalCounts.AMOUNT_DISAGREES_BANK || 0) === c.BULK_SETTLEMENT / 3,
  `got ${summary.signalCounts.AMOUNT_DISAGREES_BANK || 0}, expected ${c.BULK_SETTLEMENT / 3}`
);
check(
  'no record claims a bank line whose amount agrees but is reported as disagreeing',
  results.every(
    (r) =>
      r.bankAmountAgrees === null ||
      r.bankAmountAgrees === (r.bankMatch.record.amount === r.settlement.netAmount)
  )
);

console.log('\n--- F. Shared-UTR (bulk settlement) detection ---');
const utrMembers = results.filter((r) => r.utrGroup);
check(
  'every BULK_SETTLEMENT record carries SHARED_UTR_GROUP',
  countWhere('BULK_SETTLEMENT', (r) => r.signals.includes('SHARED_UTR_GROUP')) ===
    c.BULK_SETTLEMENT
);
check(
  'SHARED_UTR_GROUP fires on nothing else',
  utrMembers.length === c.BULK_SETTLEMENT,
  `${utrMembers.length} members vs ${c.BULK_SETTLEMENT} bulk records`
);
check(
  'summary.sharedUtrGroups === number of bulk groups',
  summary.sharedUtrGroups === c.BULK_SETTLEMENT / 3
);
check(
  'every group reports the right member count and sibling list',
  utrMembers.every((r) => r.utrGroup.size === 3 && r.utrGroup.siblingEntityIds.length === 2)
);
// The deterministic proof of a bulk settlement: the members' nets sum to the
// one credit that carries their shared UTR. This is arithmetic, so the engine
// can hand Day 3 a settled fact rather than a question — see the Day 3 note in
// the README about resolving bulk groups without spending an LLM call.
check(
  'every group is arithmetically proven (sum of member nets === the shared credit)',
  utrMembers.length > 0 && utrMembers.every((r) => r.utrGroup.combinedNetMatchesCredit === true),
  utrMembers
    .filter((r) => r.utrGroup.combinedNetMatchesCredit !== true)
    .map((r) => `${r.settlement.entityId}: ${r.utrGroup.combinedNet} vs ${r.utrGroup.bankCreditAmount}`)
    .join(', ')
);

console.log('\n--- G. Reference-matching coverage ---');
const methodCounts = {};
for (const r of results) {
  for (const m of [r.bankMethod, r.ledgerMethod]) {
    if (m) methodCounts[m] = (methodCounts[m] || 0) + 1;
  }
}
console.log(' ', methodCounts);
for (const method of [
  'EXACT_UTR',
  'EXACT_ORDER_ID',
  'EXACT_ORDER_RECEIPT',
  'AMOUNT_DATE_PROXIMITY',
  'AMBIGUOUS_PROXIMITY',
]) {
  check(`${method} is exercised at least once`, (methodCounts[method] || 0) > 0);
}

console.log('\n--- H. Generator self-consistency ---');
// Guards the settled_at drift bug: the grouped case types align every member's
// bank line to one settlement date, and settled_at has to be baked from that
// same date. When it wasn't, members drifted up to 7.5 days from their own bank
// credit, and one ambiguous pair fell out of the 3-day window entirely — it
// still came out UNRESOLVED, but for the wrong reason, which is exactly the
// class of bug a green test suite hides.
const driftOffenders = results.filter((r) => {
  const rec = r.bankMatch && r.bankMatch.record;
  if (!rec) return false;
  if (EXACT_METHODS.has(r.bankMethod)) return false; // exact match doesn't consult the date
  return daysApart(rec.date, r.settlement.settledAt || r.settlement.createdAt) > BANK_WINDOW_DAYS;
});
check(
  'no proximity-matched bank line sits outside the bank date window',
  driftOffenders.length === 0,
  driftOffenders.map((r) => r.settlement.entityId).join(', ')
);

// Every bank line the generator built for a record should be reachable: within
// the window if it has no reference, or reference-matched otherwise. This is
// the same drift bug seen from the generator's side rather than the engine's.
const unreachable = [];
for (const [entityId, gt] of Object.entries(groundTruth.records)) {
  const r = byEntity.get(entityId);
  for (const extId of gt.trueBankExternalIds) {
    const rec = bankStatement.find((b) => b.externalId === extId);
    if (!rec) continue;
    const sameUtr = rec.refs.utr && rec.refs.utr === r.settlement.settlementUtr;
    const inWindow =
      daysApart(rec.date, r.settlement.settledAt || r.settlement.createdAt) <= BANK_WINDOW_DAYS;
    if (!sameUtr && !inWindow) unreachable.push(`${entityId}/${gt.caseType}`);
  }
}
check(
  'every generated bank line is reachable by reference or by date window',
  unreachable.length === 0,
  unreachable.join(', ')
);

check(
  'receipt-only ledger entries exist (drives EXACT_ORDER_RECEIPT)',
  ledger.some((l) => l.refs.orderReceipt && !l.refs.orderId)
);
check(
  'ledger receipt numbers are globally unique (no cross-record claim possible)',
  new Set(ledger.map((l) => l.refs.orderReceipt).filter(Boolean)).size ===
    ledger.filter((l) => l.refs.orderReceipt).length
);
check(
  'ground truth covers every settlement record',
  Object.keys(groundTruth.records).length === SIZE
);

console.log('\n--- I. Contract hygiene ---');
// The signal vocabulary is the Day 3 LLM layer's input schema and Day 4's audit
// column set. An off-list signal would silently break both.
const knownSignals = new Set(SIGNALS);
const strays = [...new Set(results.flatMap((r) => r.signals))].filter((s) => !knownSignals.has(s));
check('no signal outside the closed SIGNALS set', strays.length === 0, strays.join(', '));
check(
  'every escalated record carries at least one signal explaining why',
  results.filter((r) => r.needsReview).every((r) => r.signals.length > 0)
);
check(
  'unresolvedReason is set exactly when status is UNRESOLVED',
  results.every((r) => (r.status === 'UNRESOLVED') === (r.unresolvedReason !== null))
);
check(
  'ground truth is never leaked into the match results',
  !JSON.stringify(results).includes('needsAiReview')
);

// needsAiReview coverage: every non-CLEAN, non-TIMING_LAG, non-ORPHAN case
// should be flagged for the LLM layer per the generator's own design.
const expectedAiReview = c.BLIND_PAYMENT + c.BULK_SETTLEMENT + c.AMOUNT_MISMATCH + c.AMBIGUOUS;
const actualAiReview = Object.values(groundTruth.records).filter((g) => g.needsAiReview).length;
check(
  'needsAiReview count matches design (blind+bulk+mismatch+ambiguous)',
  actualAiReview === expectedAiReview
);

console.log('\n--- Routing scorecard (what Day 3 inherits) ---');
console.log(
  `  resolved deterministically : ${summary.cleanlyReconciled}/${SIZE} ` +
    `(${((summary.cleanlyReconciled / SIZE) * 100).toFixed(1)}%)`
);
console.log(
  `  escalated                  : ${summary.needsReview}/${SIZE} ` +
    `(${((summary.needsReview / SIZE) * 100).toFixed(1)}%)`
);
console.log(`    of which genuine exceptions: ${expectedAiReview}`);
console.log(`    of which true orphans      : ${c.ORPHAN} (nothing to find; unavoidable)`);
console.log(`  silent misses              : ${silentMisses.length}`);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
