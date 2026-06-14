import { describe, expect, it, vi } from 'vitest';
import { createTurnGate, TurnGateError } from '../../../src/loops/loop1/turngate.js';

// Loop 1 TurnGate: the conversation-write mutex. Only the owner (Poe) may ever
// hold it; any other acquirer throws immediately (a hard error, structural
// enforcement, not a warning).

describe('loop 1 TurnGate (conversation mutex)', () => {
  it('lets the owner acquire and release, tracking held state and holder', () => {
    const gate = createTurnGate();
    expect(gate.isHeld()).toBe(false);
    expect(gate.heldBy()).toBe(null);

    const token = gate.acquire('Poe');
    expect(gate.isHeld()).toBe(true);
    expect(gate.heldBy()).toBe('Poe');

    gate.release(token);
    expect(gate.isHeld()).toBe(false);
    expect(gate.heldBy()).toBe(null);
  });

  it('hard-throws immediately when any non-owner attempts to acquire', () => {
    const gate = createTurnGate();
    for (const agent of ['CV', 'p53', 'Edgar Allan', 'Novelty Checker', null, undefined, '']) {
      expect(() => gate.acquire(agent)).toThrow(TurnGateError);
    }
    // None of the rejected attempts took the gate, and it is not corrupted: the
    // owner can still acquire.
    expect(gate.isHeld()).toBe(false);
    const t = gate.acquire('Poe');
    expect(gate.heldBy()).toBe('Poe');
    gate.release(t);
  });

  it('classifies the forbidden acquire with code and ids', () => {
    const gate = createTurnGate();
    try {
      gate.acquire('CV');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TurnGateError);
      expect(err.code).toBe('forbidden');
      expect(err.agentId).toBe('CV');
      expect(err.owner).toBe('Poe');
    }
  });

  it('is a single-holder mutex: a second acquire while held throws', () => {
    const gate = createTurnGate();
    const t = gate.acquire('Poe');
    expect(() => gate.acquire('Poe')).toThrow(/already held/i);
    expect(gate.heldBy()).toBe('Poe'); // still the original holder
    gate.release(t);
  });

  it('release requires the holder token and refuses when free', () => {
    const gate = createTurnGate();
    expect(() => gate.release({})).toThrow(/not held/i);

    const t = gate.acquire('Poe');
    expect(() => gate.release({ not: 'the token' })).toThrow(/token mismatch/i);
    expect(gate.isHeld()).toBe(true); // a bad release did not free it

    gate.release(t);
    expect(() => gate.release(t)).toThrow(/not held/i); // double release
  });

  it('assertHeldBy guards a writer: passes for the holder, throws otherwise', () => {
    const gate = createTurnGate();
    expect(() => gate.assertHeldBy('Poe')).toThrow(TurnGateError); // not held yet
    const t = gate.acquire('Poe');
    expect(() => gate.assertHeldBy('Poe')).not.toThrow();
    expect(() => gate.assertHeldBy('CV')).toThrow(/without holding/i);
    gate.release(t);
  });

  it('withTurn acquires, runs, and always releases, even when the body throws', async () => {
    const gate = createTurnGate();

    const out = await gate.withTurn('Poe', async () => {
      expect(gate.isHeld()).toBe(true);
      expect(gate.heldBy()).toBe('Poe');
      return 'done';
    });
    expect(out).toBe('done');
    expect(gate.isHeld()).toBe(false);

    await expect(
      gate.withTurn('Poe', async () => {
        expect(gate.isHeld()).toBe(true);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(gate.isHeld()).toBe(false); // released despite the throw
  });

  it('withTurn for a non-owner throws before the body runs', async () => {
    const gate = createTurnGate();
    const body = vi.fn();
    await expect(gate.withTurn('CV', body)).rejects.toThrow(TurnGateError);
    expect(body).not.toHaveBeenCalled();
    expect(gate.isHeld()).toBe(false);
  });

  it('honors a custom owner and a custom clock', () => {
    let now = 1000;
    const gate = createTurnGate({ owner: 'Host', clock: () => now });
    expect(() => gate.acquire('Poe')).toThrow(/only be held by Host/);
    now = 2000;
    const t = gate.acquire('Host');
    expect(gate.heldBy()).toBe('Host');
    gate.release(t);
  });

  it('emits acquire and release events to an injected logger', () => {
    const events = [];
    const gate = createTurnGate({ logger: (e) => events.push(e.type) });
    const t = gate.acquire('Poe');
    gate.release(t);
    expect(events).toEqual(['turngate:acquired', 'turngate:released']);
  });
});
