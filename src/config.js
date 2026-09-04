// src/config.js
// Single place that reads process.env so the rest of the app never touches
// process.env directly. Makes it obvious what the app depends on, and makes
// testing/fixture-mode trivial (just don't set the Razorpay keys).

require('dotenv').config();

const VALID_MODES = ['live', 'fixture'];

// `Number(x) || fallback` is wrong for every knob whose valid range includes 0,
// and it silently swallows typos: Number('') and Number('typo') are both falsy,
// so LLM_CONFIDENCE_THRESHOLD=0 (a legitimate "accept everything" ablation) and
// LLM_CONFIDENCE_THRESHOLD=typo BOTH quietly became the default. Unset falls
// back; set-but-unparseable throws, per this file's own fail-early contract.
function numberFromEnv(name, fallback, { min, max } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw.trim() === '') return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`${name} must be >= ${min}, got ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`${name} must be <= ${max}, got ${parsed}`);
  }
  return parsed;
}

const mode = (process.env.SETTLEMENT_SOURCE_MODE || 'fixture').toLowerCase();

if (!VALID_MODES.includes(mode)) {
  throw new Error(
    `SETTLEMENT_SOURCE_MODE must be one of ${VALID_MODES.join(', ')}, got "${mode}"`
  );
}

const config = {
  mode, // 'live' | 'fixture'

  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
  },

  settlementQuery: {
    year: Number(process.env.SETTLEMENT_YEAR) || new Date().getFullYear(),
    month: Number(process.env.SETTLEMENT_MONTH) || new Date().getMonth() + 1,
    day: process.env.SETTLEMENT_DAY ? Number(process.env.SETTLEMENT_DAY) : undefined,
  },

  fixturePath: process.env.FIXTURE_PATH || 'fixtures/settlement-recon-sample.json',

  // Day 3: Groq is primary, OpenRouter/Nemotron 3 Super is fallback (ADR-003).
  // Both are OpenAI-compatible chat-completions endpoints, so llmClient.js can
  // use one request shape for both. `llama-3.3-70b-versatile` is deprecated as
  // of June 2026 on Groq, hence gpt-oss-120b as the primary model.
  llm: {
    primary: {
      provider: 'groq',
      apiUrl: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: process.env.GROQ_API_KEY || '',
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    },
    fallback: {
      provider: 'openrouter',
      apiUrl: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      model: process.env.OPENROUTER_MODEL || 'nvidia/nemotron-3-super-120b-a12b:free',
    },
    // Below this, a structurally valid decision is still not auto-accepted —
    // see validateDecision.js. This is a knob, not a hardcoded magic number.
    confidenceThreshold: numberFromEnv('LLM_CONFIDENCE_THRESHOLD', 0.7, { min: 0, max: 1 }),
    maxCandidatesPerException: numberFromEnv('LLM_MAX_CANDIDATES', 5, { min: 0 }),
    requestTimeoutMs: numberFromEnv('LLM_TIMEOUT_MS', 30000, { min: 1 }),
    // Both configured models are reasoning models: they emit a chain of thought
    // before the answer. At 500 the reasoning alone exhausted the budget and no
    // JSON was ever produced — Groq (which enforces response_format) returned
    // HTTP 400 json_validate_failed with an empty generation, and OpenRouter
    // (which does not enforce it for Nemotron) returned raw prose that failed to
    // parse. Measured: 7 of 10 real calls rejected as MALFORMED_JSON. At 2500
    // every provider/parameter combination parses first try. See ADR-003.
    maxTokens: numberFromEnv('LLM_MAX_TOKENS', 2500, { min: 1 }),
    // Retries apply only to the SAME provider before failing over, and only for
    // transient failures (timeout / 429 / 5xx). A 400 is deterministic — the
    // request itself is wrong — so retrying it just burns quota.
    maxAttemptsPerProvider: numberFromEnv('LLM_ATTEMPTS_PER_PROVIDER', 2, { min: 1 }),
    // After this many consecutive primary failures in one batch, stop trying the
    // primary at all and go straight to the fallback. Without it, a hard-down
    // Groq costs one doomed call per record (50 wasted round-trips on a 50-record
    // batch) before every single fallback call.
    primaryFailureThreshold: numberFromEnv('LLM_PRIMARY_FAILURE_THRESHOLD', 3, { min: 1 }),
    // ...but it un-trips. An open breaker is re-probed once this long has passed,
    // because the failure it most often sees is a rate limit, not an outage. On
    // the first 120-record live run, five transient Groq 429s sidelined the
    // primary for the rest of the batch and pushed everything onto OpenRouter's
    // 20-requests/minute free tier, which then failed 4 records outright. 15s is
    // longer than the 1-8s Groq asks for and long enough for a per-minute token
    // bucket to refill meaningfully, while still giving a long batch several
    // chances to pick the primary back up. Set 0 to latch open for the batch.
    primaryCooldownMs: numberFromEnv('LLM_PRIMARY_COOLDOWN_MS', 15000, { min: 0 }),
    // Ceiling on honouring a provider's own `retry-after`. Past this, failing over
    // to the other provider is strictly faster than waiting — which is the entire
    // reason there are two of them.
    maxRetryAfterWaitMs: numberFromEnv('LLM_MAX_RETRY_AFTER_WAIT_MS', 5000, { min: 0 }),
  },
};

// Fail loudly and early rather than making a confusing API call with empty keys.
function assertLiveModeIsConfigured() {
  if (config.mode !== 'live') return;
  if (!config.razorpay.keyId || !config.razorpay.keySecret) {
    throw new Error(
      'SETTLEMENT_SOURCE_MODE=live but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are missing. ' +
        'Set them in .env, or switch to SETTLEMENT_SOURCE_MODE=fixture.'
    );
  }
}

// Same philosophy as assertLiveModeIsConfigured: fail before making a network
// call, not during one. At least one of the two providers must be usable —
// the LLM layer's own primary/fallback logic (llmClient.js) handles the case
// where only one of the two is actually configured.
function assertLlmIsConfigured() {
  if (!config.llm.primary.apiKey && !config.llm.fallback.apiKey) {
    throw new Error(
      'Neither GROQ_API_KEY nor OPENROUTER_API_KEY is set. ' +
        'Set at least one in .env before running the LLM exception layer.'
    );
  }
}

module.exports = { config, assertLiveModeIsConfigured, assertLlmIsConfigured, numberFromEnv };
