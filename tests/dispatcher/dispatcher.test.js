import { describe, expect, it, vi } from 'vitest';
import { createDispatcher, dispatch, configureDispatcher } from '../../src/dispatcher/dispatcher.js';
import * as sim from '../../src/dispatcher/simulator.js';
import { RequestError } from '../../src/dispatcher/errors.js';

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

  it('surfaces a 4xx request error instead of retrying or failing over', async () => {
    const d = makeDispatcher(sim.always(sim.requestError(400)));
    await expect(
      d.dispatch({ messages: [], agentId: 'agent-1', safeDefault: 'SAFE' }),
    ).rejects.toBeInstanceOf(RequestError);
  });
});
