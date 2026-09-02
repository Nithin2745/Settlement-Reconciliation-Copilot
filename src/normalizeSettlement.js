// src/normalizeSettlement.js
//
// Converts a raw Razorpay Settlement Recon response (real field names:
// entity_id, settlement_utr, amount, fee, tax, settled, ...) into the
// internal model the matcher (Day 1) will work with, and — because this is
// the one place every record passes through — validates the net-settlement
// waterfall right here: gross amount -> fees -> tax -> net settled amount.
//
// Waterfall rule, derived from Razorpay's own recon example:
//   payment / adjustment (money IN):  net = amount - fee - tax
//   refund / transfer    (money OUT): net = -(amount + fee + tax)
// net is compared against the record's own (credit - debit), which Razorpay
// already computed. A mismatch means the record's numbers don't add up —
// exactly the kind of thing that should be flagged, not silently trusted.

const KNOWN_TYPES_IN = new Set(['payment', 'adjustment']);
const KNOWN_TYPES_OUT = new Set(['refund', 'transfer']);

function unixToIso(unixSeconds) {
  if (unixSeconds === null || unixSeconds === undefined) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function expectedNet(type, amount, fee, tax) {
  if (KNOWN_TYPES_IN.has(type)) return amount - fee - tax;
  if (KNOWN_TYPES_OUT.has(type)) return -(amount + fee + tax);
  return null; // unrecognized type — skip the check rather than guess
}

function normalizeItem(raw) {
  const actualNet = (raw.credit || 0) - (raw.debit || 0);
  const expected = expectedNet(raw.type, raw.amount, raw.fee || 0, raw.tax || 0);
  const waterfallOk = expected === null ? null : expected === actualNet;

  return {
    entityId: raw.entity_id,
    type: raw.type,
    settlementId: raw.settlement_id,
    settlementUtr: raw.settlement_utr,
    orderId: raw.order_id,
    orderReceipt: raw.order_receipt,
    paymentId: raw.payment_id,

    grossAmount: raw.amount,
    fee: raw.fee || 0,
    tax: raw.tax || 0,
    debit: raw.debit || 0,
    credit: raw.credit || 0,
    netAmount: actualNet,
    currency: raw.currency,

    waterfallOk,
    waterfallExpectedNet: expected,
    waterfallNote:
      waterfallOk === false
        ? `expected net ${expected}, record shows ${actualNet} — amount/fee/tax don't reconcile`
        : null,

    settled: raw.settled,
    onHold: raw.on_hold,
    createdAt: unixToIso(raw.created_at),
    settledAt: unixToIso(raw.settled_at),

    method: raw.method,
    description: raw.description,
    disputeId: raw.dispute_id,

    raw, // keep the original for the audit trail (never discard source data)
  };
}

/**
 * @param {{entity: string, count: number, items: object[]}} reconResponse
 * @returns {{count: number, records: object[]}}
 */
function normalizeSettlementRecon(reconResponse) {
  const records = (reconResponse.items || []).map(normalizeItem);
  return {
    count: records.length,
    records,
  };
}

module.exports = { normalizeSettlementRecon, normalizeItem, expectedNet };
