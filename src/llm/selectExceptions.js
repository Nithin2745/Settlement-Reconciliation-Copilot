// src/llm/selectExceptions.js
//
// Day 3: decides which matcher-escalated records are actually worth an LLM
// call. `needsReview` alone is not enough — a true orphan (ORPHAN case type,
// or any record with genuinely nothing nearby in either unclaimed pool) has
// no existing proposal and no plausible candidate to examine, so sending it
// to the LLM would just spend a call to be told "no match found," which the
// deterministic engine already effectively knows. This is the "LLM calls
// avoided" number from the master doc's evaluation layer (§4.6) — computed
// honestly here, not asserted after the fact from a fixed percentage.
//
// Deliberately reuses buildCandidatePayload rather than a separate, cheaper
// "is there material" check: "is there material to reason about" and "what
// is the material" are the same question, and computing an answer to it
// twice risks the two answers drifting apart.

const { buildCandidatePayload } = require('./buildCandidatePayload');

function hasReviewMaterial(payload) {
  return (
    !!payload.deterministic_context.existing_bank_match ||
    !!payload.deterministic_context.existing_ledger_match ||
    !!payload.deterministic_context.utr_group ||
    payload.bank_candidates.length > 0 ||
    payload.ledger_candidates.length > 0
  );
}

/**
 * @param {object[]} results - matchThreeWay(...).results
 * @param {object[]} unclaimedBankRecords - matchThreeWay(...).unclaimedBankRecords
 * @param {object[]} unclaimedLedgerRecords - matchThreeWay(...).unclaimedLedgerRecords
 * @param {number} [maxCandidatesPerException]
 */
function selectExceptions({
  results,
  unclaimedBankRecords,
  unclaimedLedgerRecords,
  maxCandidatesPerException,
}) {
  const reviewable = [];
  const skipped = [];

  for (const result of results) {
    if (!result.needsReview) continue;

    const payload = buildCandidatePayload(
      { result },
      { unclaimedBankRecords, unclaimedLedgerRecords, maxCandidatesPerException }
    );

    if (hasReviewMaterial(payload)) {
      reviewable.push({ result, payload });
    } else {
      skipped.push({ result, payload, reason: 'NO_CANDIDATES' });
    }
  }

  return { reviewable, skipped };
}

module.exports = { selectExceptions, hasReviewMaterial };
