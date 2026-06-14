// CV, the Loop 1 (The Agora) completeness validator.
//
// CV scores how complete the RQPacket is across the fields a rigorous research
// question requires, returning a strict structured result,
// { status: 'pass' | 'fail', score: number, blocking_fields: string[] }. CV is a
// backstage agent: it writes its score and blocking fields to the IO panel (the
// orchestrator surfaces its packet to the Packet Inspector and its status to the
// Agent Console), never to the conversation layer.
//
// Scoring is DETERMINISTIC (no LLM dispatch). The FINAL completeness rule is owned by
// the schema (src/loops/loop1/rqschema.js, scoreCompleteness): a field is populated
// when it has content or is explicitly marked unknown; a conditional scope field the
// paradigm makes irrelevant is not counted; StudyPhase null is always valid; the pass
// threshold is 1.0 (every applicable required field populated). CV applies that rule
// over the structured packet the extraction produced, so a clean run reaches pass
// reliably (an LLM completeness score could not hold the 1.0 gate). CV keeps its
// output contract (cvResultSchema, spec-given) and fails closed.

import { CV_SYSTEM_PROMPT } from '../prompts.js';
import { scoreCompleteness } from '../rqschema.js';

// CV_SYSTEM_PROMPT is retained as the human-facing description of CV's job; the
// deterministic scorer no longer dispatches it. Re-exported for callers that read it.
export { CV_SYSTEM_PROMPT };

// CV's output contract, given verbatim by the spec. Strict: the orchestrator only
// acts on a value that matches this. The deterministic scorer produces it by
// construction; the re-check below keeps the orchestrator off any off-contract value.
export function cvResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.status !== 'pass' && v.status !== 'fail') return false;
  if (typeof v.score !== 'number' || Number.isNaN(v.score)) return false;
  if (!Array.isArray(v.blocking_fields)) return false;
  return v.blocking_fields.every((f) => typeof f === 'string');
}

// CV's safe default if scoring cannot run. It fails closed: an unscored packet never
// falsely passes, and it names no blocking fields it cannot know.
export const CV_SAFE_DEFAULT = Object.freeze({ status: 'fail', score: 0, blocking_fields: [] });

// The orchestrator state CV routes back to on a failed check so Poe resumes
// elicitation (surfacing the blocking fields). A literal so the agent does not depend
// on the orchestrator module; the orchestrator validates it against legal adjacency.
const POE_INTAKE = 'POE_INTAKE';

function defaultRouteOnResult(result) {
  return result.status === 'fail' ? POE_INTAKE : undefined;
}

function formatScore(score) {
  const n = typeof score === 'number' && !Number.isNaN(score) ? score : 0;
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

// A compact, non-conversational summary for the Packet Inspector / Agent Console.
function summarize(result) {
  const blocking = result.blocking_fields.length
    ? ` Blocking: ${result.blocking_fields.join(', ')}.`
    : '';
  return `Completeness ${formatScore(result.score)} (${result.status}).${blocking}`;
}

export function createCVAgent(deps = {}) {
  // The scorer is injectable so tests can pin behavior, defaulting to the FINAL rule.
  const score = typeof deps.score === 'function' ? deps.score : scoreCompleteness;
  const routeOnResult = deps.routeOnResult || defaultRouteOnResult;

  // The completeness step the orchestrator runs at CV_CHECK. RQPacket in, a validated
  // { status, score, blocking_fields } out, attributed to CV. Deterministic.
  return async function cvCheck(ctx = {}) {
    const session = ctx.session || {};
    const rqPacket = session.rqPacket && typeof session.rqPacket === 'object' ? session.rqPacket : {};

    let scored;
    try {
      scored = score(rqPacket);
    } catch (_err) {
      scored = CV_SAFE_DEFAULT;
    }
    const result = cvResultSchema(scored) ? scored : CV_SAFE_DEFAULT;
    const transition = routeOnResult(result);

    return {
      agentId: 'CV',
      content: summarize(result),
      result,
      control: transition ? { transition } : {},
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance. main.js injects this as the orchestrator's CV step. Tests
// build isolated agents with createCVAgent({ score }) on a fake scorer.
export const cvAgent = createCVAgent();
