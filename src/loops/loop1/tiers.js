// Loop 1 provider tiers.
//
// A tier is an ordered provider preference an agent passes to the dispatcher as a
// per-call `failover` override, so the agent's lead provider holds regardless of
// the global provider-priority setting. The dispatcher's HIPAA enforcement still
// overrides any tier absolutely. Single source for the tier orders so the agents
// cannot drift apart; each agent module re-exports the one it uses.

// Conversation tier: Groq leads for streaming speed (Poe). Falls back through the
// dispatcher.
export const CONVERSATION_TIER = Object.freeze(['groq', 'anthropic', 'mistral']);

// Extraction tier: Anthropic leads (it follows a structured-output contract
// closely) for the validators and structure agents (CV, RQSupervisor, ...). Falls
// back through the dispatcher.
export const EXTRACTION_TIER = Object.freeze(['anthropic', 'groq', 'mistral']);
