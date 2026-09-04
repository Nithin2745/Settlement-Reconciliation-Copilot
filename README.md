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

## Status — Days 1–3 complete

| Day | Scope | State |
|---|---|---|
| **Day 1** | Ingestion, normalization, waterfall validation, deterministic 3-way match engine | Complete |
| **Day 2** | Synthetic bank statement + ledger generators, ground-truth answer key, batch stress test | Complete |
| **Day 3** | LLM exception layer (Groq primary, OpenRouter fallback), constrained JSON, acceptance gate, evaluation metrics | Complete |
| Day 4 | Dashboard, SQLite audit trail, `DECISIONS.md`, scope freeze | Not started |

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

Two live runs, `npm run run-exception-layer <size> <seed>`. Every AI number below is scored against
`ground-truth.internal.json`, which neither the matcher nor the model ever reads.

| Metric | 30 records, seed 42 | 60 records, seed 7 |
|---|---|---|
| Deterministic claim precision | 100% (44/44) | 100% (88/88) |
| Silent misses / silent wrong claims | 0 / 0 | 0 / 0 |
| Escalation recall | 100% (11/11) | 100% (22/22) |
| LLM calls made / avoided | 11 / 2 | 22 / 4 |
| **AI match precision** | **100% (8 named)** | **100% (15 named)** |
| AI false positives | 0 | 0 |
| Decision accuracy over accepted | 100% | 93.8% |
| Rejected by the acceptance gate | 0 | 0 |
| LLM errors | 0 | 0 |
| **End-to-end coverage** | **83.3%** | **81.7%** |

The 93.8% on the second run is one `NO_MATCH_FOUND` where a true counterpart *was* on the shortlist —
a missed opportunity, counted as such rather than quietly scored as a correct decline. On the first
run the confidence gate blocked one wrong answer at a cost of zero right ones.

Provider mix varies run to run (`{groq: 8, openrouter: 3}` and `{groq: 4, openrouter: 18}`) because
the free Groq tier rate-limits under load. Both runs completed with zero errors, which is the
fallback doing exactly what ADR-003 asks of it — unprompted, on real traffic.

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

The circuit breaker is batch-scoped: after 3 consecutive primary failures the primary is skipped for
the rest of the run, and a later success clears the count. Two runs in one process never inherit each
other's failure state.

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

That runs all four verification suites in order. Individually:

| Command | Target | What it proves |
|---|---|---|
| `npm run verify-adapter` | [scripts/verifyAdapter.js](scripts/verifyAdapter.js) | Ingestion, normalization and the net-settlement waterfall work end to end |
| `npm run verify-matcher` | [scripts/verifyMatcher.js](scripts/verifyMatcher.js) | All four match outcomes reproduced on a hand-written fixture where every expectation is asserted by name |
| `npm run generate-synthetic` | [scripts/generateSyntheticData.js](scripts/generateSyntheticData.js) | Writes a reproducible dataset to `fixtures/synthetic/` |
| `npm run verify-synthetic` | [scripts/verifySyntheticData.js](scripts/verifySyntheticData.js) | 47 structural + routing invariants against the 120-record batch and its ground truth |
| `npm run verify-llm-layer` | [scripts/verifyLlmLayer.js](scripts/verifyLlmLayer.js) | The whole Day 3 layer with **no network access**: payload shapes, the acceptance gate, orchestration, failover/retry/breaker behaviour against a mocked `fetch`, and the evaluation layer against ground truth |
| `npm run run-exception-layer` | [scripts/runExceptionLayer.js](scripts/runExceptionLayer.js) | The real thing. Live Groq/OpenRouter calls, then the same evaluation block. **Not** part of `npm test` |

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
number is better anyway.** Measured: 60.8% of records resolve deterministically with zero silent
misses, and of the records that *are* escalated, 15% need no call because there is nothing to offer
the model (2 of 13 and 4 of 26 on the two live runs). End-to-end coverage — rules plus AI, counting
only correctly named counterparts — lands at 81.7–83.3% with 100% AI match precision. The corpus is
deliberately exception-heavy (39% of it is a genuine exception by construction), which is why the
deterministic share is lower than a production mix would give. The demo should quote the measured
numbers.

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
- **Dates are compared with day-granularity windows**, not settlement-cycle awareness. A merchant on
  a weekly settlement schedule would need a wider bank window than the 3-day default (it is a
  constructor option, not a constant).

### Correction vs. the original architecture

The initial plan assumed an `instance.settlements.settlementRecon({...})` method on the Node SDK.
That method is **PHP-only**. The Node SDK reuses `instance.settlements.reports({ year, month, day })`
for day-level recon: pass a `day` and you get the recon line items; omit it and you get the
settlement-batch summary. Documented at
[src/razorpayAdapter.js](src/razorpayAdapter.js) and fixed before anything depended on the wrong
name.

---

## Next steps

**Day 4** — Batch dashboard, SQLite audit trail (`better-sqlite3`, already pinned), `DECISIONS.md`
with ADR 001–004, and scope freeze. The per-record `resolutions` array is already shaped for it:
every entry carries `offeredCandidateIds`, the model's `rawReasonCodes`, the sanitized `reasonCodes`,
`validationWarnings` and `validationReason`, so the audit trail can show what the model was shown,
what it said, and what the gate did about it.

**Day 5** — Demo recording and submission buffer. No coding.
