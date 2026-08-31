# Settlement Reconciliation Copilot

Razorpay AI Builder Internship 2026 — Track 4 (AI Finance Controller).

Reconciles Razorpay settlement records against a bank statement and an
internal ledger. Deterministic rules resolve exact matches; an LLM is called
only for genuine exceptions (blind payments, bulk settlements) and never gets
execution authority — it proposes a structured resolution, the app validates
and decides.

## Status: Day 1 — ingestion + normalization

What exists right now:
- `src/config.js` — env loading, `live` vs `fixture` mode switch
- `src/razorpayAdapter.js` — Razorpay Settlement Recon ingestion, same
  interface for live API calls and fixture files
- `src/normalizeSettlement.js` — raw response → internal model, including the
  net-settlement waterfall check (gross → fee → tax → net)
- `fixtures/settlement-recon-sample.json` — schema-accurate placeholder data
  (real Razorpay field names, but not a live capture)
- `scripts/captureFixture.js` — run once test-mode keys work, to capture a
  real response
- `scripts/verifyAdapter.js` — smoke test: ingests, normalizes, prints a
  waterfall pass/fail summary

Not built yet (later days): cross-record matching, synthetic bank
statement/ledger generators, LLM exception layer, evaluation metrics,
dashboard, `DECISIONS.md`.

## Setup

```bash
npm install
cp .env.example .env   # defaults to fixture mode, no keys needed to start
npm run verify-adapter
```

Expect output like:

```
Records ingested: 4
  pay_SAMPLE0000001    payment    gross=  50000 fee= 1000 tax= 180 net=  48820  waterfall=ok
  ...
[verify] PASS — adapter and normalizer are working end to end.
```

## Switching to live Razorpay data

1. Get **test-mode** keys from the Razorpay Dashboard → API Keys.
2. In `.env`: set `SETTLEMENT_SOURCE_MODE=live`, fill in `RAZORPAY_KEY_ID` /
   `RAZORPAY_KEY_SECRET`, set `SETTLEMENT_YEAR` / `MONTH` / `DAY` to a date
   with settlement activity in your test account.
3. `npm run capture-fixture` — writes a real response to
   `fixtures/settlement-recon-captured.json`.
4. Either point `FIXTURE_PATH` at the captured file, or keep both: the sample
   fixture for fast iteration, the captured one as proof of a real
   integration for the pitch/demo.

A test-mode account with no settled test payments yet will legitimately
return an empty `items[]` — that's a valid response, not a bug. Create a test
payment and wait for it to settle (or pick a day that has activity).

## Known correction from the original plan

The original architecture doc assumed a Node method called
`instance.settlements.settlementRecon({...})`. Checked against the real
`razorpay-node` SDK docs: that method doesn't exist for Node — it's PHP-only.
The Node SDK reuses `instance.settlements.reports({ year, month, day })` for
both the settlement-batch summary (no `day`) and the day-level recon (with
`day`). Fixed in `src/razorpayAdapter.js` before anything downstream depended
on the wrong name.
