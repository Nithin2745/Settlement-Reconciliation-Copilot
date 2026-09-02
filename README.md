# Settlement Reconciliation Copilot

*Razorpay AI Builder Internship 2026 — Track 4: AI Finance Controller*

Reconciles Razorpay settlement records against an independent bank statement and internal ledger. Deterministic rules resolve certainty (exact references, net settlement waterfall, timing-lag proximity); an LLM is called only for genuine exceptions (blind payments, bulk settlements) and never gets execution authority — it proposes structured resolutions that the application layer validates and decides.

---

## Status: Day 1 & Day 2 Complete (Deterministic Foundation + Synthetic Ground Truth)

### Implemented Components

#### 1. Ingestion & Normalization (`src/`)
- [`src/config.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/config.js) — Environment config with strict `live` vs `fixture` mode switching.
- [`src/razorpayAdapter.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/razorpayAdapter.js) — Unified settlement recon ingestion interface for live Razorpay API calls and captured fixtures.
- [`src/normalizeSettlement.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/normalizeSettlement.js) — Normalizes raw API responses into internal records and validates the net-settlement waterfall (`net = amount - fee - tax`).

#### 2. Deterministic 3-Way Match Engine (`src/matcher/`)
- [`src/matcher/matchEngine.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/matcher/matchEngine.js) — Deterministic-first matching engine implementing:
  - Exact reference priority: `settlement_utr` (bank) > `order_id` (ledger) > `order_receipt` (ledger).
  - Proximity fallback: amount matching within configurable date windows (T+1/T+2 lag).
  - Ambiguity refusal: deliberately flags multiple candidate collisions as `AMBIGUOUS_CANDIDATES` rather than guessing.
  - Confidence tiering (`HIGH`, `MEDIUM`, `LOW`).

#### 3. Synthetic Batch & Ground Truth Generator (`src/synthetic/`)
- [`src/synthetic/prng.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/synthetic/prng.js) — Seeded Mulberry32 pseudo-random number generator for 100% reproducible test batches.
- [`src/synthetic/generateSyntheticBatch.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/synthetic/generateSyntheticBatch.js) — Generates 100+ record batches covering 7 weighted case types with realistic Smart Collect UPI IDs (`rpy.payto00000<vendor>@<bank>`) and 16-digit customer IDs, paired with a hidden `ground-truth.internal.json` answer key:
  1. `CLEAN` (45%) — Exact UTR + Order ID matches (`FULLY_MATCHED`).
  2. `TIMING_LAG` (15%) — Bank credit lagged 1–3 days (`FULLY_MATCHED` via proximity).
  3. `BLIND_PAYMENT` (12%) — Virtual account credit without invoice reference (`PARTIAL_BANK_ONLY`, marked for AI).
  4. `BULK_SETTLEMENT` (8%) — Multi-order combined credit under single UTR (`FULLY_MATCHED` / `PARTIAL_LEDGER_ONLY`).
  5. `AMOUNT_MISMATCH` (8%) — Corrupted settlement credit (`PARTIAL_LEDGER_ONLY` + `waterfallOk: false`).
  6. `AMBIGUOUS` (5%) — Duplicate amount collision with stripped references (`UNRESOLVED/AMBIGUOUS_CANDIDATES`).
  7. `ORPHAN` (7%) — Internal transfers with no customer-facing counterpart (`UNRESOLVED/NO_CANDIDATE_FOUND`).

---

## Quick Start & Verification

```bash
# 1. Install dependencies
npm install

# 2. Setup environment (defaults to fixture mode, zero keys required)
cp .env.example .env

# 3. Run Day 1 Ingestion & Waterfall Verification
npm run verify-adapter

# 4. Run Day 1/2 Matcher Verification
npm run verify-matcher

# 5. Generate a 120-record Synthetic Batch (seed 42)
npm run generate-synthetic

# 6. Run Day 2 Synthetic Batch Structural Checks (14/14 checks)
npm run verify-synthetic
```

### Verification Scripts Overview

| Command | Target | Description |
|---|---|---|
| `npm run verify-adapter` | [`scripts/verifyAdapter.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/scripts/verifyAdapter.js) | Ingests, normalizes, and validates net-settlement waterfall formulas. |
| `npm run verify-matcher` | [`scripts/verifyMatcher.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/scripts/verifyMatcher.js) | Validates all 4 match outcomes (`FULLY_MATCHED`, `PARTIAL_BANK_ONLY`, `PARTIAL_LEDGER_ONLY`, `UNRESOLVED`). |
| `npm run generate-synthetic` | [`scripts/generateSyntheticData.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/scripts/generateSyntheticData.js) | Generates reproducible fixture datasets in `fixtures/synthetic/`. |
| `npm run verify-synthetic` | [`scripts/verifySyntheticData.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/scripts/verifySyntheticData.js) | Executes deterministic matching against the synthetic batch and verifies 14 structural invariants against ground truth. |

---

## Switching to Live Razorpay Data

1. Obtain **test-mode** keys from Razorpay Dashboard → Settings → API Keys.
2. In `.env`:
   ```env
   SETTLEMENT_SOURCE_MODE=live
   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxxxxx
   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
   SETTLEMENT_YEAR=2026
   SETTLEMENT_MONTH=9
   SETTLEMENT_DAY=1
   ```
3. Capture a live response:
   ```bash
   npm run capture-fixture
   ```
   *(Saves response to `fixtures/settlement-recon-captured.json` for deterministic offline testing and live demo reliability).*

---

## Next Steps (Upcoming Days)

- **Day 3 (Sept 3):** LLM Exception Layer (Groq `openai/gpt-oss-120b` + OpenRouter `nvidia/nemotron-3-super` fallback), constrained JSON schema validation, and ground-truth evaluation engine (precision, AI precision, false-positive rate, LLM calls avoided).
- **Day 4 (Sept 4):** Batch Stress-Test Dashboard, SQLite audit trail (`better-sqlite3`), `DECISIONS.md` (ADR 001–004), 100+ record end-to-end stress test, and scope freeze.
- **Day 5 (Sept 5):** Demo video recording and submission buffer.

---

## Known Corrections from Initial Architecture

The initial project plan anticipated an `instance.settlements.settlementRecon({...})` method on the Node SDK. As documented in [`src/razorpayAdapter.js`](file:///c:/Razorpay/Settlement%20Reconciliation%20Copilot/src/razorpayAdapter.js#L8-L16), that method is PHP-only; the Node SDK reuses `instance.settlements.reports({ year, month, day })` for day-level settlement recon. This was handled cleanly in the adapter without affecting downstream modules.
