// src/llm/resolveExceptions.js
//
// Day 3: the orchestrator. Ties selectExceptions -> prompt -> llmClient ->
// validateDecision together into one call, and produces both a per-record
// outcome list (audit-trail material for Day 4) and the summary numbers the
// master doc's evaluation layer (§4.6, src/eval/evaluateRun.js) scores against
// ground truth: llmCallsAvoided, accepted, flaggedLowConfidence,
// rejectedByValidator, llmErrors.
//
// `llmCaller` is injectable and defaults to the real network client
// (llmClient.callLlmWithFallback). This is what lets verifyLlmLayer.js either
// (a) mock global.fetch and use the REAL caller — exercising the actual
// Groq->OpenRouter fallback code — or (b) inject a fake caller for pure
// orchestration/validation tests, with no network access needed either way.

const { selectExceptions } = require('./selectExceptions');
const { buildMessages } = require('./prompt');
const { validateDecision, collectKnownCandidateIds } = require('./validateDecision');
const { callLlmWithFallback, createBreaker } = require('./llmClient');

/**
 * @param {object[]} results - matchThreeWay(...).results
 * @param {object[]} unclaimedBankRecords
 * @param {object[]} unclaimedLedgerRecords
 * @param {number} [maxCandidatesPerException]
 * @param {function} [llmCaller] - ({systemPrompt, userPrompt, breaker}) => Promise<{raw, provider}>
 */
async function resolveExceptions({
  results,
  unclaimedBankRecords,
  unclaimedLedgerRecords,
  maxCandidatesPerException,
  llmCaller = callLlmWithFallback,
}) {
  const { reviewable, skipped } = selectExceptions({
    results,
    unclaimedBankRecords,
    unclaimedLedgerRecords,
    maxCandidatesPerException,
  });

  // One breaker for this batch, so a hard-down primary is skipped after N
  // consecutive failures instead of costing a doomed round-trip per record.
  // Batch-scoped rather than module-global: two runs in one process must not
  // inherit each other's failure state.
  const breaker = createBreaker();

  const resolutions = [];

  for (const entry of skipped) {
    resolutions.push({
      entityId: entry.result.settlement.entityId,
      status: entry.result.status,
      outcome: 'SKIPPED_NO_CANDIDATES',
      llmCalled: false,
    });
  }

  for (const entry of reviewable) {
    const { result, payload } = entry;
    const { system, user } = buildMessages(payload);
    // Recorded per record because the evaluation layer needs to know what the
    // model was actually shown: "declined to match" only counts as a miss if a
    // true counterpart was on the shortlist it was given.
    const offeredCandidateIds = [...collectKnownCandidateIds(payload)];

    let response = null;
    let callError = null;
    try {
      response = await llmCaller({ systemPrompt: system, userPrompt: user, breaker });
    } catch (err) {
      callError = err && err.message ? err.message : String(err);
    }

    if (callError) {
      resolutions.push({
        entityId: result.settlement.entityId,
        status: result.status,
        outcome: 'LLM_ERROR',
        llmCalled: true,
        offeredCandidateIds,
        error: callError,
      });
      continue;
    }

    const validation = validateDecision(response.raw, payload);
    const outcome = validation.accepted
      ? 'ACCEPTED'
      : validation.downgraded
        ? 'FLAGGED_LOW_CONFIDENCE'
        : 'REJECTED_BY_VALIDATOR';

    resolutions.push({
      entityId: result.settlement.entityId,
      status: result.status,
      outcome,
      llmCalled: true,
      provider: response.provider,
      decision: validation.parsed ? validation.parsed.decision : null,
      candidateId: validation.parsed ? validation.parsed.candidate_id : null,
      confidence: validation.parsed ? validation.parsed.confidence : null,
      // Sanitized justification: the model's codes minus any the payload
      // disproves. `rawReasonCodes` keeps the unedited original so the Day 4
      // audit trail can show what the model actually said, not just what
      // survived the gate.
      reasonCodes: validation.reasonCodes
        ? validation.reasonCodes
        : validation.parsed
          ? validation.parsed.reason_codes
          : null,
      rawReasonCodes: validation.parsed ? validation.parsed.reason_codes : null,
      validationWarnings: validation.warnings || [],
      validationReason: validation.reason,
      offeredCandidateIds,
    });
  }

  const summary = {
    totalNeedingReview: reviewable.length + skipped.length,
    llmCallsAvoided: skipped.length,
    llmCallsMade: resolutions.filter((r) => r.llmCalled).length,
    accepted: resolutions.filter((r) => r.outcome === 'ACCEPTED').length,
    flaggedLowConfidence: resolutions.filter((r) => r.outcome === 'FLAGGED_LOW_CONFIDENCE').length,
    rejectedByValidator: resolutions.filter((r) => r.outcome === 'REJECTED_BY_VALIDATOR').length,
    llmErrors: resolutions.filter((r) => r.outcome === 'LLM_ERROR').length,
    // Decisions that were accepted only after the gate dropped a reason code the
    // payload disproved. Worth its own number: a rising count means the prompt
    // is drifting from the vocabulary, which is a warning sign that shows up
    // nowhere in the accept/reject split.
    sanitizedReasonCodes: resolutions.filter(
      (r) => r.validationWarnings && r.validationWarnings.length > 0
    ).length,
  };

  return { resolutions, summary };
}

module.exports = { resolveExceptions };
