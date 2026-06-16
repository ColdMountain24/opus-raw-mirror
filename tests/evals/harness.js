// Workflow eval harness.
//
// The evals exercise the real reliability spine end to end: the real adapters,
// circuit breaker, queue, retry/backoff, cache, HIPAA resolver, and validation,
// all wired exactly as the app wires them, but driven by the deterministic
// simulator instead of network calls and run on virtual time. There is no
// loop-specific logic here; these are baseline spine workflows.
//
// Determinism comes from three injected seams: a virtual clock whose sleep()
// advances time instantly, a fixed random (zero jitter), and isolated in-memory
// cache storage per eval.

import { createDispatcher } from '../../src/dispatcher/dispatcher.js';
import { ADAPTERS } from '../../src/dispatcher/adapters/index.js';
import { FAILOVER_SEQUENCE } from '../../src/dispatcher/failover.js';
import { hipaaResolver } from '../../src/dispatcher/hipaa.js';
import { createCircuitBreaker } from '../../src/dispatcher/circuitBreaker.js';
import { createQueue } from '../../src/dispatcher/queue.js';
import { createRetry } from '../../src/dispatcher/backoff.js';
import { createCache } from '../../src/dispatcher/cache.js';

// Virtual time: sleep advances the clock and resolves immediately, so backoffs,
// rate windows, and breaker cooldowns are exact and instant.
export function virtualTime() {
  let nowMs = 0;
  return {
    clock: () => nowMs,
    sleep: (ms) => {
      nowMs += Math.max(0, Number(ms) || 0);
      return Promise.resolve();
    },
    random: () => 0,
    now: () => nowMs,
  };
}

// Isolated localStorage-shaped stub so each eval has its own cache.
export function memStorage() {
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

// Capture every event the spine emits so workflows can assert on them.
export function recorder() {
  const events = [];
  const logger = (e) => events.push(e);
  logger.events = events;
  logger.types = () => events.map((e) => e.type);
  return logger;
}

// Wrap a transport (a simulator thunk-consumer) to count how often it is hit.
// Forwards the full call (request + the optional { onToken } context) so a
// streaming transport still receives its onToken sink through the wrapper.
export function counted(fn) {
  const wrapped = async (req, ctx) => {
    wrapped.calls += 1;
    return fn(req, ctx);
  };
  wrapped.calls = 0;
  return wrapped;
}

// Build the real spine with injected transports + virtual time, mirroring the
// app's buildAppDeps wiring (adapters, breaker, queue, retry, cache, hipaa).
export function buildSpine({
  transports = {},
  vt = virtualTime(),
  storage = memStorage(),
  logger,
  failoverSequence = FAILOVER_SEQUENCE,
} = {}) {
  const log = logger || (() => {});
  return createDispatcher({
    adapters: ADAPTERS,
    transports,
    failoverSequence,
    hipaaResolver,
    breaker: createCircuitBreaker({ clock: vt.clock, logger: log }),
    queue: createQueue({ clock: vt.clock, sleep: vt.sleep }),
    retry: createRetry({ sleep: vt.sleep, random: vt.random }),
    cache: createCache({ storage, logger: log }),
    logger: log,
    clock: vt.clock,
    sleep: vt.sleep,
    random: vt.random,
  });
}

// Assertion helpers that throw a clear, self-describing error on failure.
export function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || 'values are not equal'}: expected ${e}, got ${a}`);
  }
}
