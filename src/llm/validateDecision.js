// src/llm/validateDecision.js
//
// Day 3: the application-layer acceptance gate (ADR-002 / master doc §4.7).
// The LLM has zero execution authority — this is the code that actually
// decides whether a proposed decision gets accepted. Every field is checked
// against a closed vocabulary; every candidate_id is checked against the
// exact candidate set that exception was actually offered, so a fabricated
// id (hallucination) is caught deterministically rather than trusted.
//
// Scope discipline matters here, and it is narrower than it first looks. This
// gate rejects claims that are unactionable (two opposed reason codes, so which
// one is load-bearing changes the answer) or that cite evidence the payload never
// contained (bulk arithmetic with no UTR group — a fabricated evidence class,
// the same failure mode as a hallucinated id). It deliberately does NOT referee
// debatable judgment, and — since the first real provider run — it no longer
// rejects a sound decision over an untidy justification: a reason code the
// payload disproves is dropped, recorded as a warning, and the decision stands
// on what survives. Rejecting a correct match because the model padded its
// reason codes buys no safety and costs coverage. Every check below is decidable
// from the payload alone.

const { ALLOWED_DECISIONS, ALLOWED_REASON_CODES } = require('./prompt');
const { config } = require('../config');

const DECISIONS_REQUIRING_CANDIDATE = new Set(['CONFIRM_MATCH', 'REJECT_MATCH', 'MATCH_CANDIDATE']);

// Both configured models are reasoning models. Even with response_format set
// and reasoning suppressed, they intermittently emit a sentence of preamble
// before the object ("We need to output JSON with candidate_id, ...") —
// observed verbatim from OpenRouter/Nemotron, which does not enforce
// response_format. Stripping fences is not enough for that; we have to locate
// the object itself. Brace counting is string-aware and escape-aware so a
// closing brace inside a narration value ("NEFT CR {ref}") cannot end the
// scan early.
function findFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null; // unbalanced — truncated mid-object (finish_reason 'length')
}

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  // Defensive only — the prompt forbids markdown fences, but models don't
  // always comply, and re-prompting costs another call.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch {
    // Fall through to the brace scan rather than failing: prose-wrapped JSON
    // is a formatting failure, not a reasoning failure, and the decision
    // inside it is still worth validating on its merits.
  }

  const candidate = findFirstJsonObject(stripped);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}


function collectKnownCandidateIds(payload) {
  const ids = new Set();
  for (const c of payload.bank_candidates || []) ids.add(c.candidate_id);
  for (const c of payload.ledger_candidates || []) ids.add(c.candidate_id);
  const dc = payload.deterministic_context || {};
  if (dc.existing_bank_match) ids.add(dc.existing_bank_match.candidate_id);
  if (dc.existing_ledger_match) ids.add(dc.existing_ledger_match.candidate_id);
  if (dc.utr_group && dc.utr_group.bankCreditExternalId) ids.add(dc.utr_group.bankCreditExternalId);
  ids.delete(undefined);
  ids.delete(null);
  return ids;
}

// Reason-code pairs that cannot both be true, split by what the contradiction
// actually costs. That split was forced by the first real provider run: 3 of 4
// validator rejections were CORRECT decisions naming real candidate ids, thrown
// away only because gpt-oss-120b had padded its justification with both amount
// codes at once. Rejecting a right answer over an untidy label is a bad trade —
// it buys no safety and costs coverage — so the two cases are now distinct:
//
//   OPPOSED   — the codes assert opposite verdicts, so which one is load-bearing
//               changes the answer. The decision is unactionable; reject it.
//   REDUNDANT — the codes point the same way and differ only in strictness. The
//               payload's own amount_agrees flag already says which is true, so
//               the surplus code is dropped, a warning is recorded, and the
//               decision stands on what survives.
const OPPOSED_REASON_CODES = [
  ['BULK_SETTLEMENT_ARITHMETIC_OK', 'BULK_SETTLEMENT_ARITHMETIC_MISMATCH'],
];

const REDUNDANT_AMOUNT_CODES = ['EXACT_AMOUNT', 'AMOUNT_WITHIN_WATERFALL_DRIFT'];

// Kept as an export for continuity: callers that only want "can these two codes
// coexist" still get the complete list, regardless of how each pair is handled.
const MUTUALLY_EXCLUSIVE_REASON_CODES = [...OPPOSED_REASON_CODES, REDUNDANT_AMOUNT_CODES];

// Mirrors matchEngine.EXACT_METHODS. Not imported, deliberately: this module is
// a gate over the *payload*, and the payload carries method names as opaque
// strings. Importing the matcher here would couple the validator to the engine
// whose output it is supposed to check independently.
const EXACT_REFERENCE_METHODS = new Set(['EXACT_UTR', 'EXACT_ORDER_ID', 'EXACT_ORDER_RECEIPT']);

// Values we put IN the payload that models keep echoing back OUT as reason
// codes. Observed on two consecutive real runs: gpt-oss-120b answered
// 'EXACT_ORDER_ID' — copied verbatim from deterministic_context.
// existing_ledger_match.method — and was rejected for an out-of-vocabulary code
// on a record it had otherwise judged correctly.
//
// This is vocabulary translation, not a loosened contract. The alias only ever
// resolves to EXACT_REFERENCE_MATCH, which still has to clear its own evidence
// requirement below, so a model echoing a method name on a record with no shared
// reference is still rejected. And it is deliberately restricted to strings we
// ourselves sent in the payload: the model is repeating our own field value, not
// inventing a code, which is what makes accepting it verifiable rather than
// generous. Anything genuinely invented still fails REASON_CODE_NOT_ALLOWED.
const REASON_CODE_ALIASES = new Map(
  [...EXACT_REFERENCE_METHODS].map((method) => [method, 'EXACT_REFERENCE_MATCH'])
);

/**
 * Could EXACT_REFERENCE_MATCH possibly be true here? Either the deterministic
 * engine already matched a side on an exact reference, or one of the settlement's
 * own references literally appears in an offered candidate's refs.
 */
function payloadHasSharedReference(p) {
  const dc = p.deterministic_context || {};
  for (const m of [dc.existing_bank_match, dc.existing_ledger_match]) {
    if (m && EXACT_REFERENCE_METHODS.has(m.method)) return true;
  }

  const s = p.settlement || {};
  const wanted = new Set([s.settlement_utr, s.order_id, s.order_receipt].filter(Boolean));
  if (wanted.size === 0) return false;

  const candidates = [...(p.bank_candidates || []), ...(p.ledger_candidates || [])];
  return candidates.some((c) =>
    Object.values((c && c.refs) || {}).some((v) => v && wanted.has(v))
  );
}

// A reason code claims a class of evidence. If the payload never carried that
// evidence, the claim is fabricated — the same failure mode as a hallucinated
// candidate_id, and just as deterministically checkable. Each predicate answers
// "could this code possibly be true given what we actually sent?"
const REASON_CODE_EVIDENCE_REQUIREMENTS = {
  BULK_SETTLEMENT_ARITHMETIC_OK: (p) => !!(p.deterministic_context || {}).utr_group,
  BULK_SETTLEMENT_ARITHMETIC_MISMATCH: (p) => !!(p.deterministic_context || {}).utr_group,
  // "Two or more candidates are equally plausible" requires two or more
  // candidates to have been offered in the first place.
  INDISTINGUISHABLE_CANDIDATES: (p) =>
    (p.bank_candidates || []).length + (p.ledger_candidates || []).length >= 2,
  EXACT_REFERENCE_MATCH: payloadHasSharedReference,
};

// The prompt binds this code to one decision: indistinguishable candidates are
// the stated reason for declining, so citing it while also naming a single
// winner is the model contradicting itself in the same object.
const REASON_CODE_REQUIRED_DECISION = {
  INDISTINGUISHABLE_CANDIDATES: 'NO_MATCH_FOUND',
};

/**
 * What the deterministic engine already told the model about the amounts on the
 * side(s) it proposed: true if any proposed side's amount agrees, false if every
 * proposed side disagrees, null if nothing was proposed (a MATCH_CANDIDATE pick
 * has no amount_agrees flag yet, so neither amount code can be disproved).
 */
function confirmedAmountAgreement(payload) {
  const dc = payload.deterministic_context || {};
  const sides = [dc.existing_bank_match, dc.existing_ledger_match].filter(Boolean);
  if (sides.length === 0) return null;
  if (sides.some((m) => m.amount_agrees === true)) return true;
  if (sides.every((m) => m.amount_agrees === false)) return false;
  return null;
}

/**
 * Checks that the reason codes are jointly true — with each other, with the
 * decision, and with the payload's own computed flags.
 *
 * @returns {{reject: string|null, warnings: string[], reasonCodes: string[]}}
 *   `reject` is a rejection reason, or null if the decision may stand.
 *   `reasonCodes` is the surviving list with disproved/redundant codes removed.
 */
function checkReasonCodeCoherence(reasonCodes, decision, payload) {
  const codes = new Set(reasonCodes);
  const warnings = [];

  for (const [a, b] of OPPOSED_REASON_CODES) {
    if (codes.has(a) && codes.has(b)) {
      return { reject: `CONTRADICTORY_REASON_CODES:${a}+${b}`, warnings, reasonCodes };
    }
  }

  for (const code of codes) {
    const requires = REASON_CODE_EVIDENCE_REQUIREMENTS[code];
    if (requires && !requires(payload)) {
      return { reject: `EVIDENCE_NOT_IN_PAYLOAD:${code}`, warnings, reasonCodes };
    }

    const requiredDecision = REASON_CODE_REQUIRED_DECISION[code];
    if (requiredDecision && decision !== requiredDecision) {
      return { reject: `REASON_CODE_CONTRADICTS_DECISION:${code}`, warnings, reasonCodes };
    }
  }

  // Amount codes: resolved from the payload rather than rejected. Skipped
  // entirely when a utr_group is present — in a bulk settlement the shared
  // credit legitimately equals the COMBINED net of the siblings rather than this
  // record's own net, so "exact" has a second valid meaning and neither code can
  // be disproved from amount_agrees alone.
  const [exact, drift] = REDUNDANT_AMOUNT_CODES;
  if (!(payload.deterministic_context || {}).utr_group) {
    // Strictly false: we ourselves told the model the amounts do not agree, so
    // EXACT_AMOUNT cannot be part of the justification.
    if (codes.has(exact) && confirmedAmountAgreement(payload) === false) {
      codes.delete(exact);
      warnings.push(`DROPPED_UNSUPPORTED_REASON_CODE:${exact}`);
    }

    // Redundant rather than false: an exact amount is trivially also within
    // drift. Keep the stronger claim, drop the padding. Note the asymmetry —
    // AMOUNT_WITHIN_WATERFALL_DRIFT on its own is never dropped, because it is a
    // weaker true statement about equal amounts, not a wrong one.
    if (codes.has(exact) && codes.has(drift)) {
      codes.delete(drift);
      warnings.push(`DROPPED_REDUNDANT_REASON_CODE:${drift}`);
    }
  }

  if (codes.size === 0) {
    // Every reason the model gave was disproved by the payload. The decision
    // itself may even be right, but nothing is left justifying it, and an
    // unjustified decision is precisely what this gate exists to stop.
    return { reject: 'NO_SUPPORTED_REASON_CODES', warnings, reasonCodes: [] };
  }

  return { reject: null, warnings, reasonCodes: [...codes] };
}

/**
 * @param {string} rawResponse - the raw text content returned by the LLM
 * @param {object} payload - the exact candidate payload this response is answering (from buildCandidatePayload)
 * @returns {{accepted: boolean, reason: string, parsed: object|null, reasonCodes?: string[], warnings?: string[], downgraded?: boolean}}
 *   `reasonCodes` is the sanitized justification — the model's list with any code
 *   the payload disproves removed. Prefer it over parsed.reason_codes; `parsed`
 *   is left exactly as the model returned it so the audit trail keeps the
 *   unedited original.
 */
function validateDecision(rawResponse, payload = {}) {
  const parsed = extractJson(rawResponse);
  if (!parsed || typeof parsed !== 'object') {
    return { accepted: false, reason: 'MALFORMED_JSON', parsed: null };
  }

  const { candidate_id: candidateId, decision, confidence, reason_codes: reasonCodes } = parsed;

  if (!ALLOWED_DECISIONS.includes(decision)) {
    return { accepted: false, reason: 'INVALID_DECISION', parsed };
  }

  if (typeof confidence !== 'number' || Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
    return { accepted: false, reason: 'INVALID_CONFIDENCE', parsed };
  }

  if (!Array.isArray(reasonCodes) || reasonCodes.length === 0) {
    return { accepted: false, reason: 'MISSING_REASON_CODES', parsed };
  }
  // Translate echoed payload field values into their real code before the
  // vocabulary check, so a model repeating our own `method` string isn't
  // rejected for it. Aliased codes still face every check below.
  const aliasWarnings = [];
  const normalizedCodes = reasonCodes.map((c) => {
    const alias = REASON_CODE_ALIASES.get(c);
    if (!alias) return c;
    aliasWarnings.push(`ALIASED_REASON_CODE:${c}->${alias}`);
    return alias;
  });
  const badCode = normalizedCodes.find((c) => !ALLOWED_REASON_CODES.includes(c));
  if (badCode) {
    return { accepted: false, reason: `REASON_CODE_NOT_ALLOWED:${badCode}`, parsed };
  }

  if (decision === 'NO_MATCH_FOUND') {
    if (candidateId) {
      return { accepted: false, reason: 'CANDIDATE_ID_WITH_NO_MATCH', parsed };
    }
  } else if (DECISIONS_REQUIRING_CANDIDATE.has(decision)) {
    if (!candidateId) {
      return { accepted: false, reason: 'MISSING_CANDIDATE_ID', parsed };
    }
    // The hallucination gate: candidate_id must be one this exact exception
    // actually offered. Never trust the model's claim that it exists.
    const knownIds = collectKnownCandidateIds(payload);
    if (!knownIds.has(candidateId)) {
      return { accepted: false, reason: 'HALLUCINATED_CANDIDATE_ID', parsed };
    }
    // Extra check for MATCH_CANDIDATE specifically: the id must be in the
    // offered candidate lists, not merely equal to some other known id (e.g.
    // an existing_bank_match id, which MATCH_CANDIDATE should never be
    // pointing at — that shape calls for CONFIRM_MATCH instead).
    if (decision === 'MATCH_CANDIDATE') {
      const offered = [...(payload.bank_candidates || []), ...(payload.ledger_candidates || [])];
      if (!offered.some((c) => c.candidate_id === candidateId)) {
        return { accepted: false, reason: 'CANDIDATE_NOT_IN_OFFERED_SET', parsed };
      }
    }
  }

  // Codes are individually legal by here; this checks they are jointly true.
  // It can also *narrow* them: a code the payload disproves is dropped and
  // recorded as a warning rather than sinking an otherwise sound decision.
  const coherence = checkReasonCodeCoherence(normalizedCodes, decision, payload);
  const warnings = [...aliasWarnings, ...coherence.warnings];

  if (coherence.reject) {
    return {
      accepted: false,
      reason: coherence.reject,
      parsed,
      reasonCodes: coherence.reasonCodes,
      warnings,
    };
  }

  if (confidence < config.llm.confidenceThreshold) {
    // Structurally valid, just not trusted enough to auto-accept. Kept
    // separate from outright rejection so the audit trail can distinguish
    // "the model was honest but unsure" from "the model was wrong."
    return {
      accepted: false,
      reason: 'BELOW_CONFIDENCE_THRESHOLD',
      parsed,
      reasonCodes: coherence.reasonCodes,
      warnings,
      downgraded: true,
    };
  }

  return {
    accepted: true,
    reason: 'OK',
    parsed,
    reasonCodes: coherence.reasonCodes,
    warnings,
  };
}

module.exports = {
  validateDecision,
  extractJson,
  findFirstJsonObject,
  collectKnownCandidateIds,
  checkReasonCodeCoherence,
  confirmedAmountAgreement,
  payloadHasSharedReference,
  MUTUALLY_EXCLUSIVE_REASON_CODES,
  OPPOSED_REASON_CODES,
  REDUNDANT_AMOUNT_CODES,
  REASON_CODE_ALIASES,
};
