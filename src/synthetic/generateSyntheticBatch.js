// src/synthetic/generateSyntheticBatch.js
//
// Day 3: synthetic bank-statement + ledger generators, with an internal
// ground-truth map, conforming exactly to:
// - the raw Razorpay Settlement Recon item shape (src/normalizeSettlement.js)
// - the ExternalRecord shape matchEngine.js was written against (Day 2)
//
// Design principle (master doc 4.6): the generator KNOWS the correct answer
// for every record before deliberately corrupting the observable fields.
// groundTruth is never passed to the matcher or the LLM layer — it exists
// so Day 5's evaluation layer can score both against reality, not just
// against each other.
//
// Seven case types, weighted per the locked distribution (mostly realistic
// traffic, a deliberate slice of every exception the LLM layer needs to
// prove itself on):
// CLEAN           45% -> FULLY_MATCHED (both exact)
// TIMING_LAG      15% -> FULLY_MATCHED (bank via proximity, ledger exact)
// BLIND_PAYMENT   12% -> PARTIAL_BANK_ONLY, but LOW-CONFIDENCE: resolved
//                        by amount+date alone, zero reference
//                        corroboration. matchEngine calls this
//                        "matched"; it is exactly the kind of
//                        single-weak-signal resolution worth flagging
//                        for review even though the status isn't
//                        UNRESOLVED. (Day 3 finding -> DECISIONS.md.)
// BULK_SETTLEMENT ~8% -> one shared settlement_utr across a group,
//                        ONE combined bank credit. First record in the
//                        group claims it (EXACT_UTR); siblings can't
//                        (pool.filter already removed it) and don't
//                        amount-match the combined credit either ->
//                        PARTIAL_LEDGER_ONLY for the rest. This is the
//                        known scope limitation flagged in Day 2's
//                        matchEngine.js comments, reproduced honestly
//                        rather than special-cased away.
// AMOUNT_MISMATCH ~8% -> settlement's own credit/debit deliberately
//                        doesn't reconcile (waterfallOk: false); bank
//                        line reflects the TRUE money movement, so it
//                        disagrees with the settlement's (wrong) net
//                        amount -> PARTIAL_LEDGER_ONLY + waterfall flag.
// AMBIGUOUS       ~5% -> pairs of settlements, identical amounts, no
//                        references anywhere -> AMBIGUOUS_PROXIMITY on
//                        both sides -> UNRESOLVED.
// ORPHAN          ~7% -> internal transfer, no order_id/receipt/utr,
//                        genuinely no bank or ledger counterpart at
//                        all -> UNRESOLVED. Not an LLM failure case —
//                        there is nothing to find. Kept in the mix so
//                        the reported unresolved rate stays honest.

const { makeRng } = require('./prng');

const BASE_DATE_MS = Date.parse('2026-08-20T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const CASE_WEIGHTS = [
  ['CLEAN', 0.45],
  ['TIMING_LAG', 0.15],
  ['BLIND_PAYMENT', 0.12],
  ['BULK_SETTLEMENT', 0.08],
  ['AMOUNT_MISMATCH', 0.08],
  ['AMBIGUOUS', 0.05],
  ['ORPHAN', 0.07],
];

const BULK_GROUP_SIZE = 3;
const AMBIGUOUS_PAIR_SIZE = 2;

const BANKS = ['icici', 'hdfc', 'sbi', 'axis', 'kotak'];
const VENDOR_DESCRIPTORS = ['acmevendor', 'blueleaf', 'zenretail', 'northgate', 'kiranashop'];

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function isoAt(offsetMs) {
  return new Date(BASE_DATE_MS + offsetMs).toISOString();
}

function unixAt(offsetMs) {
  return Math.floor((BASE_DATE_MS + offsetMs) / 1000);
}

/**
 * Compute integer counts per case type from the weighted distribution,
 * respecting grouping (bulk groups of BULK_GROUP_SIZE, ambiguous pairs of
 * AMBIGUOUS_PAIR_SIZE), with any rounding remainder folded into CLEAN so
 * the total always equals `size` exactly.
 */
function computeCounts(size) {
  const raw = Object.fromEntries(CASE_WEIGHTS.map(([k, w]) => [k, Math.round(size * w)]));

  raw.BULK_SETTLEMENT = Math.max(
    BULK_GROUP_SIZE,
    Math.round(raw.BULK_SETTLEMENT / BULK_GROUP_SIZE) * BULK_GROUP_SIZE
  );
  raw.AMBIGUOUS = Math.max(
    AMBIGUOUS_PAIR_SIZE,
    Math.round(raw.AMBIGUOUS / AMBIGUOUS_PAIR_SIZE) * AMBIGUOUS_PAIR_SIZE
  );

  const subtotal = Object.values(raw).reduce((a, b) => a + b, 0);
  raw.CLEAN += size - subtotal; // absorb rounding drift, can be negative

  if (raw.CLEAN < 0) {
    throw new Error(
      `computeCounts: batch size ${size} too small for the grouped case types ` +
        `(bulk groups of ${BULK_GROUP_SIZE}, ambiguous pairs of ${AMBIGUOUS_PAIR_SIZE}). ` +
        'Use a larger size.'
    );
  }

  return raw;
}

function makeIdFactory() {
  let n = 0;
  return (prefix) => {
    n += 1;
    return `${prefix}_SYN${pad(n, 7)}`;
  };
}

/**
 * Builds one raw Razorpay-shaped settlement item (same field names as
 * fixtures/settlement-recon-sample.json) plus zero or more bank/ledger
 * ExternalRecords, plus its ground-truth entry. Returns
 * { settlement, bankRecords, ledgerRecords, groundTruth }.
 */
function buildRecord({ rng, nextId, caseType, amountPool, groupTag }) {
  const entityId = nextId('pay');
  const amount = amountPool ?? rng.int(5000, 500000); // paise: ₹50 - ₹5,000
  const fee = Math.round(amount * 0.02);
  const tax = Math.round(fee * 0.18);

  const createdOffset = rng.int(0, 8) * DAY_MS + rng.int(0, 12) * 60 * 60 * 1000;
  const settledOffset = createdOffset + DAY_MS; // T+1 settlement, the common case

  const orderIdx = nextId('order').replace('order_SYN', '');
  const orderId = `order_SYN${orderIdx}`;
  const orderReceipt = `INV-${pad(rng.int(1, 9999), 4)}`;
  const settlementUtr = groupTag || `${unixAt(settledOffset)}syn${orderIdx}`;
  const trueNet = amount - fee - tax; // what the money movement actually is

  const settlement = {
    entity_id: entityId,
    type: 'payment',
    debit: 0,
    credit: trueNet,
    amount,
    currency: 'INR',
    fee,
    tax,
    on_hold: false,
    settled: true,
    created_at: unixAt(createdOffset),
    settled_at: unixAt(settledOffset),
    settlement_id: `setl_SYN${pad(Math.floor(settledOffset / DAY_MS) + 1, 6)}`,
    posted_at: null,
    credit_type: 'default',
    description: 'Order payment',
    notes: '{}',
    payment_id: null,
    settlement_utr: settlementUtr,
    order_id: orderId,
    order_receipt: orderReceipt,
    method: rng.choice(['upi', 'card', 'netbanking']),
    card_network: null,
    card_issuer: null,
    card_type: null,
    dispute_id: null,
  };

  const bank = {
    externalId: `bank_${entityId}`,
    source: 'bank',
    amount: trueNet,
    date: isoAt(settledOffset),
    refs: {
      utr: settlementUtr,
      orderId: null,
      orderReceipt: null,
      narration: `NEFT CR ${settlementUtr} RAZORPAY SETTLEMENT`,
    },
  };

  const ledger = {
    externalId: `ledger_${entityId}`,
    source: 'ledger',
    amount,
    date: isoAt(createdOffset - rng.int(0, 3) * DAY_MS),
    refs: {
      utr: null,
      orderId,
      orderReceipt,
      narration: null,
    },
  };

  return {
    settlement,
    trueNet,
    createdOffset,
    settledOffset,
    entityId,
    orderId,
    orderReceipt,
    settlementUtr,
    amount,
    bank,
    ledger,
  };
}

function applyCaseType(base, caseType, { rng, groupExtras } = {}) {
  const { settlement, bank, ledger } = base;
  const gt = {
    caseType,
    needsAiReview: false,
    note: '',
    trueBankExternalIds: [bank.externalId],
    trueLedgerExternalIds: [ledger.externalId],
  };

  let bankRecords = [bank];
  let ledgerRecords = [ledger];

  switch (caseType) {
    case 'CLEAN': {
      gt.note = 'Exact UTR + exact order_id on the first pass, no lag.';
      break;
    }

    case 'TIMING_LAG': {
      // Bank credit posts 1-3 days after settledAt, and (realistically) the
      // narration doesn't always echo the UTR verbatim -> forces the
      // deterministic proximity fallback rather than exact match, which is
      // exactly the T+1/T+2 case that fallback exists for.
      const lagDays = rng.int(1, 3);
      bank.date = isoAt(base.settledOffset + lagDays * DAY_MS);
      bank.refs.utr = null;
      bank.refs.narration = 'NEFT CR RAZORPAY SETTLEMENT (ref unavailable)';
      gt.note = `Bank credit lagged ${lagDays}d and UTR wasn't echoed -> resolved by amount+date proximity, not exact match.`;
      break;
    }

    case 'BLIND_PAYMENT': {
      // Genuine blind payment: no order_id/order_receipt/UTR at all. Only
      // signal is the Smart Collect virtual UPI narration. No ledger entry
      // exists (no invoice was ever raised).
      settlement.order_id = null;
      settlement.order_receipt = null;
      settlement.settlement_utr = null;
      const bankNum = rng.int(1, 9) + '0'.repeat(15 - String(rng.int(1, 9)).length);
      const descriptor = rng.choice(VENDOR_DESCRIPTORS);
      const bankName = rng.choice(BANKS);
      bank.refs.utr = null;
      bank.refs.orderId = null;
      bank.refs.orderReceipt = null;
      bank.refs.narration = `UPI CR ${bankNum} rpy.payto00000${descriptor}@${bankName}`;
      ledgerRecords = [];
      gt.trueLedgerExternalIds = [];
      gt.needsAiReview = true;
      gt.note =
        'No order/receipt/UTR anywhere -- resolved by amount+date proximity alone (single weak signal). ' +
        'matchEngine reports PARTIAL_BANK_ONLY (matched), but this is exactly the low-confidence ' +
        'resolution the LLM should re-examine using the Smart Collect narration, per master doc 4.2.';
      break;
    }

    case 'AMOUNT_MISMATCH': {
      // Settlement's own credit is deliberately wrong (waterfall breaks),
      // and the bank line reflects the true (different) net -- so even
      // amount+date proximity fails on the bank side. UTR withheld too,
      // since a bank that credited the wrong amount plausibly also
      // wouldn't echo a UTR cleanly matching Razorpay's records.
      const drift = rng.int(50, 500) * (rng.bool() ? 1 : -1); // paise
      settlement.credit = base.trueNet + drift; // now inconsistent with amount-fee-tax
      settlement.settlement_utr = null;
      bank.refs.utr = null;
      bank.refs.narration = 'NEFT CR RAZORPAY SETTLEMENT (amount variance)';
      // bank.amount stays at the TRUE net -- it disagrees with the
      // settlement's now-corrupted netAmount, so proximity also fails.
      gt.needsAiReview = true;
      gt.note = `Settlement credit corrupted by ${drift}p (waterfallOk=false); bank reflects the true net, so it can't be reference- or amount-matched.`;
      break;
    }

    case 'AMBIGUOUS': {
      // Handled by the caller (needs a partner record with the same
      // amount+window); this branch just strips all references so neither
      // side can resolve via exact match.
      settlement.order_id = null;
      settlement.order_receipt = null;
      settlement.settlement_utr = null;
      bank.refs.utr = null;
      bank.refs.narration = 'NEFT CR RAZORPAY SETTLEMENT';
      ledger.refs.orderId = null;
      ledger.refs.orderReceipt = null;
      // Snap dates so both records in the pair land in the same window.
      bank.date = isoAt(base.settledOffset);
      ledger.date = isoAt(base.createdOffset);
      gt.needsAiReview = true;
      gt.note =
        'Part of an identical-amount pair with no references -- deterministic engine ' +
        'correctly refuses to guess (AMBIGUOUS_PROXIMITY on both sides).';
      break;
    }

    case 'BULK_SETTLEMENT': {
      // groupExtras carries the shared bank line (built once per group) and
      // whether this record is the group's designated "winner" (first
      // processed, claims the shared UTR via EXACT_UTR).
      settlement.settlement_utr = groupExtras.sharedUtr;
      bankRecords = groupExtras.isWinner ? [groupExtras.sharedBank] : [];
      gt.trueBankExternalIds = [groupExtras.sharedBank.externalId];
      gt.needsAiReview = true;
      gt.note = groupExtras.isWinner
        ? `Bulk settlement group of ${groupExtras.groupSize}: this record claimed the shared combined bank credit via EXACT_UTR.`
        : `Bulk settlement group of ${groupExtras.groupSize}: UTR shared with ${groupExtras.groupSize - 1} sibling(s); the combined bank credit was already claimed, so this record is left PARTIAL_LEDGER_ONLY -- the known 1:1-simplification limitation from Day 2, reproduced honestly rather than special-cased away.`;
      break;
    }

    case 'ORPHAN': {
      // Genuine internal transfer: no order/receipt/UTR, and -- unlike
      // every other case type -- deliberately NO bank or ledger record
      // generated at all. Nothing to find; this is a true dead end.
      settlement.type = 'transfer';
      settlement.order_id = null;
      settlement.order_receipt = null;
      settlement.settlement_utr = null;
      settlement.debit = base.amount + settlement.fee + settlement.tax;
      settlement.credit = 0;
      settlement.description = null;
      bankRecords = [];
      ledgerRecords = [];
      gt.trueBankExternalIds = [];
      gt.trueLedgerExternalIds = [];
      gt.needsAiReview = false;
      gt.note =
        'True orphan: internal transfer with no customer-facing counterpart on either side. Correctly UNRESOLVED; not an LLM failure.';
      break;
    }

    default:
      throw new Error(`Unknown case type: ${caseType}`);
  }

  return { settlement, bankRecords, ledgerRecords, groundTruth: gt };
}

function generateSyntheticBatch({ size = 120, seed = 42 } = {}) {
  const rng = makeRng(seed);
  const nextId = makeIdFactory();
  const counts = computeCounts(size);

  const settlements = [];
  const bankStatement = [];
  const ledger = [];
  const groundTruth = {};

  // Flat plan of case types honoring group boundaries, then shuffled at the
  // group level so groups aren't all clustered at the end of the batch.
  const plan = [];
  for (const [caseType, count] of Object.entries(counts)) {
    if (caseType === 'BULK_SETTLEMENT') {
      for (let g = 0; g < count / BULK_GROUP_SIZE; g += 1) {
        plan.push({ caseType, groupSize: BULK_GROUP_SIZE });
      }
    } else if (caseType === 'AMBIGUOUS') {
      for (let g = 0; g < count / AMBIGUOUS_PAIR_SIZE; g += 1) {
        plan.push({ caseType, groupSize: AMBIGUOUS_PAIR_SIZE });
      }
    } else {
      for (let i = 0; i < count; i += 1) {
        plan.push({ caseType, groupSize: 1 });
      }
    }
  }

  // Fisher-Yates shuffle using the seeded rng, for deterministic-but-mixed order.
  for (let i = plan.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.float() * (i + 1));
    [plan[i], plan[j]] = [plan[j], plan[i]];
  }

  const usedAmounts = new Set();
  function uniqueAmount() {
    let a;
    do {
      a = rng.int(5000, 500000);
    } while (usedAmounts.has(a));
    usedAmounts.add(a);
    return a;
  }

  for (const item of plan) {
    if (item.caseType === 'BULK_SETTLEMENT') {
      const sharedUtr = `bulk${unixAt(rng.int(0, 8) * DAY_MS)}syn${pad(rng.int(1, 999), 3)}`;
      const settledOffset = rng.int(0, 8) * DAY_MS + DAY_MS;
      let combinedNet = 0;
      const members = [];
      for (let k = 0; k < item.groupSize; k += 1) {
        const base = buildRecord({
          rng,
          nextId,
          caseType: item.caseType,
          amountPool: uniqueAmount(),
        });
        base.settledOffset = settledOffset; // align the whole group to one settlement date
        base.bank.date = isoAt(settledOffset);
        combinedNet += base.trueNet;
        members.push(base);
      }
      const sharedBank = {
        externalId: `bank_bulk_${sharedUtr}`,
        source: 'bank',
        amount: combinedNet,
        date: isoAt(settledOffset),
        refs: {
          utr: sharedUtr,
          orderId: null,
          orderReceipt: null,
          narration: `NEFT CR ${sharedUtr} RAZORPAY SETTLEMENT (bulk, ${item.groupSize} orders)`,
        },
      };

      members.forEach((base, idx) => {
        const { settlement, bankRecords, ledgerRecords, groundTruth: gt } = applyCaseType(
          base,
          item.caseType,
          {
            rng,
            groupExtras: { sharedUtr, sharedBank, isWinner: idx === 0, groupSize: item.groupSize },
          }
        );
        settlements.push(settlement);
        bankStatement.push(...bankRecords);
        ledger.push(...ledgerRecords);
        groundTruth[base.entityId] = gt;
      });
      continue;
    }

    if (item.caseType === 'AMBIGUOUS') {
      const sharedAmount = uniqueAmount();
      const settledOffset = rng.int(0, 8) * DAY_MS + DAY_MS;
      for (let k = 0; k < item.groupSize; k += 1) {
        const base = buildRecord({
          rng,
          nextId,
          caseType: item.caseType,
          amountPool: sharedAmount,
        });
        base.settledOffset = settledOffset;
        const { settlement, bankRecords, ledgerRecords, groundTruth: gt } = applyCaseType(
          base,
          item.caseType,
          { rng }
        );
        settlements.push(settlement);
        bankStatement.push(...bankRecords);
        ledger.push(...ledgerRecords);
        groundTruth[base.entityId] = gt;
      }
      continue;
    }

    // Ungrouped case types.
    const base = buildRecord({
      rng,
      nextId,
      caseType: item.caseType,
      amountPool: uniqueAmount(),
    });
    const { settlement, bankRecords, ledgerRecords, groundTruth: gt } = applyCaseType(
      base,
      item.caseType,
      { rng }
    );
    settlements.push(settlement);
    bankStatement.push(...bankRecords);
    ledger.push(...ledgerRecords);
    groundTruth[base.entityId] = gt;
  }

  const caseTypeCounts = {};
  for (const gt of Object.values(groundTruth)) {
    caseTypeCounts[gt.caseType] = (caseTypeCounts[gt.caseType] || 0) + 1;
  }

  return {
    settlementRecon: {
      _fixture_note: `SYNTHETIC batch, seed=${seed}, size=${settlements.length}. Generated by generateSyntheticBatch for Day 3 stress-testing. Schema matches the real Settlement Recon response.`,
      entity: 'collection',
      count: settlements.length,
      items: settlements,
    },
    bankStatement,
    ledger,
    groundTruth: {
      seed,
      size: settlements.length,
      caseTypeCounts,
      records: groundTruth,
    },
  };
}

module.exports = { generateSyntheticBatch, computeCounts, CASE_WEIGHTS };
