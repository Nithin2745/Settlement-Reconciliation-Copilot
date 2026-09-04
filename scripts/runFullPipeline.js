// scripts/runFullPipeline.js
//
// Day 4: the same pipeline as runExceptionLayer.js, with the SQLite audit trail
// wired in — this is what the dashboard reads from.
//   - a `runs` row is created before anything starts, so the dashboard can show
//     the run the moment it exists rather than only once it finishes
//   - every RULE_ONLY record is bulk-written right after matching (instant, so
//     there is no progress worth streaming)
//   - every escalated record is written the moment it resolves, through
//     resolveExceptions' onResolution hook — the live part, and the reason the
//     dashboard's progress is real rather than an animation
//   - eval_verdict / eval_case_type are populated from ground truth because this
//     is a synthetic run. On a real run they stay null (see src/db/auditDb.js).
//
// Usage: node scripts/runFullPipeline.js [size] [seed]

require('dotenv').config();
const { config, assertLlmIsConfigured } = require('../src/config');
const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay } = require('../src/matcher/matchEngine');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');
const { resolveExceptions } = require('../src/llm/resolveExceptions');
const {
  evaluateRun,
  formatEvaluation,
  judgeDecision,
  trueIdsFor,
} = require('../src/eval/evaluateRun');
const auditDb = require('../src/db/auditDb');

const PATH_BY_OUTCOME = {
  SKIPPED_NO_CANDIDATES: 'LLM_SKIPPED',
  ACCEPTED: 'LLM_ACCEPTED',
  FLAGGED_LOW_CONFIDENCE: 'LLM_FLAGGED',
  REJECTED_BY_VALIDATOR: 'LLM_REJECTED',
  LLM_ERROR: 'LLM_ERROR',
};

/**
 * Ground-truth verdict for a record the rules resolved on their own. Deliberately
 * built on the evaluation layer's own trueIdsFor(), so the audit trail and the
 * printed summary can never disagree about what "correct" means.
 */
function ruleOnlyVerdict(result, gt) {
  if (!gt) return null;
  const truth = trueIdsFor(gt);
  const claimed = [
    result.bankMatch && result.bankMatch.record ? result.bankMatch.record.externalId : null,
    result.ledgerMatch && result.ledgerMatch.record ? result.ledgerMatch.record.externalId : null,
  ].filter(Boolean);
  if (claimed.length === 0) return gt.needsAiReview ? 'MISSED' : 'CORRECT';
  return claimed.every((id) => truth.all.has(id)) ? 'CORRECT' : 'WRONG';
}

// The deterministic half of an audit row. Shared by both paths so a rule-only
// record and an escalated one describe the match the same way — an escalated
// record still has whatever the engine did find, and dropping that would make
// the trail unable to answer "what did the model actually start from?"
function auditRowFromResult(r, gt, extra) {
  return {
    entityId: r.settlement.entityId,
    entityType: r.settlement.type,
    status: r.status,
    confidenceTier: r.confidenceTier,
    bankMatchId: r.bankMatch && r.bankMatch.record ? r.bankMatch.record.externalId : null,
    // Method, not just id: for a finance reviewer the difference between
    // EXACT_UTR and AMOUNT_DATE_PROXIMITY is the difference between certain and
    // inferred, and confidence_tier alone does not say which side was fuzzy.
    bankMatchMethod: r.bankMethod,
    ledgerMatchId: r.ledgerMatch && r.ledgerMatch.record ? r.ledgerMatch.record.externalId : null,
    ledgerMatchMethod: r.ledgerMethod,
    signals: r.signals,
    unresolvedReason: r.unresolvedReason,
    evalCaseType: gt ? gt.caseType : null,
    ...extra,
  };
}

async function main() {
  try {
    assertLlmIsConfigured();
  } catch (err) {
    console.error(`[runFullPipeline] ${err.message}`);
    console.error('Set GROQ_API_KEY and/or OPENROUTER_API_KEY in .env, then re-run.');
    process.exitCode = 1;
    return;
  }

  const size = parseInt(process.argv[2], 10) || 30;
  const seed = parseInt(process.argv[3], 10) || 42;

  const runId = auditDb.createRun({
    ingestMode: config.mode,
    source: 'synthetic',
    batchSize: size,
    seed,
  });
  console.log(
    `[runFullPipeline] run ${runId} started — size=${size}, seed=${seed}, mode=${config.mode}`
  );

  try {
    const { settlementRecon, bankStatement, ledger, groundTruth } = generateSyntheticBatch({
      size,
      seed,
    });
    const { records } = normalizeSettlementRecon(settlementRecon);
    const { results, unclaimedBankRecords, unclaimedLedgerRecords } = matchThreeWay(
      records,
      bankStatement,
      ledger
    );

    const ruleRows = results
      .filter((r) => !r.needsReview)
      .map((r) => {
        const gt = groundTruth.records[r.settlement.entityId];
        return auditRowFromResult(r, gt, {
          resolutionPath: 'RULE_ONLY',
          evalVerdict: ruleOnlyVerdict(r, gt),
        });
      });
    auditDb.logResolutionsBulk(runId, ruleRows);
    console.log(`[runFullPipeline] wrote ${ruleRows.length} RULE_ONLY rows`);

    const byEntityId = new Map(results.map((r) => [r.settlement.entityId, r]));
    let escalatedWritten = 0;

    const { resolutions, summary } = await resolveExceptions({
      results,
      unclaimedBankRecords,
      unclaimedLedgerRecords,
      maxCandidatesPerException: config.llm.maxCandidatesPerException,
      onResolution: (res) => {
        const gt = groundTruth.records[res.entityId];
        auditDb.logResolution(runId, {
          ...auditRowFromResult(byEntityId.get(res.entityId), gt, {}),
          status: res.status,
          resolutionPath: PATH_BY_OUTCOME[res.outcome] || 'LLM_ERROR',
          llmProvider: res.provider,
          llmDecision: res.decision,
          llmCandidateId: res.candidateId,
          llmConfidence: res.confidence,
          llmReasonCodes: res.reasonCodes,
          llmRawReasonCodes: res.rawReasonCodes,
          validationReason: res.validationReason || res.error,
          validationWarnings: res.validationWarnings,
          // Only accepted decisions would actually be acted on, so only they
          // carry a verdict. A flagged or rejected row is the gate working, not
          // an outcome to score — scoring it would credit the model for answers
          // the pipeline threw away.
          evalVerdict: gt && res.outcome === 'ACCEPTED' ? judgeDecision(res, gt) : null,
        });
        escalatedWritten += 1;
        process.stdout.write(`\r[runFullPipeline] escalated rows written live: ${escalatedWritten}`);
      },
    });
    process.stdout.write('\n');

    console.log(`[runFullPipeline] exception layer: ${JSON.stringify(summary)}`);

    const evaluation = evaluateRun({ results, groundTruth, resolutions });
    console.log('\n' + formatEvaluation(evaluation) + '\n');

    auditDb.finishRun(runId, { status: 'complete', summary: evaluation });

    // Read the trail back out rather than reporting what we think we wrote: if
    // the writes and the summary ever disagree, the demo should show it here and
    // not in front of a panel.
    const progress = auditDb.getRunProgress(runId);
    console.log(
      `[runFullPipeline] run ${runId} complete — ${progress.total} audit rows in ${auditDb.DEFAULT_DB_PATH}`
    );
    console.log(`  by resolution path : ${JSON.stringify(progress.byResolutionPath)}`);
    console.log(`  ground-truth tally : ${JSON.stringify(progress.evalVerdicts)}`);
    if (progress.total !== results.length) {
      console.error(
        `  WARNING: ${results.length} records matched but ${progress.total} rows logged — the trail is incomplete.`
      );
      process.exitCode = 1;
    }
  } catch (err) {
    auditDb.finishRun(runId, { status: 'failed', error: err.message });
    throw err;
  } finally {
    // Checkpoints the WAL and releases the file so the dashboard (or a second
    // run) isn't left reading a half-flushed db.
    auditDb.closeDb();
  }
}

main().catch((err) => {
  console.error('[runFullPipeline] fatal error:', err);
  process.exitCode = 1;
});
