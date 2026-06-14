import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, dispatch, configureDispatcher } from '../../src/dispatcher/dispatcher.js';
import * as sim from '../../src/dispatcher/simulator.js';

// 5a: dispatcher core. Verifies the orchestration spine (template -> send ->
// validate -> safe default), the single export point, and event emission,
// using a minimal injected adapter + simulator. The real adapters and the
// reliability collaborators (5b through 5i) are tested in their own suites.

function mockAdapter() {
  return {
    name: 'mock',
    template: (messages, spec) => ({ messages, temperature: spec.temperature || 0 }),
    parse429: () => ({}),
    send: (request, { transport }) => transport(request),
  };
}

function makeDispatcher(transport, extra = {}) {
  return createDispatcher({
    adapters: { mock: mockAdapter() },
    transports: { mock: transport },
    failoverSequence: ['mock'],
    ...extra,
  });
}

describe('dispatcher core (5a)', () => {
  it('exposes a single dispatch entry point', () => {
    expect(typeof dispatch).toBe('function');
    expect(typeof configureDispatcher).toBe('function');
    expect(typeof createDispatcher).toBe('function');
    expect(typeof makeDispatcher(sim.always(sim.success())).dispatch).toBe('function');
  });

  it('returns the provider body on a clean success', async () => {
    const d = makeDispatcher(sim.always(sim.success({ text: 'ok' })));
    const out = await d.dispatch({
      messages: [{ role: 'user', content: 'hi' }],
      agentId: 'agent-1',
      safeDefault: 'SAFE',
    });
    expect(out).toEqual({ text: 'ok' });
  });

  it('emits start and success events through the logger', async () => {
    const logger = vi.fn();
    const d = makeDispatcher(sim.always(sim.success({ text: 'ok' })), { logger });
    await d.dispatch({ messages: [], agentId: 'agent-1', safeDefault: 'SAFE' });
    const types = logger.mock.calls.map(([e]) => e.type);
    expect(types).toContain('dispatch:start');
    expect(types).toContain('dispatch:success');
  });

  it('runs a corrective retry when the schema fails, then returns the valid body', async () => {
    const schema = (v) => v && v.text === 'good';
    const d = makeDispatcher(
      sim.sequence([sim.success({ text: 'bad' }), sim.success({ text: 'good' })]),
    );
    const out = await d.dispatch({
      messages: [],
      agentId: 'agent-1',
      schema,
      safeDefault: 'SAFE',
    });
    expect(out).toEqual({ text: 'good' });
  });

  it('falls back to the safe default when the schema fails twice', async () => {
    const schema = (v) => v && v.text === 'good';
    const d = makeDispatcher(sim.always(sim.success({ text: 'bad' })));
    const out = await d.dispatch({
      messages: [],
      agentId: 'agent-1',
      schema,
      safeDefault: 'SAFE',
    });
    expect(out).toBe('SAFE');
  });

  it('returns the safe default when the only provider is down', async () => {
    const d = makeDispatcher(sim.always(sim.server503()));
    const out = await d.dispatch({ messages: [], agentId: 'agent-1', safeDefault: 'SAFE' });
    expect(out).toBe('SAFE');
  });

  it('does not retry a 4xx on the same provider and returns the safe default when alone', async () => {
    // A 4xx is not retried on the same provider; with no other provider to fail over
    // to, the dispatch degrades to the safe default rather than aborting the turn.
    const transport = vi.fn(sim.always(sim.requestError(400)));
    const d = makeDispatcher(transport);
    const out = await d.dispatch({ messages: [], agentId: 'agent-1', safeDefault: 'SAFE' });
    expect(out).toBe('SAFE');
    expect(transport).toHaveBeenCalledTimes(1); // no same-provider retry
  });

  it('fails over past a provider 4xx to the next provider that accepts the request', async () => {
    // Regression: a 4xx from one provider must NOT abort the whole dispatch. Each
    // adapter builds a different request, so the next provider can still succeed.
    const logger = vi.fn();
    const d = createDispatcher({
      adapters: { a: mockAdapter(), b: mockAdapter() },
      transports: {
        a: sim.always(sim.requestError(400, { error: { message: 'model not found' } })),
        b: sim.always(sim.success({ text: 'ok from b' })),
      },
      failoverSequence: ['a', 'b'],
      logger,
    });
    const out = await d.dispatch({ messages: [], agentId: 'agent-1', safeDefault: 'SAFE' });
    expect(out).toEqual({ text: 'ok from b' });
    // The 4xx was surfaced (with the provider's reason) before failing over.
    const reqErr = logger.mock.calls.map(([e]) => e).find((e) => e.type === 'dispatch:request_error');
    expect(reqErr).toMatchObject({ provider: 'a', status: 400, detail: 'model not found' });
  });
});

// Per-call failover override: an agent (e.g. Poe's conversation tier) may name a
// provider order for a single call. It overrides the global order but never
// HIPAA enforcement, which stays absolute.
describe('dispatcher per-call failover override', () => {
  function recordingDispatcher(extra = {}) {
    const hits = [];
    const mk = (name) => ({
      name,
      template: (messages) => ({ name, messages }),
      parse429: () => ({}),
      send: async (req) => {
        hits.push(req.name);
        return { status: 200, headers: {}, body: { via: req.name } };
      },
    });
    const d = createDispatcher({
      adapters: {
        anthropic: mk('anthropic'),
        groq: mk('groq'),
        mistral: mk('mistral'),
        ollama: mk('ollama'),
      },
      failoverSequence: ['anthropic', 'groq', 'mistral'],
      hipaaResolver: (loopContext) => (loopContext && loopContext.hipaa ? ['ollama'] : null),
      ...extra,
    });
    return { d, hits };
  }

  it('uses the global order when no spec.failover is given', async () => {
    const { d, hits } = recordingDispatcher();
    const out = await d.dispatch({ agentId: 'x', messages: [], safeDefault: null });
    expect(out).toEqual({ via: 'anthropic' });
    expect(hits).toEqual(['anthropic']);
  });

  it('leads with the provider named in spec.failover', async () => {
    const { d, hits } = recordingDispatcher();
    const out = await d.dispatch({
      agentId: 'Poe',
      messages: [],
      failover: ['groq', 'anthropic', 'mistral'],
      safeDefault: null,
    });
    expect(out).toEqual({ via: 'groq' });
    expect(hits).toEqual(['groq']);
  });

  it('keeps HIPAA enforcement absolute over a per-call failover override', async () => {
    const { d, hits } = recordingDispatcher();
    const out = await d.dispatch({
      agentId: 'Poe',
      messages: [],
      failover: ['groq', 'anthropic', 'mistral'],
      loopContext: { hipaa: true },
      safeDefault: null,
    });
    expect(out).toEqual({ via: 'ollama' });
    expect(hits).toEqual(['ollama']); // never the requested groq
  });
});
