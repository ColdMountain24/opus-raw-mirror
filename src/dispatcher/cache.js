// localStorage packet cache (5i).
//
// Caches completed input-packet -> validated-output pairs, keyed by a hash of
// the input packet and the agent ID. A hit returns the cached result and skips
// the LLM call entirely (the dispatcher logs the hit). This is also a live-demo
// safety net: a pre-warmed cache means a repeat run consumes zero quota.
//
// Storage is injectable so tests use an isolated stub. All storage access is
// best effort: a failure is reported through the logger, never thrown, so a
// cache problem cannot break a dispatch.

const NAMESPACE = 'opuscc:cache:v1';

// FNV-1a 32-bit, returned as 8 hex chars. Sync and dependency free.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Deterministic JSON with sorted object keys, so key order never changes a hash.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_err) {
    return null;
  }
}

export function createCache({
  storage = defaultStorage(),
  namespace = NAMESPACE,
  logger = () => {},
} = {}) {
  function keyFor(spec) {
    if (!spec || spec.agentId == null) return null; // no agent id, no caching
    const input = {
      agentId: spec.agentId,
      tier: spec.tier != null ? spec.tier : null,
      messages: spec.messages || [],
    };
    const hash = fnv1a(`${stableStringify(input)}|${String(spec.agentId)}`);
    return `${namespace}:${spec.agentId}:${hash}`;
  }

  function get(key) {
    if (!storage || key == null) return undefined;
    try {
      const raw = storage.getItem(key);
      if (raw == null) return undefined;
      return JSON.parse(raw);
    } catch (err) {
      logger({ type: 'cache:error', op: 'get', message: err && err.message });
      return undefined;
    }
  }

  function set(key, value) {
    if (!storage || key == null || value === undefined) return;
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (err) {
      logger({ type: 'cache:error', op: 'set', message: err && err.message });
    }
  }

  function clear() {
    if (!storage) return;
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k && k.startsWith(namespace)) keys.push(k);
      }
      keys.forEach((k) => storage.removeItem(k));
    } catch (err) {
      logger({ type: 'cache:error', op: 'clear', message: err && err.message });
    }
  }

  return { keyFor, get, set, clear };
}
