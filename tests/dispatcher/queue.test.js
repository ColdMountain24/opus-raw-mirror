import { describe, expect, it } from 'vitest';
import { createQueue } from '../../src/dispatcher/queue.js';
import { RATE_LIMITS, THROTTLE } from '../../src/dispatcher/RATE_LIMITS.js';
import { RequestError } from '../../src/dispatcher/errors.js';

// 5d: request queue. Virtual time so window math is deterministic and instant.
// acquire() resolves with the admission timestamp; Promise.all returns those by
// position regardless of resolution order.
function virtualTime() {
  const ref = { now: 0 };
  return {
    clock: () => ref.now,
    sleep: (ms) => {
      ref.now += Math.max(0, ms);
      return Promise.resolve();
    },
  };
}

describe('request queue (5d)', () => {
  it('encodes the user-provided rate limits and 80% throttle', () => {
    expect(RATE_LIMITS.anthropic).toEqual({ rpm: 50, itpm: 40_000, otpm: 8_000 });
    expect(RATE_LIMITS.groq).toEqual({ rpm: 30, tpm: 6_000 });
    expect(RATE_LIMITS.mistral.rps).toBe(1);
    expect(THROTTLE).toBe(0.8);
  });

  it('caps requests at 80% of RPM, then admits the overflow a window later', async () => {
    const vt = virtualTime();
    const q = createQueue({ limits: { anthropic: { rpm: 50 } }, ...vt }); // cap = 40
    const times = await Promise.all(
      Array.from({ length: 41 }, () => q.acquire('anthropic', {})),
    );
    expect(times.slice(0, 40).every((t) => t === 0)).toBe(true);
    expect(times[40]).toBe(60_000);
  });

  it('enforces RPM and token limits independently', async () => {
    // ITPM-bound: RPM is generous, but two 60-token requests exceed a 100 cap.
    const vt1 = virtualTime();
    const q1 = createQueue({ limits: { p: { rpm: 100, itpm: 100 } }, throttle: 1, ...vt1 });
    const t1 = await Promise.all([
      q1.acquire('p', { tokensIn: 60 }),
      q1.acquire('p', { tokensIn: 60 }),
    ]);
    expect(t1).toEqual([0, 60_000]);

    // RPM-bound: tokens are generous, but a cap of 1 holds the second request.
    const vt2 = virtualTime();
    const q2 = createQueue({ limits: { p: { rpm: 1, itpm: 100_000 } }, throttle: 1, ...vt2 });
    const t2 = await Promise.all([
      q2.acquire('p', { tokensIn: 10 }),
      q2.acquire('p', { tokensIn: 10 }),
    ]);
    expect(t2).toEqual([0, 60_000]);
  });

  it('rejects a request that alone exceeds a token cap (no slot consumed)', async () => {
    const vt = virtualTime();
    const q = createQueue({ limits: { p: { itpm: 100 } }, throttle: 1, ...vt });
    await expect(q.acquire('p', { tokensIn: 200 })).rejects.toBeInstanceOf(RequestError);
  });

  it('honors a Mistral-style minimum interval', async () => {
    const vt = virtualTime();
    const q = createQueue({ limits: { mistral: { rps: 1 } }, throttle: 1, ...vt }); // 1 req/s
    const times = await Promise.all([
      q.acquire('mistral', {}),
      q.acquire('mistral', {}),
      q.acquire('mistral', {}),
    ]);
    expect(times).toEqual([0, 1000, 2000]);
  });

  it('drains the priority lane ahead of FIFO normal requests', async () => {
    const vt = virtualTime();
    const q = createQueue({ limits: { x: { rpm: 1 } }, throttle: 1, ...vt });
    // first saturates the single slot; then B, C (normal) and D (critical) wait.
    const [first, b, c, d] = await Promise.all([
      q.acquire('x', {}),
      q.acquire('x', {}),
      q.acquire('x', {}),
      q.acquire('x', { priority: 'critical' }),
    ]);
    // D (critical) jumps ahead of B and C; B before C preserves FIFO.
    expect([first, d, b, c]).toEqual([0, 60_000, 120_000, 180_000]);
  });
});
