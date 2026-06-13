import { describe, expect, it } from 'vitest';
import { createRetry } from '../../src/dispatcher/backoff.js';
import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import * as sim from '../../src/dispatcher/simulator.js';
import {
  RateLimitError,
  ServerError,
  TimeoutError,
  RequestError,
  OverloadedError,
} from '../../src/dispatcher/errors.js';

// 5e: retry with exponential backoff and jitter.
function recorder() {
  const slept = [];
  return {
    slept,
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
}

describe('retry with backoff (5e)', () => {
  it('backs off 1s, 2s, 4s across a 4-attempt cap, then gives up', async () => {
    const r = recorder();
    const retry = createRetry({ sleep: r.sleep, random: () => 0 });
    let calls = 0;
    await expect(
      retry.run(async () => {
        calls += 1;
        throw new ServerError();
      }),
    ).rejects.toBeInstanceOf(ServerError);
    expect(calls).toBe(4);
    expect(r.slept).toEqual([1000, 2000, 4000]);
  });

  it('adds bounded jitter on top of the computed backoff', async () => {
    const r = recorder();
    const retry = createRetry({ sleep: r.sleep, random: () => 1, jitter: 0.5 });
    await expect(retry.run(async () => { throw new ServerError(); })).rejects.toBeTruthy();
    expect(r.slept).toEqual([1500, 3000, 6000]); // computed + 50%
  });

  it('honors retry-after over the computed backoff', async () => {
    const r = recorder();
    const retry = createRetry({ sleep: r.sleep, random: () => 0 });
    let calls = 0;
    const out = await retry.run(async () => {
      calls += 1;
      if (calls === 1) throw new RateLimitError('429', { retryAfterMs: 5000 });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(r.slept).toEqual([5000]); // server value, not 1000
  });

  it('retries a timeout', async () => {
    const r = recorder();
    const retry = createRetry({ sleep: r.sleep, random: () => 0 });
    let calls = 0;
    const out = await retry.run(async () => {
      calls += 1;
      if (calls < 3) throw new TimeoutError();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(r.slept).toEqual([1000, 2000]);
  });

  it('never retries a 4xx request error', async () => {
    const r = recorder();
    const retry = createRetry({ sleep: r.sleep });
    let calls = 0;
    await expect(
      retry.run(async () => {
        calls += 1;
        throw new RequestError('400', { status: 400 });
      }),
    ).rejects.toBeInstanceOf(RequestError);
    expect(calls).toBe(1);
    expect(r.slept).toEqual([]);
  });

  it('on 529 overloaded, backs off once then hands off to failover', async () => {
    const r = recorder();
    const retry = createRetry({ sleep: r.sleep });
    let calls = 0;
    await expect(
      retry.run(async () => {
        calls += 1;
        throw new OverloadedError();
      }),
    ).rejects.toBeInstanceOf(OverloadedError);
    expect(calls).toBe(1);
    expect(r.slept).toEqual([1000]);
  });

  it('integrates with dispatch: a transient 503 is retried then succeeds', async () => {
    const r = recorder();
    const d = createDispatcher({
      adapters: {
        mock: {
          name: 'mock',
          template: (m) => ({ messages: m }),
          parse429: () => ({}),
          send: (req, { transport }) => transport(req),
        },
      },
      transports: { mock: sim.sequence([sim.server503(), sim.success({ text: 'ok' })]) },
      failoverSequence: ['mock'],
      retry: createRetry({ sleep: r.sleep, random: () => 0 }),
      sleep: r.sleep,
      random: () => 0,
    });
    const out = await d.dispatch({ messages: [], agentId: 'a', safeDefault: 'SAFE' });
    expect(out).toEqual({ text: 'ok' });
    expect(r.slept).toEqual([1000]);
  });
});
