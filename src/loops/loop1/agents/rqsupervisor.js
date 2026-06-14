// RQSupervisor, the Loop 1 (The Agora) question-structure reviewer.
//
// RQSupervisor receives an RQPacket that passed CV's completeness check and judges
// its structure: internal consistency, scope appropriateness, and which research
// paradigm it belongs to. It returns a strict structured result,
// { approved, paradigm, feedback, revision_required }, which the dispatcher
// validates against the schema before the orchestrator acts on it. It is a
// backstage agent: it writes to the IO panel (Packet Inspector + Agent Console),
// never the conversation layer. Only Poe writes the conversation.
//
// Provider: the extraction tier, Anthropic-first, falling back through the
// dispatcher. HIPAA enforcement in the dispatcher still overrides this.
//
// Charter boundary. RQSupervisor owns its output contract (the result schema,
// given verbatim by the spec) and its safe default. It does NOT own the RQPacket
// schema or the ResearchParadigm set (both FINAL): paradigm is returned as a free
// string and the prompt's example paradigms are illustrative, not a hard enum.

import { dispatch as defaultDispatch } from '../../../dispatcher/dispatcher.js';
import { RQSUPERVISOR_SYSTEM_PROMPT } from '../prompts.js';
import { EXTRACTION_TIER } from '../tiers.js';

export { EXTRACTION_TIER };

// RQSupervisor's output contract, given verbatim by the spec. Strict: the
// orchestrator only ever acts on a value that matches this, so the dispatcher runs
// the corrective retry on a miss and otherwise falls back to the safe default.
export function rqResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.approved !== 'boolean') return false;
  if (typeof v.paradigm !== 'string') return false;
  if (!Array.isArray(v.feedback) || !v.feedback.every((f) => typeof f === 'string')) return false;
  return typeof v.revision_required === 'boolean';
}

// Safe default when no provider is reachable. Fails closed: an unreachable
// reviewer never approves, and requires revision so the chain returns to Poe
// rather than proceeding on an unreviewed question. It names no paradigm and no
// feedback it cannot know.
export const RQSUPERVISOR_SAFE_DEFAULT = Object.freeze({
  approved: false,
  paradigm: '',
  feedback: [],
  revision_required: true,
});

// The orchestrator state RQSupervisor routes back to so Poe can resume elicitation
// when a revision is required. Kept as a literal so the agent does not depend on
// the orchestrator module; the orchestrator validates the transition against its
// legal adjacency, so a wrong name would fail loudly rather than silently.
const POE_INTAKE = 'POE_INTAKE';

// Routing per the spec: when revision_required is true the orchestrator routes
// back to Poe (with the feedback); otherwise no explicit transition, so the
// default forward edge (RQ_SUPERVISOR -> NOVELTY_CHECK) proceeds. Injectable so
// the FINAL routing policy can override it.
function defaultRouteOnResult(result) {
  return result.revision_required ? POE_INTAKE : undefined;
}

// A compact, non-conversational summary for the Packet Inspector / Agent Console.
function summarize(result) {
  const verdict = result.approved ? 'approved' : 'not approved';
  const paradigm = result.paradigm ? ` paradigm: ${result.paradigm}.` : '';
  const feedback = result.feedback.length ? ` Feedback: ${result.feedback.join('; ')}.` : '';
  return `Structure ${verdict}.${paradigm}${feedback}`;
}

export function createRQSupervisorAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || RQSUPERVISOR_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 384;
  const routeOnResult = deps.routeOnResult || defaultRouteOnResult;

  // The structure step the orchestrator runs at RQ_SUPERVISOR. RQPacket in, a
  // validated { approved, paradigm, feedback, revision_required } out, attributed
  // to RQSupervisor.
  return async function rqSupervise(ctx = {}) {
    const session = ctx.session || {};
    const rqPacket = session.rqPacket && typeof session.rqPacket === 'object' ? session.rqPacket : {};

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Research question packet (version ${
          rqPacket.version == null ? 'unknown' : rqPacket.version
        }):\n${JSON.stringify(rqPacket, null, 2)}`,
      },
    ];

    const raw = await dispatch({
      agentId: 'RQSupervisor',
      tier: 'extraction',
      failover,
      messages,
      schema: rqResultSchema,
      safeDefault: RQSUPERVISOR_SAFE_DEFAULT,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    // Validate once more before the orchestrator acts (the safe default is valid
    // by construction; this guarantees an on-contract result regardless of path).
    const result = rqResultSchema(raw) ? raw : RQSUPERVISOR_SAFE_DEFAULT;
    const transition = routeOnResult(result);

    return {
      agentId: 'RQSupervisor',
      content: summarize(result),
      result,
      control: transition ? { transition } : {},
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance, built against the real dispatch singleton. main.js injects
// this as the orchestrator's `RQSupervisor` step. Tests build isolated agents with
// createRQSupervisorAgent({ dispatch, ... }) on a fake dispatch.
export const rqSupervisorAgent = createRQSupervisorAgent();
