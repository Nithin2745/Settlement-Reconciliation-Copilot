# Settlement Reconciliation Copilot

*Razorpay AI Builder Internship 2026 — Track 4: AI Finance Controller*

Reconciles Razorpay settlement records against an independent bank statement and an internal
ledger. Deterministic rules resolve everything that can be resolved with certainty — exact
references, the net-settlement waterfall, T+1/T+2 timing lag. An LLM is called only for genuine
exceptions, and never gets execution authority: it proposes a structured resolution, the
application layer validates and decides.

The design constraint that shapes everything else: **the engine never reports certainty it hasn't
earned.** An exact-reference hit whose amount disagrees is a flagged match, not a clean one.

---

## Status — Days 1–4 complete, scope frozen

| Day | Scope | State |
|---|---|---|
| **Day 1** | Ingestion, normalization, waterfall validation, deterministic 3-way match engine | Complete |
| **Day 2** | Synthetic bank statement + ledger generators, ground-truth answer key, batch stress test | Complete |
| **Day 3** | LLM exception layer (Groq primary, OpenRouter fallback), constrained JSON, acceptance gate, evaluation metrics | Complete |
| **Day 4** | SQLite audit trail + live 120-record run, read-only dashboard over the trail, [DECISIONS.md](DECISIONS.md), [scope freeze](DECISIONS.md#scope-freeze--4-september-2026) | Complete |
| Day 5 | Demo recording and submission buffer. No coding | Pending |

The live Razorpay path is verified against real test-mode credentials: `npm run capture-fixture`
authenticates, calls `settlements.reports({ year, month, day })`, paginates and writes
`fixtures/settlement-recon-captured.json`. The test account has no payment history, so the captured
response is a valid empty collection (`{"entity":"collection","count":0,"items":[]}`) — it proves the
auth path, the endpoint and the response envelope, not the record shape. Everything else runs against
fixtures, which is the point of ADR-004.

### Measured on the 120-record synthetic batch (seed 42)

| Metric | Value |
|---|---|
| Resolved deterministically, no LLM needed | **73 / 120 (60.8%)** |
| Escalated to the exception layer | 47 / 120 (39.2%) |
| — genuine exceptions (ground truth agrees) | 39 |
| — true orphans (nothing to find, unavoidable) | 8 |
| **Silent misses** (needed review, reported clean) | **0** |
| Confidence tiers | HIGH 55 · MEDIUM 18 · LOW 47 |

Reproduce with `npm run verify-synthetic`. Holds across every seed and size tested
(100–1000 records, 10 combinations): deterministic resolution stays at 58–61%, silent misses stay
at 0.

### Measured end to end with the real LLM layer

Three live runs against the real providers. Every AI number below is scored against
`ground-truth.internal.json`, which neither the matcher nor the model ever reads. The 120-record run
is the headline one — `npm run run-pipeline 120 42`, which also writes the full audit trail; the two
smaller runs used `npm run run-exception-layer <size> <seed>`.

| Metric | **120 records, seed 42** | 60 records, seed 7 | 30 records, seed 42 |
|---|---|---|---|
| Deterministic claim precision | **100% (182/182)** | 100% (88/88) | 100% (44/44) |
| Silent misses / silent wrong claims | **0 / 0** | 0 / 0 | 0 / 0 |
| Escalation recall | **100% (39/39)** | 100% (22/22) | 100% (11/11) |
| LLM calls made / avoided | 39 / 8 | 22 / 4 | 11 / 2 |
| **AI match precision** | **100% (25 named)** | 100% (15 named) | 100% (8 named) |
| AI false positives | **0** | 0 | 0 |
| Decision accuracy over accepted | 92.6% | 93.8% | 100% |
| Rejected by the acceptance gate | 4 | 0 | 0 |
| LLM errors | **0** | 0 | 0 |
| **End-to-end coverage** | **81.7%** | 81.7% | 83.3% |

The number that matters most is the one that stays at 100% in every column: **the AI never named a
counterpart that wasn't the right one.** Where it fails, it fails conservatively — the two errors
behind 92.6% are one `REJECT_MATCH` on a pair that was genuinely a match and one `NO_MATCH_FOUND`
where a true counterpart *was* on the shortlist. Both are missed opportunities that leave work on a
human's desk. Neither puts a wrong match into the books, which is the failure direction this design
is built to prefer.

All 4 acceptance-gate rejections on the 120-record run were the same thing:
`EVIDENCE_NOT_IN_PAYLOAD:BULK_SETTLEMENT_ARITHMETIC_OK` — the model claiming a bulk-settlement
arithmetic proof the payload didn't support. That is the gate earning its place, and it is also the
evidence behind open decision 2 below.

Provider mix varies run to run because the free Groq tier rate-limits under load; the 120-record run
honoured 28 separate `retry-after` waits from Groq and still finished with zero LLM errors. That is
the fallback and the retry policy doing exactly what ADR-003 asks of them — unprompted, on real
traffic. See the build log: the first 120-record run is what exposed the rate-limit handling bug.

---

## How the reconciliation works

Three independent records describe the same money movement:

```
Razorpay settlement record  ←→  bank statement line  ←→  internal ledger entry
   (what the PSP says)          (what the bank says)      (what accounting says)
```

Bank lines and ledger entries are normalized to one `ExternalRecord` shape before reaching the
engine, so the matcher never knows or cares which system a record came from:

```js
{
  externalId: string,
  source: 'bank' | 'ledger',
  amount: number,                  // paise
  date: string,                    // ISO 8601
  refs: { utr, orderId, orderReceipt, narration }   // any may be null
}
```

Bank credits are compared against the settlement's **net** amount; ledger/invoice entries against
its **gross** amount. That distinction is a one-line table in the engine and the reason a bulk
settlement is detectable at all.

### Pass 1 — exact reference, across every record first

`settlement_utr` → `order_id` → `order_receipt`, in that priority order. Run for all records
before any proximity fallback, so a same-amount coincidence elsewhere can never steal a candidate
that another record needed for its exact match.

Deliberately **does not** check the amount. Whether two records describe the same event and whether
the money agrees are two different questions; conflating them silently swallows bulk settlements
instead of flagging them.

### Pass 2 — amount + date proximity

Only for records still unmatched on that side. Accepted only when **exactly one** unclaimed
candidate satisfies both amount equality and the date window (bank 3 days for T+1/T+2 lag, ledger
30 days since invoices can precede settlement). Two or more viable candidates is reported as
`AMBIGUOUS_PROXIMITY` and left unresolved — guessing wrong here is a financial error, not a UX
inconvenience.

### The hand-off contract: `needsReview` + `signals[]`

Every record the engine can't resolve with certainty is escalated carrying a machine-readable list
of *why*. This closed set is the Day 3 LLM layer's input vocabulary and the Day 4 audit trail's
column set, so nothing outside it can ever appear on a result.

| Signal | Meaning |
|---|---|
| `AMOUNT_DISAGREES_BANK` | Exact reference hit, but the credit isn't this record's net |
| `AMOUNT_DISAGREES_LEDGER` | Exact reference hit, but the invoice isn't this record's gross |
| `AMBIGUOUS_BANK_CANDIDATES` | 2+ bank lines fit on amount + date; refused to guess |
| `AMBIGUOUS_LEDGER_CANDIDATES` | 2+ ledger entries fit on amount + date; refused to guess |
| `SHARED_UTR_GROUP` | This UTR covers 2+ settlement records (bulk settlement) |
| `WATERFALL_MISMATCH` | The record's own amount/fee/tax/net don't reconcile |
| `PROXIMITY_ONLY_NO_REFERENCE` | Matched on amount + date with zero reference corroboration |
| `NO_BANK_CANDIDATE` | No bank line claimed |
| `NO_LEDGER_CANDIDATE` | No ledger entry claimed |

`NO_*_CANDIDATE` is non-degrading: a legitimately one-sided record (a refund isn't separately
invoiced) is already described by its status, and double-counting it would drag every such record
to LOW.

`PROXIMITY_ONLY_NO_REFERENCE` is the rule that makes the escalation rate meaningful. A proximity
match is trustworthy when the *other* source corroborates it with a real reference — the T+1/T+2
lag case, where the bank narration dropped the UTR but the ledger still carries the order id. With
no exact reference anywhere, the only thing tying the records together is a coincidence of value
and timing, which is precisely a blind payment. On the synthetic batch this keeps all 18 timing-lag
records out of the LLM queue while catching all 14 blind payments.

Confidence is **derived from the signals**, never hand-assigned per branch, so "why is this HIGH?"
always has a checkable answer:

- `LOW` — unresolved, or any degrading signal present. Always escalated.
- `HIGH` — fully matched with an exact reference on *both* sides and nothing degrading.
- `MEDIUM` — everything else (typically one side matched inexactly, nothing wrong).

```
needsReview = status !== 'FULLY_MATCHED' || any degrading signal
```

Escalating a true orphan is an accepted cost: no deterministic rule can distinguish "no counterpart
exists" from "the counterpart is missing". Silently passing a wrong match is not an accepted cost,
so the asymmetry is deliberate and measured (8 of the 47 escalations are orphans).

---

## Components

### Ingestion & normalization
| File | Role |
|---|---|
| [src/config.js](src/config.js) | Environment config with strict `live` vs `fixture` mode switching |
| [src/razorpayAdapter.js](src/razorpayAdapter.js) | One interface over live API calls and captured fixtures (ADR-004); live mode paginates on `skip` |
| [src/normalizeSettlement.js](src/normalizeSettlement.js) | Raw recon response → internal records, and validates the net-settlement waterfall |

Waterfall rule, derived from Razorpay's own recon example and enforced on every record as it passes
through:

```
payment / adjustment (money IN):   net =   amount - fee - tax
refund  / transfer   (money OUT):  net = -(amount + fee + tax)
```

checked against the record's own `credit - debit`. A record that fails carries
`waterfallOk: false` all the way to the audit trail rather than being dropped.

### Deterministic match engine
| File | Role |
|---|---|
| [src/matcher/matchEngine.js](src/matcher/matchEngine.js) | Exact-reference pass, proximity fallback, ambiguity refusal, shared-UTR detection, signal derivation, confidence tiering, escalation routing |

No LLM appears anywhere in this file. That is the point (ADR-001).

`buildUtrGroups()` does one extra thing worth calling out: when a UTR is shared by 2+ settlement
records, it also checks whether a bank line carrying that UTR credits *exactly* the sum of the
group's net amounts. On the synthetic batch that arithmetic proof succeeds for 9 of 9 bulk members —
meaning bulk settlements can be resolved by addition rather than by inference. Acting on that is a
scope decision, still open (see [Open decisions](#open-decisions)); computing it costs one pass over
the bank lines and no inference at all, and the proof is handed to the model in the payload either
way.

### Synthetic corpus & ground truth
| File | Role |
|---|---|
| [src/synthetic/prng.js](src/synthetic/prng.js) | Seeded mulberry32 PRNG — byte-reproducible batches |
| [src/synthetic/generateSyntheticBatch.js](src/synthetic/generateSyntheticBatch.js) | Generates settlements + bank statement + ledger and a hidden ground-truth answer key |

The generator knows the correct answer for every record *before* deliberately corrupting the
observable fields. Ground truth is written to a separate `ground-truth.internal.json` that the
matcher provably never reads — asserted, not assumed
(`ground truth is never leaked into the match results`).

### The seven case types

Weighted to look like real traffic, with a deliberate slice of every exception the LLM layer has to
prove itself on. Realistic Smart Collect UPI IDs (`rpy.payto00000<vendor>@<bank>`) and 16-digit
customer identifiers in the blind-payment narrations.

| Case | Weight | Deterministic outcome | Escalated? |
|---|---|---|---|
| `CLEAN` | 45% | `FULLY_MATCHED`, HIGH — exact on both sides | No |
| `TIMING_LAG` | 15% | `FULLY_MATCHED`, MEDIUM — bank via proximity, ledger exact | No |
| `BLIND_PAYMENT` | 12% | `PARTIAL_BANK_ONLY`, LOW — `PROXIMITY_ONLY_NO_REFERENCE` | Yes |
| `BULK_SETTLEMENT` | 8% | Winner `FULLY_MATCHED` + `AMOUNT_DISAGREES_BANK`; siblings `PARTIAL_LEDGER_ONLY` | Yes |
| `AMOUNT_MISMATCH` | 8% | `PARTIAL_LEDGER_ONLY` + `WATERFALL_MISMATCH` | Yes |
| `AMBIGUOUS` | 5% | `UNRESOLVED` / `AMBIGUOUS_CANDIDATES` | Yes |
| `ORPHAN` | 7% | `UNRESOLVED` / `NO_CANDIDATE_FOUND` | Yes (over-escalation; nothing to find) |

A ~20% slice of the clean paths carries only an invoice/receipt number on the ledger side and no
order id — the ordinary reality of an accounting system keyed on invoices. That slice is the only
thing that exercises `EXACT_ORDER_RECEIPT`, which fired 13 times in the current batch and **zero**
times before it was added.

### LLM exception layer

| File | Role |
|---|---|
| [src/llm/selectExceptions.js](src/llm/selectExceptions.js) | Decides which escalated records are worth a call at all, and builds each one's payload |
| [src/llm/buildCandidatePayload.js](src/llm/buildCandidatePayload.js) | One exception → the exact JSON sent to the model: settlement, deterministic context, and a bounded candidate shortlist |
| [src/llm/prompt.js](src/llm/prompt.js) | The closed vocabularies (4 decisions, 10 reason codes) and the system prompt built from them |
| [src/llm/llmClient.js](src/llm/llmClient.js) | Groq → OpenRouter failover, retry classification, timeouts, circuit breaker |
| [src/llm/validateDecision.js](src/llm/validateDecision.js) | The acceptance gate. Nothing the model says is trusted until this passes |
| [src/llm/resolveExceptions.js](src/llm/resolveExceptions.js) | Orchestrates the four above over a batch and emits per-record outcomes |
| [src/eval/evaluateRun.js](src/eval/evaluateRun.js) | Scores what actually happened against ground truth |

The model proposes exactly four things and nothing else:

```json
{ "candidate_id": string|null, "decision": "CONFIRM_MATCH|REJECT_MATCH|MATCH_CANDIDATE|NO_MATCH_FOUND",
  "confidence": 0..1, "reason_codes": [ ...closed set ] }
```

The gate checks, in order: JSON parses (including out of prose the reasoning models leak) → decision
is in the closed set → confidence is a real number in range → reason codes are in the closed set →
**`candidate_id` is one this exact exception was actually offered** → the codes are jointly coherent
with each other, the decision and the payload → confidence clears 0.7.

The hallucination check is the load-bearing one: `candidate_id` is compared against the exact id set
that record's payload contained, so an invented id is caught by set membership rather than by
trusting the model's claim that it exists.

Two things the gate deliberately does *not* do. It does not referee debatable judgment — that would
make it a second, worse matcher. And it does not sink a sound decision over an untidy justification:
a reason code the payload disproves is dropped and recorded as a warning, leaving the decision
standing on what survives. Both boundaries were set by real output, not by taste — see the build log.

### Failure handling

`RETRYABLE_STATUS` separates "try again" (408, 429, 5xx, timeouts) from "this request is wrong and
will stay wrong" (400, 401, 422) — a deterministic 400 fails over to OpenRouter immediately instead
of burning two doomed round-trips. An HTTP 200 carrying empty `message.content` is treated as a
failure, not an answer, because that is exactly what a token-budget truncation looks like from the
outside.

A retryable failure waits as long as the provider asked it to. Both providers say so, differently —
OpenRouter sets a `retry-after` header, Groq puts `"Please try again in 1.785s"` in the JSON body —
and both are parsed, capped at 5s so that an absurd wait fails over rather than stalling the batch.
A blind fixed backoff retries *inside* the window the provider just asked it to sit out, which is a
guaranteed second failure.

The circuit breaker is batch-scoped: after 3 consecutive primary failures the primary is skipped, and
a later success clears the count. Two runs in one process never inherit each other's failure state.
It trips but does not latch — an open breaker is re-probed after 15s, because the failure that
actually happens in a long batch is a rate limit rather than an outage, and the two want opposite
handling. A dead provider re-trips on the probe and costs one wasted call per cooldown window instead
of one per record; a throttled one gets picked back up as soon as its token bucket refills. Both
halves of that are in the build log: latching is what broke the first 120-record run.

### Audit trail

Every run and every record lands in SQLite, so "why was this record cleared?" has an answer that
outlives the process.

| File | Role |
|---|---|
| [src/db/auditDb.js](src/db/auditDb.js) | Schema, writes, per-run progress tallies, CSV/JSON export. Zero business logic — write-behind only |
| [scripts/runFullPipeline.js](scripts/runFullPipeline.js) | The whole pipeline with the trail wired in: match → escalate → resolve → record |

Two tables. `runs` carries one row per invocation — mode, size, seed, status, the evaluation summary
as JSON, and an error if it died. `audit_log` carries one row per record, 31 columns, keyed by
`run_id` so runs accumulate side by side rather than overwriting each other.

Every record gets exactly one `resolution_path`, and they partition the batch:

| Path | Meaning |
|---|---|
| `RULE_ONLY` | The deterministic engine settled it. No call made |
| `LLM_SKIPPED` | Escalated, but there was nothing to show the model — no call made |
| `LLM_ACCEPTED` | The model proposed and the gate accepted |
| `LLM_FLAGGED` | Structurally valid but under the confidence threshold |
| `LLM_REJECTED` | The gate refused it |
| `LLM_ERROR` | Both providers failed for this record |

Five design points worth naming:

- **The writes are live, not a dump at the end.** `resolveExceptions` takes an `onResolution` hook and
  fires it the instant each record resolves. The DB module knows nothing about the LLM layer and the
  LLM layer knows nothing about SQLite. WAL mode means a reader can watch a run while it is still
  being written, which is what makes a progress view real rather than an animation.
- **An empty array is stored as `[]`, not `null`.** "Nothing was recorded" and "something was
  recorded, and it was empty" are different claims, and an audit trail that collapses them is lying by
  omission.
- **The money is stored, in integer paise, as each of the three sources stated it.** `gross_amount` /
  `fee` / `tax` / `net_amount` are the settlement's own waterfall; `bank_amount` and `ledger_amount`
  are what the matched counterparties said. The signals could always *name* a disagreement —
  `AMOUNT_DISAGREES_BANK` lands in `signals_json` — but nothing in the trail could say *by how much*,
  which is the first question a finance reviewer asks. A null counterparty amount means no match on
  that side, which is a different fact from an amount of zero, so these bind with `?? null` and never
  `|| null`: a fully-waived fee of 0 is a measurement, not a blank.
- **New columns arrive by `ALTER TABLE ADD COLUMN`, never by rewriting the table.** `CREATE TABLE IF
  NOT EXISTS` is a no-op against a database that already has the table, so adding a column to the
  schema literal does not reach an existing `data/audit.db` — the column would exist in the code and
  not on disk, and the first insert would fail on a name that isn't there. `migrate()` applies the
  additive list, guarded by what the file actually has, and rows written before an addition read back
  null. That is the honest answer: that run genuinely did not record the field, and the dashboard
  renders it as an em dash rather than a zero nobody measured.
- **The ground-truth columns are nullable and demo-only.** `eval_case_type` / `eval_verdict` are
  populated from the synthetic answer key. A real run leaves them null, and `getRunProgress()` returns
  `evalVerdicts: null` rather than `{}` — so an unscored run is distinguishable from a scored run with
  nothing right yet. Only *accepted* decisions are scored: crediting the model for an answer the gate
  threw away would flatter it.

### Read-only dashboard

```bash
npm run dashboard
```

| File | Role |
|---|---|
| [src/dashboard/server.js](src/dashboard/server.js) | The whole server — `node:http`, zero dependencies, GET/HEAD only |
| [src/dashboard/public/index.html](src/dashboard/public/index.html) | One static page. No framework, no build step |
| [src/dashboard/public/app.js](src/dashboard/public/app.js) | Renders the API responses; polls only while a run is still being written |
| [src/dashboard/public/app.css](src/dashboard/public/app.css) | The resolution-path palette, defined once so the bar, the pills and the legend cannot drift |
| [scripts/dashboard.js](scripts/dashboard.js) | Thin CLI wrapper — one port argument, prints the security posture, closes the SQLite handle on Ctrl-C |

Five read routes: `/api/runs`, `/api/runs/:id`, `/api/runs/:id/rows`, and `export.csv` /
`export.json` per run. Every one is a thin pass-through to a function
[src/db/auditDb.js](src/db/auditDb.js) already exposed and `verify-audit-db` already covers.

Four properties are structural rather than conventional, which is the reason this is a hand-written
server rather than an Express app:

- **Read-only by construction.** Every verb that is not GET or HEAD is refused with `405` and an
  `Allow: GET, HEAD` header *before any routing happens*. It is one branch at the top of the handler,
  so it is a policy rather than an omission each route has to remember. `POST /api/does-not-exist`
  gets 405, not 404 — asserted, because that ordering is the whole claim: **the viewer cannot alter a
  reconciliation result.**
- **A static allowlist, not a directory walk.** Three files, four exact pathnames, one `Map`. No
  request-controlled string ever reaches `path.join`, so `/../../.env` and `/%2e%2e/%2e%2e/.env` 404
  through the same code path as any unknown file — there is no traversal to defend against because
  there is no resolution step.
- **It polls, and only while the run is live.** `runs.status === 'running'` is the only thing that
  arms the timer; a finished run is immutable, so polling it would be three queries a second for no
  new facts. WAL mode in `auditDb.getDb` is what makes reading a run mid-write safe at all, and this
  is the feature that cashes that in.
- **Nothing from the database is ever written as HTML.** Every value goes through `textContent` or
  `createElement`. A narration field is merchant-controlled text arriving from a bank statement, and
  it is rendered on the same page as an audit trail.

**No authentication.** The whole reconciliation trail is readable by anyone who can reach the port,
so the default bind is `127.0.0.1` and a non-loopback `DASHBOARD_HOST` prints a boxed
`NO AUTHENTICATION` warning at startup rather than binding quietly. That is a mitigation, not a
solution — see [Known limitations](#known-limitations).

What the page shows, in the order it shows it: the six headline tiles (records, resolved by rules, AI
accepted, held for a human, silent misses, AI match precision), the stacked `resolution_path` bar with
a plain-English gloss per path, the scorecards (match status, ground-truth verdicts, the ADR-001 and
ADR-002 numbers, and why the gate rejected what it rejected), and the per-record table. Clicking a
record opens the full chain for it: what each source said the money was, what the engine matched and
how, the signals it raised, the path it took, what the model proposed, what the gate did about it —
including any reason code the gate dropped, shown struck through next to the ones that survived — the
ground-truth verdict, and the run and row it came from.

The amount column carries a disagreement cue under the net figure whenever a counterparty amount
exists and differs, so scanning the column finds the money problems instead of reading 120 rows of
confirmation. Each side is measured against the settlement field it is supposed to equal — bank
credits against net, ledger entries against gross — mirroring `AMOUNT_FIELD_BY_SOURCE` in the matcher.
Comparing both to net would print a red delta of exactly fee + tax on every clean record — 92 false
cues instead of 3 on the reference run, which would make the cue worthless. As it stands it fires on 3
of 120 rows, and all three are bulk settlements where one bank credit covers three records.

Two numbers deliberately appear in only one place each. The three partition tiles are derived from
`byResolutionPath` alone so they sum to the record total exactly; `pipeline.leftForHuman` (22) and
`endToEndCoverage` (81.7%) differ from the path-derived figures (20 and 83.3%) because two accepted
decisions were `REJECT_MATCH`/`NO_MATCH_FOUND` rather than matches, so both live in the labelled
scorecard under their own names instead of contradicting a tile.

---

## Quick start

```bash
npm install
```

```bash
cp .env.example .env
```

Fixture mode is the default and needs no keys at all.

```bash
npm test
```

That runs all six verification suites in order, with no network access. **359 assertions, exit code 0.**
Four of the suites print one `OK` line per check and account for **341** of them — llm-layer 117,
dashboard 93, audit-db 84, synthetic 47. The adapter and matcher suites assert through `node:assert`
(10 and 8 assertions), which throws on failure and prints nothing on success, so they contribute no
`OK` lines to that 341. Individually:

| Command | Target | What it proves |
|---|---|---|
| `npm run verify-adapter` | [scripts/verifyAdapter.js](scripts/verifyAdapter.js) | Ingestion, normalization and the net-settlement waterfall work end to end |
| `npm run verify-matcher` | [scripts/verifyMatcher.js](scripts/verifyMatcher.js) | All four match outcomes reproduced on a hand-written fixture where every expectation is asserted by name |
| `npm run generate-synthetic` | [scripts/generateSyntheticData.js](scripts/generateSyntheticData.js) | Writes a reproducible dataset to `fixtures/synthetic/` for inspection. **Not** part of `npm test` — the suites and the runners build the same batch in memory from the same seed |
| `npm run verify-synthetic` | [scripts/verifySyntheticData.js](scripts/verifySyntheticData.js) | 47 structural + routing invariants against the 120-record batch and its ground truth |
| `npm run verify-llm-layer` | [scripts/verifyLlmLayer.js](scripts/verifyLlmLayer.js) | The whole Day 3 layer with **no network access**: payload shapes, the acceptance gate, orchestration, failover/retry/breaker/`retry-after` behaviour against a mocked `fetch`, and the evaluation layer against ground truth |
| `npm run verify-audit-db` | [scripts/verifyAuditDb.js](scripts/verifyAuditDb.js) | The audit trail against a throwaway SQLite file: schema, run lifecycle, field round-trips, per-run isolation, CSV escaping, the additive migration replayed against a pre-money 24-column database, and one end-to-end pass through the **real** matcher and orchestrator proving the trail accounts for every record exactly once and that every stored amount agrees with the signal the matcher raised |
| `npm run verify-dashboard` | [scripts/verifyDashboard.js](scripts/verifyDashboard.js) | The dashboard: every write verb refused before routing, traversal attempts 404 by allowlist, the read API's null-vs-`[]` fidelity, export headers, and one real loopback bind with three real requests over TCP |
| `npm run dashboard` | [scripts/dashboard.js](scripts/dashboard.js) | Serves the trail read-only on `http://127.0.0.1:4000`. **Not** part of `npm test` |
| `npm run run-exception-layer` | [scripts/runExceptionLayer.js](scripts/runExceptionLayer.js) | The real thing. Live Groq/OpenRouter calls, then the evaluation block. **Not** part of `npm test` |
| `npm run run-pipeline` | [scripts/runFullPipeline.js](scripts/runFullPipeline.js) | The same, plus the audit trail written to `data/audit.db` as it goes. **Not** part of `npm test` |

`verify-llm-layer` mocks `fetch`, so a missing key or a flaky provider can never break the build.
That trade has a cost worth naming: its fake caller returns hand-written valid JSON, so no assert in
it can catch a provider-level formatting failure. `run-exception-layer` is the other half — the
`max_tokens` bug below passed every offline check and was only ever visible there.

Both generator scripts take optional `size` and `seed` arguments:

```bash
node scripts/verifySyntheticData.js 1000 3
```

The real run takes them too:

```bash
npm run run-exception-layer -- 30 42
```

The full pipeline is the same call plus the audit trail. Runs accumulate in `data/audit.db` — the file
is gitignored, so nothing about a run is committed:

```bash
npm run run-pipeline -- 120 42
```

Then read the trail. The dashboard is a viewer, not a second copy of the data — it opens the same
`data/audit.db` read-only, so it can be left running while the pipeline above writes into it:

```bash
npm run dashboard
```

`http://127.0.0.1:4000`, or `npm run dashboard -- 4100` for a different port. Loopback only, because
there is no authentication.

---

## Switching to live Razorpay data

1. Get **test-mode** keys from Razorpay Dashboard → Settings → API Keys. Live-mode keys are not
   needed and should not be used.
2. In `.env` (gitignored):
   ```env
   SETTLEMENT_SOURCE_MODE=live
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   SETTLEMENT_YEAR=2026
   SETTLEMENT_MONTH=9
   SETTLEMENT_DAY=1
   ```
3. Capture the response once, then work offline from it:
   ```bash
   npm run capture-fixture
   ```
   Saved to `fixtures/settlement-recon-captured.json` (gitignored). An empty `items[]` from a
   fresh test account is still a valid capture — it proves the auth path, the endpoint and the
   response envelope, which is what the fixture is insurance for.

Live mode paginates on `skip` until a short page comes back. A silently truncated day is the worst
possible failure mode here: the missing line items don't surface as unresolved, they simply don't
exist, so the batch reconciles clean while real money goes unaccounted for.

---

## Open decisions

**1. `settlement_utr` semantics on real data.** In the synthetic corpus a shared UTR means a bulk
settlement, and `SHARED_UTR_GROUP` fires on exactly the 9 bulk records. On **real** Razorpay recon
data, every line item in one settlement batch shares that batch's UTR — one UTR per payout, many
line items. The signal is structurally correct either way, but against real data it would fire on
essentially every record, and the correct reconciliation model becomes *one bank credit per
settlement batch equal to the sum of all net amounts in it*, with each record matching its ledger
invoice individually. This has not been redesigned unilaterally: it needs one real captured response
carrying actual line items. The live path is now proven, but the test account has never processed a
payment (`settlements.all`, `payments.all` and month-level `settlements.reports` all return
`count: 0`), so confirming the shape requires settlement activity on the account — a test payment
that has settled — not more code.

**2. Should bulk settlements go to the LLM at all?** Still open, still a scope call rather than a code
one. `buildUtrGroups()` already proves them by arithmetic — the members' nets sum to the single
credit, 9 for 9 on the current batch — and the payload hands the model that finished proof, so
`BULK_SETTLEMENT_ARITHMETIC_OK` is the model agreeing with arithmetic it did not have to do.
Resolving them deterministically would be strictly more correct *and* would cut the escalation rate;
the cost is that what the LLM demonstrably handles shrinks to blind payments, ambiguous pairs and
amount mismatches. The master doc treats bulk settlement as an LLM exception case, so it is left as
one. Changing it would also mean splitting ground truth's `needsAiReview` into "is an exception" vs
"requires inference" and updating both verification suites.

**3. The "86% of LLM calls avoided" pitch line is not achievable on this dataset, and the honest
number is better anyway.** Measured on the 120-record batch (seed 42), which is the batch every figure
in the tables above describes unless it says otherwise: 60.8% of records resolve deterministically
with zero silent misses, and of the 47 that *are* escalated, 17% need no call at all because there is
nothing to offer the model (8 of 47; the smaller runs gave 2 of 13 and 4 of 26). End-to-end coverage —
rules plus AI, counting only correctly named counterparts — lands at 81.7–83.3% with 100% AI match
precision on every run. The corpus is deliberately exception-heavy (39% of it is a genuine exception by
construction), which is why the deterministic share is lower than a production mix would give. The
demo should quote the measured numbers.

---

## Build log — real bugs found and fixed

Kept because the failure modes are more instructive than the fixes.

**The engine reported HIGH confidence on matches whose money didn't agree.** `tryExactMatch` never
cross-checked the amount, so a bulk settlement's UTR — which genuinely belongs to the record —
produced a clean `FULLY_MATCHED`/HIGH result while the credit was ~3× the record's own net
(`pay_SYN0000167`: net 419,808 vs bank 1,070,149). Three records, and they were the *only* three
records in the batch that ground truth said needed review and the engine didn't flag. Fixed by
computing `bankAmountAgrees` / `ledgerAmountAgrees` separately from the reference match and treating
disagreement as a degrading signal. A reference hit proves two records describe the same event; it
does not prove the money agrees.

**Ambiguity was detected and then thrown away.** `tryProximityMatch` correctly reported 2+ viable
candidates as `AMBIGUOUS_PROXIMITY`, but the result builder dropped any match with no claimed
record, so the signal appeared 0 times in 120 results. The exception layer needs to know a record
was ambiguous even when the other source matched fine. Fixed by reporting the method independently
of whether a record was claimed.

**The generator's `settled_at` drifted from its own bank line.** Grouped case types aligned every
member's bank credit to one settlement date *after* `buildRecord` had already baked `settled_at`
from the record's original date — up to 7.5 days apart, against a 3-day bank window. One ambiguous
pair member came out `UNRESOLVED` with no candidate at all instead of the documented
`AMBIGUOUS_PROXIMITY`; the test suite passed anyway because the 30-day ledger window carried it.
Right answer, wrong reason, green tests. Fixed by passing the group's settlement date *into*
`buildRecord` so it is baked correctly once instead of patched afterwards, and guarded by two new
invariants that check reachability from both the engine's and the generator's side.

**`EXACT_ORDER_RECEIPT` had never executed.** Ledger entries always carried an `orderId`, so the
third branch of the reference-priority chain was dead code across all 120 records — and across every
seed. Fixed by giving a deterministic ~20% slice of clean-path ledger entries a receipt but no order
id. That immediately exposed a second latent bug: receipts were `INV-<random 4 digits>`, which
collides across a 120-record batch about 23% of the time, so an `EXACT_ORDER_RECEIPT` lookup could
have claimed a different record's invoice. Receipts are now derived from the monotonic record index
and asserted globally unique.

**`better-sqlite3@11` cannot build on Node 24.** `node-gyp` fails with
`Could not find any Visual Studio installation to use` — there is no prebuild for Node 24 on that
line. Pinned to `12.2.0`, which ships one. If a reviewer on a different Node version hits the same
wall, `node:sqlite` (`DatabaseSync`) is a zero-dependency stdlib fallback that supports prepared
statements and constraint enforcement, verified working on Node 24.

**A `max_tokens` that passed every offline test broke every real call.** Both configured models are
reasoning models, and both bill chain-of-thought against `max_tokens` — so a 500-token budget was
spent thinking before a single character of the answer was emitted. Groq returned HTTP 400
`json_validate_failed` (its `response_format` enforcement failing on a truncated object) and
OpenRouter returned raw reasoning prose with no JSON in it at all. The mocked suite never saw this
because a mock returns a complete object regardless of the budget. Raised to 2500 and confirmed on
live traffic: 0 LLM errors across 4 runs, both providers. The class of bug is the point — anything
that only manifests against the real endpoint cannot be covered by a mock, which is why
`run-exception-layer` exists as a separate, real-network script rather than a test.

**My own acceptance gate threw away three correct answers.** The first live run rejected 4 of 11
decisions; 3 were `CONTRADICTORY_REASON_CODES:EXACT_AMOUNT+AMOUNT_WITHIN_WATERFALL_DRIFT`, and
ground truth confirmed all three had named the **correct** bank record. The model had padded its
justification with both amount codes at once; the gate treated that as a contradiction and discarded
the match. It is not a contradiction — an exact amount *is* trivially within drift, so the two codes
point the same way and differ only in strictness. Fixed by splitting severity: `OPPOSED_REASON_CODES`
(genuinely opposite verdicts, e.g. bulk arithmetic OK vs mismatch) still reject, because which code
is load-bearing changes the answer; `REDUNDANT_AMOUNT_CODES` are now resolved against the payload's
own `amount_agrees` flag — the surplus code is dropped, a warning is recorded, and the decision
stands on what survives. Rejecting a right answer over an untidy label buys no safety and costs
coverage. Rejections went 4 → 0 and accepted 4 → 8 on the same seed. Diagnosed by dumping the real
payloads next to ground truth rather than guessing which side was wrong.

**The closed vocabulary had a hole, and the model found it twice.** `pay_SYN0000039` was rejected for
`REASON_CODE_NOT_ALLOWED:EXACT_ORDER_ID` — the model had answered with the matcher's own `method`
value, copied out of the payload, because there was no way in the allowed list to say *"a shared
reference ties these two records together"*: the single most common reason a match is trustworthy.
The model was right and the vocabulary was incomplete. Adding `EXACT_REFERENCE_MATCH` plus a prompt
rule naming the method values as non-codes was **not** enough — the next run produced the same
rejection. Fixed by also aliasing the three `EXACT_*` method names to `EXACT_REFERENCE_MATCH` before
the vocabulary check. That is vocabulary translation, not a loosened contract, and the distinction is
load-bearing: the alias only ever resolves to a code that must still clear its own evidence
predicate, so a model echoing a method name on a record with no shared reference is still rejected —
pinned by an assert that tries exactly that. It is also restricted to strings *we* put in the
payload, so the model is repeating our own field value rather than inventing a code.

**The circuit breaker treated "slow down" as "you are broken", and it only showed at 120 records.**
The first live run at full scale lost 4 records to `LLM_ERROR` with nothing actually wrong at either
provider. Two mistakes compounded. Groq's 429 body says exactly how long to wait
(`"Please try again in 1.785s"`) and the retry policy ignored it, sleeping a blind 250ms — so the
retry landed inside the window Groq had just asked it to sit out and was guaranteed to fail. Those
manufactured failures then hit a breaker that latched: three of them retired the primary for the
remaining ~25 records, so every one of them went to OpenRouter's free tier, which is capped at 20
requests/minute, and 4 records fell off the end when *that* limit hit. A rate limit and an outage look
identical to a failure counter and need opposite handling — one recovers in two seconds, the other
does not recover at all. Fixed by parsing `retry-after` from both providers (header and message body,
capped at 5s so an absurd wait fails over instead of stalling) and giving the breaker a 15s cooldown
after which one request probes the primary again. Re-run on the same seed: 28 honoured waits, the
breaker never tripped, `llmErrors` 4 → 0, and two more escalations cleared. Both runs are still in
`data/audit.db` as runs 1 and 2, which is the argument for keying the trail by `run_id` rather than
overwriting: the regression and its fix are side by side in the same table.

The two extra records the fix recovered are also why decision accuracy reads 92.6% rather than 100% —
they were the two hardest exceptions in the batch, and the model got both wrong in the conservative
direction (one `REJECT_MATCH` on a real pair, one `NO_MATCH_FOUND` with the answer on the shortlist).
Fixing an infrastructure bug lowered a quality metric by giving the model two more chances to be
wrong. The alternative was a nicer-looking percentage over fewer answered records.

**A wrong `SETTLEMENT_MONTH` would have reconciled the wrong day and looked healthy doing it.** Found
in the final pre-submission read, not by a failing test — because there was no test. The three
settlement-query knobs were still on `Number(x) || fallback`, the exact pattern
[src/config.js](src/config.js) carries a comment condemning everywhere else: `SETTLEMENT_MONTH=0` and
`SETTLEMENT_YEAR=twentytwentysix` are both falsy, so both silently resolved to *today*. In fixture mode
that is invisible, which is why four days of green runs never surfaced it; in live mode it fetches a
different day's recon and every log line still reads normally — a wrong answer with no error attached,
which is the failure class this whole project is built to refuse. Fixed by routing all three through
`numberFromEnv` with ranges, and pinned by 8 assertions in
[scripts/verifyAdapter.js](scripts/verifyAdapter.js) that all passed silently before the fix. The
lesson is the one the build log keeps repeating: the dangerous defects are not the ones that throw.

---

## Known limitations

- **Matching is 1:1 per source.** A bank line or ledger entry, once claimed, is removed from the
  pool. Bulk settlements need 1:many and are therefore *reported* as `SHARED_UTR_GROUP` exceptions
  with the combined net attached, not force-fitted into a 1:1 match. See
  [Open decisions](#open-decisions).
- **No real settlement records captured.** The live path is verified end to end, but the test account
  has no payment or settlement history, so the capture is an empty collection. Confirming real
  `settlement_utr` semantics needs a settled test payment, not code.
- **No linter or CI.** Deliberately out of scope for a 5-day build; `npm test` is the gate.
- **The dashboard has no authentication, and no authorization model to add one to.** Anyone who can
  reach the port reads the entire reconciliation trail — settlement amounts, bank references, ledger
  ids, every LLM proposal. The mitigations are that it is read-only by construction (no verb but GET
  and HEAD is served, so the trail cannot be altered through it) and that it binds `127.0.0.1` by
  default and warns loudly when told to bind anything else. Neither is a substitute for auth. It is
  a local review tool for a 5-day build, and anything beyond that needs a real identity layer in
  front of it before it is exposed to a network.
- **Dates are compared with day-granularity windows**, not settlement-cycle awareness. A merchant on
  a weekly settlement schedule would need a wider bank window than the 3-day default (it is a
  constructor option, not a constant).

### Deviations from the original architecture

Three, all deliberate. Named here rather than left for a reviewer to spot.

**1. `settlements.settlementRecon()` → `settlements.reports({ year, month, day })`.** The initial plan
assumed an `instance.settlements.settlementRecon({...})` method on the Node SDK. That method is
**PHP-only**. The Node SDK reuses `instance.settlements.reports({ year, month, day })` for day-level
recon: pass a `day` and you get the recon line items; omit it and you get the settlement-batch summary.
Documented at [src/razorpayAdapter.js](src/razorpayAdapter.js) and fixed before anything depended on
the wrong name.

**2. No `groq-sdk` — both providers are called through plain `fetch`.** Groq and OpenRouter both speak
the OpenAI chat-completions shape, so one request builder serves both and failover is a URL-and-key
swap rather than a second integration. It is also what makes the failover *testable*: mocking one
`global.fetch` drives ten real failure scenarios with no network. See
[ADR-003](DECISIONS.md#adr-003--groq-primary-openrouter-fallback-over-raw-fetch).

**3. No fuzzy-matching library, and nothing replaced it.** The plan named `string-similarity` or
`fuzzball`. Neither is installed and no similarity scoring happens anywhere in the engine — a
similarity *score* is the specific mechanism that produces a confident wrong match. It converts "these
two strings look 0.87 alike" into a reconciliation claim, and there is no threshold that can be
justified to an auditor afterwards. What covers the same ground is three parts, each explainable on its
own: **exact-reference priority** across two passes (`settlement_utr`, `order_id`, `order_receipt`)
before any proximity fallback; **single-candidate proximity** on amount and date, which refuses as
`AMBIGUOUS_PROXIMITY` the moment a second candidate also fits; and the **LLM reading the narration as
text** under a closed vocabulary, where `SMART_COLLECT_IDENTIFIER` and `NARRATION_VENDOR_MATCH` do the
work a fuzzy score would have done — except the claim is checked back against the payload it came from
([validateDecision.js](src/llm/validateDecision.js)) instead of being trusted as a number. This is the
[ADR-001](DECISIONS.md#adr-001--deterministic-rules-decide-the-llm-only-proposes) principle applied to
a dependency: judgment about text goes to the layer that has to justify itself, not to a float.
`package.json` lists three runtime dependencies, and neither library is among them.

---

## Next steps

**Day 4, done** — The SQLite audit trail is built and wired into the live pipeline
([src/db/auditDb.js](src/db/auditDb.js), [scripts/runFullPipeline.js](scripts/runFullPipeline.js)),
covered by a fifth verification suite, and exercised by a real 120-record run. The trail records what
the model was shown (`offeredCandidateIds`), what it said (`llm_raw_reason_codes`), what the gate did
about it (`llm_reason_codes`, `validation_reason`, `validation_warnings`) and which of the six
`resolution_path` values every record ended on. The ADRs are written up in
[DECISIONS.md](DECISIONS.md).

The read-only dashboard over that trail is built too ([src/dashboard/](src/dashboard/),
[scripts/dashboard.js](scripts/dashboard.js)) — `node:http`, zero new dependencies, one static page,
GET and HEAD only — and covered by a sixth suite, [ADR-005](DECISIONS.md#adr-005--the-dashboard-is-read-only-by-construction-not-by-omission).
`npm test` is 359 assertions across six suites, all passing with no network access. Both prior runs are
visible in the same run selector, which is the payoff of keying the trail by `run_id`: the
rate-limit regression and its fix sit side by side.

**Day 4, remaining** — Nothing. The build is frozen; see
[DECISIONS.md § Scope freeze](DECISIONS.md#scope-freeze--4-september-2026) for what is in, what is
deliberately out, and the one exception that still permits a code change before submission.

**Day 5** — Demo recording and submission buffer. No coding.
