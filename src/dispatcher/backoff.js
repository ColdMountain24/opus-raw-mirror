// Retry with exponential backoff and jitter (5e).
//
// Retries only on 429, 5xx, and timeout. Never retries a 4xx request error.
// Honors a retry-after value (5f) over the computed backoff. Anthropic 529
// overloaded is retryable but flagged for failover: back off briefly once, then
// give up so the dispatcher moves to the next provider.
//
// Backoff schedule doubles: 1s, 2s, 4s, 8s, ... The cap is 4 attempts, which
// uses the first three gaps (1s, 2s, 4s). Raising maxAttempts reaches 8s and
// beyond. After the cap, the last error is thrown so the failover loop runs.
//
// sleep and random are injectable (also overridable per call) for deterministic
// tests.

const BASE_MS = 1000;
const MAX_ATTEMPTS = 4;
const JITTER = 0.5; // up to +50% added to the computed delay

export function createRetry({
  maxAttempts = MAX_ATTEMPTS,
  baseMs = BASE_MS,
  jitter = JITTER,
  sleep: defaultSleep,
  random: defaultRandom,
} = {}) {
  async function run(fn, opts = {}) {
    const sleep = opts.sleep || defaultSleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const random = opts.random || defaultRandom || Math.random;

    let attempt = 0;
    let lastErr;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        // 4xx request errors and not-wired transports: do not retry here.
        if (err && err.retryable === false) throw err;

        // 529 overloaded: short backoff, then hand off to failover.
        if (err && err.failover) {
          await sleep(err.retryAfterMs != null ? err.retryAfterMs : baseMs);
          throw err;
        }

        // Retryable (429 / 5xx / timeout). Give up once the cap is reached.
        if (attempt >= maxAttempts) break;

        const computed = baseMs * 2 ** (attempt - 1);
        const delay = err && err.retryAfterMs != null
          ? err.retryAfterMs // honor retry-after over computed backoff
          : computed + random() * computed * jitter;
        await sleep(delay);
      }
    }

    throw lastErr;
  }

  return { run };
}
