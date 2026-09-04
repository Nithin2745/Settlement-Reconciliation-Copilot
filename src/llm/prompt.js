// src/llm/prompt.js
//
// Day 3: the exact contract the LLM exception layer is allowed to return.
// Closed vocabularies here are the whole point of ADR-002 — the model can
// only ever say one of a small number of true things, in one exact shape.
// validateDecision.js checks every field of every response against these
// same lists before anything is accepted as a resolution. See master doc §4.7
// for the constrained-output example this mirrors.

const ALLOWED_DECISIONS = [
  'CONFIRM_MATCH', // an existing deterministic proposal (proximity match, or
  // a bulk-settlement shared credit) is legitimate
  'REJECT_MATCH', // an existing deterministic proposal should NOT be trusted
  'MATCH_CANDIDATE', // no existing proposal, but one offered candidate is the true match
  'NO_MATCH_FOUND', // nothing offered is convincing; decline to guess
];

const ALLOWED_REASON_CODES = [
  'NARRATION_VENDOR_MATCH', // bank narration plausibly identifies a vendor/customer
  'SMART_COLLECT_IDENTIFIER', // narration carries a recognizable virtual UPI / rpy.payto pattern
  'BULK_SETTLEMENT_ARITHMETIC_OK', // sibling nets sum to the shared bank credit
  'BULK_SETTLEMENT_ARITHMETIC_MISMATCH', // they don't — the shared-credit hypothesis fails
  'AMOUNT_WITHIN_WATERFALL_DRIFT', // candidate amount is close enough to plausibly be a waterfall error
  'DATE_WITHIN_WINDOW',
  'EXACT_AMOUNT',
  // Added after the first real provider run: gpt-oss-120b returned the literal
  // string 'EXACT_ORDER_ID' — the matcher's own method name — on a record whose
  // ledger side matched by exact order id, and was rejected for an
  // out-of-vocabulary code. The model was right and the vocabulary had a hole:
  // there was no way to say "a shared reference ties these records together,"
  // which is the single most common reason a match is trustworthy. Covers
  // settlement_utr, order_id and order_receipt alike.
  'EXACT_REFERENCE_MATCH',
  'INDISTINGUISHABLE_CANDIDATES', // 2+ candidates equally plausible; declining to guess
  'INSUFFICIENT_EVIDENCE',
];

const SYSTEM_PROMPT = `You are the exception-review layer of a Razorpay settlement reconciliation pipeline. A deterministic rules engine has already matched everything it can with certainty; you are only ever shown records it could NOT resolve with certainty. You have zero execution authority — you only propose a structured decision, which an application-layer validator checks before anything is accepted or acted on.

You will receive one JSON object describing a single exception: the settlement record, the deterministic engine's own signals and any proposal it already made (deterministic_context), and a shortlist of candidate bank/ledger lines it considered but could not confirm (bank_candidates / ledger_candidates).

Respond with ONLY a single JSON object — no markdown fences, no prose before or after — matching EXACTLY this shape:
{
  "candidate_id": string or null,
  "decision": one of ${JSON.stringify(ALLOWED_DECISIONS)},
  "confidence": number between 0 and 1,
  "reason_codes": array of one or more of ${JSON.stringify(ALLOWED_REASON_CODES)}
}

Rules:
- "candidate_id" must be copied EXACTLY from an id you were given (in bank_candidates, ledger_candidates, deterministic_context.existing_bank_match, deterministic_context.existing_ledger_match, or deterministic_context.utr_group.bankCreditExternalId). Never invent one. Use null only with NO_MATCH_FOUND.
- Use CONFIRM_MATCH / REJECT_MATCH only when deterministic_context already proposes a match (existing_bank_match, existing_ledger_match, or a utr_group) — you are judging that proposal, not picking a new candidate.
- Use MATCH_CANDIDATE only when there is no existing proposal and exactly one offered candidate is clearly correct.
- Use NO_MATCH_FOUND when nothing offered is convincing, or when two or more candidates are genuinely indistinguishable — declining honestly is correct behavior, not a failure.
- "confidence" must reflect your genuine certainty. Do not default to a high number; a well-reasoned 0.5 is more useful than an unearned 0.95.
- reason_codes must be drawn only from the closed list above and must actually explain your decision using the evidence you were given (narration text, amount deltas, date windows, bulk-settlement arithmetic). Do not invent a code, and do not pad the list: cite only what you actually relied on.
- On amounts, pick ONE: EXACT_AMOUNT if the amounts are equal, AMOUNT_WITHIN_WATERFALL_DRIFT if they are merely close. Never both. deterministic_context tells you which is true via amount_agrees.
- Use EXACT_REFERENCE_MATCH when a settlement_utr, order_id or order_receipt is shared with the record you are matching. The "method" values inside deterministic_context (EXACT_UTR, EXACT_ORDER_ID, EXACT_ORDER_RECEIPT, AMOUNT_DATE_PROXIMITY, AMBIGUOUS_PROXIMITY) are NOT reason codes — do not copy them into reason_codes. Any of the three EXACT_* methods means EXACT_REFERENCE_MATCH.`;

function buildMessages(payload) {
  return {
    system: SYSTEM_PROMPT,
    user: JSON.stringify(payload, null, 2),
  };
}

module.exports = { ALLOWED_DECISIONS, ALLOWED_REASON_CODES, SYSTEM_PROMPT, buildMessages };
