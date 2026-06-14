// Loop 1 TurnGate: a single-holder mutex over the conversation layer.
//
// Only Poe may write the conversation. The TurnGate makes that a runtime, not a
// convention: only the owner ('Poe') can ever hold the gate, and any other agent
// that attempts to acquire it throws immediately - a hard error, not a warning.
// It is a simple mutex (one holder at a time): Poe acquires it at the start of a
// user-facing message and releases it when finished. The orchestrator runs the
// agent calls during the interval Poe holds the gate; agents never touch the gate
// (they have no conversation handle) and write to the IO panel only.
//
// This complements the closure-based TurnGate in poe.js. poe.js hides the
// conversation DOM so no other module can reach it; this makes the *right to
// write* it a mutex that only Poe can hold, so even Poe-side code cannot write
// two overlapping turns and a stray agent id cannot take the floor.

export class TurnGateError extends Error {
  constructor(message, { agentId, owner, code } = {}) {
    super(message);
    this.name = 'TurnGateError';
    this.agentId = agentId; // who attempted the operation
    this.owner = owner; // the only id allowed to hold the gate
    this.code = code; // 'forbidden' | 'already_held' | 'not_held' | 'token_mismatch'
  }
}

export function createTurnGate({ owner = 'Poe', clock = () => Date.now(), logger } = {}) {
  let token = null; // the unique handle of the current holder; null when free
  let heldAt = null;

  const emit = (type, data = {}) => {
    if (typeof logger !== 'function') return;
    try {
      logger({ type, owner, ...data });
    } catch (_err) {
      // logging is best effort and must never break the gate
    }
  };

  // Acquire the gate. Hard-throws if agentId is not the owner (structural: only
  // Poe may ever hold the floor) or if the gate is already held (single-holder
  // mutex). Returns an opaque token the holder must present to release().
  function acquire(agentId) {
    if (agentId !== owner) {
      throw new TurnGateError(
        `TurnGate may only be held by ${owner}; ${String(agentId)} may not acquire it`,
        { agentId, owner, code: 'forbidden' },
      );
    }
    if (token !== null) {
      throw new TurnGateError(`TurnGate is already held by ${owner}; it is a single-holder mutex`, {
        agentId,
        owner,
        code: 'already_held',
      });
    }
    token = { owner: agentId, id: Symbol('turngate') };
    heldAt = clock();
    emit('turngate:acquired', { at: heldAt });
    return token;
  }

  // Release the gate. The caller must present the token from acquire(); a
  // mismatch, or a release while free, is a hard error (never a silent no-op).
  function release(handle) {
    if (token === null) {
      throw new TurnGateError('TurnGate is not held; nothing to release', {
        owner,
        code: 'not_held',
      });
    }
    if (handle !== token) {
      throw new TurnGateError('TurnGate release token mismatch; only the holder may release', {
        owner,
        code: 'token_mismatch',
      });
    }
    token = null;
    heldAt = null;
    emit('turngate:released', {});
  }

  function isHeld() {
    return token !== null;
  }

  function heldBy() {
    return token ? token.owner : null;
  }

  // Writer guard: throw unless the gate is currently held by agentId. A writer
  // (Poe) can call this immediately before a conversation write to fail loudly
  // if it ever writes off the floor.
  function assertHeldBy(agentId) {
    if (token === null || token.owner !== agentId) {
      throw new TurnGateError(
        `${String(agentId)} attempted a conversation write without holding the TurnGate`,
        { agentId, owner, code: 'not_held' },
      );
    }
  }

  // acquire -> run fn -> release (always, even if fn throws). The owner check in
  // acquire still applies, so withTurn('CV', ...) throws before fn ever runs.
  async function withTurn(agentId, fn) {
    const handle = acquire(agentId);
    try {
      return await fn(handle);
    } finally {
      release(handle);
    }
  }

  return { acquire, release, isHeld, heldBy, assertHeldBy, withTurn, owner };
}

// Default Loop 1 gate. The orchestrator builds its own per instance (injectable
// for tests); this singleton serves the app's default orchestrator, mirroring the
// factory + default-singleton convention of the other app services.
export const turnGate = createTurnGate();
