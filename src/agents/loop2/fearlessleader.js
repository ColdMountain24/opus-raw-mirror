// Fearless Leader, the Loop 2 (The Archive) sweep planner.
//
// Fearless Leader receives the finalized RQPacket (inherited from Loop 1) and plans
// the subspecialization sweep: which research subspecializations to cover, how many
// Grad Students to spin up per subspecialization, and the retrieval query to pass to
// Edgar Allan for each. It returns a strict structured result,
// { subspecializations: [{ id, name, query, grad_student_count }], rationale }, which
// the dispatcher validates against the schema (corrective retry + safe default) before
// the orchestrator proceeds to PHASE_1. It is a BACKSTAGE agent: its plan is written to
// the IO panel (the orchestrator routes its packet to the Packet Inspector / Agent
// Console), never to the conversation layer. Only Poe writes the conversation.
//
// Provider: the extraction tier, Anthropic-first, falling back through the dispatcher.
// HIPAA enforcement in the dispatcher still overrides this. It supplies ONE system
// prompt; the dispatcher's adapters differentiate it per provider.
//
// Charter boundary. Fearless Leader owns its output contract (the result schema, given
// verbatim by the spec) and its safe default. It does NOT own the RQPacket schema
// (FINAL): it reasons over the packet and the research question it is handed and names
// subspecializations from the study's own content. The subspecialization/Grad-Student/
// query VALUES are the agent's, supplied by the model, never invented by the mechanism.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { FEARLESS_LEADER_SYSTEM_PROMPT } from './prompts.js';
// Tiers are app-wide provider orderings; they currently live under loop1/ (a historical
// home). FUTURE: move tiers.js to a shared path now that Loop 2 consumes them too.
import { EXTRACTION_TIER } from '../../loops/loop1/tiers.js';

export { EXTRACTION_TIER };

// One subspecialization entry. Strict shape (spec): a non-empty id/name/query and a
// positive-integer grad_student_count. The retrieval-query bound (an upper cap on
// grad_student_count, the actual Grad-Student fan-out) belongs to the PHASE_1 wiring
// that consumes this plan, not to the structural contract, so no cap is enforced here.
function isSubspecialization(s) {
  return (
    s &&
    typeof s === 'object' &&
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.name === 'string' &&
    s.name.length > 0 &&
    typeof s.query === 'string' &&
    s.query.length > 0 &&
    Number.isInteger(s.grad_student_count) &&
    s.grad_student_count >= 1
  );
}

// Fearless Leader's output contract, given verbatim by the spec. Strict: the
// orchestrator only ever acts on a value that matches this, so the dispatcher runs the
// corrective retry on a miss and otherwise falls back to the safe default. A sweep plan
// with zero subspecializations is not a plan, so the array must be non-empty.
export function fearlessLeaderResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.rationale !== 'string') return false;
  if (!Array.isArray(v.subspecializations) || v.subspecializations.length === 0) return false;
  return v.subspecializations.every(isSubspecialization);
}

// The query the degraded fallback sweep uses when even the research question is absent.
export const FALLBACK_QUERY = 'broad literature review of the research question';

// Safe default when no provider is reachable: a single broad sweep over the inherited
// research question, so the pipeline degrades to one pass rather than stalling, and the
// rationale states plainly that the plan is degraded (no silent swallowing). It is
// built from the research question rather than a frozen constant because a sweep needs a
// real query; it invents no subspecialization topics the planner could not reason about.
export function buildSafeDefault({ researchQuestion } = {}) {
  const q = typeof researchQuestion === 'string' && researchQuestion.trim() ? researchQuestion.trim() : FALLBACK_QUERY;
  return {
    subspecializations: [{ id: 'subspec-1', name: 'General literature sweep', query: q, grad_student_count: 1 }],
    rationale:
      'Planner unreachable: degraded to a single broad literature sweep over the research question. Re-run when a provider is reachable for a full subspecialization plan.',
  };
}

// A compact, non-conversational summary for the Packet Inspector / Agent Console.
function summarize(result) {
  const subs = result.subspecializations;
  const n = subs.length;
  const totalStudents = subs.reduce((acc, s) => acc + s.grad_student_count, 0);
  const names = subs.map((s) => s.name).join(', ');
  return `Planned ${n} subspecialization${n === 1 ? '' : 's'} (${totalStudents} grad student${
    totalStudents === 1 ? '' : 's'
  }): ${names}.`;
}

export function createFearlessLeaderAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || FEARLESS_LEADER_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 768;

  // The planning step the orchestrator runs at FEARLESS_LEADER. RQPacket in, a validated
  // { subspecializations, rationale } out, attributed to Fearless Leader. No control
  // transition is requested, so the default forward edge (FEARLESS_LEADER -> PHASE_1)
  // proceeds.
  return async function fearlessLeaderPlan(ctx = {}) {
    const session = ctx.session || {};
    const rqPacket =
      ctx.rqPacket != null && typeof ctx.rqPacket === 'object'
        ? ctx.rqPacket
        : session.rqPacket && typeof session.rqPacket === 'object'
          ? session.rqPacket
          : {};
    const researchQuestion = ctx.researchQuestion != null ? ctx.researchQuestion : session.researchQuestion;
    const extraPapers = Array.isArray(session.extraPapers) ? session.extraPapers : [];

    // The unknown-field surfacing loop (orchestrator-owned) stages the unaddressed RQ aspects on
    // session.unknownFields before a re-sweep. Read them as additional context so this plan TARGETS
    // them, then CLEAR them (consume-once) so the initial sweep and later non-loop entries are
    // unaffected. The agent invents no fields; it only narrows the sweep toward the ones surfaced.
    const unknownFields = Array.isArray(session.unknownFields) ? session.unknownFields.filter((f) => typeof f === 'string' && f.trim()) : [];
    if (session && 'unknownFields' in session) session.unknownFields = [];

    const safeDefault = buildSafeDefault({ researchQuestion });

    const targetedDirective = unknownFields.length
      ? `\nPrior sweeps left these RQ aspects UNADDRESSED; plan subspecializations that TARGET them: ${unknownFields.join('; ')}.\n`
      : '';

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          `Research question:\n${researchQuestion || '(inherited from Loop 1; see packet)'}\n\n` +
          `Research question packet (version ${rqPacket.version == null ? 'unknown' : rqPacket.version}):\n` +
          `${JSON.stringify(rqPacket, null, 2)}\n\n` +
          `Papers the researcher added for this review: ${extraPapers.length}.\n` +
          targetedDirective +
          `\nPlan the subspecialization sweep.`,
      },
    ];

    const raw = await dispatch({
      agentId: 'Fearless Leader',
      tier: 'extraction',
      failover,
      messages,
      schema: fearlessLeaderResultSchema,
      safeDefault,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    // Validate once more before the orchestrator acts (the safe default is valid by
    // construction; this guarantees an on-contract plan regardless of path).
    const result = fearlessLeaderResultSchema(raw) ? raw : safeDefault;

    return {
      agentId: 'Fearless Leader',
      content: summarize(result),
      result,
      control: {},
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance, built against the real dispatch singleton. main.js injects this
// as the orchestrator's `Fearless Leader` step. Tests build isolated agents with
// createFearlessLeaderAgent({ dispatch, ... }) on a fake dispatch.
export const fearlessLeaderAgent = createFearlessLeaderAgent();
