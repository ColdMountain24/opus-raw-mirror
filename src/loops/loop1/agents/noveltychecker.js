// Novelty Checker, the Loop 1 (The Agora) novelty assessor.
//
// The Novelty Checker invokes Edgar Allan to retrieve recent literature on the
// research question topic, then evaluates whether the question proposes something
// meaningfully novel relative to that literature. It returns a validated result,
// { novelty_signal: 'high'|'medium'|'low', rationale, overlapping_papers }.
//
// A low novelty signal is a non-blocking warning: it is carried forward (on the
// packet and in session.noveltyWarning) for the cessation card to surface through
// Poe, and the chain still proceeds. It does NOT route back to Poe like a CV or
// RQSupervisor block: the researcher decides whether to proceed.
//
// Because the Novelty Checker invokes Edgar itself, it routes forward to
// P53_EVALUATE, past the orchestrator's now-redundant EDGAR_RETRIEVE state (which
// the stub linear chain still uses). It runs on the extraction tier,
// Anthropic-first; HIPAA enforcement in the dispatcher still overrides this.
//
// Charter boundary. The Novelty Checker owns its output contract (the result
// schema, given by the spec) and its safe default. It does NOT own the RQPacket
// schema; Edgar (its tool) is injected, and the paradigm it hands Edgar is read
// from the RQSupervisor verdict in history.

import { dispatch as defaultDispatch } from '../../../dispatcher/dispatcher.js';
import { NOVELTY_SYSTEM_PROMPT } from '../prompts.js';
import { EXTRACTION_TIER } from '../tiers.js';
import { edgarAgent as defaultEdgar } from './edgar.js';

export { EXTRACTION_TIER };

const SIGNALS = new Set(['high', 'medium', 'low']);

// The Novelty Checker's output contract, given verbatim by the spec.
export function noveltyResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!SIGNALS.has(v.novelty_signal)) return false;
  if (typeof v.rationale !== 'string') return false;
  if (!Array.isArray(v.overlapping_papers) || !v.overlapping_papers.every((s) => typeof s === 'string')) {
    return false;
  }
  return true;
}

// Safe default when novelty cannot be assessed (no provider reachable). It reports
// a low signal with an explicit rationale, so the researcher is cautioned that
// novelty was not checked rather than falsely reassured. A low signal warns but
// never blocks.
export const NOVELTY_SAFE_DEFAULT = Object.freeze({
  novelty_signal: 'low',
  rationale:
    'Novelty could not be assessed because the literature check was unavailable. Treat this as a caution, not a finding.',
  overlapping_papers: [],
});

// Forward state: the Novelty Checker invokes Edgar itself, so it routes to
// P53_EVALUATE, past the redundant EDGAR_RETRIEVE state. Literal so the agent does
// not depend on the orchestrator module; the orchestrator validates it against the
// legal adjacency.
const P53_EVALUATE = 'P53_EVALUATE';

// Read the paradigm RQSupervisor detected from history, to route Edgar's sources.
function paradigmFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const e = history[i];
    const paradigm = e && e.agentId === 'RQSupervisor' && e.packet && e.packet.result && e.packet.result.paradigm;
    if (typeof paradigm === 'string' && paradigm) return paradigm;
  }
  return undefined;
}

function summarize(result, retrieval) {
  const overlap = result.overlapping_papers.length ? ` ${result.overlapping_papers.length} overlapping.` : '';
  const n = retrieval.retrieval_count;
  return `Novelty ${result.novelty_signal} against ${n} paper${n === 1 ? '' : 's'}.${overlap}`;
}

export function createNoveltyCheckerAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const edgar = deps.edgar || defaultEdgar;
  const systemPrompt = deps.systemPrompt || NOVELTY_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 384;
  const forwardTransition = deps.forwardTransition || P53_EVALUATE;

  // The novelty step the orchestrator runs at NOVELTY_CHECK. It invokes Edgar,
  // evaluates novelty against the retrieved papers, and returns a validated
  // result attributed to the Novelty Checker.
  return async function noveltyCheck(ctx = {}) {
    const session = ctx.session || {};
    const rqPacket = session.rqPacket && typeof session.rqPacket === 'object' ? session.rqPacket : {};

    // Invoke Edgar Allan to retrieve literature (Edgar is the Novelty Checker's
    // tool). Pass the detected paradigm so Edgar routes its sources.
    const paradigm = paradigmFromHistory(ctx.history) || session.paradigm;
    const edgarPacket = await edgar({
      session,
      researchQuestion: ctx.researchQuestion != null ? ctx.researchQuestion : session.researchQuestion,
      query: ctx.query,
      paradigm,
    });
    const retrieval =
      edgarPacket && edgarPacket.result && typeof edgarPacket.result === 'object'
        ? edgarPacket.result
        : { papers: [], query_used: '', retrieval_count: 0 };

    const messages = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Research question packet (version ${
          rqPacket.version == null ? 'unknown' : rqPacket.version
        }):\n${JSON.stringify(rqPacket, null, 2)}\n\nRetrieved literature (${
          retrieval.retrieval_count
        } papers):\n${JSON.stringify(retrieval.papers, null, 2)}`,
      },
    ];

    const raw = await dispatch({
      agentId: 'Novelty Checker',
      tier: 'extraction',
      failover,
      messages,
      schema: noveltyResultSchema,
      safeDefault: NOVELTY_SAFE_DEFAULT,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });
    const result = noveltyResultSchema(raw) ? raw : NOVELTY_SAFE_DEFAULT;

    // A low signal is a non-blocking warning carried forward to the cessation
    // card (surfaced through Poe there); it never routes back or blocks.
    const warning =
      result.novelty_signal === 'low'
        ? { kind: 'low_novelty', rationale: result.rationale, overlapping_papers: result.overlapping_papers }
        : null;
    session.noveltyWarning = warning;

    return {
      agentId: 'Novelty Checker',
      content: summarize(result, retrieval),
      result,
      retrieval, // Edgar's retrieval surfaced through the Novelty Checker's packet (IO panel)
      warning, // non-blocking; the cessation card surfaces it through Poe
      control: { transition: forwardTransition },
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance, built against the real dispatch singleton and the default
// (not-wired) Edgar. main.js injects a configured instance. Tests build isolated
// agents with createNoveltyCheckerAgent({ dispatch, edgar, ... }) on fakes.
export const noveltyCheckerAgent = createNoveltyCheckerAgent();
