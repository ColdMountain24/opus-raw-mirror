// The MATERIAL_CONTRADICTIONS step + the material-contradiction resolution helpers.
//
// Poe surfaces the cross-subspecialization contradictions Skips found (carried on the Revision Check
// packet) to the researcher BEFORE the GlobalKG promotion (BOOKKEEPER_PROMOTE), so the researcher can
// mark each one: resolved (one side clearly stronger), unresolved (acknowledge and continue), or
// escalated (flag for Loop 3 hypothesis scrutiny). The surfacer step itself is the conversation lead-in
// (agentId 'Poe', routed through poe.receive); the per-contradiction DECISION (enrich with the paper
// sources on each side, surface one at a time through Poe's overlay, record the choice, resume) is
// orchestrator-owned (it cannot live in a backstage agent), mirroring the RQ-revision check. These pure
// helpers carry the testable mechanics the orchestrator wires.
//
// Charter boundary. A MECHANISM: it reads the contradictions Skips produced and resolves the claim text +
// paper sources from the staged KGs (inventing nothing). It owns no contradiction content and adds no
// routing edges (MATERIAL_CONTRADICTIONS -> BOOKKEEPER_PROMOTE is the user-supplied adjacency).

// A stable id for a Skips contradiction pair. Directed as Skips emits it (claim_a then claim_b), so the
// orchestrator's resolution map key and the Bookkeeper's GlobalKG tagging lookup agree (both key off the
// same Skips contradictions array).
export function contradictionKey(c) {
  return `${c && c.claim_a_id}::${c && c.claim_b_id}`;
}

// Index the staged SubspecializationKGs by raw claim_id -> { text, paper_dois, subspecialization_id }, so a
// contradiction's claim ids resolve to the claim text + its supporting papers (the sources on each side).
function indexStagedClaims(stagedKGs) {
  const byId = new Map();
  for (const kg of Array.isArray(stagedKGs) ? stagedKGs : []) {
    const subId = kg && typeof kg.subspecialization_id === 'string' ? kg.subspecialization_id : '';
    for (const claim of Array.isArray(kg && kg.claims) ? kg.claims : []) {
      if (claim && typeof claim.claim_id === 'string' && !byId.has(claim.claim_id)) {
        byId.set(claim.claim_id, {
          claim_id: claim.claim_id,
          text: typeof claim.text === 'string' ? claim.text : '',
          paper_dois: Array.isArray(claim.supporting_paper_dois)
            ? claim.supporting_paper_dois.filter((d) => typeof d === 'string')
            : [],
          subspecialization_id: subId,
        });
      }
    }
  }
  return byId;
}

function resolveSide(claimId, index) {
  const found = index.get(claimId);
  if (found) return found;
  // Fallback when the claim is not in the staged KGs (e.g. a refinement round dropped it): show the id,
  // with no sources, rather than fabricating a paper.
  return { claim_id: claimId, text: '', paper_dois: [], subspecialization_id: '' };
}

// Attach the paper sources (+ claim text + subspecialization) on each side of every contradiction,
// resolved from the staged SubspecializationKGs. Pure: reads documented fields, invents nothing, and
// drops a malformed pair (missing claim ids).
export function enrichContradictions({ contradictions, stagedKGs } = {}) {
  const index = indexStagedClaims(stagedKGs);
  return (Array.isArray(contradictions) ? contradictions : [])
    .filter((c) => c && typeof c.claim_a_id === 'string' && typeof c.claim_b_id === 'string')
    .map((c) => ({
      claim_a_id: c.claim_a_id,
      claim_b_id: c.claim_b_id,
      nature: typeof c.nature === 'string' ? c.nature : '',
      side_a: resolveSide(c.claim_a_id, index),
      side_b: resolveSide(c.claim_b_id, index),
    }));
}

// The enriched contradictions the researcher has not yet decided (no entry in the resolutions map). The
// orchestrator surfaces one undecided contradiction at a time and resumes once this is empty.
export function pendingContradictions(enriched, resolutions) {
  const res = resolutions && typeof resolutions === 'object' ? resolutions : {};
  return (Array.isArray(enriched) ? enriched : []).filter((c) => !res[contradictionKey(c)]);
}

// The enriched contradictions the researcher escalated for Loop 3 hypothesis scrutiny (recorded status
// 'escalated'). These are tagged in the GlobalKG (Bookkeeper Phase 2) and forwarded into the Loop3Input
// packet (the OUTPUT_HOOK phase reads them).
export function escalatedFrom(enriched, resolutions) {
  const res = resolutions && typeof resolutions === 'object' ? resolutions : {};
  return (Array.isArray(enriched) ? enriched : []).filter((c) => {
    const r = res[contradictionKey(c)];
    return r && r.status === 'escalated';
  });
}

export function createContradictionSurfacer() {
  return async function surfaceContradictions(ctx = {}) {
    const contradictions = readContradictions(ctx.history);
    const n = contradictions.length;
    const content = n
      ? `${n} material cross-subspecialization contradiction${n === 1 ? '' : 's'} open for your resolution.`
      : 'No material cross-subspecialization contradictions found.';
    // The raw contradictions ride on the result; the orchestrator enriches them with the staged KGs' paper
    // sources and drives the per-contradiction researcher decision (resolved/unresolved/escalated).
    return { agentId: 'Poe', content, result: { contradictions }, contradictions, control: {} };
  };
}

// Read the contradictions off the most recent packet in history that carries them (the Revision Check
// packet). Returns [] when none have been produced.
export function readContradictions(history) {
  const list = Array.isArray(history) ? history : [];
  let found = [];
  for (const h of list) {
    const c = h && h.packet && h.packet.result && h.packet.result.contradictions;
    if (Array.isArray(c)) found = c;
  }
  return found;
}

// Default app instance. main.js injects this as the orchestrator's `Poe` step (used only at
// MATERIAL_CONTRADICTIONS; POE_INTAKE is handled by the orchestrator's intake gate, not this step).
export const contradictionSurfacer = createContradictionSurfacer();
