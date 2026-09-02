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

## Status — Days 1 & 2 complete

| Day | Scope | State |
|---|---|---|
| **Day 1** | Ingestion, normalization, waterfall validation, deterministic 3-way match engine | Complete |
| **Day 2** | Synthetic bank statement + ledger generators, ground-truth answer key, batch stress test | Complete |
| Day 3 | LLM exception layer (Groq primary, OpenRouter fallback), constrained JSON, evaluation metrics | Not started |
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
Day 3 decision (see [Open decisions](#open-decisions-for-day-3)); computing it costs one pass over
the bank lines and no inference at all.

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

That runs all three verification suites in order. Individually:

| Command | Target | What it proves |
|---|---|---|
| `npm run verify-adapter` | [scripts/verifyAdapter.js](scripts/verifyAdapter.js) | Ingestion, normalization and the net-settlement waterfall work end to end |
| `npm run verify-matcher` | [scripts/verifyMatcher.js](scripts/verifyMatcher.js) | All four match outcomes reproduced on a hand-written fixture where every expectation is asserted by name |
| `npm run generate-synthetic` | [scripts/generateSyntheticData.js](scripts/generateSyntheticData.js) | Writes a reproducible dataset to `fixtures/synthetic/` |
| `npm run verify-synthetic` | [scripts/verifySyntheticData.js](scripts/verifySyntheticData.js) | 47 structural + routing invariants against the 120-record batch and its ground truth |

Both generator scripts take optional `size` and `seed` arguments:

```bash
node scripts/verifySyntheticData.js 1000 3
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

## Open decisions for Day 3

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

**2. Should bulk settlements go to the LLM at all?** `buildUtrGroups()` already proves them by
arithmetic — the members' nets sum to the single credit, 9 for 9 on the current batch. Resolving
them deterministically would be strictly more correct than an LLM proposal *and* would cut the
escalation rate, at the cost of shrinking what the LLM demonstrably handles to blind payments,
ambiguous pairs and amount mismatches. The master doc treats bulk settlement as an LLM exception
case, so this is a scope decision, not a code one.

**3. The "86% of LLM calls avoided" pitch line is not achievable on this dataset.** Measured
honestly: 60.8% resolved deterministically, 39.2% escalated. Getting to 86% would require either a
gentler case-type mix (the corpus is deliberately exception-heavy — 39% of it is genuine exceptions
by construction) or resolving bulk settlements deterministically per decision 2. The number in the
demo should be the measured one.

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

---

## Known limitations

- **Matching is 1:1 per source.** A bank line or ledger entry, once claimed, is removed from the
  pool. Bulk settlements need 1:many and are therefore *reported* as `SHARED_UTR_GROUP` exceptions
  with the combined net attached, not force-fitted into a 1:1 match. See
  [Open decisions](#open-decisions-for-day-3).
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

**Day 3** — LLM exception layer over the 47 escalated records: Groq (`openai/gpt-oss-120b`) primary
with an OpenRouter (`nvidia/nemotron-3-super`) fallback tested by deliberately killing the Groq key;
constrained JSON output (`candidate_id`, `decision`, `confidence`, `reason_codes`); application-side
validation that the proposed candidate exists, the amount is compatible, the date is compatible, the
confidence clears threshold and every reason code is in the allowed set. Then the evaluation layer
scoring deterministic precision, AI precision, false-positive rate and LLM calls avoided against
`ground-truth.internal.json`.

**Day 4** — Batch dashboard, SQLite audit trail (`better-sqlite3`, already pinned), `DECISIONS.md`
with ADR 001–004, and scope freeze.

**Day 5** — Demo recording and submission buffer. No coding.
