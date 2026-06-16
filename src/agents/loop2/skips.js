// Skips, the Loop 2 (The Archive) cross-subspecialization analyst. An INTERNAL TOOL (no dedicated
// orchestrator state, like Edgar): it is invoked inside the Revision Check control point. After the
// subspecializations are extracted and promoted, Skips scans ACROSS all SubspecializationKGs (never
// within a single one) for two signals:
//   - cross-subspecialization contradictions: a claim in one subspecialization that directly
//     contradicts a claim in a DIFFERENT subspecialization, and
//   - unknown fields: RQPacket aspects no subspecialization has addressed.
// It returns { contradictions: [{claim_a_id, claim_b_id, nature}], unknown_fields: string[] }. The
// Revision Check routes on this result: contradictions are surfaced to the researcher via Poe
// (MATERIAL_CONTRADICTIONS), unknown fields trigger a new subspecialization sweep (Fearless Leader).
// It runs on the extraction tier.
//
// The judgments (what contradicts what, which fields are unaddressed) need the model, so there is no
// deterministic floor: the safe default is the empty result (on a provider outage, Skips surfaces
// nothing rather than inventing routing). The model's contradictions are filtered to claim_id pairs
// that actually exist in the KGs (no hallucinated ids).
//
// Charter boundary. Skips owns its output contract (the result schema, given verbatim by the spec)
// and its safe default. It does NOT own the claim schema or the RQPacket schema (FINAL): it reasons
// over the KGs + packet it is handed and names unaddressed aspects from the packet's own content.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { SKIPS_SYSTEM_PROMPT } from './prompts.js';
// Tiers live under loop1/ (historical home). FUTURE: move to a shared path.
import { EXTRACTION_TIER } from '../../loops/loop1/tiers.js';

export { EXTRACTION_TIER };

function isStringArray(a) {
  return Array.isArray(a) && a.every((s) => typeof s === 'string');
}

function isContradiction(c) {
  return (
    c &&
    typeof c === 'object' &&
    typeof c.claim_a_id === 'string' &&
    c.claim_a_id.length > 0 &&
    typeof c.claim_b_id === 'string' &&
    c.claim_b_id.length > 0 &&
    typeof c.nature === 'string'
  );
}

// Skips' output contract, given verbatim by the spec. Strict: the Revision Check only routes on a
// value that matches this, so the dispatcher runs the corrective retry on a miss and otherwise falls
// back to the safe default.
export function skipsResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!Array.isArray(v.contradictions) || !v.contradictions.every(isContradiction)) return false;
  if (!isStringArray(v.unknown_fields)) return false;
  return true;
}

// The dispatcher safe default when no provider is reachable: the empty result (no contradictions,
// no unknown fields). Non-destructive - a provider outage never invents a contradiction to surface
// or an unknown field that would trigger a spurious re-sweep.
export const SKIPS_SAFE_DEFAULT = Object.freeze({ contradictions: [], unknown_fields: [] });

// Read the most recent packet in history that carries SubspecializationKGs (the Bookkeeper stage,
// else the PHASE_1 Grad Students aggregate). The later entry wins.
export function readSubspecializationKGs(history) {
  const list = Array.isArray(history) ? history : [];
  let found = null;
  for (const h of list) {
    const subs = h && h.packet && h.packet.result && h.packet.result.subspecializations;
    if (Array.isArray(subs) && subs.length) found = subs;
  }
  return found || [];
}

function allClaimIds(kgs) {
  const ids = new Set();
  kgs.forEach((kg) => (Array.isArray(kg.claims) ? kg.claims : []).forEach((c) => {
    if (c && typeof c.claim_id === 'string') ids.add(c.claim_id);
  }));
  return ids;
}

function summarize(result) {
  const c = result.contradictions.length;
  const u = result.unknown_fields.length;
  return `Cross-subspecialization scan: ${c} contradiction${c === 1 ? '' : 's'}, ${u} unknown field${
    u === 1 ? '' : 's'
  }.`;
}

export function createSkipsAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || SKIPS_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 1024;

  function claimLine(c) {
    return `    - [${c.claim_id}] ${c.text || ''}`;
  }

  function subspecBlock(kg) {
    const claims = Array.isArray(kg.claims) ? kg.claims : [];
    return (
      `Subspecialization "${kg.subspecialization_label || kg.subspecialization_id || '(unnamed)'}" (id ${kg.subspecialization_id || 'unknown'}):\n` +
      `${claims.map(claimLine).join('\n') || '    (no claims)'}`
    );
  }

  function buildScanText(kgs, rqPacket) {
    return (
      `Research question packet:\n${JSON.stringify(rqPacket, null, 2)}\n\n` +
      `SubspecializationKGs (${kgs.length}):\n${kgs.map(subspecBlock).join('\n\n') || '(none)'}\n\n` +
      `Scan ACROSS the subspecializations and return the JSON object.`
    );
  }

  // The scan step. Invoked by the Revision Check control point with the orchestrator ctx (history +
  // RQPacket). Returns { agentId:'Skips', result:{contradictions, unknown_fields} }; the parent step
  // reads the result and drives the routing. Not an orchestrator state, so no control transition.
  return async function skipsScan(ctx = {}) {
    const session = ctx.session || {};
    const kgs = readSubspecializationKGs(ctx.history);
    const rqPacket =
      ctx.rqPacket != null && typeof ctx.rqPacket === 'object'
        ? ctx.rqPacket
        : session.rqPacket && typeof session.rqPacket === 'object'
          ? session.rqPacket
          : {};

    const raw = await dispatch({
      agentId: 'Skips',
      tier: 'extraction',
      failover,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildScanText(kgs, rqPacket) },
      ],
      schema: skipsResultSchema,
      safeDefault: SKIPS_SAFE_DEFAULT,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    const model = skipsResultSchema(raw) ? raw : SKIPS_SAFE_DEFAULT;

    // Keep only contradictions whose BOTH claim ids exist in the KGs (drop any the model invented).
    const known = allClaimIds(kgs);
    const contradictions = model.contradictions.filter((c) => known.has(c.claim_a_id) && known.has(c.claim_b_id));
    const result = { contradictions, unknown_fields: model.unknown_fields };

    return { agentId: 'Skips', content: summarize(result), result, control: {} };
  };
}

// Default app instance, built against the real dispatch singleton. main.js injects this into the
// Revision Check step (createRevisionCheck({ skips })). Tests build isolated agents with
// createSkipsAgent({ dispatch, ... }) on a fake dispatch.
export const skipsAgent = createSkipsAgent();
