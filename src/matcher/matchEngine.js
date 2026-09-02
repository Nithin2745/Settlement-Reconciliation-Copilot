// src/matcher/matchEngine.js
//
// Day 1: the deterministic match engine. No LLM anywhere in this file — that
// is the point (ADR-001). This module answers one question per settlement
// record: "does an independent bank-statement line and/or ledger entry agree
// with this Razorpay settlement record?" per section 1 of the master doc
// (three independent records of the same money movement).
//
// The engine's contract with the Day 3 LLM exception layer is `needsReview`
// plus `signals[]`: every record it cannot resolve with certainty is escalated
// carrying a machine-readable list of *why*. It never guesses, and it never
// reports certainty it hasn't earned — an exact-reference hit whose amount
// disagrees is a flagged match, not a clean one.
//
// ExternalRecord shape (what bank-statement lines and ledger entries both
// normalize to before reaching this engine):
//   {
//     externalId: string,
//     source: 'bank' | 'ledger',
//     amount: number,                // paise; see AMOUNT_FIELD_BY_SOURCE below
//     date: string,                  // ISO 8601
//     refs: {
//       utr: string | null,          // bank: statement reference / UTR
//       orderId: string | null,      // ledger: linked Razorpay order id
//       orderReceipt: string | null, // ledger: invoice / receipt number
//       narration: string | null,    // bank: raw narration (Smart Collect-style)
//     },
//   }

// Which settlement amount field each source's external record should agree
// with. Bank credits reflect the *net* settled amount; ledger/invoice
// amounts reflect the *gross* order value raised before fees/tax.
const AMOUNT_FIELD_BY_SOURCE = {
  bank: 'netAmount',
  ledger: 'grossAmount',
};

// Closed set of deterministic signals. Nothing outside this list can appear on
// a result, which keeps the escalation reason auditable, gives the Day 3 LLM
// layer a fixed vocabulary to reason over, and gives Day 4's audit trail a
// fixed column set. Deliberately small: each signal has to change a routing or
// confidence decision, or it doesn't belong here.
const SIGNALS = [
  'AMOUNT_DISAGREES_BANK', // exact reference hit, but the credit isn't this record's net
  'AMOUNT_DISAGREES_LEDGER', // exact reference hit, but the invoice isn't this record's gross
  'AMBIGUOUS_BANK_CANDIDATES', // 2+ bank lines fit on amount + date; refused to guess
  'AMBIGUOUS_LEDGER_CANDIDATES', // 2+ ledger entries fit on amount + date; refused to guess
  'SHARED_UTR_GROUP', // this UTR covers 2+ settlement records (bulk settlement)
  'WATERFALL_MISMATCH', // the record's own amount/fee/tax/net don't reconcile
  'PROXIMITY_ONLY_NO_REFERENCE', // matched on amount + date with zero reference corroboration
  'NO_BANK_CANDIDATE',
  'NO_LEDGER_CANDIDATE',
];

// Signals that, on their own, mean "do not call this clean." NO_*_CANDIDATE is
// excluded: a bank-only or ledger-only record is already described by `status`,
// and double-counting it as a degrading signal would drag every legitimately
// one-sided record (refunds aren't separately invoiced, for instance) to LOW.
const NON_DEGRADING_SIGNALS = new Set(['NO_BANK_CANDIDATE', 'NO_LEDGER_CANDIDATE']);

const EXACT_METHODS = new Set(['EXACT_UTR', 'EXACT_ORDER_ID', 'EXACT_ORDER_RECEIPT']);

const DEFAULT_OPTS = {
  bankDateWindowDays: 3, // covers T+1/T+2 settlement lag
  ledgerDateWindowDays: 30, // invoices can be raised well before settlement
};

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return Infinity;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / msPerDay;
}

/** Does an external record's amount agree with the settlement figure it mirrors? */
function amountAgrees(settlement, record, source) {
  return record.amount === settlement[AMOUNT_FIELD_BY_SOURCE[source]];
}

/**
 * Try exact-reference match for a single settlement record against a pool of
 * still-unclaimed external records of one source.
 * Priority: settlement_utr (bank) > order_id > order_receipt (both ledger-ish).
 *
 * Deliberately does NOT check the amount: whether the two records refer to the
 * same event and whether the money agrees are two different questions, and
 * conflating them would silently drop bulk settlements (real UTR, combined
 * amount) instead of flagging them. The amount check happens in buildResult().
 */
function tryExactMatch(settlement, pool) {
  if (settlement.settlementUtr) {
    const hit = pool.find((r) => r.refs.utr && r.refs.utr === settlement.settlementUtr);
    if (hit) return { record: hit, method: 'EXACT_UTR' };
  }
  if (settlement.orderId) {
    const hit = pool.find((r) => r.refs.orderId && r.refs.orderId === settlement.orderId);
    if (hit) return { record: hit, method: 'EXACT_ORDER_ID' };
  }
  if (settlement.orderReceipt) {
    const hit = pool.find(
      (r) => r.refs.orderReceipt && r.refs.orderReceipt === settlement.orderReceipt
    );
    if (hit) return { record: hit, method: 'EXACT_ORDER_RECEIPT' };
  }
  return null;
}

/**
 * Fallback for records that survive the exact pass: amount + date proximity.
 * Only accepted when exactly one unclaimed candidate satisfies both amount
 * equality and the date window — an ambiguous (2+) match is deliberately left
 * unresolved rather than guessed, since guessing wrong here is a financial
 * error, not a UX inconvenience. Ambiguous cases are exactly what the Day 3
 * LLM exception layer (with reason codes) exists to reason about.
 */
function tryProximityMatch(settlement, pool, source, dateWindowDays) {
  const targetAmount = settlement[AMOUNT_FIELD_BY_SOURCE[source]];
  const referenceDate = settlement.settledAt || settlement.createdAt;

  const candidates = pool.filter(
    (r) => r.amount === targetAmount && daysBetween(r.date, referenceDate) <= dateWindowDays
  );

  if (candidates.length === 1) {
    return { record: candidates[0], method: 'AMOUNT_DATE_PROXIMITY' };
  }
  if (candidates.length > 1) {
    return { record: null, method: 'AMBIGUOUS_PROXIMITY', ambiguousCount: candidates.length };
  }
  return null;
}

/**
 * Group settlement records by settlement_utr. A UTR shared by 2+ records IS a
 * bulk settlement — one bank credit covering several orders. Detecting that is
 * arithmetic, not judgment, so the deterministic engine states it plainly and
 * hands the exception layer a formed hypothesis rather than a shrug: the
 * sibling records, the combined net they should sum to, and whether a bank line
 * carrying that UTR actually credits exactly that combined amount.
 *
 * That last check is the difference between "we can't match this" and "we can
 * prove these three records were paid by this one credit" — worth computing
 * here even though acting on it is a Day 3 decision, because it costs one pass
 * over the bank lines and no inference at all.
 */
function buildUtrGroups(settlementRecords, bankLines = []) {
  const byUtr = new Map();
  for (const s of settlementRecords) {
    if (!s.settlementUtr) continue;
    if (!byUtr.has(s.settlementUtr)) byUtr.set(s.settlementUtr, []);
    byUtr.get(s.settlementUtr).push(s);
  }

  const groups = new Map(); // entityId -> group info
  for (const [utr, members] of byUtr) {
    if (members.length < 2) continue;
    const combinedNet = members.reduce((sum, m) => sum + m.netAmount, 0);
    const credit = bankLines.find((r) => r.refs && r.refs.utr === utr) || null;
    for (const m of members) {
      groups.set(m.entityId, {
        utr,
        size: members.length,
        siblingEntityIds: members.filter((o) => o !== m).map((o) => o.entityId),
        combinedNet,
        bankCreditExternalId: credit ? credit.externalId : null,
        bankCreditAmount: credit ? credit.amount : null,
        combinedNetMatchesCredit: credit ? credit.amount === combinedNet : null,
      });
    }
  }
  return groups;
}

/**
 * Turn one settlement record plus its per-source match attempts into the final
 * result object, including the signal list, confidence tier and review routing
 * decision. Pure function of its inputs — no pool mutation, no ordering
 * effects — so a single record's verdict can be reasoned about in isolation.
 */
function buildResult(settlement, bankMatch, ledgerMatch, utrGroup) {
  const hasBank = !!(bankMatch && bankMatch.record);
  const hasLedger = !!(ledgerMatch && ledgerMatch.record);

  let status;
  if (hasBank && hasLedger) status = 'FULLY_MATCHED';
  else if (hasBank) status = 'PARTIAL_BANK_ONLY';
  else if (hasLedger) status = 'PARTIAL_LEDGER_ONLY';
  else status = 'UNRESOLVED';

  const signals = [];

  // Amount cross-check. A reference hit proves the two records describe the
  // same event; it does not prove the money agrees. Bulk settlements are the
  // textbook case — the UTR genuinely belongs to this record, but the credit
  // covers its siblings too, so the amount is several times too large.
  // Reporting that as a clean, HIGH-confidence match would be the single most
  // dangerous thing this engine could do, so it is checked explicitly.
  const bankAmountAgrees = hasBank ? amountAgrees(settlement, bankMatch.record, 'bank') : null;
  const ledgerAmountAgrees = hasLedger
    ? amountAgrees(settlement, ledgerMatch.record, 'ledger')
    : null;
  if (bankAmountAgrees === false) signals.push('AMOUNT_DISAGREES_BANK');
  if (ledgerAmountAgrees === false) signals.push('AMOUNT_DISAGREES_LEDGER');

  // Ambiguity, preserved. tryProximityMatch reports 2+ viable candidates with
  // record: null, and that fact used to be dropped whenever the other source
  // matched — the exception layer needs it either way.
  const bankAmbiguous = !!(bankMatch && bankMatch.method === 'AMBIGUOUS_PROXIMITY');
  const ledgerAmbiguous = !!(ledgerMatch && ledgerMatch.method === 'AMBIGUOUS_PROXIMITY');
  if (bankAmbiguous) signals.push('AMBIGUOUS_BANK_CANDIDATES');
  if (ledgerAmbiguous) signals.push('AMBIGUOUS_LEDGER_CANDIDATES');

  if (utrGroup) signals.push('SHARED_UTR_GROUP');
  if (settlement.waterfallOk === false) signals.push('WATERFALL_MISMATCH');
  if (!hasBank && !bankAmbiguous) signals.push('NO_BANK_CANDIDATE');
  if (!hasLedger && !ledgerAmbiguous) signals.push('NO_LEDGER_CANDIDATE');

  // "Matched, but on nothing except amount + date." A proximity hit is
  // trustworthy when the OTHER source corroborates it with a real reference —
  // the T+1/T+2 lag case, where the bank narration dropped the UTR but the
  // ledger still carries the order id. With no exact reference anywhere, the
  // only thing tying the records together is a coincidence of value and
  // timing, which is precisely a blind payment and precisely what the LLM
  // layer exists for. Distinguishing these two keeps the deterministic engine
  // from burning inference on lag it already handled correctly.
  const methodsUsed = [bankMatch && bankMatch.method, ledgerMatch && ledgerMatch.method].filter(
    Boolean
  );
  const hasExactCorroboration = methodsUsed.some((m) => EXACT_METHODS.has(m));
  if ((hasBank || hasLedger) && !hasExactCorroboration) {
    signals.push('PROXIMITY_ONLY_NO_REFERENCE');
  }

  const unresolvedReason =
    status !== 'UNRESOLVED'
      ? null
      : bankAmbiguous || ledgerAmbiguous
        ? 'AMBIGUOUS_CANDIDATES'
        : 'NO_CANDIDATE_FOUND';

  // Confidence is derived from the signals rather than hand-assigned per
  // branch, so "why is this HIGH?" always has a checkable answer.
  const degrading = signals.filter((sig) => !NON_DEGRADING_SIGNALS.has(sig));
  const bothExact =
    hasBank &&
    hasLedger &&
    EXACT_METHODS.has(bankMatch.method) &&
    EXACT_METHODS.has(ledgerMatch.method);

  let confidenceTier;
  if (status === 'UNRESOLVED' || degrading.length > 0) confidenceTier = 'LOW';
  else if (status === 'FULLY_MATCHED' && bothExact) confidenceTier = 'HIGH';
  else confidenceTier = 'MEDIUM';

  // The hand-off contract to Day 3. Anything that is not a complete,
  // corroborated, arithmetically consistent match gets escalated. Escalating a
  // true orphan is an acceptable cost — no deterministic rule can tell "no
  // counterpart exists" from "the counterpart is missing" — whereas silently
  // passing a wrong match is not.
  const needsReview = status !== 'FULLY_MATCHED' || degrading.length > 0;

  return {
    settlement,
    bankMatch: hasBank ? bankMatch : null,
    ledgerMatch: hasLedger ? ledgerMatch : null,
    // Method is reported even when no record was claimed, so an
    // AMBIGUOUS_PROXIMITY outcome survives into the audit trail.
    bankMethod: bankMatch ? bankMatch.method : null,
    ledgerMethod: ledgerMatch ? ledgerMatch.method : null,
    status,
    waterfallOk: settlement.waterfallOk,
    bankAmountAgrees,
    ledgerAmountAgrees,
    unresolvedReason,
    signals,
    utrGroup,
    confidenceTier,
    needsReview,
  };
}

/**
 * @param {object[]} settlementRecords - normalized settlement records (from normalizeSettlement.js)
 * @param {object[]} bankLines - ExternalRecord[] with source: 'bank'
 * @param {object[]} ledgerEntries - ExternalRecord[] with source: 'ledger'
 * @param {object} [opts]
 */
function matchThreeWay(settlementRecords, bankLines, ledgerEntries, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };

  // Mutable pools so a matched external record can't be claimed twice (1:1
  // assumption). Bulk settlements need 1:many and are therefore reported as
  // SHARED_UTR_GROUP exceptions rather than force-fitted into a 1:1 match.
  let bankPool = [...bankLines];
  let ledgerPool = [...ledgerEntries];

  const utrGroups = buildUtrGroups(settlementRecords, bankLines);

  const bankMatches = new Map(); // settlement.entityId -> match attempt
  const ledgerMatches = new Map();

  // Pass 1 — exact reference, across ALL settlement records, before any
  // proximity fallback runs, so a same-amount coincidence elsewhere can never
  // steal a candidate another record needed for its exact match.
  for (const s of settlementRecords) {
    const hit = tryExactMatch(s, bankPool);
    if (hit) {
      bankMatches.set(s.entityId, hit);
      bankPool = bankPool.filter((r) => r !== hit.record);
    }
  }
  for (const s of settlementRecords) {
    const hit = tryExactMatch(s, ledgerPool);
    if (hit) {
      ledgerMatches.set(s.entityId, hit);
      ledgerPool = ledgerPool.filter((r) => r !== hit.record);
    }
  }

  // Pass 2 — amount + date proximity, only for records still missing a match
  // on that side. tryExactMatch is deliberately not retried here: pass 1
  // already ran it against a strictly larger pool, so it cannot succeed now.
  for (const s of settlementRecords) {
    if (bankMatches.has(s.entityId)) continue;
    const hit = tryProximityMatch(s, bankPool, 'bank', cfg.bankDateWindowDays);
    if (!hit) continue;
    bankMatches.set(s.entityId, hit);
    if (hit.record) bankPool = bankPool.filter((r) => r !== hit.record);
  }
  for (const s of settlementRecords) {
    if (ledgerMatches.has(s.entityId)) continue;
    const hit = tryProximityMatch(s, ledgerPool, 'ledger', cfg.ledgerDateWindowDays);
    if (!hit) continue;
    ledgerMatches.set(s.entityId, hit);
    if (hit.record) ledgerPool = ledgerPool.filter((r) => r !== hit.record);
  }

  const results = settlementRecords.map((s) =>
    buildResult(
      s,
      bankMatches.get(s.entityId) || null,
      ledgerMatches.get(s.entityId) || null,
      utrGroups.get(s.entityId) || null
    )
  );

  const signalCounts = {};
  for (const r of results) {
    for (const sig of r.signals) signalCounts[sig] = (signalCounts[sig] || 0) + 1;
  }

  const summary = {
    total: results.length,
    fullyMatched: results.filter((r) => r.status === 'FULLY_MATCHED').length,
    partialBankOnly: results.filter((r) => r.status === 'PARTIAL_BANK_ONLY').length,
    partialLedgerOnly: results.filter((r) => r.status === 'PARTIAL_LEDGER_ONLY').length,
    unresolved: results.filter((r) => r.status === 'UNRESOLVED').length,
    waterfallMismatches: results.filter((r) => r.waterfallOk === false).length,
    // The two numbers the pitch actually rests on: what the deterministic
    // engine settled on its own, and what it escalated. Measured here, not
    // estimated later.
    cleanlyReconciled: results.filter((r) => !r.needsReview).length,
    needsReview: results.filter((r) => r.needsReview).length,
    byConfidenceTier: {
      HIGH: results.filter((r) => r.confidenceTier === 'HIGH').length,
      MEDIUM: results.filter((r) => r.confidenceTier === 'MEDIUM').length,
      LOW: results.filter((r) => r.confidenceTier === 'LOW').length,
    },
    sharedUtrGroups: new Set(
      results.filter((r) => r.utrGroup).map((r) => r.utrGroup.utr)
    ).size,
    signalCounts,
    unclaimedBankLines: bankPool.length,
    unclaimedLedgerEntries: ledgerPool.length,
  };

  return { summary, results };
}

module.exports = {
  matchThreeWay,
  tryExactMatch,
  tryProximityMatch,
  buildUtrGroups,
  AMOUNT_FIELD_BY_SOURCE,
  SIGNALS,
};
