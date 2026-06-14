// FrameworkRegistry: the client-side framework content store.
//
// A framework maps a single id to a full field set. The registry exists to keep
// framework CONTENT out of LLM prompts: the model emits only a framework id in its
// structured output, and this registry maps that id to the field set
// deterministically, client-side, after the call returns. Nothing here ever
// touches the dispatcher; the lookup is a synchronous in-memory map.
//
// Charter boundary. The registry is the MECHANISM (register + deterministic
// lookup); the framework definitions themselves are FINAL content (user-owned) and
// are NOT invented here. The default singleton ships EMPTY: the FINAL frameworks
// register as data (register(id, definition)) when the architecture supplies them.
// The assembler (src/loops/loop1/rqpacket.js) is the one client of the lookup.
//
// Failure model mirrors storage.js: an absent id is a value (null), not an error;
// genuine misuse (a blank id, a non-object definition, a duplicate id) throws a
// typed FrameworkRegistryError so it reaches the boundary with reproducible
// context, never silently swallowed.

// Typed error for registry misuse. Carries the op and the id involved.
export class FrameworkRegistryError extends Error {
  constructor(message, { op, id } = {}) {
    super(message);
    this.name = 'FrameworkRegistryError';
    this.op = op; // 'register' | 'lookup'
    this.id = id; // the framework id involved, when there is one
  }
}

// Deep-freeze a definition so a stored framework is immutable: lookup can hand the
// same frozen object out repeatedly (deterministic, shareable) and no caller can
// mutate the registry's content through a returned reference.
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze(value[key]);
    }
  }
  return value;
}

function normalizeId(op, id) {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new FrameworkRegistryError(`${op} requires a non-empty string framework id`, { op, id });
  }
  return id;
}

export function createFrameworkRegistry(definitions = {}) {
  const store = new Map();

  // Register one framework id -> field set. The definition is the FINAL field set
  // (any object shape); the registry stores it frozen and does not interpret it.
  function register(id, definition) {
    const key = normalizeId('register', id);
    if (!definition || typeof definition !== 'object') {
      throw new FrameworkRegistryError('register requires an object framework definition', {
        op: 'register',
        id: key,
      });
    }
    if (store.has(key)) {
      throw new FrameworkRegistryError(`framework id "${key}" is already registered`, {
        op: 'register',
        id: key,
      });
    }
    store.set(key, deepFreeze(definition));
    return key;
  }

  // Deterministic client-side lookup: the same id always returns the same frozen
  // field set; an unregistered id returns null (absence, not an error). The
  // assembler decides the fail-closed policy on a null.
  function lookup(id) {
    const key = normalizeId('lookup', id);
    return store.has(key) ? store.get(key) : null;
  }

  function has(id) {
    return store.has(normalizeId('lookup', id));
  }

  function ids() {
    return [...store.keys()];
  }

  // Seed any definitions passed to the factory (the FINAL frameworks register here
  // when supplied; the default singleton passes none and so ships empty).
  for (const [id, definition] of Object.entries(definitions)) {
    register(id, definition);
  }

  return { register, lookup, has, ids };
}

// Default app singleton. EMPTY by design: framework content is FINAL (Autonomy
// Charter), so it is registered as data when the architecture supplies it, not
// hard-coded here. main.js hands this instance to the RQPacket assembler.
export const frameworkRegistry = createFrameworkRegistry();
