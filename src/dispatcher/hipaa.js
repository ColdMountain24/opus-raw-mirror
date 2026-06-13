// HIPAA enforcement (5h).
//
// Before any provider selection, the dispatcher checks the loop context for a
// HIPAA flag. If present, the entire provider sequence is overridden to Ollama
// only (local, no data leaves the machine). This resolver runs before the
// circuit breaker and before the queue, and the override is absolute: a HIPAA
// session never falls back to a hosted provider, even if Ollama is unavailable.
//
// The HIPAA routing decision itself is owned upstream and is not changed here;
// this module only enforces it.

export const HIPAA_SEQUENCE = ['ollama'];

export function createHipaaResolver({ sequence = HIPAA_SEQUENCE } = {}) {
  return function resolve(loopContext) {
    if (loopContext && loopContext.hipaa) return [...sequence];
    return null;
  };
}

// Default resolver for the application instance.
export const hipaaResolver = createHipaaResolver();
