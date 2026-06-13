// Circuit breaker (5c), one state machine per provider.
//
//   CLOSED     normal. Calls flow. Consecutive failures are counted.
//   OPEN       the provider failed. Reject immediately until the cooldown ends.
//   HALF-OPEN  cooldown elapsed. Allow one trial call to test recovery.
//
// Transitions:
//   CLOSED  -> OPEN       after `threshold` (3) consecutive failures
//   OPEN    -> HALF-OPEN  after `cooldownMs` (60s) has elapsed
//   HALF-OPEN -> CLOSED   on a success
//   HALF-OPEN -> OPEN     on a failure (cooldown restarts)
//
// Every transition is logged so the agent console can show it. The clock is
// injected so tests can advance time without waiting.

export const CLOSED = 'CLOSED';
export const OPEN = 'OPEN';
export const HALF_OPEN = 'HALF_OPEN';

export function createCircuitBreaker({
  clock = () => Date.now(),
  logger = () => {},
  threshold = 3,
  cooldownMs = 60000,
} = {}) {
  const states = new Map();

  function entry(name) {
    let s = states.get(name);
    if (!s) {
      s = { state: CLOSED, failures: 0, openedAt: 0 };
      states.set(name, s);
    }
    return s;
  }

  function transition(name, s, to) {
    const from = s.state;
    if (from === to) return;
    s.state = to;
    logger({ type: 'circuit:transition', provider: name, from, to });
  }

  // Reject when OPEN and still within the cooldown. After the cooldown, move to
  // HALF-OPEN and allow a single trial.
  function isOpen(name) {
    const s = entry(name);
    if (s.state === OPEN) {
      if (clock() - s.openedAt >= cooldownMs) {
        transition(name, s, HALF_OPEN);
        return false;
      }
      return true;
    }
    return false; // CLOSED or HALF-OPEN allow the call
  }

  function recordSuccess(name) {
    const s = entry(name);
    s.failures = 0;
    if (s.state !== CLOSED) transition(name, s, CLOSED);
  }

  function recordFailure(name) {
    const s = entry(name);
    if (s.state === HALF_OPEN) {
      s.openedAt = clock();
      transition(name, s, OPEN);
      return;
    }
    if (s.state === OPEN) return;
    s.failures += 1;
    if (s.failures >= threshold) {
      s.openedAt = clock();
      transition(name, s, OPEN);
    }
  }

  function stateOf(name) {
    return entry(name).state;
  }

  function reset(name) {
    if (name) states.delete(name);
    else states.clear();
  }

  return { isOpen, recordSuccess, recordFailure, stateOf, reset };
}
