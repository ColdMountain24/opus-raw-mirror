import { describe, expect, it } from 'vitest';
import { headerGet, retryAfterToMs } from '../../src/dispatcher/parse429helpers.js';
import { anthropic } from '../../src/dispatcher/adapters/anthropic.js';
import { groq } from '../../src/dispatcher/adapters/groq.js';
import { mistral } from '../../src/dispatcher/adapters/mistral.js';
import { errorFromResponse, RateLimitError, OverloadedError } from '../../src/dispatcher/errors.js';
import * as sim from '../../src/dispatcher/simulator.js';

// 5f: each provider sends 429 in a different format. The parsers extract the
// correct retry interval regardless of format.

describe('429 parsers (5f)', () => {
  it('retryAfterToMs handles seconds and HTTP dates', () => {
    expect(retryAfterToMs('5')).toBe(5000);
    expect(retryAfterToMs('2.5')).toBe(2500);
    expect(retryAfterToMs('')).toBeUndefined();
    expect(retryAfterToMs(undefined)).toBeUndefined();
    const now = 1_000_000;
    const date = new Date(now + 10_000).toUTCString();
    expect(retryAfterToMs(date, now)).toBe(10_000);
  });

  it('headerGet is case-insensitive', () => {
    expect(headerGet({ 'Retry-After': '3' }, 'retry-after')).toBe('3');
    expect(headerGet({ 'X-RateLimit-Remaining': '0' }, 'x-ratelimit-remaining')).toBe('0');
  });

  it('anthropic reads retry-after and flags 529 overloaded', () => {
    const r429 = anthropic.parse429(sim.rate429({ retryAfter: 7 })());
    expect(r429.retryAfterMs).toBe(7000);
    expect(r429.overloaded).toBe(false);

    const r529 = anthropic.parse429(sim.overloaded529()());
    expect(r529.overloaded).toBe(true);
  });

  it('anthropic falls back to x-ratelimit reset headers', () => {
    const reset = new Date(Date.now() + 30_000).toUTCString();
    const out = anthropic.parse429({
      status: 429,
      headers: { 'anthropic-ratelimit-requests-reset': reset },
      body: {},
    });
    expect(out.retryAfterMs).toBeGreaterThan(0);
    expect(out.retryAfterMs).toBeLessThanOrEqual(31_000);
  });

  it('groq reads retry-after (any casing)', () => {
    expect(groq.parse429(sim.rate429({ retryAfter: 3 })()).retryAfterMs).toBe(3000);
    expect(groq.parse429({ status: 429, headers: { 'Retry-After': '4' } }).retryAfterMs).toBe(4000);
  });

  it('mistral reads Retry-After and X-RateLimit-Remaining', () => {
    const out = mistral.parse429({
      status: 429,
      headers: { 'Retry-After': '4', 'X-RateLimit-Remaining': '0' },
    });
    expect(out.retryAfterMs).toBe(4000);
    expect(out.remaining).toBe(0);
  });

  it('feeds errorFromResponse so the typed error carries retry-after', () => {
    const rate = errorFromResponse(sim.rate429({ retryAfter: 5 })(), {
      provider: 'groq',
      parse429: groq.parse429,
    });
    expect(rate).toBeInstanceOf(RateLimitError);
    expect(rate.retryAfterMs).toBe(5000);

    const over = errorFromResponse(sim.overloaded529()(), {
      provider: 'anthropic',
      parse429: anthropic.parse429,
    });
    expect(over).toBeInstanceOf(OverloadedError);
    expect(over.failover).toBe(true);
  });
});
