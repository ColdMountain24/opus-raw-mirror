// Salvia, the Loop 2 (The Archive) uncertainty surveyor (the orchestrator's UNKNOWN_FIELD_SURFACING
// agent). After the subspecializations are extracted and promoted, Salvia scans the resulting
// SubspecializationKGs plus the inherited research-question packet for the uncertainty that remains
// and returns a compact summary that the p53 cessation evaluator consumes (the adjacency runs
// UNKNOWN_FIELD_SURFACING -> P53_EVALUATE). It runs on the extraction tier.
//
// Three uncertainty signals (the spec): claims whose evidence conflicts with another claim in the
// same subspecialization, claims already flagged for quality, and aspects of the RQPacket no claim
// yet addresses. The flagged-claim signal is DETERMINISTIC (Salvia reads each claim's quality_review
// / salvia_status), so the safe default already surfaces it; the conflicting-evidence and
// unaddressed-field judgments need the model, so Salvia dispatches and the model's validated result
// is the authority, UNIONED with the deterministic flags (a flagged claim is never missed) and
// filtered to claim_ids that actually exist (no hallucinated ids).
//
// NOTE: this is a SEPARATE concern from the per-claim salvia_status grounding seam inside the Grad
// Student (which SETS each claim's valid/flagged/rejected status). Salvia here READS those flags and
// surfaces aggregate uncertainty; it is not that validator (see Opus_DELTAS).
//
// Charter boundary. Salvia owns its output contract (the result schema, given verbatim by the spec)
// and its safe default. It does NOT own the claim schema or the RQPacket schema (FINAL): it reasons
// over the KGs + packet it is handed and names unaddressed aspects from the packet's own content,
// never inventing claims or field names.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { SALVIA_SYSTEM_PROMPT } from './prompts.js';
// Tiers live under loop1/ (historical home). FUTURE: move to a shared path.
import { EXTRACTION_TIER } from '../../loops/loop1/tiers.js';

export { EXTRACTION_TIER };

export const UNCERTAINTY_LEVELS = Object.freeze(['low', 'medium', 'high']);

function isStringArray(a) {
  return Array.isArray(a) && a.every((s) => typeof s === 'string');
}

// Salvia's output contract, given verbatim by the spec. Strict: p53 only acts on a value that
// matches this, so the dispatcher runs the corrective retry on a miss and otherwise falls back to
// the safe default.
export function salviaResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!isStringArray(v.uncertain_claims)) return false;
  if (!isStringArray(v.unaddressed_rq_fields)) return false;
  if (!UNCERTAINTY_LEVELS.includes(v.uncertainty_level)) return false;
  return true;
}

// Read the most recent packet in history that carries SubspecializationKGs: the Bookkeeper stage
// (the staged KGs), else the PHASE_1 Grad Students aggregate. The later entry wins, so the staged
// KGs supersede the raw PHASE_1 ones.
export function readSubspecializationKGs(history) {
  const list = Array.isArray(history) ? history : [];
  let found = null;
  for (const h of list) {
    const subs = h && h.packet && h.packet.result && h.packet.result.subspecializations;
    if (Array.isArray(subs) && subs.length) found = subs;
  }
  return found || [];
}

function isFlagged(c) {
  return (c && c.quality_review && c.quality_review.quality === 'flag') || (c && c.salvia_status === 'flagged');
}

function allClaimIds(kgs) {
  const ids = [];
  kgs.forEach((kg) => (Array.isArray(kg.claims) ? kg.claims : []).forEach((c) => {
    if (c && typeof c.claim_id === 'string') ids.push(c.claim_id);
  }));
  return ids;
}

// Uncertainty level from the flagged proportion (the deterministic part). No claims at all is
// maximally uncertain (the sweep surfaced nothing to be certain about).
function levelFor(flaggedCount, total) {
  if (total === 0) return 'high';
  const ratio = flaggedCount / total;
  if (ratio === 0) return 'low';
  if (ratio < 0.34) return 'medium';
  return 'high';
}

// The deterministic scan: flagged claims -> uncertain_claims, a level from the flagged proportion,
// and no unaddressed-field judgment (that needs the model, so [] here). Used as the dispatcher safe
// default AND as a seed/floor unioned into the model's result.
export function scanForUncertainty(kgs) {
  const list = Array.isArray(kgs) ? kgs : [];
  let total = 0;
  const uncertain = [];
  list.forEach((kg) => (Array.isArray(kg.claims) ? kg.claims : []).forEach((c) => {
    if (!c || typeof c.claim_id !== 'string') return;
    total += 1;
    if (isFlagged(c)) uncertain.push(c.claim_id);
  }));
  return { uncertain_claims: uncertain, unaddressed_rq_fields: [], uncertainty_level: levelFor(uncertain.length, total) };
}

function summarize(result) {
  const u = result.uncertain_claims.length;
  const f = result.unaddressed_rq_fields.length;
  return `Uncertainty ${result.uncertainty_level}: ${u} uncertain claim${u === 1 ? '' : 's'}, ${f} unaddressed field${
    f === 1 ? '' : 's'
  }.`;
}

export function createSalviaAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || SALVIA_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 768;

  function claimLine(c) {
    const flags = [];
    if (c.quality_review && c.quality_review.quality === 'flag') flags.push('quality-flagged');
    if (c.salvia_status === 'flagged') flags.push('grounding-flagged');
    const dois = Array.isArray(c.supporting_paper_dois) ? c.supporting_paper_dois.join(', ') : '';
    return `  - [${c.claim_id}] ${c.text || ''}${flags.length ? ` (${flags.join(', ')})` : ''} | supporting: ${dois || '(none)'}`;
  }

  function subspecBlock(kg) {
    const claims = Array.isArray(kg.claims) ? kg.claims : [];
    return (
      `Subspecialization: ${kg.subspecialization_label || kg.subspecialization_id || '(unnamed)'} (id ${kg.subspecialization_id || 'unknown'})\n` +
      `Claims (${claims.length}):\n${claims.map(claimLine).join('\n') || '  (none)'}`
    );
  }

  function buildScanText(kgs, rqPacket, seed) {
    return (
      `Research question packet:\n${JSON.stringify(rqPacket, null, 2)}\n\n` +
      `SubspecializationKGs (${kgs.length}):\n${kgs.map(subspecBlock).join('\n\n') || '(none)'}\n\n` +
      `Claims already flagged for quality (deterministic): ${seed.uncertain_claims.join(', ') || '(none)'}\n\n` +
      `Scan for uncertainty and return the JSON object.`
    );
  }

  // The scan step the orchestrator runs at UNKNOWN_FIELD_SURFACING. KGs + RQPacket in, a validated
  // uncertainty summary out, attributed to Salvia, backstage (settled to the IO panel). No control
  // transition, so the default forward edge (UNKNOWN_FIELD_SURFACING -> P53_EVALUATE) proceeds.
  return async function salviaScan(ctx = {}) {
    const session = ctx.session || {};
    const kgs = readSubspecializationKGs(ctx.history);
    const rqPacket =
      ctx.rqPacket != null && typeof ctx.rqPacket === 'object'
        ? ctx.rqPacket
        : session.rqPacket && typeof session.rqPacket === 'object'
          ? session.rqPacket
          : {};

    const safeDefault = scanForUncertainty(kgs);

    const raw = await dispatch({
      agentId: 'Salvia',
      tier: 'extraction',
      failover,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildScanText(kgs, rqPacket, safeDefault) },
      ],
      schema: salviaResultSchema,
      safeDefault,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    const model = salviaResultSchema(raw) ? raw : safeDefault;

    // Union the model's uncertain claims with the deterministic flagged floor (a flagged claim is
    // never missed), and filter to claim_ids that actually exist (drop any the model invented).
    const known = new Set(allClaimIds(kgs));
    const uncertain = Array.from(new Set([...safeDefault.uncertain_claims, ...model.uncertain_claims])).filter((id) =>
      known.has(id),
    );

    const result = {
      uncertain_claims: uncertain,
      unaddressed_rq_fields: model.unaddressed_rq_fields,
      uncertainty_level: model.uncertainty_level,
    };

    return { agentId: 'Salvia', content: summarize(result), result, control: {} };
  };
}

// Default app instance, built against the real dispatch singleton. main.js injects this as the
// orchestrator's `Salvia` step at UNKNOWN_FIELD_SURFACING. Tests build isolated agents with
// createSalviaAgent({ dispatch, ... }) on a fake dispatch.
export const salviaAgent = createSalviaAgent();
