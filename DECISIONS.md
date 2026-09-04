# Architecture Decision Records

Settlement Reconciliation Copilot — Razorpay AI Builder Internship 2026, Track 4.

Four decisions shaped this build. Each one is written up the same way: what was decided, what forced
it, what it costs, and where in the code it actually lives. The consequences sections are not
speculative — every number in them was measured on the 120-record synthetic batch (seed 42) or on live
provider traffic, and the [README build log](README.md#build-log--real-bugs-found-and-fixed) has the
failures behind them.

---

## ADR-001 — Deterministic rules decide; the LLM only proposes

**Status:** accepted, and it is the decision the other three serve.

### Decision

The deterministic match engine resolves everything resolvable with certainty. An LLM is invoked only
for records the engine has already declared it cannot settle, and its output is a *proposal* that the
application layer validates and then accepts or discards. The LLM has no execution authority: nothing
it returns reaches a reconciliation result without passing
[src/llm/validateDecision.js](src/llm/validateDecision.js).

There is no LLM call anywhere in [src/matcher/matchEngine.js](src/matcher/matchEngine.js). That is
checkable in one `grep`, and it is meant to be.

### Context

This is finance. A reconciliation engine that occasionally invents a match is worse than one that
occasionally gives up, because a wrong match is silently absorbed into the books while an escalation
lands on a human's desk. Exact references, the net-settlement waterfall and T+1/T+2 timing lag are
*arithmetic and set membership* — a model adds nothing to them except cost, latency and a failure mode
that did not previously exist.

The corollary constraint, which shapes the matcher more than anything else: **the engine never reports
certainty it hasn't earned.** An exact-reference hit whose amount disagrees is a flagged match, not a
clean one.

### Consequences

- 73 of 120 records (60.8%) never reach a model at all. Holds at 58–61% across every seed and size
  tested (100–1000 records, 10 combinations).
- **Silent misses: 0. Silent wrong claims: 0.** These are the two numbers the whole argument rests on,
  scored against a ground-truth answer key the matcher never reads.
- Deterministic claim precision: 100% (182/182 claims on the 120-record batch).
- The engine over-escalates rather than guessing: 8 records (6.7%) are true orphans with nothing to
  find, and it escalates them anyway because it cannot prove they are orphans. That is the cost, and it
  is the right direction to pay it in.
- Ambiguity is a first-class outcome. Two bank lines that both fit on amount and date produce
  `UNRESOLVED` / `AMBIGUOUS_CANDIDATES`, never a coin flip.
- The escalation contract (`needsReview` + `signals[]`) had to be designed as a real interface rather
  than a boolean, because the exception layer needs to know *why* a record was escalated.

### Where it lives

[src/matcher/matchEngine.js](src/matcher/matchEngine.js) (no LLM, by construction) ·
[src/llm/buildCandidatePayload.js](src/llm/buildCandidatePayload.js) ·
[src/eval/evaluateRun.js](src/eval/evaluateRun.js) (scores the two layers separately, so a good AI
number can never paper over a bad deterministic one)

### What would change it

If a real merchant mix pushed the deterministic share to ~90%+ and the residual exceptions were all
genuinely inferential, the case for the LLM layer would rest entirely on that residue — worth
re-examining, but the ordering would not change. Reversing the ordering is not on the table: it is the
submission's central claim.

---

## ADR-002 — Constrained JSON with closed vocabularies, validated application-side

**Status:** accepted.

### Decision

The model answers with exactly four fields and nothing else:

```json
{ "candidate_id": string|null,
  "decision": "CONFIRM_MATCH|REJECT_MATCH|MATCH_CANDIDATE|NO_MATCH_FOUND",
  "confidence": 0..1,
  "reason_codes": [ ...closed set of 10 ] }
```

Every response is treated as untrusted text. The gate checks, in order: JSON parses (including out of
prose the reasoning models leak) → decision is in the closed set → confidence is a real number in
range → reason codes are in the closed set → **`candidate_id` is one this exact exception was actually
offered** → the codes are jointly coherent with each other, the decision and the payload → confidence
clears 0.7.

### Context

Provider-side structured output is not a guarantee. `response_format: {type:'json_object'}` is
*enforced* by Groq and *ignored* by OpenRouter for Nemotron — measured, not assumed. Anything that
depends on the provider honouring a schema is depending on a per-provider implementation detail. And a
free-text rationale cannot be audited, aggregated or regression-tested; a closed vocabulary can be
counted.

The hallucination check is the load-bearing one. `candidate_id` is compared against the exact id set
*that record's* payload contained, so an invented id is caught by set membership rather than by
trusting the model's claim that the id exists.

### Consequences

- Hallucinated candidate ids are caught deterministically, per record, with no model involvement in
  catching them.
- AI match precision: **100%** on all three live runs. Zero false positives — the model has never
  named a counterpart that wasn't the right one.
- The gate rejected 4 of 39 decisions on the 120-record run, all of them the same claim
  (`EVIDENCE_NOT_IN_PAYLOAD:BULK_SETTLEMENT_ARITHMETIC_OK`), which is also the evidence behind
  [open decision 2](README.md#open-decisions).
- Two boundaries the gate deliberately does *not* cross, both set by real output rather than by taste:
  it does not referee debatable judgment (that would make it a second, worse matcher), and it does not
  sink a sound decision over an untidy justification. A reason code the payload disproves is dropped
  and recorded as a warning, and the decision stands on what survives — `llm_raw_reason_codes` keeps
  the unedited original so the edit is auditable.
- Enforcing that split cost real coverage to get right. As a flat contradiction rule the gate threw
  away three *correct* answers; severity tiering (`OPPOSED_REASON_CODES` reject,
  `REDUNDANT_AMOUNT_CODES` drop-and-warn) took rejections 4 → 0 and accepted 4 → 8 on the same seed.
- A closed vocabulary can have holes, and the model will find them. It answered with the matcher's own
  `EXACT_ORDER_ID` because the allowed list had no way to say "a shared reference ties these two
  records together" — the single most common reason a match is trustworthy. The vocabulary was
  incomplete and the model was right; `EXACT_REFERENCE_MATCH` plus a bounded alias fixed it.

### Where it lives

[src/llm/prompt.js](src/llm/prompt.js) (the vocabularies, and the system prompt built *from* them so
the two cannot drift) · [src/llm/validateDecision.js](src/llm/validateDecision.js) (the gate) ·
[src/llm/buildCandidatePayload.js](src/llm/buildCandidatePayload.js) (bounds the offered id set)

### What would change it

Nothing about provider tooling. Even with a provider that enforced the schema perfectly, the gate would
stay: schema validity is not the same claim as *this candidate id was on the shortlist we sent*, and
only the second one prevents a hallucinated match.

---

## ADR-003 — Groq primary, OpenRouter fallback, over raw `fetch`

**Status:** accepted.

### Decision

Groq `openai/gpt-oss-120b` is the primary provider; OpenRouter `nvidia/nemotron-3-super-120b-a12b:free`
is the fallback. Both are called through plain `fetch` — no `groq-sdk`, no OpenAI client. The fallback
is a real executing code path, not a documented intention.

### Context

Both providers speak the OpenAI chat-completions shape, so one request builder serves both and failing
over is a URL and key swap rather than a second integration. Adding `groq-sdk` would have bought
nothing except a second request shape to keep in sync and a dependency to keep current. Node 18+ has
`fetch` globally.

The free tiers are the real constraint: Groq rate-limits at 8000 tokens/minute and OpenRouter's free
models at 20 requests/minute. A single-provider design does not survive a 120-record batch on either.

### Consequences

- Zero LLM errors on all three live runs, including one where Groq rate-limited repeatedly and the
  fallback absorbed it unprompted.
- Retry classification is a real distinction, not a blanket policy: `RETRYABLE_STATUS` (408, 429, 5xx,
  timeouts) retries the same provider; a deterministic 400/401/422 fails over immediately instead of
  burning two doomed round-trips. An HTTP 200 carrying empty `message.content` counts as a failure, not
  an answer, because that is exactly what a token-budget truncation looks like from outside.
- Retries honour the provider's own `retry-after` — parsed from OpenRouter's header *and* from Groq's
  message body, capped at 5s so an absurd wait fails over rather than stalling the batch. A blind fixed
  backoff retries inside the window the provider just asked it to sit out.
- The circuit breaker trips after 3 consecutive primary failures but **does not latch**: it re-probes
  after 15s. Latching is what broke the first 120-record run — three manufactured 429 failures retired
  Groq for the remaining ~25 records, pushed all of them onto OpenRouter's 20-req/min tier, and lost 4
  records to `LLM_ERROR` with nothing wrong at either provider. A rate limit and an outage look
  identical to a failure counter and need opposite handling. After the fix, on the same seed: 28
  honoured waits, breaker never tripped, `llmErrors` 4 → 0.
- The breaker is batch-scoped, not module-global, so two runs in one process never inherit each other's
  failure state.
- Because the network layer is one injectable function, the whole exception layer is testable with **no
  network access** two different ways: mock `global.fetch` and exercise the real failover code, or
  inject a fake caller and exercise pure orchestration. `npm test` does both.
- The cost of that testability is named rather than hidden: a mock returns a complete object regardless
  of the token budget, so the `max_tokens` bug — reasoning models billing chain-of-thought against
  `max_tokens`, leaving no budget for the answer — passed every offline check and was only ever visible
  on real traffic. `run-exception-layer` and `run-pipeline` exist as separate real-network scripts for
  exactly this class of bug.

### Where it lives

[src/llm/llmClient.js](src/llm/llmClient.js) · [src/config.js](src/config.js) (every knob is an env
var with a documented default: `maxTokens` 2500, `confidenceThreshold` 0.7,
`primaryFailureThreshold` 3, `primaryCooldownMs` 15000, `maxRetryAfterWaitMs` 5000) ·
[scripts/verifyLlmLayer.js](scripts/verifyLlmLayer.js) §E (proves the failover, retry, breaker and
`retry-after` paths execute)

### What would change it

A paid tier removes the rate-limit pressure that justifies the aggressiveness of the retry policy, but
not the fallback — single-provider dependency is the risk, and it is unrelated to quota.

---

## ADR-004 — One adapter over live API and captured fixtures, chosen by config

**Status:** accepted.

### Decision

The application calls `getSettlementRecon()` and never knows whether the response came from the
Razorpay API or from a captured JSON file. `SETTLEMENT_SOURCE_MODE` (`live` | `fixture`) decides, and
`fixture` is the default. The same split is applied to storage: an audit run records its
`ingest_mode`, and the demo-only ground-truth columns are nullable so a real run leaves them empty.

### Context

A reconciliation engine that can only be exercised against a live API is one that cannot be tested,
demoed offline, or reasoned about deterministically. Reviewers need to run `npm test` with no
credentials. Reproducibility needs byte-identical inputs. And the live path still has to be *proven*,
not stubbed out and hoped for.

### Consequences

- `npm test` runs five suites, 225 asserts, with **no network access and no API keys**. A flaky provider
  or a missing key cannot break the build.
- The live path is verified against real test-mode credentials: `npm run capture-fixture`
  authenticates, calls `settlements.reports({ year, month, day })`, paginates on `skip` and writes the
  response. The test account has no payment history, so the capture is a valid empty collection
  (`{"entity":"collection","count":0,"items":[]}`) — that proves the auth path, the endpoint and the
  response envelope, and does *not* prove the record shape. Stated as a limitation rather than
  smoothed over.
- Config fails loudly and early. `assertLiveModeIsConfigured()` and `assertLlmIsConfigured()` throw
  before a network call is attempted with empty keys, instead of during one.
- The synthetic corpus is the other half of the same idea: a seeded mulberry32 PRNG makes batches
  byte-reproducible, so `120 42` means the same 120 records to everyone, and a hidden ground-truth
  answer key scores what the matcher and the model produce without either of them ever reading it.
- Applied to the audit trail, the split is what keeps the demo instrumentation honest:
  `eval_case_type` / `eval_verdict` are populated from the answer key on a synthetic run and left null
  on a real one, and `getRunProgress()` returns `evalVerdicts: null` rather than `{}` so an unscored
  run is distinguishable from a scored run with nothing right yet.

### Where it lives

[src/razorpayAdapter.js](src/razorpayAdapter.js) (the whole ADR in one file) ·
[src/config.js](src/config.js) · [scripts/captureFixture.js](scripts/captureFixture.js) ·
[src/synthetic/generateSyntheticBatch.js](src/synthetic/generateSyntheticBatch.js) ·
[src/db/auditDb.js](src/db/auditDb.js)

### Correction this ADR absorbed

The original plan assumed `instance.settlements.settlementRecon({...})` on the Node SDK. That method is
**PHP-only**. The Node SDK reuses `instance.settlements.reports({ year, month, day })` for day-level
recon: pass a `day` and you get the recon line items, omit it and you get the settlement-batch summary.
Caught and fixed before anything depended on the wrong name — the adapter boundary is why it was a
one-file change.

---

## Decisions deliberately left open

Two, both documented with the evidence rather than resolved by assertion. See
[README § Open decisions](README.md#open-decisions).

1. **`settlement_utr` semantics on real data** — whether it is per-payout or per-record cannot be
   confirmed without a settled test payment. The matcher already handles both readings.
2. **Whether bulk settlements should reach the LLM at all** — `buildUtrGroups()` already proves them by
   arithmetic (9 for 9 on the current batch) and the payload hands the model that finished proof, so
   `BULK_SETTLEMENT_ARITHMETIC_OK` is the model agreeing with arithmetic it did not have to do.
   Resolving them deterministically would be strictly more correct and would cut the escalation rate;
   the cost is that what the LLM demonstrably handles shrinks to blind payments, ambiguous pairs and
   amount mismatches. The master doc treats bulk settlement as an LLM exception case, so it is left as
   one. This is a scope call, not a code one.
