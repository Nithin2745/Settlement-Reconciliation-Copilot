// scripts/verifyLlmLayer.js
//
// Day 3 regression guard. Unlike runExceptionLayer.js, this makes NO real
// network calls — it sets dummy API keys and mocks global.fetch, so it can
// run in CI or a sandboxed environment with no Groq/OpenRouter access, same
// spirit as verify-adapter/verify-matcher/verify-synthetic before it.
//
// Six things get checked, in order:
//   A. selectExceptions classifies every ground-truth case type correctly
//      (which records get an LLM call vs which are correctly skipped)
//   B. buildCandidatePayload produces the right shape per case type — this
//      is where the AMBIGUOUS_PROXIMITY "match object with record: null"
//      trap would show up as a crash if handled wrong
//   C. validateDecision's acceptance gate: hallucinated candidate_id,
//      malformed JSON, prose-wrapped JSON, out-of-vocab enums, incoherent
//      reason codes, and below-threshold confidence, unit-tested directly
//      against a real payload
//   D. resolveExceptions end-to-end over the whole batch, with a fake
//      payload-driven llmCaller standing in for the model — proves the
//      orchestration wiring (skip/accept/downgrade/reject/error) is correct
//   E. the REAL llmClient.callLlmWithFallback, called with global.fetch
//      mocked — proves the actual Groq->OpenRouter fallback code executes
//      (not just that the orchestrator would call it), that transient
//      failures retry and deterministic 4xx do not, and that the circuit
//      breaker stops re-calling a hard-down primary
//   F. the evaluation layer scores both layers against ground truth, and the
//      two numbers the whole deterministic-first argument rests on — silent
//      misses and silent wrong claims — are zero
//
// A note on what a passing run here does and does not prove: section D's fake
// caller returns hand-written valid JSON, so no assert in this file can catch
// a provider-level formatting failure (the max_tokens truncation bug did not
// fail a single check here). That is what `npm run run-exception-layer` is
// for. This file proves the code is correct; only a real call proves the
// providers behave.

// Dummy keys BEFORE config.js is required by anything, so
// assertLlmIsConfigured() doesn't throw during these tests.
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-groq-key';
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'test-openrouter-key';

const { config } = require('../src/config');
const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay } = require('../src/matcher/matchEngine');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');
const { selectExceptions } = require('../src/llm/selectExceptions');
const { validateDecision } = require('../src/llm/validateDecision');
const { resolveExceptions } = require('../src/llm/resolveExceptions');
const { evaluateRun, formatEvaluation } = require('../src/eval/evaluateRun');
const llmClient = require('../src/llm/llmClient');

const SIZE = parseInt(process.argv[2], 10) || 150;
const SEED = parseInt(process.argv[3], 10) || 42;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK ${label}`);
  } else {
    console.log(`FAIL ${label}${detail ? ` -> ${detail}` : ''}`);
    failures += 1;
  }
}

function jsonOf(obj) {
  return JSON.stringify(obj);
}

async function main() {
  console.log(`Generating synthetic batch: size=${SIZE}, seed=${SEED}\n`);
  const { settlementRecon, bankStatement, ledger, groundTruth } = generateSyntheticBatch({
    size: SIZE,
    seed: SEED,
  });
  const { records } = normalizeSettlementRecon(settlementRecon);
  const { results, unclaimedBankRecords, unclaimedLedgerRecords } = matchThreeWay(
    records,
    bankStatement,
    ledger
  );

  // -------------------------------------------------------------------------
  // A. selectExceptions classification vs ground truth
  // -------------------------------------------------------------------------
  console.log('--- A. selectExceptions classification ---');

  const { reviewable, skipped } = selectExceptions({
    results,
    unclaimedBankRecords,
    unclaimedLedgerRecords,
    maxCandidatesPerException: config.llm.maxCandidatesPerException,
  });

  const reviewableIds = new Set(reviewable.map((e) => e.result.settlement.entityId));
  const skippedIds = new Set(skipped.map((e) => e.result.settlement.entityId));

  check(
    'reviewable + skipped covers exactly the needsReview records',
    reviewable.length + skipped.length === results.filter((r) => r.needsReview).length
  );
  check(
    'no entity appears in both reviewable and skipped',
    [...reviewableIds].every((id) => !skippedIds.has(id))
  );

  const orphanIds = Object.entries(groundTruth.records)
    .filter(([, gt]) => gt.caseType === 'ORPHAN')
    .map(([id]) => id);
  check(
    'every ORPHAN is skipped (no candidates to reason about)',
    orphanIds.length > 0 && orphanIds.every((id) => skippedIds.has(id)),
    `${orphanIds.filter((id) => !skippedIds.has(id)).length} ORPHANs were NOT skipped`
  );

  const needsAiReviewIds = Object.entries(groundTruth.records)
    .filter(([, gt]) => gt.needsAiReview)
    .map(([id]) => id);
  check(
    'every needsAiReview:true ground-truth record is reviewable',
    needsAiReviewIds.length > 0 && needsAiReviewIds.every((id) => reviewableIds.has(id)),
    `${needsAiReviewIds.filter((id) => !reviewableIds.has(id)).length} were silently skipped`
  );

  for (const caseType of ['BULK_SETTLEMENT', 'BLIND_PAYMENT', 'AMOUNT_MISMATCH', 'AMBIGUOUS']) {
    const ids = Object.entries(groundTruth.records)
      .filter(([, gt]) => gt.caseType === caseType)
      .map(([id]) => id);
    check(
      `every ${caseType} record is reviewable (n=${ids.length})`,
      ids.length > 0 && ids.every((id) => reviewableIds.has(id))
    );
  }

  // -------------------------------------------------------------------------
  // B. buildCandidatePayload shape per case type
  // -------------------------------------------------------------------------
  console.log('\n--- B. buildCandidatePayload shape per case type ---');

  function payloadFor(entityId) {
    const entry = reviewable.find((e) => e.result.settlement.entityId === entityId);
    return entry ? entry.payload : null;
  }

  const blindId = Object.entries(groundTruth.records).find(([, gt]) => gt.caseType === 'BLIND_PAYMENT')?.[0];
  if (blindId) {
    const p = payloadFor(blindId);
    check('BLIND_PAYMENT payload exists', !!p);
    check('BLIND_PAYMENT has an existing_bank_match to review', !!p.deterministic_context.existing_bank_match);
    check('BLIND_PAYMENT has no existing_ledger_match', !p.deterministic_context.existing_ledger_match);
    check(
      'BLIND_PAYMENT narration carries the Smart Collect pattern',
      /rpy\.payto/.test(p.deterministic_context.existing_bank_match.refs.narration || '')
    );
  }

  const mismatchId = Object.entries(groundTruth.records).find(([, gt]) => gt.caseType === 'AMOUNT_MISMATCH')?.[0];
  if (mismatchId) {
    const p = payloadFor(mismatchId);
    check('AMOUNT_MISMATCH payload exists', !!p);
    check(
      'AMOUNT_MISMATCH has no existing_bank_match (reference stripped, amount corrupted)',
      !p.deterministic_context.existing_bank_match
    );
    check('AMOUNT_MISMATCH has an existing_ledger_match (ledger untouched)', !!p.deterministic_context.existing_ledger_match);
    check('AMOUNT_MISMATCH surfaces at least one loose bank candidate within drift tolerance', p.bank_candidates.length >= 1);
  }

  const bulkWinnerId = Object.entries(groundTruth.records).find(
    ([, gt]) => gt.caseType === 'BULK_SETTLEMENT' && gt.note.includes('claimed the shared combined bank credit')
  )?.[0];
  const bulkSiblingId = Object.entries(groundTruth.records).find(
    ([, gt]) => gt.caseType === 'BULK_SETTLEMENT' && gt.note.includes('left PARTIAL_LEDGER_ONLY')
  )?.[0];
  if (bulkWinnerId) {
    const p = payloadFor(bulkWinnerId);
    check('BULK_SETTLEMENT winner payload exists', !!p);
    check('BULK_SETTLEMENT winner carries utr_group', !!p.deterministic_context.utr_group);
    check(
      'BULK_SETTLEMENT winner utr_group arithmetic checks out',
      p.deterministic_context.utr_group.combinedNetMatchesCredit === true
    );
  }
  if (bulkSiblingId) {
    const p = payloadFor(bulkSiblingId);
    check('BULK_SETTLEMENT sibling payload exists', !!p);
    check('BULK_SETTLEMENT sibling carries utr_group too', !!p.deterministic_context.utr_group);
    check(
      'BULK_SETTLEMENT sibling has no existing_bank_match (credit already claimed by winner)',
      !p.deterministic_context.existing_bank_match
    );
  }

  const ambiguousId = Object.entries(groundTruth.records).find(([, gt]) => gt.caseType === 'AMBIGUOUS')?.[0];
  if (ambiguousId) {
    // This is the exact shape (bankMatch/ledgerMatch present but .record
    // null) that would crash a naive `r.bankMatch ? ... : null` check —
    // confirming it doesn't crash AND correctly reports no existing match is
    // the point here.
    const p = payloadFor(ambiguousId);
    check('AMBIGUOUS payload exists and did not throw while building', !!p);
    check('AMBIGUOUS has no existing_bank_match (ambiguous != matched)', !p.deterministic_context.existing_bank_match);
    check('AMBIGUOUS has no existing_ledger_match', !p.deterministic_context.existing_ledger_match);
    check('AMBIGUOUS offers 2+ bank candidates', p.bank_candidates.length >= 2);
    check('AMBIGUOUS offers 2+ ledger candidates', p.ledger_candidates.length >= 2);
  }

  // -------------------------------------------------------------------------
  // C. validateDecision acceptance gate — unit tests against a real payload
  // -------------------------------------------------------------------------
  console.log('\n--- C. validateDecision acceptance gate ---');

  const samplePayload = mismatchId ? payloadFor(mismatchId) : reviewable[0].payload;
  const realCandidateId = samplePayload.bank_candidates[0]
    ? samplePayload.bank_candidates[0].candidate_id
    : samplePayload.deterministic_context.existing_ledger_match.candidate_id;

  check(
    'well-formed MATCH_CANDIDATE at high confidence is accepted',
    validateDecision(
      jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 0.9, reason_codes: ['EXACT_AMOUNT'] }),
      samplePayload
    ).accepted === true
  );

  check('malformed JSON is rejected', validateDecision('not json at all {{{', samplePayload).reason === 'MALFORMED_JSON');

  check(
    'response wrapped in markdown fences still parses',
    validateDecision(
      '```json\n' +
        jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 0.9, reason_codes: ['EXACT_AMOUNT'] }) +
        '\n```',
      samplePayload
    ).accepted === true
  );

  check(
    'decision outside the allowed set is rejected',
    validateDecision(
      jsonOf({ candidate_id: realCandidateId, decision: 'DEFINITELY_MATCH', confidence: 0.9, reason_codes: ['EXACT_AMOUNT'] }),
      samplePayload
    ).reason === 'INVALID_DECISION'
  );

  check(
    'confidence outside 0..1 is rejected',
    validateDecision(
      jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 1.4, reason_codes: ['EXACT_AMOUNT'] }),
      samplePayload
    ).reason === 'INVALID_CONFIDENCE'
  );

  check(
    'empty reason_codes is rejected',
    validateDecision(
      jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 0.9, reason_codes: [] }),
      samplePayload
    ).reason === 'MISSING_REASON_CODES'
  );

  check(
    'reason code outside the closed vocabulary is rejected',
    validateDecision(
      jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 0.9, reason_codes: ['VIBES'] }),
      samplePayload
    ).reason === 'REASON_CODE_NOT_ALLOWED:VIBES'
  );

  check(
    'MATCH_CANDIDATE/CONFIRM_MATCH/REJECT_MATCH without a candidate_id is rejected',
    validateDecision(
      jsonOf({ candidate_id: null, decision: 'MATCH_CANDIDATE', confidence: 0.9, reason_codes: ['EXACT_AMOUNT'] }),
      samplePayload
    ).reason === 'MISSING_CANDIDATE_ID'
  );

  check(
    'a fabricated (hallucinated) candidate_id is rejected — the core hallucination gate',
    validateDecision(
      jsonOf({ candidate_id: 'bank_totally_made_up_9999', decision: 'MATCH_CANDIDATE', confidence: 0.95, reason_codes: ['EXACT_AMOUNT'] }),
      samplePayload
    ).reason === 'HALLUCINATED_CANDIDATE_ID'
  );

  check(
    'NO_MATCH_FOUND carrying a candidate_id anyway is rejected',
    validateDecision(
      jsonOf({ candidate_id: realCandidateId, decision: 'NO_MATCH_FOUND', confidence: 0.9, reason_codes: ['INSUFFICIENT_EVIDENCE'] }),
      samplePayload
    ).reason === 'CANDIDATE_ID_WITH_NO_MATCH'
  );

  check(
    'NO_MATCH_FOUND with candidate_id: null is accepted',
    validateDecision(
      jsonOf({ candidate_id: null, decision: 'NO_MATCH_FOUND', confidence: 0.8, reason_codes: ['INSUFFICIENT_EVIDENCE'] }),
      samplePayload
    ).accepted === true
  );

  const belowThreshold = validateDecision(
    jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 0.4, reason_codes: ['EXACT_AMOUNT'] }),
    samplePayload
  );
  check(
    'below-confidence-threshold decision is structurally valid but downgraded, not accepted',
    belowThreshold.accepted === false &&
      belowThreshold.downgraded === true &&
      belowThreshold.reason === 'BELOW_CONFIDENCE_THRESHOLD'
  );

  // Reasoning models intermittently narrate before answering even with
  // response_format set — this exact prefix came back from OpenRouter/Nemotron
  // in a real call. A formatting failure should not discard a good decision.
  check(
    'prose-prefixed JSON (chain-of-thought leak) still parses and is judged on merit',
    validateDecision(
      'We need to output JSON with candidate_id, decision, confidence, reason_codes.\n\n' +
        jsonOf({ candidate_id: realCandidateId, decision: 'MATCH_CANDIDATE', confidence: 0.9, reason_codes: ['EXACT_AMOUNT'] }),
      samplePayload
    ).accepted === true
  );

  check(
    'a closing brace inside a narration string does not end the JSON scan early',
    validateDecision(
      'Here is my answer: ' +
        jsonOf({
          candidate_id: realCandidateId,
          decision: 'MATCH_CANDIDATE',
          confidence: 0.9,
          reason_codes: ['NARRATION_VENDOR_MATCH'],
          note: 'NEFT CR {ref} } RAZORPAY',
        }),
      samplePayload
    ).accepted === true
  );

  check(
    'truncated JSON (finish_reason=length) is rejected, not half-parsed',
    validateDecision(
      '{"candidate_id": "' + realCandidateId + '", "decision": "MATCH_CANDIDATE", "confid',
      samplePayload
    ).reason === 'MALFORMED_JSON'
  );

  // Coherence: each of these codes is individually in the allowed list, so the
  // closed vocabulary alone would let all of them through.
  //
  // The amount pair is the case the first real provider run got wrong. It used
  // to be a flat rejection, which threw away 3 correct decisions on real
  // candidate ids because gpt-oss-120b had cited both amount codes at once.
  // EXACT_AMOUNT and AMOUNT_WITHIN_WATERFALL_DRIFT point the same way and differ
  // only in strictness, so the gate now resolves them from the payload instead
  // of sinking the decision. These asserts pin that down in both directions.
  const agreeingPayload = {
    settlement: { entity_id: 'pay_COHERENCE_1', net_amount: 12539 },
    deterministic_context: {
      existing_bank_match: {
        candidate_id: 'bank_agreeing',
        method: 'AMOUNT_DATE_PROXIMITY',
        amount: 12539,
        amount_agrees: true,
      },
      existing_ledger_match: null,
    },
    bank_candidates: [],
    ledger_candidates: [],
  };
  const agreeingBoth = validateDecision(
    jsonOf({
      candidate_id: 'bank_agreeing',
      decision: 'CONFIRM_MATCH',
      confidence: 0.85,
      reason_codes: ['EXACT_AMOUNT', 'DATE_WITHIN_WINDOW', 'AMOUNT_WITHIN_WATERFALL_DRIFT'],
    }),
    agreeingPayload
  );
  check(
    'both amount codes on an agreeing amount: decision survives (a padded label is not a wrong answer)',
    agreeingBoth.accepted === true
  );
  check(
    'both amount codes on an agreeing amount: the weaker code is dropped, the stronger kept',
    agreeingBoth.reasonCodes.includes('EXACT_AMOUNT') &&
      !agreeingBoth.reasonCodes.includes('AMOUNT_WITHIN_WATERFALL_DRIFT')
  );
  check(
    'dropping a code is recorded as a warning, never silently',
    agreeingBoth.warnings.includes('DROPPED_REDUNDANT_REASON_CODE:AMOUNT_WITHIN_WATERFALL_DRIFT')
  );
  check(
    'the raw model output is preserved unedited for the audit trail',
    agreeingBoth.parsed.reason_codes.length === 3
  );

  const disagreeingPayload = {
    settlement: { entity_id: 'pay_COHERENCE_2', net_amount: 111573 },
    deterministic_context: {
      existing_bank_match: {
        candidate_id: 'bank_disagreeing',
        method: 'AMOUNT_DATE_PROXIMITY',
        amount: 111642,
        amount_agrees: false,
      },
      existing_ledger_match: null,
    },
    bank_candidates: [],
    ledger_candidates: [],
  };
  const disagreeingClaim = validateDecision(
    jsonOf({
      candidate_id: 'bank_disagreeing',
      decision: 'CONFIRM_MATCH',
      confidence: 0.85,
      reason_codes: ['EXACT_AMOUNT', 'DATE_WITHIN_WINDOW'],
    }),
    disagreeingPayload
  );
  check(
    'EXACT_AMOUNT is dropped when we ourselves told the model the amounts disagree',
    disagreeingClaim.accepted === true &&
      !disagreeingClaim.reasonCodes.includes('EXACT_AMOUNT') &&
      disagreeingClaim.reasonCodes.includes('DATE_WITHIN_WINDOW')
  );
  check(
    'a disproved code that was the ONLY justification sinks the decision (nothing left supporting it)',
    validateDecision(
      jsonOf({
        candidate_id: 'bank_disagreeing',
        decision: 'CONFIRM_MATCH',
        confidence: 0.95,
        reason_codes: ['EXACT_AMOUNT'],
      }),
      disagreeingPayload
    ).reason === 'NO_SUPPORTED_REASON_CODES'
  );
  check(
    'AMOUNT_WITHIN_WATERFALL_DRIFT alone is never dropped (a weaker true claim, not a wrong one)',
    validateDecision(
      jsonOf({
        candidate_id: 'bank_agreeing',
        decision: 'CONFIRM_MATCH',
        confidence: 0.85,
        reason_codes: ['AMOUNT_WITHIN_WATERFALL_DRIFT'],
      }),
      agreeingPayload
    ).reasonCodes.includes('AMOUNT_WITHIN_WATERFALL_DRIFT')
  );

  check(
    'opposed reason codes ARE still rejected: two opposite bulk verdicts make the decision unactionable',
    validateDecision(
      jsonOf({
        candidate_id: realCandidateId,
        decision: 'MATCH_CANDIDATE',
        confidence: 0.95,
        reason_codes: ['BULK_SETTLEMENT_ARITHMETIC_OK', 'BULK_SETTLEMENT_ARITHMETIC_MISMATCH'],
      }),
      samplePayload
    ).reason ===
      'CONTRADICTORY_REASON_CODES:BULK_SETTLEMENT_ARITHMETIC_OK+BULK_SETTLEMENT_ARITHMETIC_MISMATCH'
  );

  // EXACT_REFERENCE_MATCH exists because the first real run had no code for the
  // commonest reason a match is trustworthy, and the model reached for the
  // matcher's internal method name ('EXACT_ORDER_ID') instead — and was rejected
  // for it. The vocabulary hole was the bug; the model was right.
  check(
    'EXACT_REFERENCE_MATCH is allowed when a side really did match on an exact reference',
    validateDecision(
      jsonOf({
        candidate_id: 'ledger_ref',
        decision: 'CONFIRM_MATCH',
        confidence: 0.9,
        reason_codes: ['EXACT_REFERENCE_MATCH', 'DATE_WITHIN_WINDOW'],
      }),
      {
        settlement: { entity_id: 'pay_COHERENCE_3', order_id: 'order_XYZ' },
        deterministic_context: {
          existing_bank_match: null,
          existing_ledger_match: {
            candidate_id: 'ledger_ref',
            method: 'EXACT_ORDER_ID',
            amount: 114341,
            amount_agrees: true,
          },
        },
        bank_candidates: [],
        ledger_candidates: [],
      }
    ).accepted === true
  );
  check(
    'EXACT_REFERENCE_MATCH claimed where no reference is shared anywhere is rejected as fabricated evidence',
    validateDecision(
      jsonOf({
        candidate_id: 'bank_noref',
        decision: 'CONFIRM_MATCH',
        confidence: 0.9,
        reason_codes: ['EXACT_REFERENCE_MATCH'],
      }),
      {
        settlement: { entity_id: 'pay_COHERENCE_4', settlement_utr: null, order_id: null, order_receipt: null },
        deterministic_context: {
          existing_bank_match: {
            candidate_id: 'bank_noref',
            method: 'AMOUNT_DATE_PROXIMITY',
            amount: 500,
            amount_agrees: true,
          },
          existing_ledger_match: null,
        },
        bank_candidates: [],
        ledger_candidates: [],
      }
    ).reason === 'EVIDENCE_NOT_IN_PAYLOAD:EXACT_REFERENCE_MATCH'
  );

  // The alias: both real runs had gpt-oss-120b echo the payload's own `method`
  // value back as a reason code. Translating it is safe precisely because the
  // translated code still has to clear the evidence requirement — the next two
  // asserts are that pair, and the second is the one that matters.
  const refPayload = {
    settlement: { entity_id: 'pay_ALIAS_1', order_id: 'order_XYZ' },
    deterministic_context: {
      existing_bank_match: null,
      existing_ledger_match: {
        candidate_id: 'ledger_ref',
        method: 'EXACT_ORDER_ID',
        amount: 114341,
        amount_agrees: true,
      },
    },
    bank_candidates: [],
    ledger_candidates: [],
  };
  const aliased = validateDecision(
    jsonOf({
      candidate_id: 'ledger_ref',
      decision: 'CONFIRM_MATCH',
      confidence: 0.85,
      reason_codes: ['EXACT_ORDER_ID', 'DATE_WITHIN_WINDOW'],
    }),
    refPayload
  );
  check(
    "a method name echoed back as a reason code is translated, not rejected ('EXACT_ORDER_ID')",
    aliased.accepted === true &&
      aliased.reasonCodes.includes('EXACT_REFERENCE_MATCH') &&
      aliased.warnings.includes('ALIASED_REASON_CODE:EXACT_ORDER_ID->EXACT_REFERENCE_MATCH')
  );
  check(
    'the alias cannot smuggle an unsupported claim through: no shared reference, still rejected',
    validateDecision(
      jsonOf({
        candidate_id: 'bank_noref',
        decision: 'CONFIRM_MATCH',
        confidence: 0.9,
        reason_codes: ['EXACT_UTR'],
      }),
      {
        settlement: { entity_id: 'pay_ALIAS_2', settlement_utr: null, order_id: null, order_receipt: null },
        deterministic_context: {
          existing_bank_match: {
            candidate_id: 'bank_noref',
            method: 'AMOUNT_DATE_PROXIMITY',
            amount: 500,
            amount_agrees: true,
          },
          existing_ledger_match: null,
        },
        bank_candidates: [],
        ledger_candidates: [],
      }
    ).reason === 'EVIDENCE_NOT_IN_PAYLOAD:EXACT_REFERENCE_MATCH'
  );
  check(
    'a genuinely invented code is still rejected outright (the closed vocabulary still holds)',
    validateDecision(
      jsonOf({
        candidate_id: 'ledger_ref',
        decision: 'CONFIRM_MATCH',
        confidence: 0.9,
        reason_codes: ['LOOKS_ABOUT_RIGHT'],
      }),
      refPayload
    ).reason === 'REASON_CODE_NOT_ALLOWED:LOOKS_ABOUT_RIGHT'
  );

  check(
    'bulk-arithmetic reason code on a record with no utr_group is rejected as fabricated evidence',
    validateDecision(
      jsonOf({
        candidate_id: realCandidateId,
        decision: 'MATCH_CANDIDATE',
        confidence: 0.95,
        reason_codes: ['BULK_SETTLEMENT_ARITHMETIC_OK'],
      }),
      samplePayload
    ).reason === 'EVIDENCE_NOT_IN_PAYLOAD:BULK_SETTLEMENT_ARITHMETIC_OK'
  );

  check(
    'INDISTINGUISHABLE_CANDIDATES claimed where fewer than 2 candidates were offered is rejected',
    validateDecision(
      jsonOf({ candidate_id: null, decision: 'NO_MATCH_FOUND', confidence: 0.95, reason_codes: ['INDISTINGUISHABLE_CANDIDATES'] }),
      {
        deterministic_context: {},
        bank_candidates: [{ candidate_id: 'bank_only_one', amount: 1000, date: '2026-09-01', refs: {} }],
        ledger_candidates: [],
      }
    ).reason === 'EVIDENCE_NOT_IN_PAYLOAD:INDISTINGUISHABLE_CANDIDATES'
  );

  if (ambiguousId) {
    // Uses the ambiguous payload deliberately: it really does offer 2+
    // candidates, so the evidence requirement is satisfied and this isolates
    // the decision-binding rule rather than accidentally testing the other one.
    const ambiguousPayload = payloadFor(ambiguousId);
    check(
      'INDISTINGUISHABLE_CANDIDATES while naming a single winner is rejected as self-contradictory',
      validateDecision(
        jsonOf({
          candidate_id: ambiguousPayload.bank_candidates[0].candidate_id,
          decision: 'MATCH_CANDIDATE',
          confidence: 0.95,
          reason_codes: ['INDISTINGUISHABLE_CANDIDATES'],
        }),
        ambiguousPayload
      ).reason === 'REASON_CODE_CONTRADICTS_DECISION:INDISTINGUISHABLE_CANDIDATES'
    );
    check(
      'INDISTINGUISHABLE_CANDIDATES with NO_MATCH_FOUND and 2+ offered candidates is allowed',
      validateDecision(
        jsonOf({ candidate_id: null, decision: 'NO_MATCH_FOUND', confidence: 0.9, reason_codes: ['INDISTINGUISHABLE_CANDIDATES'] }),
        ambiguousPayload
      ).accepted === true
    );
  }

  if (bulkWinnerId) {
    const bulkPayload = payloadFor(bulkWinnerId);
    check(
      'bulk-arithmetic reason code IS allowed on a record that actually has a utr_group',
      validateDecision(
        jsonOf({
          candidate_id: bulkPayload.deterministic_context.utr_group.bankCreditExternalId,
          decision: 'CONFIRM_MATCH',
          confidence: 0.93,
          reason_codes: ['BULK_SETTLEMENT_ARITHMETIC_OK'],
        }),
        bulkPayload
      ).accepted === true
    );
  }

  // -------------------------------------------------------------------------
  // D. resolveExceptions end-to-end with a fake, payload-driven llmCaller
  // -------------------------------------------------------------------------
  console.log('\n--- D. resolveExceptions orchestration (fake llmCaller) ---');

  let fakeCallCount = 0;
  async function fakeLlmCaller({ userPrompt }) {
    fakeCallCount += 1;
    const payload = JSON.parse(userPrompt);
    const dc = payload.deterministic_context;

    if (dc.utr_group) {
      return {
        raw: jsonOf({
          candidate_id: dc.utr_group.bankCreditExternalId,
          decision: dc.utr_group.combinedNetMatchesCredit ? 'CONFIRM_MATCH' : 'REJECT_MATCH',
          confidence: 0.93,
          reason_codes: [dc.utr_group.combinedNetMatchesCredit ? 'BULK_SETTLEMENT_ARITHMETIC_OK' : 'BULK_SETTLEMENT_ARITHMETIC_MISMATCH'],
        }),
        provider: 'groq',
      };
    }

    if (dc.existing_bank_match && !dc.existing_ledger_match && payload.ledger_candidates.length === 0) {
      return {
        raw: jsonOf({
          candidate_id: dc.existing_bank_match.candidate_id,
          decision: 'CONFIRM_MATCH',
          confidence: 0.81,
          reason_codes: ['SMART_COLLECT_IDENTIFIER', 'NARRATION_VENDOR_MATCH'],
        }),
        provider: 'groq',
      };
    }

    if (payload.bank_candidates.length >= 2 || payload.ledger_candidates.length >= 2) {
      return {
        raw: jsonOf({ candidate_id: null, decision: 'NO_MATCH_FOUND', confidence: 0.55, reason_codes: ['INDISTINGUISHABLE_CANDIDATES'] }),
        provider: 'groq',
      };
    }

    if (payload.bank_candidates.length >= 1 && !dc.existing_bank_match) {
      return {
        raw: jsonOf({
          candidate_id: payload.bank_candidates[0].candidate_id,
          decision: 'MATCH_CANDIDATE',
          confidence: 0.72,
          reason_codes: ['AMOUNT_WITHIN_WATERFALL_DRIFT', 'DATE_WITHIN_WINDOW'],
        }),
        provider: 'groq',
      };
    }
    if (payload.ledger_candidates.length >= 1 && !dc.existing_ledger_match) {
      return {
        raw: jsonOf({
          candidate_id: payload.ledger_candidates[0].candidate_id,
          decision: 'MATCH_CANDIDATE',
          confidence: 0.72,
          reason_codes: ['AMOUNT_WITHIN_WATERFALL_DRIFT', 'DATE_WITHIN_WINDOW'],
        }),
        provider: 'groq',
      };
    }

    return {
      raw: jsonOf({ candidate_id: 'bank_unexpected_shape', decision: 'MATCH_CANDIDATE', confidence: 0.99, reason_codes: ['EXACT_AMOUNT'] }),
      provider: 'groq',
    };
  }

  const { resolutions, summary } = await resolveExceptions({
    results,
    unclaimedBankRecords,
    unclaimedLedgerRecords,
    maxCandidatesPerException: config.llm.maxCandidatesPerException,
    llmCaller: fakeLlmCaller,
  });

  console.log('  resolveExceptions summary:', summary);

  check(
    'every needsReview record produced exactly one resolution',
    resolutions.length === results.filter((r) => r.needsReview).length
  );
  check(
    'llmCallsAvoided + llmCallsMade === total needing review',
    summary.llmCallsAvoided + summary.llmCallsMade === summary.totalNeedingReview
  );
  check('llmCallsMade matches the number of times the fake caller actually ran', summary.llmCallsMade === fakeCallCount);
  check('at least one exception was ACCEPTED', summary.accepted > 0);
  check('at least one exception was FLAGGED_LOW_CONFIDENCE (the ambiguous pair)', summary.flaggedLowConfidence > 0);

  const byOutcome = new Map(resolutions.map((r) => [r.entityId, r]));
  if (bulkWinnerId) {
    const o = byOutcome.get(bulkWinnerId);
    check('BULK_SETTLEMENT winner resolved as ACCEPTED/CONFIRM_MATCH', o?.outcome === 'ACCEPTED' && o?.decision === 'CONFIRM_MATCH');
  }
  if (bulkSiblingId) {
    const o = byOutcome.get(bulkSiblingId);
    check('BULK_SETTLEMENT sibling resolved as ACCEPTED/CONFIRM_MATCH', o?.outcome === 'ACCEPTED' && o?.decision === 'CONFIRM_MATCH');
  }
  if (blindId) {
    const o = byOutcome.get(blindId);
    check('BLIND_PAYMENT resolved as ACCEPTED/CONFIRM_MATCH', o?.outcome === 'ACCEPTED' && o?.decision === 'CONFIRM_MATCH');
  }
  if (mismatchId) {
    const o = byOutcome.get(mismatchId);
    check('AMOUNT_MISMATCH resolved as ACCEPTED/MATCH_CANDIDATE', o?.outcome === 'ACCEPTED' && o?.decision === 'MATCH_CANDIDATE');
  }
  if (ambiguousId) {
    const o = byOutcome.get(ambiguousId);
    check(
      'AMBIGUOUS resolved as FLAGGED_LOW_CONFIDENCE, not silently accepted (correctly refused to guess)',
      o?.outcome === 'FLAGGED_LOW_CONFIDENCE' && o?.decision === 'NO_MATCH_FOUND'
    );
  }
  check(
    'no ORPHAN entity ever reached the (fake) LLM (all correctly SKIPPED_NO_CANDIDATES)',
    orphanIds.every((id) => byOutcome.get(id)?.outcome === 'SKIPPED_NO_CANDIDATES' && byOutcome.get(id)?.llmCalled === false)
  );

  // -------------------------------------------------------------------------
  // E. Real llmClient.callLlmWithFallback with global.fetch mocked — proves
  // the actual Groq->OpenRouter fallback code executes, not just that the
  // orchestrator intended to call it.
  // -------------------------------------------------------------------------
  console.log('\n--- E. real llmClient fallback path (mocked fetch, no network) ---');

  const originalFetch = global.fetch;
  const goodContent = jsonOf({ candidate_id: null, decision: 'NO_MATCH_FOUND', confidence: 0.9, reason_codes: ['INSUFFICIENT_EVIDENCE'] });
  // Expectations are derived from config, not hardcoded, so these checks keep
  // testing the real behaviour if the knobs are retuned in .env.
  const ATTEMPTS = config.llm.maxAttemptsPerProvider;
  const THRESHOLD = config.llm.primaryFailureThreshold;

  function fakeResponse({ ok, status = 200, statusText = 'OK', content, finishReason }) {
    return {
      ok,
      status,
      statusText,
      text: async () => (ok ? '' : 'provider error body'),
      json: async () => ({ choices: [{ message: { content }, finish_reason: finishReason }] }),
    };
  }

  async function withMockedFetch(handler, fn) {
    global.fetch = handler;
    try {
      return await fn();
    } finally {
      global.fetch = originalFetch;
    }
  }

  // E1 — primary (Groq) succeeds outright: exactly one call, provider 'groq'.
  {
    const calls = [];
    const result = await withMockedFetch(
      async (url) => {
        calls.push(url);
        return fakeResponse({ ok: true, content: goodContent });
      },
      () => llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user' })
    );
    check('primary success: exactly one fetch call made (no gratuitous retry)', calls.length === 1);
    check('primary success: called the Groq URL', calls[0] === config.llm.primary.apiUrl);
    check('primary success: reported provider is groq', result.provider === 'groq');
  }

  // E2 — primary fails with a TRANSIENT error (HTTP 500): retried against the
  // same provider up to maxAttemptsPerProvider, then failed over. This is the
  // actual ADR-003 code path.
  {
    const calls = [];
    const result = await withMockedFetch(
      async (url) => {
        calls.push(url);
        if (url === config.llm.primary.apiUrl) {
          return fakeResponse({ ok: false, status: 500, statusText: 'Internal Server Error' });
        }
        return fakeResponse({ ok: true, content: goodContent });
      },
      () => llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user' })
    );
    const primaryCalls = calls.filter((u) => u === config.llm.primary.apiUrl).length;
    check(
      `transient 500: primary retried ${ATTEMPTS}x then failed over (${calls.length} calls total)`,
      primaryCalls === ATTEMPTS && calls.length === ATTEMPTS + 1
    );
    check('transient 500: the last call was OpenRouter', calls[calls.length - 1] === config.llm.fallback.apiUrl);
    check('transient 500: reported provider is openrouter', result.provider === 'openrouter');
  }

  // E3 — both providers fail: throws, does not silently return anything.
  {
    let threw = false;
    const calls = [];
    await withMockedFetch(
      async (url) => {
        calls.push(url);
        return fakeResponse({ ok: false, status: 503, statusText: 'Service Unavailable' });
      },
      async () => {
        try {
          await llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user' });
        } catch (err) {
          threw = err instanceof llmClient.LlmProviderError;
        }
      }
    );
    check('both providers failing throws an LlmProviderError (never a silent success)', threw);
    check(
      `both failing: each provider was attempted ${ATTEMPTS}x, no more`,
      calls.length === ATTEMPTS * 2
    );
  }

  // E4 — primary fails with a DETERMINISTIC error (HTTP 400): must NOT be
  // retried. A malformed request fails identically the second time; retrying it
  // just burns quota and delays the fallback. This is the exact status Groq
  // returned when the reasoning chain exhausted max_tokens.
  {
    const calls = [];
    const result = await withMockedFetch(
      async (url) => {
        calls.push(url);
        if (url === config.llm.primary.apiUrl) {
          return fakeResponse({ ok: false, status: 400, statusText: 'Bad Request' });
        }
        return fakeResponse({ ok: true, content: goodContent });
      },
      () => llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user' })
    );
    check(
      'deterministic 400: primary called exactly once, then failed over immediately',
      calls.filter((u) => u === config.llm.primary.apiUrl).length === 1 && calls.length === 2
    );
    check('deterministic 400: reported provider is openrouter', result.provider === 'openrouter');
  }

  // E5 — a 200 response with empty content (a reasoning model that spent the
  // whole token budget thinking, finish_reason 'length') is treated as a
  // failure and failed over, not returned as an empty answer.
  {
    const calls = [];
    const result = await withMockedFetch(
      async (url) => {
        calls.push(url);
        if (url === config.llm.primary.apiUrl) {
          return fakeResponse({ ok: true, content: '', finishReason: 'length' });
        }
        return fakeResponse({ ok: true, content: goodContent });
      },
      () => llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user' })
    );
    check(
      'empty content on a 200 is a failure, not an answer: failed over to the fallback',
      result.provider === 'openrouter' && calls[calls.length - 1] === config.llm.fallback.apiUrl
    );
  }

  // E6 — circuit breaker: with a hard-down primary and one breaker shared
  // across a batch, the primary stops being called at all after
  // primaryFailureThreshold consecutive failures. Without this, every record
  // in a 50-record batch pays for a doomed primary round-trip first.
  {
    const calls = [];
    const breaker = llmClient.createBreaker();
    const invocations = THRESHOLD + 2;
    await withMockedFetch(
      async (url) => {
        calls.push(url);
        if (url === config.llm.primary.apiUrl) {
          return fakeResponse({ ok: false, status: 500, statusText: 'Internal Server Error' });
        }
        return fakeResponse({ ok: true, content: goodContent });
      },
      async () => {
        for (let i = 0; i < invocations; i += 1) {
          await llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user', breaker });
        }
      }
    );
    const primaryCalls = calls.filter((u) => u === config.llm.primary.apiUrl).length;
    const fallbackCalls = calls.filter((u) => u === config.llm.fallback.apiUrl).length;
    check(
      `breaker: primary tried only for the first ${THRESHOLD} records (${primaryCalls} calls, not ${invocations * ATTEMPTS})`,
      primaryCalls === THRESHOLD * ATTEMPTS
    );
    check('breaker: every record still got an answer from the fallback', fallbackCalls === invocations);
    check('breaker: reports itself open after the threshold', breaker.open === true);
  }

  // E7 — the breaker resets on success, so one transient blip early in a batch
  // does not permanently sideline a healthy primary.
  {
    const breaker = llmClient.createBreaker();
    await withMockedFetch(
      async (url) => {
        if (url === config.llm.primary.apiUrl) {
          return fakeResponse({ ok: false, status: 500, statusText: 'Internal Server Error' });
        }
        return fakeResponse({ ok: true, content: goodContent });
      },
      () => llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user', breaker })
    );
    const failuresAfterBlip = breaker.consecutiveFailures;
    await withMockedFetch(
      async () => fakeResponse({ ok: true, content: goodContent }),
      () => llmClient.callLlmWithFallback({ systemPrompt: 'sys', userPrompt: 'user', breaker })
    );
    check(
      'breaker: a later success clears the failure count (no permanent sidelining)',
      failuresAfterBlip === 1 && breaker.consecutiveFailures === 0 && breaker.open === false
    );
  }

  // -------------------------------------------------------------------------
  // F. Evaluation layer — scores both layers against ground truth the matcher
  // and the LLM layer never read. Operational counts can be perfect while the
  // answers are wrong; this is the section that would catch that.
  // -------------------------------------------------------------------------
  console.log('\n--- F. evaluation layer vs ground truth ---');

  const evaluation = evaluateRun({ results, groundTruth, resolutions });
  const { deterministic: det, ai: aiEval, pipeline } = evaluation;

  check(
    'every generated record was scored (no records silently skipped by the scorer)',
    det.recordsScored === results.length && results.length === Object.keys(groundTruth.records).length
  );
  check(
    'ZERO silent misses: no record ground truth says needs review was reported clean',
    det.silentMisses === 0,
    jsonOf(det.silentMissDetails.slice(0, 5))
  );
  check(
    'ZERO silent wrong claims: no wrong match was reported clean',
    det.silentWrongClaims === 0,
    jsonOf(det.wrongClaimDetails.filter((w) => !w.escalated).slice(0, 5))
  );
  check('deterministic escalation recall is 100%', det.recall === 1, `recall=${det.recall}`);
  check(
    'deterministic claim precision is 100% (every match it committed to was real)',
    det.precision === 1,
    `precision=${det.precision}, wrong=${jsonOf(det.wrongClaimDetails.slice(0, 5))}`
  );
  check(
    'over-escalation is measured and reported, not hidden',
    typeof det.overEscalated === 'number' && det.overEscalationRate !== null
  );
  check(
    'the ORPHANs are exactly what got over-escalated (the known, accepted cost)',
    det.overEscalated === orphanIds.length,
    `overEscalated=${det.overEscalated}, orphans=${orphanIds.length}`
  );

  check('AI layer produced at least one accepted decision to score', aiEval.acceptedDecisions > 0);
  check(
    'AI match precision is computed from real ids, not asserted (fake caller: expect 100%)',
    aiEval.matchPrecision === 1,
    `matchPrecision=${aiEval.matchPrecision}, falsePositives=${jsonOf(aiEval.falsePositiveDetails.slice(0, 5))}`
  );
  check('AI false positives are zero under the fake caller', aiEval.falsePositives === 0);
  check(
    'the ambiguous pairs show up as declines, not as matches',
    aiEval.declineDecisions + aiEval.flaggedLowConfidence > 0
  );
  check(
    'every flagged decision lands in exactly one bucket (none silently dropped)',
    aiEval.flaggedWouldHaveBeenCorrect + aiEval.flaggedWouldHaveBeenWrong + aiEval.flaggedDeclines ===
      aiEval.flaggedLowConfidence
  );
  check(
    'every resolution is accounted for by the scorer',
    aiEval.acceptedDecisions +
      aiEval.flaggedLowConfidence +
      aiEval.rejectedByValidator +
      aiEval.llmErrors +
      aiEval.skippedNoCandidates ===
      resolutions.length
  );
  check(
    'pipeline coverage accounting adds up (rules + AI + human == every record)',
    pipeline.resolvedByRules + pipeline.escalated === pipeline.totalRecords &&
      pipeline.resolvedByAi + pipeline.leftForHuman === pipeline.escalated
  );
  check(
    'LLM call accounting matches the orchestrator',
    pipeline.llmCallsMade === summary.llmCallsMade && pipeline.llmCallsAvoided === summary.llmCallsAvoided
  );

  // A deliberately wrong decision must move the number. Without this, a
  // precision metric that is hardcoded to 1 would pass every check above.
  {
    const victim = resolutions.find((r) => r.outcome === 'ACCEPTED' && r.candidateId);
    if (victim) {
      const poisoned = resolutions.map((r) =>
        r === victim ? { ...r, candidateId: 'bank_fabricated_for_the_test' } : r
      );
      const poisonedEval = evaluateRun({ results, groundTruth, resolutions: poisoned });
      check(
        'injecting one wrong candidate_id drops AI precision below 100% (the metric is real)',
        poisonedEval.ai.matchPrecision !== null &&
          poisonedEval.ai.matchPrecision < 1 &&
          poisonedEval.ai.falsePositives === 1
      );
    }
  }

  console.log('');
  console.log(formatEvaluation(evaluation));

  // ---------------------------------------------------------------------------
  console.log('\n--- Day 3 summary ---');
  console.log(`  needing review     : ${summary.totalNeedingReview}`);
  console.log(`  LLM calls avoided  : ${summary.llmCallsAvoided}`);
  console.log(`  LLM calls made     : ${summary.llmCallsMade}`);
  console.log(`  accepted           : ${summary.accepted}`);
  console.log(`  flagged (low conf) : ${summary.flaggedLowConfidence}`);
  console.log(`  rejected by gate   : ${summary.rejectedByValidator}`);
  console.log(`  errors             : ${summary.llmErrors}`);

  if (failures > 0) {
    console.log(`\n${failures} CHECK(S) FAILED`);
    process.exitCode = 1;
  } else {
    console.log('\nALL CHECKS PASSED');
  }
}

main().catch((err) => {
  console.error('\n[verifyLlmLayer] fatal error:', err);
  process.exitCode = 1;
});
