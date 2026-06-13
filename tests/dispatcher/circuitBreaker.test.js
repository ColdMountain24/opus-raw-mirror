import { describe, expect, it, vi } from 'vitest';
import {
  createCircuitBreaker,
  CLOSED,
  OPEN,
  HALF_OPEN,
} from '../../src/dispatcher/circuitBreaker.js';
import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import * as sim from '../../src/dispatcher/simulator.js';

// 5c: circuit breaker. Uses an injected clock so 60s passes instantly.

function fixedClock() {
  const ref = { now: 0 };
  return { clock: () => ref.now, advance: (ms) => { ref.now += ms; }, ref };
}

describe('circuit breaker (5c)', () => {
  it('opens after 3 consecutive failures and rejects immediately', () => {
    const { clock } = fixedClock();
    const b = createCircuitBreaker({ clock });
    expect(b.stateOf('groq')).toBe(CLOSED);
    expect(b.isOpen('groq')).toBe(false);

    b.recordFailure('groq');
    b.recordFailure('groq');
    expect(b.stateOf('groq')).toBe(CLOSED);
    b.recordFailure('groq');
    expect(b.stateOf('groq')).toBe(OPEN);
    expect(b.isOpen('groq')).toBe(true);
  });

  it('a success resets the consecutive failure count', () => {
    const b = createCircuitBreaker({ clock: () => 0 });
    b.recordFailure('groq');
    b.recordFailure('groq');
    b.recordSuccess('groq');
    b.recordFailure('groq');
    b.recordFailure('groq');
    expect(b.stateOf('groq')).toBe(CLOSED);
  });

  it('moves OPEN to HALF-OPEN after the 60s cooldown, then CLOSED on success', () => {
    const c = fixedClock();
    const b = createCircuitBreaker({ clock: c.clock, cooldownMs: 60000 });
    b.recordFailure('groq');
    b.recordFailure('groq');
    b.recordFailure('groq');
    expect(b.stateOf('groq')).toBe(OPEN);

    c.advance(59000);
    expect(b.isOpen('groq')).toBe(true); // still cooling down

    c.advance(1000); // total 60s
    expect(b.isOpen('groq')).toBe(false); // trial allowed
    expect(b.stateOf('groq')).toBe(HALF_OPEN);

    b.recordSuccess('groq');
    expect(b.stateOf('groq')).toBe(CLOSED);
  });

  it('a failure in HALF-OPEN reopens and restarts the cooldown', () => {
    const c = fixedClock();
    const b = createCircuitBreaker({ clock: c.clock, cooldownMs: 60000 });
    b.recordFailure('groq');
    b.recordFailure('groq');
    b.recordFailure('groq');
    c.advance(60000);
    expect(b.isOpen('groq')).toBe(false); // -> HALF-OPEN
    b.recordFailure('groq');
    expect(b.stateOf('groq')).toBe(OPEN);
    expect(b.isOpen('groq')).toBe(true);
  });

  it('logs every state transition', () => {
    const c = fixedClock();
    const logger = vi.fn();
    const b = createCircuitBreaker({ clock: c.clock, logger, cooldownMs: 60000 });
    b.recordFailure('groq');
    b.recordFailure('groq');
    b.recordFailure('groq'); // -> OPEN
    c.advance(60000);
    b.isOpen('groq'); // -> HALF-OPEN
    b.recordSuccess('groq'); // -> CLOSED

    const transitions = logger.mock.calls
      .map(([e]) => e)
      .filter((e) => e.type === 'circuit:transition')
      .map((e) => `${e.from}->${e.to}`);
    expect(transitions).toEqual(['CLOSED->OPEN', 'OPEN->HALF_OPEN', 'HALF_OPEN->CLOSED']);
  });

  it('trips through dispatch and then skips the open provider', async () => {
    let sent = 0;
    const transport = async () => {
      sent += 1;
      return sim.server503()();
    };
    const breaker = createCircuitBreaker({ clock: () => 0 });
    const d = createDispatcher({
      adapters: {
        groq: {
          name: 'groq',
          template: (m) => ({ messages: m }),
          parse429: () => ({}),
          send: (req, { transport: t }) => t(req),
        },
      },
      transports: { groq: transport },
      failoverSequence: ['groq'],
      breaker,
    });

    for (let i = 0; i < 3; i += 1) {
      await d.dispatch({ messages: [], agentId: 'a', safeDefault: 'SAFE' });
    }
    expect(breaker.stateOf('groq')).toBe(OPEN);

    const before = sent;
    const out = await d.dispatch({ messages: [], agentId: 'a', safeDefault: 'SAFE' });
    expect(out).toBe('SAFE');
    expect(sent).toBe(before); // open provider was skipped, not called
  });
});
