// src/matcher/matchEngine.js
//
// Day 2: the deterministic match engine. No LLM anywhere in this file — that
// is the point (ADR-001). This module answers one question per settlement
// record: "does an independent bank-statement line and/or ledger entry agree
// with this Razorpay settlement record?" per section 1 of the master doc
// (three independent records of the same money movement).
//
// SCOPE NOTE: Day 3 builds the real synthetic bank-statement/ledger
// generators (with an internal ground-truth map). This engine is written
// against the *shape* those generators will produce (see ExternalRecord
// below) so Day 3 only has to conform to the shape, not touch this file.
// scripts/verifyMatcher.js exercises it today with a small hand-built mock
// dataset derived from fixtures/settlement-recon-sample.json.
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

const DEFAULT_OPTS = {
  bankDateWindowDays: 3, // covers T+1/T+2 settlement lag
  ledgerDateWindowDays: 30, // invoices can be raised well before settlement
};

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return Infinity;
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.abs(new Date(isoA).getTime() - new Date(isoB).getTime()) / msPerDay;
}

/**
 * Try exact-reference match for a single settlement record against a pool of
 * still-unclaimed external records of one source.
 * Priority: settlement_utr (bank) > order_id > order_receipt (both ledger-ish).
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
 * equality and the date window — an ambiguous (2+) match is deliberately
 * left unresolved rather than guessed, since guessing wrong here is a
 * financial error, not a UX inconvenience. Ambiguous cases are exactly what
 * the Day 4 LLM exception layer (with reason codes) exists to reason about.
 */
function tryProximityMatch(settlement, pool, source, dateWindowDays) {
  const amountField = AMOUNT_FIELD_BY_SOURCE[source];
  const targetAmount = settlement[amountField];
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

function matchAgainstSource(settlement, pool, source, dateWindowDays) {
  const exact = tryExactMatch(settlement, pool);
  if (exact) return exact;

  const proximity = tryProximityMatch(settlement, pool, source, dateWindowDays);
  if (proximity && proximity.record) return proximity;
  if (proximity && proximity.method === 'AMBIGUOUS_PROXIMITY') return proximity; // record: null

  return null;
}

/**
 * @param {object[]} settlementRecords - normalized settlement records (from normalizeSettlement.js)
 * @param {object[]} bankLines - ExternalRecord[] with source: 'bank'
 * @param {object[]} ledgerEntries - ExternalRecord[] with source: 'ledger'
 * @param {object} [opts]
 */
function matchThreeWay(settlementRecords, bankLines, ledgerEntries, opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts };

  // Mutable pools so a matched external record can't be claimed twice
  // (one-to-one assumption; bulk settlements that need one-to-many are
  // exactly the unresolved cases Day 4's LLM layer is for).
  let bankPool = [...bankLines];
  let ledgerPool = [...ledgerEntries];

  // Exact-reference pass first, across ALL settlement records, before any
  // proximity fallback runs — so a same-amount coincidence elsewhere never
  // steals a candidate that another record needed for its exact match.
  const bankMatches = new Map(); // settlement.entityId -> matchResult
  const ledgerMatches = new Map();

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

  // Proximity pass second, only for settlement records still missing a match
  // on that side.
  for (const s of settlementRecords) {
    if (bankMatches.has(s.entityId)) continue;
    const hit = matchAgainstSource(s, bankPool, 'bank', cfg.bankDateWindowDays);
    if (hit) {
      bankMatches.set(s.entityId, hit);
      if (hit.record) bankPool = bankPool.filter((r) => r !== hit.record);
    }
  }
  for (const s of settlementRecords) {
    if (ledgerMatches.has(s.entityId)) continue;
    const hit = matchAgainstSource(s, ledgerPool, 'ledger', cfg.ledgerDateWindowDays);
    if (hit) {
      ledgerMatches.set(s.entityId, hit);
      if (hit.record) ledgerPool = ledgerPool.filter((r) => r !== hit.record);
    }
  }

  const results = settlementRecords.map((s) => {
    const bankMatch = bankMatches.get(s.entityId) || null;
    const ledgerMatch = ledgerMatches.get(s.entityId) || null;

    const hasBank = !!(bankMatch && bankMatch.record);
    const hasLedger = !!(ledgerMatch && ledgerMatch.record);

    let status;
    if (hasBank && hasLedger) status = 'FULLY_MATCHED';
    else if (hasBank) status = 'PARTIAL_BANK_ONLY';
    else if (hasLedger) status = 'PARTIAL_LEDGER_ONLY';
    else status = 'UNRESOLVED';

    return {
      settlement: s,
      bankMatch: hasBank ? bankMatch : null,
      ledgerMatch: hasLedger ? ledgerMatch : null,
      status,
      waterfallOk: s.waterfallOk,
      // Surfaced so the LLM exception layer (Day 4) and audit trail (Day 6)
      // don't have to re-derive why nothing matched.
      unresolvedReason:
        status === 'UNRESOLVED'
          ? (bankMatch && bankMatch.method === 'AMBIGUOUS_PROXIMITY') ||
            (ledgerMatch && ledgerMatch.method === 'AMBIGUOUS_PROXIMITY')
            ? 'AMBIGUOUS_CANDIDATES'
            : 'NO_CANDIDATE_FOUND'
          : null,
    };
  });

  const summary = {
    total: results.length,
    fullyMatched: results.filter((r) => r.status === 'FULLY_MATCHED').length,
    partialBankOnly: results.filter((r) => r.status === 'PARTIAL_BANK_ONLY').length,
    partialLedgerOnly: results.filter((r) => r.status === 'PARTIAL_LEDGER_ONLY').length,
    unresolved: results.filter((r) => r.status === 'UNRESOLVED').length,
    waterfallMismatches: results.filter((r) => r.waterfallOk === false).length,
    unclaimedBankLines: bankPool.length,
    unclaimedLedgerEntries: ledgerPool.length,
  };

  return { summary, results };
}

module.exports = { matchThreeWay, tryExactMatch, tryProximityMatch, AMOUNT_FIELD_BY_SOURCE };
