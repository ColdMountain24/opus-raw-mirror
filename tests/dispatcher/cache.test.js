import { describe, expect, it, vi } from 'vitest';
import { createCache } from '../../src/dispatcher/cache.js';
import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import * as sim from '../../src/dispatcher/simulator.js';

// 5i: localStorage packet cache. Isolated in-memory storage stub per test.
function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

function mockDispatcher(cache, onSent) {
  let calls = 0;
  const logger = vi.fn();
  const d = createDispatcher({
    adapters: {
      mock: {
        name: 'mock',
        template: (m) => ({ messages: m }),
        parse429: () => ({}),
        send: (req, { transport }) => transport(req),
      },
    },
    transports: {
      mock: async () => {
        calls += 1;
        if (onSent) onSent();
        return sim.success({ text: 'ok' })();
      },
    },
    failoverSequence: ['mock'],
    cache,
    logger,
  });
  return { d, logger, calls: () => calls };
}

describe('packet cache (5i)', () => {
  it('keys by input packet and agent id', () => {
    const cache = createCache({ storage: memStorage() });
    const base = { agentId: 'a', messages: [{ role: 'user', content: 'hi' }] };
    expect(cache.keyFor(base)).toBe(cache.keyFor({ ...base }));
    expect(cache.keyFor(base)).not.toBe(cache.keyFor({ ...base, agentId: 'b' }));
    expect(cache.keyFor(base)).not.toBe(
      cache.keyFor({ ...base, messages: [{ role: 'user', content: 'bye' }] }),
    );
    expect(cache.keyFor({ messages: [] })).toBeNull(); // no agentId
  });

  it('stores on miss and reads back on hit', () => {
    const cache = createCache({ storage: memStorage() });
    const spec = { agentId: 'a', messages: [{ role: 'user', content: 'hi' }] };
    const key = cache.keyFor(spec);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, { text: 'cached' });
    expect(cache.get(key)).toEqual({ text: 'cached' });
  });

  it('a hit returns the cached result and skips the LLM call', async () => {
    const cache = createCache({ storage: memStorage() });
    const { d, logger, calls } = mockDispatcher(cache);
    const spec = { messages: [{ role: 'user', content: 'hi' }], agentId: 'a', safeDefault: 'SD' };

    const first = await d.dispatch(spec);
    expect(first).toEqual({ text: 'ok' });
    expect(calls()).toBe(1);

    const second = await d.dispatch(spec);
    expect(second).toEqual({ text: 'ok' });
    expect(calls()).toBe(1); // no second LLM call
    expect(logger.mock.calls.map(([e]) => e.type)).toContain('cache:hit');
  });

  it('a different agent id misses and calls the provider again', async () => {
    const cache = createCache({ storage: memStorage() });
    const { d, calls } = mockDispatcher(cache);
    const messages = [{ role: 'user', content: 'hi' }];
    await d.dispatch({ messages, agentId: 'a', safeDefault: 'SD' });
    await d.dispatch({ messages, agentId: 'b', safeDefault: 'SD' });
    expect(calls()).toBe(2);
  });

  it('reports a storage failure through the logger instead of throwing', () => {
    const logger = vi.fn();
    const broken = {
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {
        throw new Error('boom');
      },
      length: 0,
      key: () => null,
    };
    const cache = createCache({ storage: broken, logger });
    expect(() => cache.set('k', { a: 1 })).not.toThrow();
    expect(cache.get('k')).toBeUndefined();
    expect(logger.mock.calls.map(([e]) => e.type)).toContain('cache:error');
  });
});
