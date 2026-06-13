// Schema validation for structured output.
//
// The caller owns the schema (agent semantics are not owned by the dispatcher).
// This is a pure check; the dispatcher orchestrates the corrective retry and the
// safe-default fallback around it. A schema may be:
//   - a predicate function (value) -> true | false | string[] of errors
//   - an object with a validate(value) -> true | { ok, errors } method
//   - absent, in which case any value passes.

export function checkSchema(schema, value) {
  if (!schema) return { ok: true, errors: [] };

  if (typeof schema === 'function') {
    const result = schema(value);
    if (result === true) return { ok: true, errors: [] };
    if (result === false) return { ok: false, errors: ['schema predicate returned false'] };
    if (Array.isArray(result)) return { ok: result.length === 0, errors: result };
    return { ok: Boolean(result), errors: result ? [] : ['schema predicate failed'] };
  }

  if (schema && typeof schema.validate === 'function') {
    const result = schema.validate(value);
    if (result === true) return { ok: true, errors: [] };
    if (result && typeof result === 'object') {
      return { ok: Boolean(result.ok), errors: result.errors || [] };
    }
    return { ok: Boolean(result), errors: result ? [] : ['schema validate failed'] };
  }

  // Unrecognized schema shape: do not block the response on it.
  return { ok: true, errors: [] };
}
