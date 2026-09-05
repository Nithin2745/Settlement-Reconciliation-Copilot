# Architecture Decision Records

Settlement Reconciliation Copilot — Razorpay AI Builder Internship 2026, Track 4.

Five decisions shaped this build. Each one is written up the same way: what was decided, what forced
it, what it costs, and where in the code it actually lives. The consequences sections are not
speculative — every number in them was measured on the 120-record synthetic batch (seed 42) or on live
provider traffic, and the [README build log](README.md#build-log--real-bugs-found-and-fixed) has the
failures behind them.

---

## ADR-001 — Deterministic rules decide; the LLM only proposes

**Status:** accepted, and it is the decision the other four serve.

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
- It also decided a dependency: **no fuzzy-matching library**, which the original plan called for. A
  similarity score is a confident guess wearing a number, and it would have had to sit inside the
  matcher — the one place this ADR says guesses do not go. Exact-reference priority, single-candidate
  proximity, and explicit `AMBIGUOUS_PROXIMITY` refusal cover the same ground with no threshold to
  defend. Written up in [README § Deviations from the original architecture](README.md#deviations-from-the-original-architecture).

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

- `npm test` runs six suites and 359 assertions — 341 of them printed as `OK` lines, the adapter and
  matcher suites asserting through `node:assert` instead — with **no network access and no API keys**.
  A flaky provider or a missing key cannot break the build.
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

## ADR-005 — The dashboard is read-only by construction, not by omission

**Status:** accepted.

### Decision

The viewer over the audit trail is a `node:http` server in one file
([src/dashboard/server.js](src/dashboard/server.js)) serving one static page — no Express, no bundler,
no client framework, no new dependency in `package.json`. Two properties are enforced structurally
rather than by convention:

1. **Every verb that is not GET or HEAD is refused with `405` and an `Allow: GET, HEAD` header before
   any routing happens.** One branch at the top of the handler, above the router, so a write cannot
   reach a route at all.
2. **Static files are served from a three-entry allowlist keyed by exact pathname.** No
   request-controlled string is ever passed to `path.join`.

It polls `/api/runs/:id` while a run's status is `running` and stops when it is not.

### Context

The trail already had its read surface — `getRunProgress()`, `getAuditRows()`, `exportAuditCsv()`,
`exportAuditJson()` — built and covered by `verify-audit-db` before any of this existed. So the
dashboard is a *presentation* layer over tested functions, and the only genuinely new risk it
introduces is that it is the first thing in the project that listens on a socket.

Express would have been the reflex, and it would have been the only new dependency in a project that
otherwise has three. It buys routing and middleware for five GET routes and one regex. What it does
not buy is either property above: a write path exists in Express by default and is closed
route-by-route, which means it is closed by remembering to.

"Read-only" is the load-bearing claim for a *reconciliation* viewer specifically. A tool that can
alter an audit trail is not an audit trail. Making that a property of the handler's first branch means
it is one assert, not a review of every route — and `POST /api/does-not-exist` returning 405 rather
than 404 is the assert that proves the ordering, because a 404 there would mean routing ran first and
the refusal is per-route after all.

The traversal decision is the same shape. The usual defence is to resolve the path and then check that
it is still inside the public directory — correct, and dependent on getting the normalization right
against percent-encoding, backslashes on Windows, and Unicode. An allowlist has no normalization step
to get wrong: `/../../.env` is not a key in the map, so it 404s through the same line as `/nope.css`.

Polling rather than streaming, and only while the run is live: WAL mode in `auditDb.getDb` is what
makes a reader safe against the pipeline writing the same run, which is the *reason* a progress view
is real rather than an animation. But a finished run is immutable, so continuing to poll it would be
three queries a second for no new facts. SSE would have meant a write-side notification path into a
module that deliberately knows nothing about its readers.

### Consequences

- Zero new dependencies. `package.json` still lists `better-sqlite3`, `dotenv`, `razorpay`.
- 93 asserts in [scripts/verifyDashboard.js](scripts/verifyDashboard.js), the sixth suite in a
  `npm test` that now runs 359 assertions. All but one section drives the exported handler with a stub
  `req`/`res` and binds no port; section F binds `127.0.0.1:0` once and makes three real requests,
  because a router that is correct in isolation and never actually served is not a dashboard.
- `null` and `[]` survive the trip to the client. `parseJsonColumns` parses the four JSON columns but
  leaves `null` as `null`, so the `jsonOrNull` distinction the trail is careful about (see ADR-004)
  is not quietly flattened on the way out. Asserted per shape, in both directions.
- A malformed audit cell is shown rather than swallowed: a JSON parse failure leaves the raw text in
  place instead of substituting an empty array, because a reviewer should see it.
- Nothing from the database is written as HTML — every value goes through `textContent` or
  `createElement`. Bank narration is merchant-controlled text, and it renders on the same page as the
  trail.
- **There is no authentication, and this is the one place where the structural approach only
  mitigates.** Anyone who can reach the port reads the entire trail. The bind defaults to `127.0.0.1`
  and a non-loopback `DASHBOARD_HOST` prints a boxed `NO AUTHENTICATION` warning naming the host
  rather than binding quietly — `warnIfHostIsExposed` is asserted to fire, and `isLoopbackHost` has a
  twelve-case truth table, because a silent non-loopback bind is the failure mode worth a test. It is
  a local review tool; exposing it to a network needs a real identity layer in front of it.
- The dashboard is where the two conflicting "left for a human" figures surfaced, and the honest fix
  was presentational: the partition tiles derive from `byResolutionPath` alone so they sum to the
  record total exactly, and `pipeline.leftForHuman` / `endToEndCoverage` appear only in the labelled
  scorecard. Two numbers that disagree are two different questions; showing both without saying which
  is which is how a dashboard starts lying.
- The amount column and its per-side delta cue were added after this ADR was written, and they did not
  bend the read-only property: they are seven more columns on the trail, carried out through the same
  GET, with no new route and no new verb. See
  [§ What putting the money on screen changed](#what-putting-the-money-on-screen-changed--5-september-2026)
  for why the bank is compared to net and the ledger to gross.

### Where it lives

[src/dashboard/server.js](src/dashboard/server.js) (the 405-before-routing branch, the allowlist,
`parseJsonColumns`, `isLoopbackHost`, `warnIfHostIsExposed`) ·
[src/dashboard/public/](src/dashboard/public/) (one page, one stylesheet, one script) ·
[scripts/dashboard.js](scripts/dashboard.js) · [src/config.js](src/config.js) (`dashboard.port`,
`dashboard.host`, `dashboard.pollMs`) · [scripts/verifyDashboard.js](scripts/verifyDashboard.js)

### What would change it

Multi-user access. The moment more than one person needs this, the answer is not to bolt a password
onto a `node:http` handler — it is to put the read API behind whatever already authenticates the rest
of the environment, at which point Express or a real framework earns its place. Nothing about the
read-only property or the allowlist would change; both get stricter under multi-user access, not
looser.

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

---

## Scope freeze — 4 September 2026

The build is frozen here. Day 5 is a buffer for the demo recording and submission, not for code.

### What is in, and done

| Layer | State |
|---|---|
| Ingestion, normalization, waterfall validation | Shipped, `verify-adapter` |
| Deterministic 3-way match engine (ADR-001) | Shipped, `verify-matcher` |
| Seeded synthetic corpus + hidden ground-truth key | Shipped, `verify-synthetic` |
| LLM exception layer, acceptance gate, failover (ADR-002, ADR-003) | Shipped, `verify-llm-layer` |
| Evaluation against ground truth | Shipped, scored on 4 live runs |
| SQLite audit trail, per-record, keyed by `run_id` | Shipped, `verify-audit-db` |
| Read-only dashboard over the trail (ADR-005) | Shipped, `verify-dashboard` |
| ADRs + README | Shipped, this file |

`npm test` is 359 assertions across six suites (341 printed as `OK` lines), no network access, no API
keys. That is the gate, and it passes.

### What is deliberately out, and stays out

Named so that "it doesn't do X" is a decision on the record rather than something a reviewer has to
discover:

- **Any write path.** Nothing in this project mutates a reconciliation result after the fact — no
  manual match override, no "approve this suggestion" button, no resolution workflow. The dashboard
  serves GET and HEAD only, structurally (ADR-005). A human acting on an escalation does it outside
  this system, which is the correct boundary for a 5-day build that has no identity layer.
- **Authentication and authorization.** See ADR-005 and README § Known limitations. The dashboard is
  loopback-bound with a loud warning, not secured.
- **1:many matching.** Bulk settlements are *reported* with the arithmetic proof attached, not
  force-fitted into the 1:1 pool. This is open decision 2, and it stays open.
- **Settlement-cycle awareness.** Date windows are day-granularity constructor options (bank 3,
  ledger 30), not a model of weekly or monthly settlement schedules.
- **Linter, CI, containerization, deployment.** `npm test` is the gate.
- **A second matcher in the gate.** ADR-002's boundary: the acceptance gate checks structure,
  provenance and evidence, and does not referee debatable judgment.

### What may still change before submission

Documentation, the demo script and the recording. Plus one exception, stated so it is not a loophole:
**a defect found while rehearsing the demo gets fixed.** A bug that is visible on camera is a bug
either way, and a freeze that forces shipping a known-broken path is cargo cult. Anything fixed under
that exception has to come with an assert in the suite that would have caught it — which is the same
rule the rest of the build log follows.

### What the final verification pass changed — 5 September 2026

A file-by-file read of all 40 tracked files before recording the demo. It found **no functional
defect**, which is the headline. Three things did change, all under the rule above:

- **The three settlement-query knobs were still on `Number(x) || fallback`** — the one pattern
  [src/config.js](src/config.js) has a comment condemning, surviving in the three places where it does
  the most damage. `SETTLEMENT_MONTH=0` and a typo'd `SETTLEMENT_YEAR` are both falsy, so both silently
  became *today*: in live mode that reconciles the wrong day while every log line looks healthy. They
  go through `numberFromEnv` with ranges now. Covered by 8 new assertions in
  [scripts/verifyAdapter.js](scripts/verifyAdapter.js) — each of which passed silently before the fix,
  which is the test the rule is asking for.
- **A dead `weighted()` sampler in [src/synthetic/prng.js](src/synthetic/prng.js)** — never called,
  because the batch composes exact integer counts and shuffles them instead, and that is *why* the
  ground truth is reproducible rather than approximately right. Removed, with the reason it does not
  exist left as a comment. Proof it was dead: the regenerated corpus is byte-identical.
- **Two documentation claims that were wrong in this repo's own favour.** `npm test` was described as
  "318 asserts across six suites" — 318 is the count of printed `OK` lines and it comes from four of
  them, the adapter and matcher asserting through `node:assert` instead. The real figure at that point
  was 336 across six. Separately, the third deviation from the original plan — **no fuzzy-matching
  library** — had no line anywhere calling it deliberate, while the other two each had a paragraph.
  Both fixed; see
  [README § Deviations from the original architecture](README.md#deviations-from-the-original-architecture).

Nothing in the matcher, the gate, the trail or the dashboard was touched. `npm test` after the pass:
336 assertions, exit 0. The section below is what moved it to 359 later the same day.

### What putting the money on screen changed — 5 September 2026

Rehearsing the demo surfaced an omission: the dashboard could say a settlement's bank amount
*disagreed* and could not say **by how much**. The signals had always carried
`AMOUNT_DISAGREES_BANK` / `AMOUNT_DISAGREES_LEDGER`, so the fact was never lost — but a reconciliation
tool whose exception view omits the number under dispute sends the reviewer back to SQL, which is the
workflow this project exists to remove. That is a storage gap, not a rendering one: `audit_log` had 24
columns and not one of them was an amount.

The two kinds of change here are labelled rather than blended: the focus bug is a defect and falls
under the exception above, while the amount column is **new feature work admitted on the last day by an
explicit scope call**, not a bug fix wearing a bug's clothes. It is recorded that way rather than
justified backwards, and both were held to the same rule — nothing shipped without an assert that
would have caught its absence.

- **Seven columns, one additive migration.** `settlement_utr`, `gross_amount`, `fee`, `tax`,
  `net_amount`, `bank_amount`, `ledger_amount` take the table from 24 columns to 31, integer paise
  throughout, formatted to rupees only in the view. `CREATE TABLE IF NOT EXISTS` is a no-op against an
  existing table, so the schema addition needed an explicit `ADDED_COLUMNS` list and a `migrate()` that
  runs `ALTER TABLE ADD COLUMN` per missing column — otherwise the columns exist in
  [src/db/auditDb.js](src/db/auditDb.js) and not on disk, and the first insert fails. That break only
  ever shows up on an upgrade, never on a fresh clone, which is precisely the class a fresh-database
  test cannot see; hence a new section in the suite that builds a **pre-money 24-column database**,
  migrates it, and asserts the round trip both ways. The real `data/audit.db` was one: four prior runs,
  367 rows, migrated in place with every old row reading back `null`.
- **`?? null`, never `|| null`.** A zero amount is a fact — a waived fee, zero tax — and `||` would
  file it as "not recorded". The same care the trail already took over `jsonOrNull`'s `null` versus
  `[]` (ADR-004) applies to money, and both directions are asserted. An unmatched counterparty stores
  `null` and renders as an em dash, not as a zero nobody measured.
- **The delta cue has two baselines, and getting that wrong was the defect worth recording.** The first
  cut compared *both* counterparty amounts against `net_amount`. The matcher does not:
  `AMOUNT_FIELD_BY_SOURCE` in [src/matcher/matchEngine.js](src/matcher/matchEngine.js) is
  `{ bank: 'netAmount', ledger: 'grossAmount' }`, because a bank credits the net while a ledger records
  the gross order value raised before fees and tax. Comparing both to net would have painted a red
  delta on all 92 records that have a ledger match — 82 of them exactly fee + tax, the other 10 the
  synthetic corpus's deliberate waterfall mismatches — against the 3 real disagreements the fixed
  version finds, and the drawer would have labelled agreeing records as disagreements. Fixed by giving
  each side its own baseline and labelling the drawer rows `vs net` / `vs gross`, so any red in that
  column is a real money problem rather than arithmetic the reader has to undo. The covering assert is a
  biconditional: for every row, `AMOUNT_DISAGREES_BANK` is present **iff** `bank_amount !== net_amount`,
  and the ledger signal iff `ledger_amount !== gross_amount` — it pins the pairing rather than the
  numbers, so it fails if either side is ever compared to the wrong field again.
- **One real accessibility defect, found the same way.** `closeDrawer()` called `renderTable()`, which
  destroyed the button that had opened the drawer, so focus fell to `<body>` and the next Tab restarted
  from the top of the page. Rows carry a `data-row-id` now and focus is restored to the opening row's
  button by id; the Escape handler is guarded so it only closes when focus is inside the drawer or on
  `<body>`, which keeps Escape-while-typing in the search box from stealing the caret.
- **The gate moved with it.** [scripts/verifyAuditDb.js](scripts/verifyAuditDb.js) goes 61 → 84 checks,
  taking `npm test` to 359 assertions across the same six suites, exit 0. One stale assert was retired
  rather than bumped: the CSV width check had a hard-coded `24`, and `toCsv` derives its columns from
  `Object.keys(row)`, so the claim that matters is "the export covers what the table has" — it reads
  the width from `PRAGMA table_info` now, with the seven new columns also named explicitly, because a
  set comparison passes when the export and the table are wrong together.

The client remains the one layer with no executable coverage — there is no jsdom in this project and
`verify-dashboard` only reaches the front end for content type and file existence, so every claim above
about rendering, focus and search was verified in the browser instead. Named here rather than left for
a reviewer to notice.

### The two things a freeze here explicitly does not claim

1. **Real `settlement_utr` semantics are unconfirmed.** The live path authenticates, paginates and
   captures, but the test account has never settled a payment, so the capture is a valid empty
   collection. Every record-shape claim in this repo is measured on the synthetic corpus. This is
   open decision 1, and no amount of further code closes it.
2. **Decision accuracy over accepted decisions is 92.6%, not 100%.** Two of the hardest exceptions in
   the 120-record batch were answered wrong, both conservatively — one `REJECT_MATCH` on a real pair,
   one `NO_MATCH_FOUND` with the counterpart on the shortlist. Both leave work on a human's desk.
   Neither puts a wrong match in the books, which is the failure direction the whole design prefers,
   and AI match precision stays at 100% across every run.

