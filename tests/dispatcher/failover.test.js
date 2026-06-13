import { describe, expect, it, vi } from 'vitest';
import { FAILOVER_SEQUENCE, availableProviders } from '../../src/dispatcher/failover.js';
import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import { createCircuitBreaker, OPEN } from '../../src/dispatcher/circuitBreaker.js';
import { ADAPTERS } from '../../src/dispatcher/adapters/index.js';
import * as sim from '../../src/dispatcher/simulator.js';

// 5g: provider failover. Uses the real adapters with injected transports, a real
// breaker, and the default one-attempt retry so a single failure fails over.

function setup(transports, breaker) {
  const logger = vi.fn();
  const d = createDispatcher({
    adapters: ADAPTERS,
    transports,
    failoverSequence: FAILOVER_SEQUENCE,
    breaker,
    logger,
  });
  return { d, logger };
}

function openProviders(breaker, names) {
  for (const name of names) {
    breaker.recordFailure(name);
    breaker.recordFailure(name);
    breaker.recordFailure(name);
  }
}

const call = (d) => d.dispatch({ messages: [], agentId: 'a', safeDefault: 'SAFE' });

describe('failover sequence (5g)', () => {
  it('exposes the canonical order and a pure availability filter', () => {
    expect(FAILOVER_SEQUENCE).toEqual(['anthropic', 'groq', 'mistral']);
    const breaker = { isOpen: (n) => n === 'anthropic' };
    expect(availableProviders(FAILOVER_SEQUENCE, breaker)).toEqual(['groq', 'mistral']);
  });

  it('walks claude -> groq -> mistral and lands on the first healthy provider', async () => {
    const breaker = createCircuitBreaker({ clock: () => 0 });
    const { d, logger } = setup(
      {
        anthropic: sim.always(sim.server503()),
        groq: sim.always(sim.server503()),
        mistral: sim.always(sim.success({ text: 'from-mistral' })),
      },
      breaker,
    );
    const out = await call(d);
    expect(out).toEqual({ text: 'from-mistral' });
    const types = logger.mock.calls.map(([e]) => e);
    expect(types.filter((e) => e.type === 'failover:next').map((e) => e.from)).toEqual([
      'anthropic',
      'groq',
    ]);
    expect(types.find((e) => e.type === 'dispatch:success').provider).toBe('mistral');
  });

  it('starts at groq when claude is OPEN', async () => {
    const breaker = createCircuitBreaker({ clock: () => 0 });
    openProviders(breaker, ['anthropic']);
    let anthropicCalled = 0;
    const { d, logger } = setup(
      {
        anthropic: async () => {
          anthropicCalled += 1;
          return sim.success()();
        },
        groq: sim.always(sim.success({ text: 'from-groq' })),
        mistral: sim.always(sim.success()),
      },
      breaker,
    );
    const out = await call(d);
    expect(out).toEqual({ text: 'from-groq' });
    expect(anthropicCalled).toBe(0); // open provider never contacted
    expect(logger.mock.calls.map(([e]) => e).some(
      (e) => e.type === 'failover:skip' && e.provider === 'anthropic',
    )).toBe(true);
  });

  it('goes to mistral when claude and groq are OPEN', async () => {
    const breaker = createCircuitBreaker({ clock: () => 0 });
    openProviders(breaker, ['anthropic', 'groq']);
    const { d } = setup(
      {
        anthropic: sim.always(sim.success()),
        groq: sim.always(sim.success()),
        mistral: sim.always(sim.success({ text: 'from-mistral' })),
      },
      breaker,
    );
    expect(await call(d)).toEqual({ text: 'from-mistral' });
  });

  it('returns the safe default and warns when all three are OPEN', async () => {
    const breaker = createCircuitBreaker({ clock: () => 0 });
    openProviders(breaker, ['anthropic', 'groq', 'mistral']);
    expect(breaker.stateOf('mistral')).toBe(OPEN);
    let contacted = 0;
    const tap = async () => {
      contacted += 1;
      return sim.success()();
    };
    const { d, logger } = setup(
      { anthropic: tap, groq: tap, mistral: tap },
      breaker,
    );
    const out = await call(d);
    expect(out).toBe('SAFE');
    expect(contacted).toBe(0);
    expect(logger.mock.calls.map(([e]) => e.type)).toContain('providers:exhausted');
  });
});
