// src/eval/evaluateRun.js
//
// Day 3: the evaluation layer (master doc §4.6). Scores what the pipeline
// actually did against the synthetic generator's ground truth — the answers it
// knew before it corrupted the observable fields, in a file the matcher and
// the LLM layer provably never read.
//
// Why this exists as its own module rather than more asserts in a verify
// script: "the wiring works" and "the wiring is right" are different claims.
// resolveExceptions.js already reports operational counts (calls made,
// accepted, flagged, rejected) and every one of them can be perfect while the
// answers are wrong. Precision needs a source of truth outside the system
// being measured.
//
// Three deliberate choices in how the numbers are computed, because each one
// could otherwise be used to flatter the system:
//
//   1. A wrong claim that was ESCALATED is not the same failure as a wrong
//      claim reported clean. Both are counted, and `silentWrongClaims` /
//      `silentMisses` are the two that actually matter — they are the only
//      way a real exception reaches a real ledger unflagged. They must be 0.
//
//   2. Over-escalation is reported, not hidden. Every ORPHAN has
//      needsAiReview:false and is escalated anyway, because no deterministic
//      rule can distinguish "no counterpart exists" from "I failed to find
//      it." That cost belongs in the metrics next to the benefit.
//
//   3. Declining to match when a true counterpart WAS on the shortlist is
//      counted as a missed opportunity, never as a false positive — and it
//      is kept out of the precision numerator AND denominator rather than
//      quietly scored as a win. On an AMBIGUOUS identical-amount pair,
//      declining is the designed correct behavior; on a bulk sibling it is a
//      real miss. Both are surfaced so the difference is visible.

// null, not 0, when there is nothing to divide: an empty denominator is
// "not measured", and printing it as 0% would read as a total failure.
function rate(numerator, denominator) {
  if (!denominator) return null;
  return Number((numerator / denominator).toFixed(4));
}

function trueIdsFor(gt) {
  return {
    bank: new Set(gt.trueBankExternalIds || []),
    ledger: new Set(gt.trueLedgerExternalIds || []),
    all: new Set([...(gt.trueBankExternalIds || []), ...(gt.trueLedgerExternalIds || [])]),
  };
}

/**
 * Scores the deterministic engine alone: every match it claimed, against the
 * counterparts that actually belong to that settlement.
 *
 * A "claim" is one side of one record where the engine committed to a specific
 * external record (`bankMatch.record` / `ledgerMatch.record`). An
 * AMBIGUOUS_PROXIMITY result — a match object whose `.record` is null — is
 * deliberately NOT a claim: refusing to pick between two tied candidates is
 * the engine working as designed, and counting it as a wrong claim would
 * punish exactly the behavior ADR-001 asks for.
 */
function evaluateDeterministic({ results, groundTruth }) {
  let claims = 0;
  let correctClaims = 0;
  let silentWrongClaims = 0;
  let silentMisses = 0;
  let correctlyEscalated = 0;
  let overEscalated = 0;
  let correctlyClean = 0;
  let scored = 0;

  const wrongClaimDetails = [];
  const silentMissDetails = [];

  for (const r of results) {
    const entityId = r.settlement.entityId;
    const gt = groundTruth.records[entityId];
    if (!gt) continue; // record not from this generator run; nothing to score against
    scored += 1;

    const truth = trueIdsFor(gt);
    const sides = [
      ['bank', r.bankMatch && r.bankMatch.record ? r.bankMatch.record.externalId : null, truth.bank],
      [
        'ledger',
        r.ledgerMatch && r.ledgerMatch.record ? r.ledgerMatch.record.externalId : null,
        truth.ledger,
      ],
    ];

    for (const [side, claimedId, trueSet] of sides) {
      if (!claimedId) continue;
      claims += 1;
      if (trueSet.has(claimedId)) {
        correctClaims += 1;
      } else {
        wrongClaimDetails.push({
          entityId,
          caseType: gt.caseType,
          side,
          claimedId,
          expected: [...trueSet],
          escalated: r.needsReview,
        });
        if (!r.needsReview) silentWrongClaims += 1;
      }
    }

    // Routing: did the engine escalate exactly the records a correct system
    // has to escalate? Scored against gt.needsAiReview, not against itself.
    if (gt.needsAiReview) {
      if (r.needsReview) correctlyEscalated += 1;
      else {
        silentMisses += 1;
        silentMissDetails.push({ entityId, caseType: gt.caseType, status: r.status });
      }
    } else if (r.needsReview) {
      overEscalated += 1;
    } else {
      correctlyClean += 1;
    }
  }

  const needingReview = correctlyEscalated + silentMisses;

  return {
    recordsScored: scored,
    claims,
    correctClaims,
    wrongClaims: claims - correctClaims,
    precision: rate(correctClaims, claims),
    // The two numbers the deterministic-first argument stands on. Anything
    // other than 0 here means a real exception was reported as clean.
    silentMisses,
    silentWrongClaims,
    recall: rate(correctlyEscalated, needingReview),
    correctlyEscalated,
    overEscalated,
    correctlyClean,
    overEscalationRate: rate(overEscalated, scored),
    wrongClaimDetails,
    silentMissDetails,
  };
}

/**
 * Judges one accepted LLM decision against ground truth.
 * Returns 'CORRECT' | 'WRONG' | 'MISSED' (declined while a true counterpart
 * was on the shortlist) | null (nothing to judge).
 *
 * The asymmetry is intentional. Naming the wrong record is a false positive:
 * it would post a bad match. Declining is never a false positive — at worst
 * it leaves work for a human, which is the failure mode this whole design
 * prefers.
 */
function judgeDecision(resolution, gt) {
  const truth = trueIdsFor(gt);

  switch (resolution.decision) {
    case 'MATCH_CANDIDATE':
    case 'CONFIRM_MATCH':
      return truth.all.has(resolution.candidateId) ? 'CORRECT' : 'WRONG';

    case 'REJECT_MATCH':
      // Rejecting a deterministic proposal is right precisely when that
      // proposal was NOT a true counterpart.
      return truth.all.has(resolution.candidateId) ? 'WRONG' : 'CORRECT';

    case 'NO_MATCH_FOUND': {
      const offered = new Set(resolution.offeredCandidateIds || []);
      const correctWasAvailable = [...truth.all].some((id) => offered.has(id));
      return correctWasAvailable ? 'MISSED' : 'CORRECT';
    }

    default:
      return null;
  }
}

/**
 * Scores the LLM exception layer over the resolutions resolveExceptions
 * produced. Accepted decisions are the ones that would actually be acted on,
 * so they carry the precision number; flagged and validator-rejected
 * decisions are scored separately to show what the two gates are buying.
 */
function evaluateAi({ resolutions, groundTruth }) {
  const named = { total: 0, correct: 0, wrong: 0 };
  const rejects = { total: 0, correct: 0, wrong: 0 };
  const declines = { total: 0, correct: 0, missed: 0 };

  const falsePositiveDetails = [];
  const missedOpportunityDetails = [];
  const validatorRejectionReasons = {};

  let flaggedTotal = 0;
  let flaggedWouldHaveBeenCorrect = 0;
  let flaggedWouldHaveBeenWrong = 0;
  let flaggedDeclines = 0;

  let llmErrors = 0;
  let skippedNoCandidates = 0;

  for (const res of resolutions) {
    const gt = groundTruth.records[res.entityId];

    if (res.outcome === 'SKIPPED_NO_CANDIDATES') {
      skippedNoCandidates += 1;
      continue;
    }
    if (res.outcome === 'LLM_ERROR') {
      llmErrors += 1;
      continue;
    }
    if (res.outcome === 'REJECTED_BY_VALIDATOR') {
      const key = res.validationReason || 'UNKNOWN';
      validatorRejectionReasons[key] = (validatorRejectionReasons[key] || 0) + 1;
      continue;
    }
    if (!gt) continue;

    const verdict = judgeDecision(res, gt);

    if (res.outcome === 'FLAGGED_LOW_CONFIDENCE') {
      // The threshold's own scorecard: how many wrong answers did 0.7 block,
      // and how many right ones did it cost? Both directions, both printed.
      // A flagged decline is neither — it is an honest "I don't know" that was
      // also low-confidence, so it is counted in its own bucket rather than
      // being silently dropped from the totals.
      flaggedTotal += 1;
      if (res.decision === 'NO_MATCH_FOUND') flaggedDeclines += 1;
      else if (verdict === 'CORRECT') flaggedWouldHaveBeenCorrect += 1;
      else if (verdict === 'WRONG') flaggedWouldHaveBeenWrong += 1;
      continue;
    }

    if (res.outcome !== 'ACCEPTED') continue;

    if (res.decision === 'MATCH_CANDIDATE' || res.decision === 'CONFIRM_MATCH') {
      named.total += 1;
      if (verdict === 'CORRECT') named.correct += 1;
      else {
        named.wrong += 1;
        falsePositiveDetails.push({
          entityId: res.entityId,
          caseType: gt.caseType,
          decision: res.decision,
          claimedId: res.candidateId,
          expected: [...trueIdsFor(gt).all],
          confidence: res.confidence,
          reasonCodes: res.reasonCodes,
        });
      }
    } else if (res.decision === 'REJECT_MATCH') {
      rejects.total += 1;
      if (verdict === 'CORRECT') rejects.correct += 1;
      else rejects.wrong += 1;
    } else if (res.decision === 'NO_MATCH_FOUND') {
      declines.total += 1;
      if (verdict === 'CORRECT') declines.correct += 1;
      else {
        declines.missed += 1;
        missedOpportunityDetails.push({
          entityId: res.entityId,
          caseType: gt.caseType,
          expected: [...trueIdsFor(gt).all],
          offered: res.offeredCandidateIds || [],
          confidence: res.confidence,
        });
      }
    }
  }

  const actedOn = named.total + rejects.total + declines.total;
  const correctlyActedOn = named.correct + rejects.correct + declines.correct;

  return {
    // The headline: when the AI names a specific counterpart and the validator
    // accepts it, how often is that the real counterpart?
    matchPrecision: rate(named.correct, named.total),
    falsePositives: named.wrong,
    falsePositiveRate: rate(named.wrong, named.total),
    namedDecisions: named.total,

    // Judging an existing deterministic proposal rather than picking one.
    rejectDecisions: rejects.total,
    rejectsCorrect: rejects.correct,

    // Declining. `missedOpportunities` is the honest cost of declining, kept
    // out of precision entirely — see the header note.
    declineDecisions: declines.total,
    declinesCorrect: declines.correct,
    missedOpportunities: declines.missed,

    decisionAccuracy: rate(correctlyActedOn, actedOn),
    acceptedDecisions: actedOn,

    flaggedLowConfidence: flaggedTotal,
    flaggedWouldHaveBeenCorrect,
    flaggedWouldHaveBeenWrong,
    flaggedDeclines,

    rejectedByValidator: Object.values(validatorRejectionReasons).reduce((a, b) => a + b, 0),
    validatorRejectionReasons,

    llmErrors,
    skippedNoCandidates,
    falsePositiveDetails,
    missedOpportunityDetails,
  };
}

/**
 * @param {object[]} results - matchThreeWay(...).results
 * @param {object} groundTruth - generateSyntheticBatch(...).groundTruth
 * @param {object[]} resolutions - resolveExceptions(...).resolutions
 * @returns {{deterministic: object, ai: object, pipeline: object}}
 */
function evaluateRun({ results, groundTruth, resolutions = [] }) {
  const deterministic = evaluateDeterministic({ results, groundTruth });
  const ai = evaluateAi({ resolutions, groundTruth });

  const totalRecords = results.length;
  const escalated = results.filter((r) => r.needsReview).length;
  const llmCallsMade = resolutions.filter((r) => r.llmCalled).length;
  const llmCallsAvoided = resolutions.length - llmCallsMade;

  // "Resolved" is deliberately strict: only a correctly named counterpart that
  // the validator accepted counts. A correct decline confirms the record is
  // genuinely unresolvable — useful, but it is not a resolution, and rolling
  // the two together would inflate coverage with records nobody matched.
  const resolvedByAi = ai.matchPrecision === null ? 0 : ai.namedDecisions - ai.falsePositives;
  const cleanFromRules = totalRecords - escalated;

  const pipeline = {
    totalRecords,
    resolvedByRules: cleanFromRules,
    escalated,
    llmCallsMade,
    llmCallsAvoided,
    llmCallAvoidanceRate: rate(llmCallsAvoided, resolutions.length),
    resolvedByAi,
    leftForHuman: escalated - resolvedByAi,
    endToEndCoverage: rate(cleanFromRules + resolvedByAi, totalRecords),
  };

  return { deterministic, ai, pipeline };
}

function pct(value) {
  return value === null || value === undefined ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/**
 * Human-readable block for the CLI. Kept next to the computation so a metric
 * can never be renamed in one place and printed stale in the other.
 */
function formatEvaluation({ deterministic: d, ai, pipeline: p }) {
  const lines = [
    'Deterministic layer (vs ground truth)',
    `  match claims made      : ${d.claims}`,
    `  claim precision        : ${pct(d.precision)} (${d.correctClaims}/${d.claims})`,
    `  silent misses          : ${d.silentMisses}   <- must be 0`,
    `  silent wrong claims    : ${d.silentWrongClaims}   <- must be 0`,
    `  escalation recall      : ${pct(d.recall)} (${d.correctlyEscalated}/${d.correctlyEscalated + d.silentMisses})`,
    `  over-escalated         : ${d.overEscalated} (${pct(d.overEscalationRate)} of all records)`,
    '',
    'AI exception layer (accepted decisions only)',
    `  named a counterpart    : ${ai.namedDecisions}`,
    `  match precision        : ${pct(ai.matchPrecision)}`,
    `  false positives        : ${ai.falsePositives} (${pct(ai.falsePositiveRate)})`,
    `  rejected a proposal    : ${ai.rejectDecisions} (${ai.rejectsCorrect} rightly)`,
    `  declined               : ${ai.declineDecisions} (${ai.declinesCorrect} rightly, ${ai.missedOpportunities} with a true match on the shortlist)`,
    `  decision accuracy      : ${pct(ai.decisionAccuracy)} over ${ai.acceptedDecisions} accepted`,
    '',
    'Gates',
    `  flagged (low conf)     : ${ai.flaggedLowConfidence} — blocked ${ai.flaggedWouldHaveBeenWrong} wrong, cost ${ai.flaggedWouldHaveBeenCorrect} right, ${ai.flaggedDeclines} were declines`,
    `  rejected by validator  : ${ai.rejectedByValidator} ${JSON.stringify(ai.validatorRejectionReasons)}`,
    `  LLM errors             : ${ai.llmErrors}`,
    '',
    'Pipeline',
    `  records                : ${p.totalRecords}`,
    `  resolved by rules      : ${p.resolvedByRules}`,
    `  escalated              : ${p.escalated}`,
    `  LLM calls made/avoided : ${p.llmCallsMade}/${p.llmCallsAvoided} (${pct(p.llmCallAvoidanceRate)} avoided)`,
    `  escalations cleared    : ${p.resolvedByAi} by AI`,
    `  left for a human       : ${p.leftForHuman}`,
    `  end-to-end coverage    : ${pct(p.endToEndCoverage)}`,
  ];
  return lines.join('\n');
}

module.exports = {
  evaluateRun,
  evaluateDeterministic,
  evaluateAi,
  judgeDecision,
  formatEvaluation,
  rate,
};


