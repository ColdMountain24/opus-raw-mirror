// Dispatcher core: the single entry point for every LLM call (5a).
//
// No module calls a provider directly. Everything goes through dispatch(), which
// composes the reliability spine in this order:
//   5h HIPAA enforcement -> 5i cache -> failover loop [5g] of
//     { 5c breaker gate -> 5d queue -> 5b template -> 5e retry/send [5f parse] }
//     -> 5a validate (corrective retry + safe default).
//
// dispatch() is written once here against injected collaborators. Each later
// sub-step supplies a real implementation; until then the default is a safe
// no-op, so the core is verifiable on its own.

import {
  RequestError,
  errorFromResponse,
} from './errors.js';
import { checkSchema } from './validate.js';
import { countMessages, estimateOutput } from './tokens.js';
import { ADAPTERS } from './adapters/index.js';
import { FAILOVER_SEQUENCE } from './failover.js';
import { hipaaResolver, HIPAA_SEQUENCE } from './hipaa.js';
import { createCircuitBreaker } from './circuitBreaker.js';
import { createQueue } from './queue.js';
import { createRetry } from './backoff.js';
import { createCache } from './cache.js';

const NOOP = () => {};

function defaultCollaborators() {
  return {
    adapters: {}, // name -> { name, template, parse429, send }   (5b)
    transports: {}, // name -> async (request) -> response          (per-adapter seam)
    failoverSequence: [], // ordered provider names                 (5g)
    hipaaResolver: () => null, // loopContext -> forced sequence | null (5h)
    breaker: { isOpen: () => false, recordSuccess: NOOP, recordFailure: NOOP }, // (5c)
    queue: { acquire: async () => {} }, // (5d)
    retry: { run: async (fn) => fn() }, // (5e) default: one attempt
    cache: { keyFor: () => null, get: () => undefined, set: NOOP }, // (5i)
    logger: NOOP, // event sink -> agent console (wired by main.js)
    onTrace: NOOP, // debug footer updates
    clock: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    random: Math.random,
  };
}

export function createDispatcher(deps = {}) {
  const c = { ...defaultCollaborators(), ...deps };

  const emit = (type, data = {}) => {
    try {
      c.logger({ type, ...data });
    } catch (_err) {
      // The logger must never break a dispatch. Logging is best effort.
    }
  };

  // Mutable runtime config the settings modal changes live, in place, without
  // rebuilding the dispatcher (a rebuild would reset the breaker, queue, and
  // cache). The failover order and the global HIPAA mode are the two knobs.
  let order = Array.isArray(c.failoverSequence) ? [...c.failoverSequence] : [];
  let hipaaMode = Boolean(c.hipaaMode);

  function breakerState(provider) {
    if (c.breaker && typeof c.breaker.stateOf === 'function') return c.breaker.stateOf(provider);
    if (c.breaker && typeof c.breaker.isOpen === 'function') {
      return c.breaker.isOpen(provider) ? 'OPEN' : 'CLOSED';
    }
    return 'CLOSED';
  }

  function setFailoverOrder(next) {
    if (Array.isArray(next) && next.length > 0) order = [...next];
    return order.slice();
  }

  function setHipaaMode(on) {
    hipaaMode = Boolean(on);
    return hipaaMode;
  }

  function clearCache() {
    if (c.cache && typeof c.cache.clear === 'function') c.cache.clear();
  }

  // Diagnostic single-provider probe for the settings connection test. It uses
  // the same adapter template + transport seam as a real call but skips the
  // queue, retry, and failover, and does not record into the breaker; it reports
  // the current breaker state alongside the result. With no transport wired it
  // reports an honest failure rather than a fake pass.
  async function probe(provider, spec = {}) {
    const adapter = c.adapters[provider];
    if (!adapter) {
      return { ok: false, provider, reason: 'no_adapter', breaker: breakerState(provider) };
    }
    if (c.breaker && typeof c.breaker.isOpen === 'function' && c.breaker.isOpen(provider)) {
      return { ok: false, provider, reason: 'circuit_open', breaker: breakerState(provider) };
    }
    const messages = spec.messages || [{ role: 'user', content: 'ping' }];
    try {
      const request = adapter.template(messages, spec);
      const response = await adapter.send(request, { transport: c.transports[provider] });
      const err = errorFromResponse(response, { provider, parse429: adapter.parse429 });
      if (err) return { ok: false, provider, reason: err.code || 'error', breaker: breakerState(provider) };
      return { ok: true, provider, breaker: breakerState(provider) };
    } catch (e) {
      return { ok: false, provider, reason: (e && (e.code || e.name)) || 'error', breaker: breakerState(provider) };
    }
  }

  // Single provider attempt: queue -> template -> retry(send + classify).
  async function callProvider(name, spec) {
    const adapter = c.adapters[name];
    if (!adapter) {
      throw new RequestError(`no adapter registered: ${name}`, { provider: name });
    }

    // 5d queue gate (80% caps, token pre-count, FIFO + priority lane).
    await c.queue.acquire(name, {
      tokensIn: countMessages(spec.messages),
      outReserve: estimateOutput(spec),
      priority: spec.priority || 'normal',
    });

    // 5b provider-ready request body.
    const request = adapter.template(spec.messages, spec);

    // 5e retry/backoff wraps the send; 5f parse429 supplies retry-after.
    return c.retry.run(
      async () => {
        // Timeout / not-wired errors are thrown by send() directly.
        const response = await adapter.send(request, { transport: c.transports[name] });
        const err = errorFromResponse(response, { provider: name, parse429: adapter.parse429 });
        if (err) throw err;
        return response.body;
      },
      { sleep: c.sleep, random: c.random, clock: c.clock, provider: name },
    );
  }

  async function dispatch(spec = {}) {
    emit('dispatch:start', { agentId: spec.agentId, tier: spec.tier });

    // 5h HIPAA enforcement: runs before the breaker and the queue. A global
    // HIPAA mode (set from the settings modal) forces ollama-only for every
    // call, exactly like the per-call loopContext.hipaa flag.
    const forced = hipaaMode ? HIPAA_SEQUENCE : c.hipaaResolver(spec.loopContext);
    // Per-call failover override: an agent may request a provider order for this
    // call (e.g. Poe's conversation tier leads with Groq for streaming speed,
    // then falls back through the rest). It applies only when HIPAA has not forced
    // a sequence: HIPAA enforcement is resolved first and stays absolute (no
    // hosted fallback can override an ollama-only session). The global failover
    // order is the default when neither applies.
    const requested =
      !forced && Array.isArray(spec.failover) && spec.failover.length > 0 ? spec.failover : null;
    const sequence = forced || requested || order;
    if (forced) {
      emit('hipaa:enforced', { agentId: spec.agentId, sequence: forced });
    }

    // 5i cache: a hit skips the LLM call entirely.
    const key = c.cache.keyFor(spec);
    if (key != null) {
      const cached = c.cache.get(key);
      if (cached !== undefined) {
        emit('cache:hit', { agentId: spec.agentId, key });
        c.onTrace({ cache: 'hit' });
        return cached;
      }
    }
    c.onTrace({ cache: 'cold' });

    // 5g failover loop.
    let attempts = 0;
    let lastError = null;
    for (const name of sequence) {
      if (c.breaker.isOpen(name)) {
        emit('failover:skip', { provider: name });
        continue;
      }

      try {
        c.onTrace({ model: name });
        attempts += 1;
        let body = await callProvider(name, spec);
        c.breaker.recordSuccess(name);

        // 5a validate -> corrective retry (+0.1 temp) -> safe default.
        const result = checkSchema(spec.schema, body);
        if (!result.ok) {
          // Include the raw model output so the dev log shows WHAT failed validation
          // (e.g. an RQSupervisor result with the wrong field types), not just that it did.
          emit('validate:fail', { provider: name, agentId: spec.agentId, errors: result.errors, body });
          const corrected = await callProvider(name, {
            ...spec,
            temperature: (spec.temperature || 0) + 0.1,
            corrective: true,
          });
          if (checkSchema(spec.schema, corrected).ok) {
            body = corrected;
          } else {
            emit('validate:safe_default', { agentId: spec.agentId, body: corrected });
            c.onTrace({ fallback: 'safe_default' });
            return spec.safeDefault;
          }
        }

        if (key != null) c.cache.set(key, body);
        c.onTrace({
          fallback: name === sequence[0] ? 'none' : name,
          retries: attempts - 1,
        });
        emit('dispatch:success', { provider: name, agentId: spec.agentId });
        return body;
      } catch (err) {
        if (err instanceof RequestError) {
          // 4xx: this provider rejected the request. Do NOT retry the same provider (a
          // retry of the same bad request fails again) and do NOT trip its breaker (a
          // 4xx is not a provider-health fault), but DO fail over to the next provider:
          // every adapter builds a different request (model id, format, auth), so a
          // request one provider rejects can be valid for another. The rejection is
          // surfaced for visibility; it is kept as the last error if every provider fails.
          emit('dispatch:request_error', { provider: name, status: err.status, detail: err.detail });
          lastError = err;
          continue;
        }
        if (!err || err.countsAsFailure !== false) {
          c.breaker.recordFailure(name);
        }
        lastError = err;
        emit('failover:next', {
          from: name,
          reason: (err && err.code) || (err && err.name) || 'error',
        });
      }
    }

    // All providers OPEN, exhausted, or rejecting the request. Surface a warning and
    // return the safe default (a turn never aborts on one provider's failure). The
    // last error's reason is included so the console shows why.
    emit('providers:exhausted', {
      agentId: spec.agentId,
      reason: lastError && (lastError.detail || lastError.code || lastError.name),
    });
    c.onTrace({ fallback: 'safe_default' });
    return spec.safeDefault;
  }

  return { dispatch, probe, breakerState, setFailoverOrder, setHipaaMode, clearCache };
}

// ---------------------------------------------------------------------------
// Default application instance, wired with the real reliability collaborators
// (5b through 5i). main.js calls configureDispatcher() once at startup to bind
// the agent-console logger and the trace sink (and, later, real transports). All
// app modules import { dispatch } from here, satisfying the single-export rule.
// ---------------------------------------------------------------------------
function buildAppDeps(opts = {}) {
  const logger = opts.logger || (() => {});
  const clock = opts.clock || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random || Math.random;
  return {
    adapters: ADAPTERS,
    // Real fetch is wired per adapter later; until then each send() reports a
    // not-wired error, which fails over to the safe default.
    transports: opts.transports || {},
    failoverSequence: opts.failoverSequence || FAILOVER_SEQUENCE,
    hipaaMode: Boolean(opts.hipaaMode),
    hipaaResolver,
    breaker: createCircuitBreaker({ clock, logger }),
    queue: createQueue({ clock, sleep }),
    retry: createRetry({ sleep, random }),
    cache: createCache({ logger }),
    logger,
    onTrace: opts.onTrace || (() => {}),
    clock,
    sleep,
    random,
  };
}

let appInstance = createDispatcher(buildAppDeps());

export function configureDispatcher(opts = {}) {
  // Rebuilds the app instance with fresh collaborators bound to the given
  // logger/trace sink. Called once at startup, before any dispatch.
  appInstance = createDispatcher(buildAppDeps(opts));
  return appInstance;
}

export function dispatch(spec) {
  return appInstance.dispatch(spec);
}

// Diagnostics and live configuration, delegating to the current app instance.
// These let the settings modal probe a provider, read circuit-breaker state, and
// change the failover order, the global HIPAA mode, and clear the cache, without
// rebuilding the dispatcher.
export function probe(provider, spec) {
  return appInstance.probe(provider, spec);
}

export function breakerState(provider) {
  return appInstance.breakerState(provider);
}

export function setFailoverOrder(order) {
  return appInstance.setFailoverOrder(order);
}

export function setHipaaMode(on) {
  return appInstance.setHipaaMode(on);
}

export function clearCache() {
  return appInstance.clearCache();
}
