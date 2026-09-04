// scripts/runExceptionLayer.js
//
// Day 3: the REAL run script — full pipeline (synthetic batch -> normalize ->
// deterministic match -> LLM exception layer -> evaluation) using actual
// Groq/OpenRouter network calls. Requires GROQ_API_KEY and/or
// OPENROUTER_API_KEY in .env.
//
// This is NOT what CI/local verification runs — that's verifyLlmLayer.js,
// which is network-free by design (mocks fetch) so a flaky provider or
// missing keys can never break the build. This script is the other half of
// that trade: verifyLlmLayer proves the code is correct, and only this proves
// the providers actually behave. The max_tokens truncation bug passed every
// offline check and was only ever visible here.
//
// Usage: node scripts/runExceptionLayer.js [size] [seed]

require('dotenv').config();
const { config, assertLlmIsConfigured } = require('../src/config');
const { normalizeSettlementRecon } = require('../src/normalizeSettlement');
const { matchThreeWay } = require('../src/matcher/matchEngine');
const { generateSyntheticBatch } = require('../src/synthetic/generateSyntheticBatch');
const { resolveExceptions } = require('../src/llm/resolveExceptions');
const { evaluateRun, formatEvaluation } = require('../src/eval/evaluateRun');

async function main() {
  try {
    assertLlmIsConfigured();
  } catch (err) {
    console.error(`[runExceptionLayer] ${err.message}`);
    console.error('Set GROQ_API_KEY and/or OPENROUTER_API_KEY in .env, then re-run.');
    process.exitCode = 1;
    return;
  }

  const size = parseInt(process.argv[2], 10) || 30;
  const seed = parseInt(process.argv[3], 10) || 42;

  console.log(`[runExceptionLayer] generating synthetic batch: size=${size}, seed=${seed}`);
  const { settlementRecon, bankStatement, ledger, groundTruth } = generateSyntheticBatch({
    size,
    seed,
  });

  const { records } = normalizeSettlementRecon(settlementRecon);
  const { summary: matchSummary, results, unclaimedBankRecords, unclaimedLedgerRecords } =
    matchThreeWay(records, bankStatement, ledger);

  console.log('\n[runExceptionLayer] deterministic match summary:');
  console.log(matchSummary);

  console.log(
    `\n[runExceptionLayer] calling LLM exception layer (real network) — ` +
      `primary=${config.llm.primary.model}, fallback=${config.llm.fallback.model}, ` +
      `max_tokens=${config.llm.maxTokens}`
  );
  const startedAt = Date.now();
  const { resolutions, summary } = await resolveExceptions({
    results,
    unclaimedBankRecords,
    unclaimedLedgerRecords,
    maxCandidatesPerException: config.llm.maxCandidatesPerException,
  });
  const elapsedMs = Date.now() - startedAt;

  console.log('\n[runExceptionLayer] LLM exception layer summary:');
  console.log(summary);

  const providerCounts = {};
  for (const r of resolutions) {
    if (r.provider) providerCounts[r.provider] = (providerCounts[r.provider] || 0) + 1;
  }
  console.log(
    `  answered by            : ${JSON.stringify(providerCounts)} in ${(elapsedMs / 1000).toFixed(1)}s` +
      (summary.llmCallsMade ? ` (${Math.round(elapsedMs / summary.llmCallsMade)}ms/call)` : '')
  );

  // The point of the whole exercise: real model output, scored against ground
  // truth the model never saw. Operational counts above can look perfect while
  // every answer is wrong.
  console.log('\n[runExceptionLayer] evaluation vs ground truth:\n');
  console.log(formatEvaluation(evaluateRun({ results, groundTruth, resolutions })));

  const failures = resolutions.filter(
    (r) => r.outcome === 'REJECTED_BY_VALIDATOR' || r.outcome === 'LLM_ERROR'
  );
  if (failures.length > 0) {
    console.log('\n[runExceptionLayer] rejected / errored records (what to look at first):');
    console.log(
      JSON.stringify(
        failures.map((r) => ({
          entityId: r.entityId,
          outcome: r.outcome,
          reason: r.validationReason || r.error,
          decision: r.decision,
          confidence: r.confidence,
          reasonCodes: r.reasonCodes,
        })),
        null,
        2
      )
    );
  }

  console.log('\n[runExceptionLayer] per-record resolutions:');
  console.log(JSON.stringify(resolutions, null, 2));
}

main().catch((err) => {
  console.error('[runExceptionLayer] fatal error:', err);
  process.exitCode = 1;
});
