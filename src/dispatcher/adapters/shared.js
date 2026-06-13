// Shared helpers for provider adapters.

// Split a logical message array into a joined system prompt and the remaining
// (user/assistant) turns. Providers place the system prompt differently.
export function splitSystem(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list
    .filter((m) => m && m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = list.filter((m) => !m || m.role !== 'system');
  return { system, rest };
}

// Resolve a concrete model id from a tier hint, falling back to the default.
export function resolveModel(models, tier) {
  if (tier && models[tier]) return models[tier];
  return models.default;
}

// Clamp the requested temperature into a safe range.
export function clampTemp(spec) {
  const t = spec && typeof spec.temperature === 'number' ? spec.temperature : 0;
  return Math.max(0, Math.min(2, t));
}

export function maxTokensOf(spec) {
  return spec && spec.maxTokens != null ? spec.maxTokens : 1024;
}
