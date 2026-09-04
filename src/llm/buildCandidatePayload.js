// src/llm/buildCandidatePayload.js
//
// Day 3: turns one matcher result that needs review into the exact JSON
// object sent to the LLM — and the exact object validateDecision.js checks
// candidate_ids against afterwards, so hallucination detection has a fixed,
// closed list of "real" ids to compare a response against. Never sends the
// whole unclaimed pool, only a bounded, deterministic shortlist — keeps the
// prompt small and every candidate the model saw auditable after the fact.
//
// Careful point: an AMBIGUOUS_PROXIMITY match attempt is NOT the same as "no
// match attempt." tryProximityMatch (matchEngine.js) returns a non-null
// object with `record: null` when 2+ candidates tie — so the correct "was
// this side actually resolved" check is `match && match.record`, never just
// `match` truthiness. Getting this wrong would either crash on `.externalId`
// of a null record, or silently treat an ambiguous pair as already matched.

const { AMOUNT_FIELD_BY_SOURCE, daysBetween } = require('../matcher/matchEngine');

// Mirrors generateSyntheticBatch.js's AMOUNT_MISMATCH corruption range
// (rng.int(50, 500) paise). A record whose reference was stripped AND whose
// exact-amount proximity failed can still plausibly be found by relaxing
// amount to "within a small drift" while widening the date window a little —
// that relaxation is a judgment call, which is exactly why it becomes an LLM
// candidate to examine rather than a rule the deterministic engine applies
// silently (ADR-001: the deterministic engine never guesses).
const AMOUNT_TOLERANCE_PAISE = 500;
const LOOSE_DATE_WINDOW_MULTIPLIER = 2;

function referenceDateFor(settlement) {
  return settlement.settledAt || settlement.createdAt;
}

function shortlistCandidates({ settlement, pool, source, dateWindowDays, maxCandidates }) {
  const targetAmount = settlement[AMOUNT_FIELD_BY_SOURCE[source]];
  const refDate = referenceDateFor(settlement);

  const exact = pool.filter(
    (r) => r.amount === targetAmount && daysBetween(r.date, refDate) <= dateWindowDays
  );

  const shortlisted =
    exact.length > 0
      ? exact
      : pool.filter(
          (r) =>
            Math.abs(r.amount - targetAmount) <= AMOUNT_TOLERANCE_PAISE &&
            daysBetween(r.date, refDate) <= dateWindowDays * LOOSE_DATE_WINDOW_MULTIPLIER
        );

  return shortlisted.slice(0, maxCandidates).map((r) => ({
    candidate_id: r.externalId,
    amount: r.amount,
    date: r.date,
    refs: r.refs,
  }));
}

function buildCandidatePayload(
  entry,
  { unclaimedBankRecords, unclaimedLedgerRecords, maxCandidatesPerException = 5 }
) {
  const r = entry.result;
  const s = r.settlement;

  const hasBankMatch = !!(r.bankMatch && r.bankMatch.record);
  const hasLedgerMatch = !!(r.ledgerMatch && r.ledgerMatch.record);

  const bankCandidates = hasBankMatch
    ? []
    : shortlistCandidates({
        settlement: s,
        pool: unclaimedBankRecords,
        source: 'bank',
        dateWindowDays: 3,
        maxCandidates: maxCandidatesPerException,
      });

  const ledgerCandidates = hasLedgerMatch
    ? []
    : shortlistCandidates({
        settlement: s,
        pool: unclaimedLedgerRecords,
        source: 'ledger',
        dateWindowDays: 30,
        maxCandidates: maxCandidatesPerException,
      });

  return {
    settlement: {
      entity_id: s.entityId,
      type: s.type,
      gross_amount: s.grossAmount,
      fee: s.fee,
      tax: s.tax,
      net_amount: s.netAmount,
      waterfall_ok: s.waterfallOk,
      settlement_utr: s.settlementUtr,
      order_id: s.orderId,
      order_receipt: s.orderReceipt,
      created_at: s.createdAt,
      settled_at: s.settledAt,
    },
    deterministic_context: {
      status: r.status,
      confidence_tier: r.confidenceTier,
      signals: r.signals,
      unresolved_reason: r.unresolvedReason,
      existing_bank_match: hasBankMatch
        ? {
            candidate_id: r.bankMatch.record.externalId,
            method: r.bankMatch.method,
            amount: r.bankMatch.record.amount,
            date: r.bankMatch.record.date,
            refs: r.bankMatch.record.refs,
            amount_agrees: r.bankAmountAgrees,
          }
        : null,
      existing_ledger_match: hasLedgerMatch
        ? {
            candidate_id: r.ledgerMatch.record.externalId,
            method: r.ledgerMatch.method,
            amount: r.ledgerMatch.record.amount,
            date: r.ledgerMatch.record.date,
            refs: r.ledgerMatch.record.refs,
            amount_agrees: r.ledgerAmountAgrees,
          }
        : null,
      // Already-computed bulk-settlement arithmetic from Day 2 (buildUtrGroups):
      // group size, siblings, combined net, and whether the shared bank credit
      // actually equals that combined net. The LLM judges this proposal; it
      // does not have to re-derive it.
      utr_group: r.utrGroup,
    },
    bank_candidates: bankCandidates,
    ledger_candidates: ledgerCandidates,
  };
}

module.exports = { buildCandidatePayload, shortlistCandidates, AMOUNT_TOLERANCE_PAISE };
