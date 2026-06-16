// Bookkeeper, the Loop 2 (The Archive) knowledge-graph promoter. CLIENT-SIDE: no LLM call, no
// dispatcher (like Edgar). It runs at the orchestrator's Bookkeeper states and branches on state:
//
//   BOOKKEEPER_STAGE   (this phase, scope 'subspecialization'): after the Grad Student + Senior
//                      review, promote each subspecialization's surviving claims into a structured
//                      SubspecializationKG, PERSIST it to IndexedDB via the storage layer, and emit
//                      the subspecialization node to the Observatory (an incremental Cytoscape add).
//   BOOKKEEPER_PROMOTE (Phase 2, scope 'global'): merge the staged SubspecializationKGs into the
//                      GlobalKG (DEDUP by subspecialization-namespaced claim id - re-promotions merge,
//                      never duplicate), TAG contradicting claims (from Skips) with their partner,
//                      persist the unified GlobalKG to IndexedDB ('loop-2','global'), and emit the
//                      contradicts edges so the Observatory shows the unified view. Also client-side.
//
// The claims it stages already passed Senior review in PHASE_1 (rejects dropped, pass/flag/unreviewed
// kept, each carrying a quality_review annotation), so "promote passing and flagged claims" is
// realized as "promote every claim that survived review" (a reviewer outage that leaves claims
// unreviewed-but-kept still promotes them, so a provider hiccup never silently empties a
// subspecialization). A defensive filter drops any claim explicitly marked reject, just in case.
//
// Charter boundary. The Bookkeeper invents no claim content (it stages what the Grad Students
// produced) and does not own the claim schema. The SubspecializationKG uses the architecture's named
// sections; the non-claim sections are scaffolded EMPTY this phase (claims-scoped), their content
// deferred. The Observatory render stays minimal: the agent emits only the subspecialization node;
// main.js (which owns the streamed-claim node registry) wires the derived-from edges to the existing
// claim nodes, so the agent needs no knowledge of render node ids.

import { kg as kgSingleton } from '../../utils/storage.js';
// The contradiction key matches the orchestrator's resolution-map key (both derive it from the same Skips
// contradiction pair), so the researcher's MATERIAL_CONTRADICTIONS decisions tag the right GlobalKG claims.
import { contradictionKey } from '../../loops/loop2/contradictions.js';

// The IndexedDB key namespace for per-subspecialization KGs. storage.kg is keyed by a
// [loopId, version] tuple (one JSON snapshot per key); we use the version slot as the
// per-subspecialization key, so each SubspecializationKG is its own record and the eventual
// GlobalKG record ('loop-2') stays separate.
export const KG_LOOP_ID = 'loop-2-subspec';

function isStringArray(a) {
  return Array.isArray(a) && a.every((s) => typeof s === 'string');
}

// A lightweight claim check at the KG level (the claims already passed the Grad Student schema
// upstream; here we only assert the identity fields a stored claim must have).
function isKgClaim(c) {
  return c && typeof c === 'object' && typeof c.claim_id === 'string' && typeof c.text === 'string';
}

// The structured SubspecializationKG stored object. Strict on identity + the claims-scoped content;
// the deferred sections must be arrays (scaffolded empty this phase).
export function subspecializationKgSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.subspecialization_id !== 'string' || v.subspecialization_id.length === 0) return false;
  if (typeof v.subspecialization_label !== 'string') return false;
  if (!v.metadata || typeof v.metadata !== 'object') return false;
  if (!Number.isInteger(v.metadata.claim_count)) return false;
  if (!Array.isArray(v.claims) || !v.claims.every(isKgClaim)) return false;
  for (const k of ['entities', 'methods', 'datasets', 'design_recommendations', 'intra_contradictions', 'unknowns']) {
    if (!Array.isArray(v[k])) return false;
  }
  return true;
}

// Claims that survived Senior review are promotable. Defensive: never promote a claim explicitly
// marked reject (gradphase already drops those; this is belt-and-suspenders), but keep unreviewed
// (quality_review null) claims (non-destructive on a reviewer outage).
function promotableClaims(claims) {
  return (Array.isArray(claims) ? claims : []).filter(
    (c) => isKgClaim(c) && !(c.quality_review && c.quality_review.quality === 'reject'),
  );
}

// Assemble a Grad Student's claims-scoped KG (from PHASE_1) into the stored SubspecializationKG.
export function buildSubspecializationKG(gsKg, clock) {
  const kg = gsKg && typeof gsKg === 'object' ? gsKg : {};
  const claims = promotableClaims(kg.claims);
  const flagged_count = claims.filter((c) => c.quality_review && c.quality_review.quality === 'flag').length;
  return {
    subspecialization_id: typeof kg.subspecialization_id === 'string' ? kg.subspecialization_id : '',
    subspecialization_label: typeof kg.subspecialization_label === 'string' ? kg.subspecialization_label : '',
    metadata: {
      grad_student_id: typeof kg.grad_student_id === 'string' ? kg.grad_student_id : '',
      retrieval_density: kg.metadata && typeof kg.metadata.retrieval_density === 'number' ? kg.metadata.retrieval_density : 0,
      edgar_queries: isStringArray(kg.edgar_queries) ? kg.edgar_queries : [],
      claim_count: claims.length,
      flagged_count,
      staged_at: clock(),
    },
    claims,
    // Architecture-named sections, scaffolded empty this phase (content deferred).
    entities: [],
    methods: [],
    datasets: [],
    design_recommendations: [],
    intra_contradictions: [],
    unknowns: [],
  };
}

// Read the PHASE_1 Grad Students packet's per-subspecialization KGs from the run history (the most
// recent PHASE_1 entry, so a refinement re-run supersedes an earlier pass).
export function readSubspecializationKGs(history) {
  const list = Array.isArray(history) ? history : [];
  let found = null;
  for (const h of list) {
    if (h && h.state === 'PHASE_1' && h.packet && h.packet.result && Array.isArray(h.packet.result.subspecializations)) {
      found = h.packet.result.subspecializations;
    }
  }
  return found || [];
}

function summarize(staged) {
  const n = staged.length;
  const claims = staged.reduce((acc, kg) => acc + kg.claims.length, 0);
  return `Staged ${n} subspecialization KG${n === 1 ? '' : 's'} to the knowledge graph (${claims} claim${
    claims === 1 ? '' : 's'
  } promoted).`;
}

// ---------------------------------------------------------------------------
// Phase 2 (BOOKKEEPER_PROMOTE): merge the staged SubspecializationKGs into the GlobalKG.
// ---------------------------------------------------------------------------

// The GlobalKG record: one snapshot keyed ('loop-2', 'global'), distinct from the per-
// subspecialization records ('loop-2-subspec', <id>). It is the unified, deduped claim graph the
// end-state's Loop3Input + Loop 3 unlock build on.
export const GLOBAL_KG_LOOP_ID = 'loop-2';
export const GLOBAL_KG_VERSION = 'global';

// A claim's identity in the GlobalKG: subspecialization-namespaced, so re-promotions of the same
// subspecialization (across refinement rounds) MERGE rather than duplicate, while two different
// subspecializations that happen to mint the same raw claim_id stay distinct.
export function globalClaimId(subspecializationId, claimId) {
  return `${subspecializationId}::${claimId}`;
}

function unionStrings(a, b) {
  const out = [];
  const seen = new Set();
  for (const s of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (typeof s === 'string' && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

// The latest BOOKKEEPER_STAGE packet's SubspecializationKGs (a refinement round only stages its own
// new subspecializations; the GlobalKG accumulates earlier ones via load + merge).
export function readStagedSubspecializationKGs(history) {
  const list = Array.isArray(history) ? history : [];
  let found = null;
  for (const h of list) {
    if (h && h.state === 'BOOKKEEPER_STAGE' && h.packet && h.packet.result && Array.isArray(h.packet.result.subspecializations)) {
      found = h.packet.result.subspecializations;
    }
  }
  return found || [];
}

// The latest Skips contradictions, carried on the Revision Check packet.
export function readContradictions(history) {
  const list = Array.isArray(history) ? history : [];
  let found = [];
  for (const h of list) {
    if (h && h.agentId === 'Revision Check' && h.packet && h.packet.result && Array.isArray(h.packet.result.contradictions)) {
      found = h.packet.result.contradictions;
    }
  }
  return found;
}

// A SubspecializationKG claim lifted into a GlobalKG claim (confidence stays null until Post-Doc).
function buildGlobalClaim(claim, subspecializationId) {
  return {
    global_claim_id: globalClaimId(subspecializationId, claim.claim_id),
    claim_id: claim.claim_id,
    subspecialization_id: subspecializationId,
    text: claim.text,
    claim_type: isStringArray(claim.claim_type) ? [...claim.claim_type] : [],
    entity_references: isStringArray(claim.entity_references) ? [...claim.entity_references] : [],
    supporting_paper_dois: isStringArray(claim.supporting_paper_dois) ? [...claim.supporting_paper_dois] : [],
    confidence: null,
    salvia_status: typeof claim.salvia_status === 'string' ? claim.salvia_status : null,
    citation_boost_count: null,
    quality_review: claim.quality_review != null ? claim.quality_review : null,
    // Tagged from the Skips contradictions below (partner raw claim_id + nature).
    contradiction_partners: [],
    // Dedup provenance: how many promotions merged into this claim (re-promotions bump it).
    promotion_count: 1,
  };
}

export function globalKgSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.loop !== 2) return false;
  if (!Array.isArray(v.subspecialization_ids) || !v.subspecialization_ids.every((s) => typeof s === 'string')) return false;
  if (!Array.isArray(v.claims)) return false;
  if (!v.claims.every((c) => c && typeof c.global_claim_id === 'string' && typeof c.claim_id === 'string')) return false;
  if (!Number.isInteger(v.claim_count) || !Number.isInteger(v.contradiction_count)) return false;
  if (!Array.isArray(v.contradictions)) return false;
  return true;
}

// Merge the staged SubspecializationKGs into the existing GlobalKG (DEDUP by global_claim_id: a claim
// already present is merged - union of evidence, latest content, promotion_count bumped - never
// duplicated), then TAG contradicting claims with their partner (re-tagged fresh from the current
// Skips scan, which is a full cross-subspecialization pass). The optional `resolutions` map (the
// researcher's MATERIAL_CONTRADICTIONS decisions, keyed by contradictionKey) stamps each tagged
// contradiction with its resolution (resolved/unresolved/escalated, + the stronger side); an escalated
// contradiction is thereby tagged in the GlobalKG (and forwarded into the Loop3Input packet). Returns the
// new GlobalKG snapshot.
export function mergeIntoGlobalKG(existing, stagedKGs, contradictions, now, resolutions) {
  const base = existing && typeof existing === 'object' && Array.isArray(existing.claims) ? existing : null;
  const byGlobalId = new Map();
  if (base) for (const c of base.claims) if (c && typeof c.global_claim_id === 'string') byGlobalId.set(c.global_claim_id, { ...c });
  const subspecIds = new Set(base && Array.isArray(base.subspecialization_ids) ? base.subspecialization_ids : []);

  for (const kg of Array.isArray(stagedKGs) ? stagedKGs : []) {
    const subId = kg && typeof kg.subspecialization_id === 'string' ? kg.subspecialization_id : '';
    if (!subId) continue;
    subspecIds.add(subId);
    for (const claim of Array.isArray(kg.claims) ? kg.claims : []) {
      if (!isKgClaim(claim)) continue;
      const gid = globalClaimId(subId, claim.claim_id);
      const prior = byGlobalId.get(gid);
      if (prior) {
        prior.supporting_paper_dois = unionStrings(prior.supporting_paper_dois, claim.supporting_paper_dois);
        prior.claim_type = unionStrings(prior.claim_type, claim.claim_type);
        prior.entity_references = unionStrings(prior.entity_references, claim.entity_references);
        prior.text = claim.text;
        if (claim.quality_review != null) prior.quality_review = claim.quality_review;
        prior.promotion_count = (Number.isInteger(prior.promotion_count) ? prior.promotion_count : 1) + 1;
      } else {
        byGlobalId.set(gid, buildGlobalClaim(claim, subId));
      }
    }
  }

  // Contradiction tagging. Skips emits raw claim_ids; index raw claim_id -> [global ids] (a raw id can
  // map to >1 global claim if two subspecializations minted it) and tag each side with its partner.
  const byRaw = new Map();
  for (const c of byGlobalId.values()) {
    c.contradiction_partners = []; // re-tag fresh from the current scan
    const arr = byRaw.get(c.claim_id) || [];
    arr.push(c.global_claim_id);
    byRaw.set(c.claim_id, arr);
  }
  const tagPartner = (fromRaw, partnerRaw, nature, resolution) => {
    for (const gid of byRaw.get(fromRaw) || []) {
      const c = byGlobalId.get(gid);
      if (!c) continue;
      if (!c.contradiction_partners.some((p) => p.partner_claim_id === partnerRaw)) {
        c.contradiction_partners.push({ partner_claim_id: partnerRaw, nature: typeof nature === 'string' ? nature : '', resolution });
      }
    }
  };
  const res = resolutions && typeof resolutions === 'object' ? resolutions : {};
  const tagged = [];
  for (const con of Array.isArray(contradictions) ? contradictions : []) {
    if (!con || typeof con.claim_a_id !== 'string' || typeof con.claim_b_id !== 'string') continue;
    // The researcher's decision for this pair (default 'open' when MATERIAL_CONTRADICTIONS has not run yet,
    // e.g. a provider-only chain). An 'escalated' tag is the Loop 3 hand-off signal.
    const decision = res[contradictionKey(con)];
    const resolution = decision && typeof decision.status === 'string' ? decision.status : 'open';
    const strongerClaimId = decision && decision.stronger_claim_id ? decision.stronger_claim_id : null;
    tagPartner(con.claim_a_id, con.claim_b_id, con.nature, resolution);
    tagPartner(con.claim_b_id, con.claim_a_id, con.nature, resolution);
    tagged.push({
      claim_a_id: con.claim_a_id,
      claim_b_id: con.claim_b_id,
      nature: typeof con.nature === 'string' ? con.nature : '',
      resolution,
      stronger_claim_id: strongerClaimId,
    });
  }

  const claims = [...byGlobalId.values()];
  return {
    loop: 2,
    version: now,
    promoted_at: now,
    subspecialization_ids: [...subspecIds],
    claims,
    contradictions: tagged,
    claim_count: claims.length,
    contradiction_count: tagged.length,
    // The subset of tagged contradictions the researcher escalated for Loop 3 (the Loop3Input forwards them).
    escalated_contradiction_count: tagged.filter((t) => t.resolution === 'escalated').length,
  };
}

// The Observatory's unified-view update: a `contradicts` edge between the render nodes of each
// contradicting claim pair, keyed by global_claim_id (main.js resolves those to render node ids via
// its claimNodeIndex, exactly as it wires the derived-from edges for the subspecialization scope).
function buildContradictionEdges(globalKg) {
  const byRaw = new Map();
  for (const c of globalKg.claims) {
    const arr = byRaw.get(c.claim_id) || [];
    arr.push(c.global_claim_id);
    byRaw.set(c.claim_id, arr);
  }
  const edges = [];
  const seen = new Set();
  for (const con of globalKg.contradictions) {
    for (const a of byRaw.get(con.claim_a_id) || []) {
      for (const b of byRaw.get(con.claim_b_id) || []) {
        if (a === b) continue;
        const key = [a, b].sort().join('::');
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ data: { id: `contra::${key}`, source: a, target: b, type: 'contradicts', nature: con.nature } });
      }
    }
  }
  return edges;
}

// Project the GlobalKG into the Observatory's UNIFIED (GlobalKG) view: one deduped claim node per
// global claim (id == global_claim_id, so the contradicts edges keyed by global_claim_id connect
// real nodes), tagged view 'global' and carrying the filterable facets + the support count (for the
// renderer's support-weighted sizing) and a contradiction flag (for the red halo); one subspecialization
// node per id (sized by its claim count); and a derived-from edge from each claim to its subspecialization.
// Presentation only: it reads documented GlobalKG fields and invents no shapes (the renderer owns pixels).
export function buildGlobalViewElements(globalKg) {
  const claims = Array.isArray(globalKg.claims) ? globalKg.claims : [];
  const subspecIds = Array.isArray(globalKg.subspecialization_ids) ? globalKg.subspecialization_ids : [];
  const claimCountBySub = new Map();
  const nodes = [];
  const edges = [];
  for (const c of claims) {
    claimCountBySub.set(c.subspecialization_id, (claimCountBySub.get(c.subspecialization_id) || 0) + 1);
    nodes.push({
      data: {
        id: c.global_claim_id,
        type: 'claim',
        view: 'global',
        label: typeof c.text === 'string' ? c.text : c.claim_id,
        subspecialization_id: c.subspecialization_id,
        claim_type: isStringArray(c.claim_type) ? [...c.claim_type] : [],
        confidence: c.confidence == null ? null : c.confidence,
        quality: c.quality_review && c.quality_review.quality ? c.quality_review.quality : null,
        salvia_status: typeof c.salvia_status === 'string' ? c.salvia_status : null,
        supportCount: isStringArray(c.supporting_paper_dois) ? c.supporting_paper_dois.length : 0,
        contradiction: Array.isArray(c.contradiction_partners) && c.contradiction_partners.length > 0 ? 1 : 0,
      },
    });
    edges.push({
      data: { id: `gdf::${c.global_claim_id}`, source: c.global_claim_id, target: `gsub::${c.subspecialization_id}`, type: 'derived-from' },
    });
  }
  for (const subId of subspecIds) {
    nodes.push({
      data: { id: `gsub::${subId}`, type: 'subspecialization', view: 'global', label: subId, claimCount: claimCountBySub.get(subId) || 0 },
    });
  }
  return { nodes, edges };
}

export function createBookkeeperAgent(deps = {}) {
  const defaultKg = deps.kg || kgSingleton;
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Bookkeeper', ...data });
    } catch (_err) {
      // logging is best effort and must never break a promotion
    }
  };

  // The Bookkeeper step the orchestrator runs at BOOKKEEPER_STAGE / BOOKKEEPER_PROMOTE.
  return async function bookkeeper(ctx = {}) {
    const state = ctx.state;
    // The orchestrator injects `storage`; prefer its kg, fall back to the configured/default singleton.
    const kgStore = (ctx.storage && ctx.storage.kg) || defaultKg;

    if (state === 'BOOKKEEPER_PROMOTE') {
      // Phase 2: merge the staged SubspecializationKGs into the GlobalKG (dedup), tag contradictions,
      // and persist the unified GlobalKG to IndexedDB. CLIENT-SIDE (no LLM). The GlobalKG accumulates
      // across refinement rounds: load the existing snapshot, merge this round's staged KGs in.
      const stagedKGs = readStagedSubspecializationKGs(ctx.history);
      const contradictions = readContradictions(ctx.history);
      // The researcher's MATERIAL_CONTRADICTIONS decisions (resolved/unresolved/escalated), recorded on the
      // session by the orchestrator. Absent on a chain that never surfaced contradictions (tags default 'open').
      const resolutions = ctx.session && ctx.session.contradictionResolutions ? ctx.session.contradictionResolutions : null;

      let existing = null;
      try {
        existing = await kgStore.load(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION);
      } catch (cause) {
        // A failed read is surfaced (not swallowed); promotion proceeds from an empty GlobalKG.
        emit('bookkeeper:global_load_error', { message: cause && cause.message ? cause.message : String(cause) });
      }

      const globalKg = mergeIntoGlobalKG(existing, stagedKGs, contradictions, clock(), resolutions);

      let persisted = true;
      try {
        await kgStore.save(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION, globalKg);
      } catch (cause) {
        persisted = false;
        emit('bookkeeper:global_persist_error', { message: cause && cause.message ? cause.message : String(cause) });
      }

      const view = buildGlobalViewElements(globalKg);
      const contradicts = buildContradictionEdges(globalKg);
      emit('bookkeeper:promoted', { claims: globalKg.claim_count, contradictions: globalKg.contradiction_count, escalated: globalKg.escalated_contradiction_count, subspecializations: globalKg.subspecialization_ids.length });

      const escalatedNote = globalKg.escalated_contradiction_count
        ? ` (${globalKg.escalated_contradiction_count} escalated for Loop 3)`
        : '';
      return {
        agentId: 'Bookkeeper',
        content: `Promoted to the GlobalKG: ${globalKg.claim_count} claim${globalKg.claim_count === 1 ? '' : 's'} across ${globalKg.subspecialization_ids.length} subspecialization${globalKg.subspecialization_ids.length === 1 ? '' : 's'}, ${globalKg.contradiction_count} contradiction${globalKg.contradiction_count === 1 ? '' : 's'} tagged${escalatedNote}.`,
        result: {
          promoted_to_global: persisted,
          claim_count: globalKg.claim_count,
          contradiction_count: globalKg.contradiction_count,
          escalated_contradiction_count: globalKg.escalated_contradiction_count,
          subspecialization_ids: globalKg.subspecialization_ids,
        },
        // The unified GlobalKG view (scope 'global'): the deduped global claim/subspecialization nodes
        // (ids == global_claim_id / gsub::<id>), the derived-from edges, and the contradicts edges -
        // which now connect the real global nodes by id, so main.js adds them directly (no resolution).
        promoted: { nodes: view.nodes, edges: [...view.edges, ...contradicts] },
        control: {},
      };
    }

    // BOOKKEEPER_STAGE (the Phase 1 operation).
    const subspecs = readSubspecializationKGs(ctx.history);

    const staged = [];
    const nodes = [];
    for (const gsKg of subspecs) {
      const built = buildSubspecializationKG(gsKg, clock);
      if (!built.subspecialization_id) {
        // A subspecialization with no id cannot be keyed or rendered; surface and skip.
        emit('bookkeeper:stage_skip', { reason: 'missing subspecialization_id' });
        continue;
      }
      try {
        await kgStore.save(KG_LOOP_ID, built.subspecialization_id, built);
      } catch (cause) {
        // No silent swallowing: a persist failure is surfaced and the rest still stage; the
        // in-memory KG is still returned so the chain proceeds.
        emit('bookkeeper:persist_error', {
          subspecialization: built.subspecialization_id,
          message: cause && cause.message ? cause.message : String(cause),
        });
      }
      staged.push(built);
      nodes.push({
        data: { id: built.subspecialization_id, type: 'subspecialization', label: built.subspecialization_label || built.subspecialization_id },
      });
    }

    return {
      agentId: 'Bookkeeper',
      content: summarize(staged),
      result: { subspecializations: staged },
      // The orchestrator forwards promoted nodes/edges to the Observatory (onPromote, scope
      // 'subspecialization'). Only the subspecialization nodes here; main.js wires the claim edges.
      promoted: { nodes, edges: [] },
      control: {},
    };
  };
}

// Default app instance, built against the real kg singleton. main.js injects this as the
// orchestrator's `Bookkeeper` step (and injects the real `storage.kg` so persistence is live).
// Tests build isolated agents with createBookkeeperAgent({ kg, clock, logger }) on a fake/real kg.
export const bookkeeperAgent = createBookkeeperAgent();
