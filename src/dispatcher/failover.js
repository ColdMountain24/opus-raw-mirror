// Provider failover sequence (5g).
//
// Default order: Claude (primary, paid) -> Groq (free, Llama 3.3 70B) -> Mistral
// (free fallback) -> safe default. The circuit breaker (5c) controls which
// providers are available: an OPEN provider is skipped. If Claude is OPEN the
// run starts at Groq; if Claude and Groq are OPEN it goes to Mistral; if all
// three are OPEN the dispatcher returns the agent's safe default and surfaces a
// warning to the user.
//
// The failover loop itself lives in dispatcher.js (it must re-check the breaker
// at the moment it reaches each provider). This module owns the canonical order
// and a pure helper for inspecting availability.

export const FAILOVER_SEQUENCE = ['anthropic', 'groq', 'mistral'];

// Providers from `sequence` whose breaker is not OPEN, in order. Pure snapshot
// for inspection and logging; dispatch checks the breaker per attempt itself.
export function availableProviders(sequence, breaker) {
  if (!breaker || typeof breaker.isOpen !== 'function') return [...sequence];
  return sequence.filter((name) => !breaker.isOpen(name));
}
