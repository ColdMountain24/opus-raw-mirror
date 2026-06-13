import { describe, expect, it, vi } from 'vitest';
import { createHipaaResolver, hipaaResolver, HIPAA_SEQUENCE } from '../../src/dispatcher/hipaa.js';
import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import { createCircuitBreaker } from '../../src/dispatcher/circuitBreaker.js';
import { FAILOVER_SEQUENCE } from '../../src/dispatcher/failover.js';
import { ADAPTERS } from '../../src/dispatcher/adapters/index.js';
import * as sim from '../../src/dispatcher/simulator.js';

// 5h: HIPAA enforcement. A HIPAA session routes to Ollama only, before the
// breaker and the queue, and never falls back to a hosted provider.

function counters() {
  const hits = { anthropic: 0, groq: 0, mistral: 0, ollama: 0 };
  const tap = (name, step) => async () => {
    hits[name] += 1;
    return step();
  };
  return { hits, tap };
}

describe('HIPAA enforcement (5h)', () => {
  it('resolves to ollama only when the flag is set, otherwise null', () => {
    expect(HIPAA_SEQUENCE).toEqual(['ollama']);
    expect(hipaaResolver({ hipaa: true })).toEqual(['ollama']);
    expect(hipaaResolver({})).toBeNull();
    expect(hipaaResolver(undefined)).toBeNull();
    expect(createHipaaResolver()({ hipaa: true })).toEqual(['ollama']);
  });

  it('routes a HIPAA session to ollama and contacts no hosted provider', async () => {
    const { hits, tap } = counters();
    const logger = vi.fn();
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: {
        anthropic: tap('anthropic', sim.success({ text: 'anthropic' })),
        groq: tap('groq', sim.success({ text: 'groq' })),
        mistral: tap('mistral', sim.success({ text: 'mistral' })),
        ollama: tap('ollama', sim.success({ text: 'ollama' })),
      },
      failoverSequence: FAILOVER_SEQUENCE,
      hipaaResolver,
      logger,
    });

    const out = await d.dispatch({
      messages: [],
      agentId: 'a',
      safeDefault: 'SAFE',
      loopContext: { hipaa: true },
    });

    expect(out).toEqual({ text: 'ollama' });
    expect(hits).toEqual({ anthropic: 0, groq: 0, mistral: 0, ollama: 1 });
    expect(logger.mock.calls.map(([e]) => e.type)).toContain('hipaa:enforced');
  });

  it('does not fall back to a hosted provider even when ollama is down', async () => {
    const { hits, tap } = counters();
    const breaker = createCircuitBreaker({ clock: () => 0 });
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: {
        anthropic: tap('anthropic', sim.success()),
        groq: tap('groq', sim.success()),
        mistral: tap('mistral', sim.success()),
        ollama: tap('ollama', sim.server503()),
      },
      failoverSequence: FAILOVER_SEQUENCE,
      hipaaResolver,
      breaker,
    });

    const out = await d.dispatch({
      messages: [],
      agentId: 'a',
      safeDefault: 'SAFE',
      loopContext: { hipaa: true },
    });

    expect(out).toBe('SAFE'); // ollama failed; no hosted fallback
    expect(hits.anthropic).toBe(0);
    expect(hits.groq).toBe(0);
    expect(hits.mistral).toBe(0);
  });

  it('uses the normal sequence when there is no HIPAA flag', async () => {
    const { hits, tap } = counters();
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: {
        anthropic: tap('anthropic', sim.success({ text: 'anthropic' })),
        groq: tap('groq', sim.success()),
        mistral: tap('mistral', sim.success()),
        ollama: tap('ollama', sim.success()),
      },
      failoverSequence: FAILOVER_SEQUENCE,
      hipaaResolver,
    });

    const out = await d.dispatch({ messages: [], agentId: 'a', safeDefault: 'SAFE' });
    expect(out).toEqual({ text: 'anthropic' });
    expect(hits).toEqual({ anthropic: 1, groq: 0, mistral: 0, ollama: 0 });
  });
});
