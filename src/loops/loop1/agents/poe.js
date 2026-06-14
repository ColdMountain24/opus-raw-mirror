// Poe, configured as the Loop 1 (The Agora) elicitation agent.
//
// Poe is the research collaborator and the only agent that speaks to the
// researcher (the TurnGate rule). In Loop 1 its sole job is elicitation: it asks
// one clarifying question per turn to articulate the research question. The
// orchestrator runs this step at POE_INTAKE; it returns a packet attributed to
// 'Poe' that the orchestrator hands to Poe's conversation surface.
//
// Provider: Poe runs on the conversation tier, Groq-first for streaming speed,
// falling back through the dispatcher (Groq -> Anthropic -> Mistral) via the
// per-call failover override. HIPAA enforcement inside the dispatcher still
// overrides this absolutely (an ollama-only session is never routed to a hosted
// provider).
//
// Charter boundary. Poe owns its conversational prose (its `content`), its own
// safe default, and its input/output interfaces. It does NOT own the RQPacket
// schema or CV's wire format (both FINAL, user-owned). Those enter through two
// injected seams with deferred defaults this phase:
//   - extractRQPacket({ transcript, previous, version }) -> rqPacket
//       Re-shapes the versioned RQPacket from the transcript. The default carries
//       the prior packet forward with the bumped version and invents no domain
//       fields; the RQPacket-schema phase swaps in the real extraction.
//   - readReviewVerdict(history) -> { passed, blocking } | null
//       Poe's consumption interface for the latest upstream review verdict (CV
//       completeness or RQSupervisor structure, whichever weighed in last). Poe
//       owns this interface; the adapters from each reviewer's FINAL packet to it
//       live in review.js. The default returns null, so with no reviewer wired
//       Poe stays in elicitation and never declares the question final.
// The version counter is a mechanism Poe owns; the packet's domain fields are not.

import { dispatch as defaultDispatch } from '../../../dispatcher/dispatcher.js';
import { POE_SYSTEM_PROMPT } from '../prompts.js';
import { CONVERSATION_TIER } from '../tiers.js';

// The conversation tier (Groq-first) is defined once in tiers.js and re-exported
// here for the callers and tests that read it off the agent.
export { CONVERSATION_TIER };

// Poe's own output contract for a conversational turn: a single non-empty
// message string. Poe owns this (it is presentation, not the FINAL RQPacket), so
// the dispatcher validates against it and runs the corrective retry on a miss.
export function poeMessageSchema(body) {
  return Boolean(body && typeof body.message === 'string' && body.message.trim().length > 0);
}

// Poe's safe default when no provider is reachable. Every transport is empty in
// this build, so live calls land here until real fetch is wired; the copy is
// unique and in character, never a generic placeholder.
export const POE_SAFE_DEFAULT = Object.freeze({
  message:
    'I lost my connection to the model for a moment. Tell me a little more about your study and I will pick the thread back up.',
});

// Deferred RQPacket extractor (FINAL schema, user-owned): carry the prior packet
// forward with the bumped version, inventing no domain fields.
function defaultExtractRQPacket({ previous, version }) {
  return { ...(previous && typeof previous === 'object' ? previous : {}), version };
}

// Deferred review verdict reader (FINAL reviewer contracts, user-owned): none yet.
function defaultReadReviewVerdict() {
  return null;
}

// Build the per-turn guidance note. This is where the review gate is enforced at
// the prompt level: Poe is told to invite confirmation only when the latest
// reviewer passed, and is otherwise told plainly not to declare the question
// final. When a reviewer reports blocking items, they are surfaced verbatim so
// Poe addresses a real gap rather than emitting a generic "not ready yet".
function guidanceFor(verdict) {
  if (verdict && verdict.passed === true) {
    return {
      role: 'system',
      content:
        'The study is now well defined. State that plainly, in one or two sentences, and invite the researcher to confirm the research question.',
    };
  }
  if (verdict && Array.isArray(verdict.blocking) && verdict.blocking.length > 0) {
    return {
      role: 'system',
      content: `The question is not yet complete. These aspects still need to be clarified: ${verdict.blocking.join(
        '; ',
      )}. Do not tell the researcher the question is final or ready to confirm. Ask one question about the single most important gap.`,
    };
  }
  return {
    role: 'system',
    content:
      'The question is not yet complete. Do not tell the researcher it is final or ready to confirm. Ask one clarifying question that moves the study toward being well defined.',
  };
}

export function createPoeAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || POE_SYSTEM_PROMPT;
  const failover = deps.failover || CONVERSATION_TIER;
  const maxTokens = deps.maxTokens || 512;
  const extractRQPacket = deps.extractRQPacket || defaultExtractRQPacket;
  const readReviewVerdict = deps.readReviewVerdict || defaultReadReviewVerdict;

  // The elicitation step the orchestrator runs at POE_INTAKE. One substantive
  // user message in, one clarifying question out, attributed to Poe.
  return async function poeIntake(ctx = {}) {
    const session = ctx.session || {};
    const userMessage = ctx.researchQuestion == null ? '' : String(ctx.researchQuestion);

    // Running conversation transcript (Poe's presentation state, not the packet).
    if (!Array.isArray(session.transcript)) session.transcript = [];
    if (userMessage) session.transcript.push({ role: 'user', content: userMessage });

    // Gate: Poe may invite the researcher to confirm a finished question only when
    // the latest reviewer passed; otherwise it keeps eliciting and never finalizes.
    const verdict = readReviewVerdict(ctx.history || []);
    const messages = [
      { role: 'system', content: systemPrompt },
      ...session.transcript,
      guidanceFor(verdict),
    ];

    const body = await dispatch({
      agentId: 'Poe',
      tier: 'conversation',
      failover,
      messages,
      schema: poeMessageSchema,
      safeDefault: POE_SAFE_DEFAULT,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    const message =
      body && typeof body.message === 'string' && body.message.trim().length > 0
        ? body.message
        : POE_SAFE_DEFAULT.message;
    session.transcript.push({ role: 'assistant', content: message });

    // Re-extract and re-version the RQPacket from the updated transcript before
    // CV runs. The orchestrator's default next state out of POE_INTAKE is
    // CV_CHECK, so returning no control transition is what "triggers CV".
    session.rqVersion = (session.rqVersion || 0) + 1;
    // The real extractor (extraction.js) dispatches to pull the structured packet, so
    // this seam is awaited. The deferred default and the test seams are synchronous;
    // awaiting a synchronous return is a no-op, so this stays backward compatible.
    session.rqPacket = await extractRQPacket({
      transcript: session.transcript.slice(),
      previous: session.rqPacket || null,
      version: session.rqVersion,
      userMessage,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    return {
      agentId: 'Poe',
      content: message,
      control: {},
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance, built against the real dispatch singleton. main.js injects
// this as the orchestrator's `Poe` step. Tests build isolated agents with
// createPoeAgent({ dispatch, ... }) on a fake dispatch and fake seams.
export const poeAgent = createPoeAgent();
