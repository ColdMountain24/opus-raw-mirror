import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import { ADAPTERS } from '../../src/dispatcher/adapters/index.js';
import { createCircuitBreaker, OPEN } from '../../src/dispatcher/circuitBreaker.js';
import * as sim from '../../src/dispatcher/simulator.js';

// The settings-modal surface on the dispatcher: probe (single-provider test),
// breakerState, live failover reorder, global HIPAA mode, and cache clear.

function openProvider(breaker, name) {
  breaker.recordFailure(name);
  breaker.recordFailure(name);
  breaker.recordFailure(name);
}

describe('dispatcher diagnostics + live config', () => {
  it('probe reports a pass when the provider responds through the seam', async () => {
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: { anthropic: sim.always(sim.success({ ok: true })) },
      failoverSequence: ['anthropic', 'groq', 'mistral'],
    });
    const out = await d.probe('anthropic');
    expect(out.ok).toBe(true);
    expect(out.provider).toBe('anthropic');
    expect(out.breaker).toBe('CLOSED');
  });

  it('probe reports an honest failure when no transport is wired', async () => {
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: {}, // nothing wired, as in the app today
      failoverSequence: ['anthropic', 'groq', 'mistral'],
    });
    const out = await d.probe('groq');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('transport_not_wired');
  });

  it('probe short-circuits when the breaker is open', async () => {
    const breaker = createCircuitBreaker({ clock: () => 0 });
    openProvider(breaker, 'anthropic');
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: { anthropic: sim.always(sim.success()) },
      failoverSequence: ['anthropic'],
      breaker,
    });
    const out = await d.probe('anthropic');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('circuit_open');
    expect(out.breaker).toBe(OPEN);
  });

  it('breakerState reflects the breaker', () => {
    const breaker = createCircuitBreaker({ clock: () => 0 });
    const d = createDispatcher({ adapters: ADAPTERS, breaker, failoverSequence: ['anthropic'] });
    expect(d.breakerState('anthropic')).toBe('CLOSED');
    openProvider(breaker, 'anthropic');
    expect(d.breakerState('anthropic')).toBe(OPEN);
  });

  it('setFailoverOrder changes which provider leads, in place', async () => {
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: {
        anthropic: sim.always(sim.success({ text: 'a' })),
        groq: sim.always(sim.success({ text: 'g' })),
      },
      failoverSequence: ['anthropic', 'groq', 'mistral'],
    });
    expect(await d.dispatch({ agentId: 'x', messages: [], safeDefault: 'SD' })).toEqual({ text: 'a' });
    d.setFailoverOrder(['groq', 'anthropic', 'mistral']);
    expect(await d.dispatch({ agentId: 'x2', messages: [], safeDefault: 'SD' })).toEqual({ text: 'g' });
  });

  it('setHipaaMode forces ollama-only for every call', async () => {
    let anthropicHits = 0;
    const d = createDispatcher({
      adapters: ADAPTERS,
      transports: {
        ollama: sim.always(sim.success({ text: 'local' })),
        anthropic: async () => {
          anthropicHits += 1;
          return sim.success({ text: 'a' })();
        },
      },
      failoverSequence: ['anthropic', 'groq', 'mistral'],
    });
    d.setHipaaMode(true);
    const out = await d.dispatch({ agentId: 'phi', messages: [], safeDefault: 'SD' });
    expect(out).toEqual({ text: 'local' });
    expect(anthropicHits).toBe(0);
  });

  it('clearCache delegates to the cache', () => {
    const clear = vi.fn();
    const d = createDispatcher({
      adapters: ADAPTERS,
      cache: { keyFor: () => null, get: () => undefined, set: () => {}, clear },
      failoverSequence: ['anthropic'],
    });
    d.clearCache();
    expect(clear).toHaveBeenCalled();
  });
});
