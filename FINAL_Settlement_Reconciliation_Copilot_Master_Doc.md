# Settlement Reconciliation Copilot — Final Project Document

*Razorpay AI Builder Internship 2026 · Track 4: AI Finance Controller*
*Locked Aug 31, 2026 · Deadline Sept 5, 2026 (5 build days) · FINAL — build starts now*

---

## 0. Verification note

Before locking anything, competitor/benchmark claims were checked, since sourced research can include fabricated repos. Honest status of each:

| Claim | Status |
|---|---|
| `srikrishna0603/razorpay-buildathon` ("Revenue Resilience AI") | **Confirmed real.** Primary-key idempotency locks, sandboxed LLM proposes diagnoses only (no execution authority), deterministic policy engine decides. |
| `SamarthKapdi/RiskPulse` (Track 2) | Referenced earlier, not re-verified this round — treat as likely real, lower confidence. |
| `SS072/Rezorpay` (Track 2) | **Confirmed real.** Sub-30ms P99 gating, in-memory bipartite graph, FastAPI + React. Shows the general bar of competitor polish. |
| `PratikGhawate/FinRCA-AI-Bench` | **Not found. Could not verify this repo exists.** Do not cite it. |
| `mollie/ai` | **Confirmed real.** Official Mollie AI agent toolkit, includes a "Settlement reconciliation agent" on the OpenAI Agents SDK. |
| Microsoft Dynamics 365 Copilot bank-reconciliation pattern | Not independently re-verified; plausible, treat as directional inspiration only. |
| Razorpay Smart Collect / virtual accounts | **Confirmed real.** 16-digit Customer Identifiers, Virtual UPI IDs (`rpy.payto00000<descriptor>@<bank>`). Razorpay auto-reconciles *these specific flows* — your edge is cross-source reconciliation (PSP + independent bank statement + internal ledger), which isn't automated. |

**Bottom line:** deterministic-first/LLM-for-exceptions is a confirmed industry benchmark, not a differentiator by itself. One claimed reference (FinRCA-AI-Bench) does not check out.

---

## 1. The problem, precisely

Reconciliation confirms that three independent records of the same money movement — PSP settlement, bank statement, internal ledger — actually agree. It breaks in three specific ways:

- **Settlement timing lag** — T+1/T+2 settlement, often under a different reference number, so naive same-day matching fails even when nothing's wrong.
- **Format fragmentation** — every PSP exports differently; multi-PSP businesses reconcile against multiple incompatible schemas at once.
- **Ambiguous-but-legitimate records** — **blind payments** (no invoice reference) and **bulk settlements** (one credit covering several invoices) get wrongly bucketed with genuine errors by a rigid rules engine, when most are resolvable with judgment.

## 2. Why it matters — the evidence

- Reconciliation consumes an estimated **40 hours/week** for a mid-size fintech finance team.
- **~3 hours/day just preparing data** before reconciliation can start (~700 hrs/year).
- Manual reconciliation carries an estimated **15% discrepancy rate**; contributes to **20%+ of operational hurdles** fintechs report.
- **70%+ of companies** still rely on manual/spreadsheet reconciliation.
- Qualitative cost: analyst burnout from rote correction work, linked to turnover in the sourced surveys.

*(Sourcing: industry surveys — Kani Payments 2025, Optimus Fintech, NAYA Finance — not first-person complaint threads, unlike the Track 3 research earlier in this project.)*

## 3. The solution

A **Settlement Reconciliation Copilot** closing one finance-ops loop end-to-end: ingest Razorpay settlement records, a synthetic bank statement, and a synthetic internal ledger — produce a match rate plus an honest, explained, *measured* exception list.

**Core design principle: restraint.** Deterministic rules handle certainty; the LLM is called only where genuine judgment is needed, and never gets execution authority — it proposes, the application layer decides.

## 4. What actually differentiates this submission

Table-stakes (everyone competent will have these): deterministic-first matching, 50+ record batch processing, an audit trail. What actually separates a strong submission:

### 4.1 Razorpay-native settlement mechanics
Models Razorpay's actual net settlement waterfall explicitly: gross amount → payment method/platform fees → tax → refunds/chargebacks → transfers → net settled amount — using real field names from the Settlement Recon API (`amount`, `fee`, `tax`, `settled`).

### 4.2 Smart Collect–aware exception handling
Synthetic bank-statement lines echo real Razorpay Smart Collect structure (virtual UPI IDs like `rpy.payto00000acmevendor@icici`, 16-digit Customer Identifiers), deliberately mangled for blind-payment/bulk-settlement cases — so the LLM resolves realistic messiness, not invented messiness.

### 4.3 Batch Stress-Test Dashboard
A live view over a 100+ record batch, showing as it processes: deterministic match rate, AI exception match rate (with measured precision, not just confidence — see 4.6), unresolved rate, and a downloadable CSV/JSON audit trail of every record's resolution path.

### 4.4 DECISIONS.md — Architecture Decision Records
- **ADR 001 — Deterministic Engine First:** why exact matches bypass the LLM (cost, latency, determinism).
- **ADR 002 — Probabilistic Layer for Exceptions Only:** structured JSON output, never raw execution authority.
- **ADR 003 — Primary/Fallback LLM Provider:** why Groq is primary, OpenRouter/Nemotron 3 Super is fallback.
- **ADR 004 — Live API + Fixture Ingestion:** why the ingestion layer supports both (see 4.5).

### 4.5 API fixture fallback — reliability, not a shortcut
The Razorpay ingestion layer supports two modes behind the same interface:
```
Razorpay Adapter
       ↓
Normalized Settlement Model
       ↓
Matcher
```
- `mode: 'live'` → calls the real Settlement Recon API.
- `mode: 'fixture'` → loads a captured real API response (or a schema-accurate fixture) from a local JSON file.

This is professional engineering, not cheating — say exactly that in the pitch: *"The production ingestion path uses Razorpay's Settlement Recon API. For reproducible stress-testing and demo reliability, the same engine also accepts captured API fixtures."* This exists specifically so a flaky test-mode account, empty settlement history, or API hiccup during the live demo never breaks the submission.

### 4.6 Ground-truth evaluation — measured, not claimed
The synthetic data generator secretly knows the correct answer for every record before deliberately corrupting the observable fields (dropping narrations, mangling references, splitting bulk settlements). After matching runs, compare results against that ground truth to report real metrics, not impressions:

- **Deterministic precision**
- **AI precision** (correct AI matches ÷ total AI matches proposed — e.g., 17 correct of 18 proposed = 94.4%)
- **Overall reconciliation accuracy**
- **False-positive rate**
- **Unresolved rate**
- **LLM calls avoided** (e.g., "86% of records reconciled without touching the LLM at all" — a strong, quotable line for the pitch)

This is the difference between "the AI said it's 94% confident" and "we measured the AI at 94.4% precision against ground truth." The second is defensible under judge questioning; the first isn't.

### 4.7 Constrained LLM output — no blind trust
The LLM never returns free-form json like `{"match": true, "confidence": 0.94}`. It must return a constrained, structured shape:
```json
{
  "candidate_id": "INV-2841",
  "decision": "MATCH",
  "confidence": 0.94,
  "reason_codes": ["SMART_COLLECT_IDENTIFIER", "EXACT_AMOUNT", "DATE_WITHIN_WINDOW"]
}
```
The application layer validates every field before accepting it as a resolution: does the candidate exist, is the amount compatible, is the date compatible, is confidence above threshold, are the reason codes from an allowed set. Only then is it logged as an accepted AI resolution. This makes the AI layer resistant to hallucinated or malformed financial decisions — and directly strengthens the "AI Judgment" story.

## 5. Why this beats the alternatives

| | Traditional rules-only | LLM-only ("CSV → LLM → reconciled") | This Copilot |
|---|---|---|---|
| Exact matches | Yes | Wasteful (burns inference on certainty) | Yes |
| T+1/T+2 lag handling | Partial | Partial | Yes |
| Blind payments | No | Partial, unverified | Yes, with measured precision |
| Bulk settlements | No | Partial, unverified | Yes, with measured precision |
| Deterministic where possible | Yes | No | Yes |
| Explainable | Partial | Partial | Yes — reason codes + audit trail |
| AI cost | Low | High | Low (LLM only on genuine exceptions) |
| Auditability | Yes | No | Yes |
| Financial execution by AI | N/A | Risk of yes | Never — proposes only |

**Positioning line for the pitch:** *"Don't ask an LLM to reconcile your books. Ask it to explain the exceptions your rules can't resolve."*

## 6. Architecture

```
   [Razorpay Settlement Recon API]        [Synthetic bank        [Synthetic
   live OR captured fixture                statement]             ledger]
   entity_id, type, settlement_utr,       (Smart Collect-         (invoices,
   order_id, amount, fee, tax, settled     style narrations,       ground-truth
               │                           deliberately corrupted  mapping kept
               │                           against known           internally)
               │                           ground truth)               │
               └──────────────┬───────────────────────────────────────┘
                              ▼
               ┌───────────────────────────────────┐
               │      Deterministic Match Engine     │
               │  settlement_utr / order_id exact     │
               │  match; net-settlement waterfall     │
               │  validated; amount + date proximity  │
               │        (no LLM — plain rules)        │
               └───────────────────────────────────┘
                     │                        │
                matched                  unresolved
                     │                        │
                     ▼                        ▼
            ┌─────────────┐      ┌───────────────────────┐
            │  Audit Log   │◄─────┤   LLM Exception Layer  │
            │  (SQLite)    │      │  Groq (gpt-oss-120b)   │
            │              │      │  → OpenRouter/Nemotron │
            │              │      │  3 Super (fallback)    │
            │              │      │  constrained JSON out: │
            │              │      │  candidate + decision +│
            │              │      │  confidence + reason   │
            │              │      │  codes → app validates │
            └─────────────┘      └───────────────────────┘
                     │
                     ▼
      ┌────────────────────────────────────┐
      │  Batch Stress-Test Dashboard         │
      │  live progress · match rate by path  │
      │  ground-truth precision/recall       │
      │  downloadable audit CSV/JSON         │
      └────────────────────────────────────┘
```

## 7. Tech stack (unchanged, confirmed)

| Layer | Choice |
|---|---|
| Runtime | Node.js |
| Razorpay integration | `razorpay` npm SDK — `instance.settlements.settlementRecon({ year, month, day })`, with fixture-mode fallback |
| LLM primary | `groq-sdk` npm package, model `openai/gpt-oss-120b` |
| LLM fallback | OpenRouter (`nvidia/nemotron-3-super-120b-a12b:free`) via try/catch |
| Data store | `better-sqlite3` — local, zero-config |
| Fuzzy matching | `string-similarity` or `fuzzball` |
| Dashboard | Simple local web view — real-time batch progress, ground-truth metrics, downloadable audit export |
| Deployment | None — local repo + demo video is the deliverable |

## 8. Evaluation criteria mapping

| Criterion | How this project answers it |
|---|---|
| **Problem Taste** | Named failure modes (blind payments, bulk settlements, T+1/T+2 lag) + Razorpay-specific mechanics, backed by industry figures |
| **Build Quality** | Local, dependency-light; deterministic core tested before the LLM layer; stress-tested on 100+ messy records; fixture-mode for demo reliability; DECISIONS.md documents design intent |
| **AI Judgment** | Deterministic-first by design; LLM has zero execution authority; constrained structured output validated before acceptance; measured (not claimed) AI precision against ground truth |
| **Failure Recovery** | Build log from day one; Groq→OpenRouter fallback is a live, demonstrable recovery mechanism; API fixture fallback prevents a live-demo dependency failure |

## 9. Build order — locked, starting now

1. Get Razorpay test-mode keys working against the Settlement Recon endpoint; capture one real response as a fixture immediately, regardless of whether live data is available.
2. Build the deterministic matcher against real field names, including the net-settlement waterfall check.
3. Build synthetic bank statement + ledger generators with an internal ground-truth mapping, using real Smart Collect narration structure, deliberately corrupted for exception cases.
4. Wire the Groq→OpenRouter LLM exception layer with constrained JSON output + application-side validation.
5. Build the ground-truth evaluation layer: precision, recall, false-positive rate, LLM-calls-avoided.
6. Build the batch dashboard with live metrics + downloadable audit export.
7. Write DECISIONS.md and the build log (real bugs, as they happen).
8. Stress-test against 100+ messy records before recording the pitch.

This document is final. No new features get added to this scope — reliability, then evaluation metrics, then demo UI, then documentation, in that priority order.
