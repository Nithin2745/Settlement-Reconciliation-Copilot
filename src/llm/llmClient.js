// src/llm/llmClient.js
//
// Day 3: the real network layer — Groq primary, OpenRouter/Nemotron 3 Super
// fallback (ADR-003), via plain fetch (Node 18+ has it globally; no groq-sdk
// dependency). Both providers speak the OpenAI chat-completions shape, so one
// request builder serves both.
//
// This file is deliberately the ONLY place that touches the network for the
// LLM layer. resolveExceptions.js takes an injectable `llmCaller` that
// defaults to callLlmWithFallback exported here — so tests can either swap in
// a fake caller (pure orchestration logic) or leave the real caller in place
// and mock global.fetch instead, which exercises this actual fallback code
// path with no network access. verifyLlmLayer.js does the latter.
//
// Three things here were learned the hard way against the live providers and are
// the reason the layer works at all; see the comments on config.llm.maxTokens:
//   1. Both models are reasoning models. A 500-token budget was consumed by the
//      chain of thought before any JSON existed, so Groq 400'd and OpenRouter
//      returned prose. The budget must leave room for reasoning AND the answer.
//   2. `response_format: {type:'json_object'}` is ENFORCED by Groq and IGNORED
//      by OpenRouter for Nemotron. It is still sent to both (it measurably
//      improves compliance) but is never relied on — validateDecision.js treats
//      every response as untrusted text.
//   3. The failure that actually happens in a long batch is a rate limit, not an
//      outage, and the two need opposite handling. At 120 records five transient
//      Groq 429s retired the primary for the rest of the run and pushed every
//      remaining record onto OpenRouter's 20-req/min free tier, which failed 4 of
//      them. So: honour the provider's own `retry-after` instead of a blind
//      backoff that retries inside the window it just asked us to wait out, and
//      let the breaker expire and re-probe rather than latch.

const { config, assertLlmIsConfigured } = require('../config');

// Transient == worth retrying the same provider. A 4xx other than 429 means the
// request itself is wrong, so a retry would fail identically and just burn quota.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

class LlmProviderError extends Error {
  constructor(provider, message, { status = null, retryable = false, retryAfterMs = null } = {}) {
    super(`[${provider}] ${message}`);
    this.name = 'LlmProviderError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    // How long the provider itself asked us to wait, when it said so. Null means
    // it did not, and the caller falls back to its own backoff.
    this.retryAfterMs = retryAfterMs;
  }
}

// A rate-limited provider usually tells you exactly how long to wait, and both of
// ours do it differently: OpenRouter sets a `retry-after` header, Groq puts
// "Please try again in 1.785s" in the JSON body. Ignoring both — as a blind 250ms
// backoff does — guarantees the retry lands inside the window the provider just
// told us to sit out, so it burns a call to be told the same thing again.
const RETRY_AFTER_IN_BODY = /try again in ([\d.]+)\s*(ms|s)\b/i;

function parseRetryAfterMs(headerValue, body) {
  if (headerValue) {
    const seconds = Number(headerValue);
    // Numeric form is seconds (RFC 9110); the HTTP-date form is legal too, hence
    // the Date fallback rather than treating a non-number as absent.
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const when = Date.parse(headerValue);
    if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  }
  const match = body && RETRY_AFTER_IN_BODY.exec(body);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return match[2].toLowerCase() === 'ms' ? value : value * 1000;
  }
  return null;
}

// Provider-specific knobs to suppress or shorten the chain of thought. Both are
// pure latency/compliance wins measured on the real endpoints (Groq 1769ms ->
// 1144ms, OpenRouter 1997ms -> 578ms) and neither changes the response schema.
// Unknown providers get nothing extra, which is always safe.
const REASONING_OPTS_BY_PROVIDER = {
  groq: { reasoning_effort: 'low' },
  openrouter: { reasoning: { enabled: false } },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callChatCompletion({
  apiUrl,
  apiKey,
  model,
  systemPrompt,
  userPrompt,
  timeoutMs,
  providerLabel,
  maxTokens = config.llm.maxTokens,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1, // low — this is a structured-decision task, not creative writing
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...(REASONING_OPTS_BY_PROVIDER[providerLabel] || {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError here is our own timeout firing, which is transient by nature.
    const isAbort = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    throw new LlmProviderError(providerLabel, `request failed: ${err.message}`, {
      retryable: true,
      status: isAbort ? 408 : null,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmProviderError(
      providerLabel,
      `HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
      {
        status: res.status,
        retryable: RETRYABLE_STATUS.has(res.status),
        retryAfterMs: parseRetryAfterMs(res.headers && res.headers.get('retry-after'), body),
      }
    );
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    // Seen in practice when a reasoning model spends the whole budget thinking:
    // finish_reason 'length' with empty content. Retrying the same provider can
    // genuinely succeed, so this counts as transient.
    const finish = data?.choices?.[0]?.finish_reason;
    throw new LlmProviderError(
      providerLabel,
      `response contained no message content (finish_reason=${finish})`,
      { retryable: true }
    );
  }

  return { raw: content, provider: providerLabel, finishReason: data?.choices?.[0]?.finish_reason };
}

/**
 * Batch-scoped failure counter. Without this, a hard-down primary costs one
 * doomed round-trip per record before every single fallback call — 50 wasted
 * calls on a 50-record batch. Created per batch rather than module-global so
 * two runs in the same process (and the test suite) never inherit each other's
 * state.
 *
 * It trips, but it does not latch. The first 120-record live run showed why:
 * five transient Groq 429s (each of which said "try again in ~2s") retired the
 * primary for the remaining ~25 records, so every one of them went to
 * OpenRouter's free tier — which is capped at 20 requests/minute — and 4 records
 * ended as LLM_ERROR with nothing wrong on either provider's side. A rate limit
 * means "you are going too fast", not "I am broken", and the two need different
 * handling. So an open breaker expires after `cooldownMs` and lets one request
 * probe the primary again: a genuinely dead provider re-trips on that probe and
 * costs one call per cooldown window instead of one per record, while a
 * throttled one gets picked back up as soon as its bucket refills.
 */
function createBreaker(
  threshold = config.llm.primaryFailureThreshold,
  cooldownMs = config.llm.primaryCooldownMs
) {
  return {
    consecutiveFailures: 0,
    open: false,
    openedAt: null,
    threshold,
    cooldownMs,
    recordFailure() {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.threshold) {
        this.open = true;
        // Re-stamped on every failure while already open, so a failed probe
        // restarts the cooldown rather than letting the next record probe again.
        this.openedAt = Date.now();
      }
    },
    recordSuccess() {
      this.consecutiveFailures = 0;
      this.open = false;
      this.openedAt = null;
    },
    /**
     * True while the primary should be skipped outright. False once the cooldown
     * has elapsed — the half-open probe — even though `open` is still true, which
     * is what keeps "the breaker tripped" observable separately from "the primary
     * is being bypassed right now".
     */
    shouldSkipPrimary() {
      if (!this.open) return false;
      if (this.cooldownMs <= 0) return true;
      return Date.now() - this.openedAt < this.cooldownMs;
    },
  };
}

async function attemptProvider({ provider, systemPrompt, userPrompt, attempts }) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await callChatCompletion({
        apiUrl: provider.apiUrl,
        apiKey: provider.apiKey,
        model: provider.model,
        systemPrompt,
        userPrompt,
        timeoutMs: config.llm.requestTimeoutMs,
        providerLabel: provider.provider,
      });
    } catch (err) {
      lastError = err;
      if (!err.retryable || attempt === attempts) break;
      // Short linear backoff by default. Deliberately not exponential: the whole
      // point of having a second provider is that we fail over quickly rather
      // than sit in a retry loop while a batch of 50 waits behind us.
      //
      // When the provider named its own wait, honour it — but only up to a
      // ceiling. Past that, failing over to the other provider is strictly
      // faster than waiting, which is the entire reason there are two.
      const backoffMs = 250 * attempt;
      const askedFor = err.retryAfterMs;
      const waitMs =
        Number.isFinite(askedFor) && askedFor > backoffMs
          ? Math.min(askedFor, config.llm.maxRetryAfterWaitMs)
          : backoffMs;
      if (waitMs > backoffMs) {
        console.warn(
          `[llmClient] ${provider.provider} asked for ${Math.round(askedFor)}ms — ` +
            `waiting ${Math.round(waitMs)}ms before retry ${attempt + 1}/${attempts}`
        );
      }
      await sleep(waitMs);
    }
  }

  throw lastError;
}

/**
 * Groq first; on failure (network error, timeout, non-2xx, empty content), fall
 * through to OpenRouter. This IS ADR-003 — the fallback is a real code path, not
 * a comment, and verifyLlmLayer.js proves it executes by mocking fetch to fail
 * the primary call.
 *
 * @param {object} [breaker] - from createBreaker(); pass the same one across a
 *   batch so a dead primary is skipped after `primaryFailureThreshold` failures.
 */
async function callLlmWithFallback({ systemPrompt, userPrompt, breaker = null }) {
  assertLlmIsConfigured();
  const { primary, fallback, maxAttemptsPerProvider } = config.llm;

  const skipPrimary = !primary.apiKey || (breaker && breaker.shouldSkipPrimary());
  // An open breaker whose cooldown has expired: this call is the probe.
  const isProbe = !skipPrimary && breaker && breaker.open;

  if (!skipPrimary) {
    try {
      const result = await attemptProvider({
        provider: primary,
        systemPrompt,
        userPrompt,
        attempts: maxAttemptsPerProvider,
      });
      if (breaker) {
        if (isProbe) {
          console.warn(`[llmClient] primary (${primary.provider}) recovered — breaker closed`);
        }
        breaker.recordSuccess();
      }
      return result;
    } catch (err) {
      // Swallow and fall through deliberately — a primary-provider failure must
      // never surface as a whole-pipeline failure when a fallback is configured.
      // Logged, not thrown, so the audit trail shows this happened without
      // stopping the batch.
      if (breaker) {
        const wasOpen = breaker.open;
        breaker.recordFailure();
        if (breaker.open && !wasOpen) {
          console.warn(
            `[llmClient] primary (${primary.provider}) failed ${breaker.consecutiveFailures}x in a row — ` +
              `skipping it for the next ${breaker.cooldownMs}ms`
          );
        }
      }
      console.warn(`[llmClient] primary (${primary.provider}) failed, falling back: ${err.message}`);
    }
  }

  if (!fallback.apiKey) {
    throw new LlmProviderError(
      'fallback',
      'primary failed or is unset, and no fallback API key is configured'
    );
  }

  return attemptProvider({
    provider: fallback,
    systemPrompt,
    userPrompt,
    attempts: maxAttemptsPerProvider,
  });
}

module.exports = {
  callLlmWithFallback,
  callChatCompletion,
  createBreaker,
  parseRetryAfterMs,
  LlmProviderError,
  RETRYABLE_STATUS,
};
