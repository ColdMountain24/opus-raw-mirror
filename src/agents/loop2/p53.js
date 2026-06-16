// p53, the Loop 2 (The Archive) cessation controller.
//
// p53 decides when the literature-review loop may stop. It is DETERMINISTIC (no LLM
// dispatcher, like the Loop 1 p53, Edgar, and the Bookkeeper): it reads the prior
// agents' results from history plus a small set of session flags and applies rules.
// It is backstage: the orchestrator settles it to the IO panel, never the
// conversation layer. It runs at the orchestrator's P53_EVALUATE state, immediately
// after Salvia (UNKNOWN_FIELD_SURFACING).
//
// Cessation conditions (the user-supplied FINAL set):
//   1. all planned subspecializations complete  (every Fearless Leader subspecialization
//      has a staged SubspecializationKG)
//   2. Salvia uncertainty is low, OR medium with researcher acknowledgment
//   3. Skips has no unresolved contradictions
//   4. GlobalKG coverage meets the architecture threshold
//
// It emits one of three states:
//   - CONTINUE:     conditions not met and the iteration cap not reached; route back
//                   to PHASE_1 for another research round (bounded by the cap).
//   - MAX_REACHED:  the cap was reached before the conditions were met; surface the
//                   SPECIFIC reasons (coverage gaps, unresolved contradictions, etc.)
//                   through Poe's overlay and PAUSE - cessation proceeds only after the
//                   researcher has seen the reasons (and resumes). Never a silent stop.
//   - CEASE:        all conditions met; route to POSTDOC_FINAL (the Post-Doc final pass)
//                   which then flows to the Output Hook.
//
// Charter boundary. p53 owns its cessation rules and its three-state output contract.
// It does NOT own the GlobalKG coverage metric or its threshold - those are "defined in
// the architecture doc" (external/FINAL), so the coverage function AND the threshold are
// injectable seams with documented placeholder defaults, replaceable when the FINAL
// values land. p53 does not own the Post-Doc pass, the Output Hook, the Loop3Input
// schema, or the overlay rendering (Poe renders the milestone it is handed). The
// iteration cap, the researcher-acknowledgment flag, and the contradiction-resolution
// set are seams (defaults documented).

import { readSubspecializationKGs } from './salvia.js';

export const P53_STATES = Object.freeze({
  CONTINUE: 'CONTINUE',
  MAX_REACHED: 'MAX_REACHED',
  CEASE: 'CEASE',
});

export const CONDITION_KEYS = Object.freeze([
  'subspecializations_complete',
  'uncertainty_acceptable',
  'no_unresolved_contradictions',
  'coverage_met',
]);

// Documented placeholder defaults. The FINAL iteration cap + coverage threshold live in
// the architecture doc; these are overridable seams until those values land.
export const DEFAULT_MAX_ITERATIONS = 3;
export const DEFAULT_COVERAGE_THRESHOLD = 0.7;

// Orchestrator state names p53 routes to. Literals so the agent does not depend on the
// orchestrator module; the orchestrator validates them against its legal adjacency
// (P53_EVALUATE -> [POSTDOC_FINAL, POSTDOC_STANDARD, PHASE_1, PAUSED]).
const PHASE_1 = 'PHASE_1';
const POSTDOC_FINAL = 'POSTDOC_FINAL';
const PAUSED = 'PAUSED';

// p53's output contract: a state, the booleans it read, the coverage it measured, the
// iteration counters, and the unmet-condition reasons (which feed the MAX_REACHED overlay).
export function p53ResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.state !== P53_STATES.CONTINUE && v.state !== P53_STATES.MAX_REACHED && v.state !== P53_STATES.CEASE) {
    return false;
  }
  if (!v.conditions || typeof v.conditions !== 'object') return false;
  if (!CONDITION_KEYS.every((k) => typeof v.conditions[k] === 'boolean')) return false;
  if (typeof v.coverage !== 'number' || !(v.coverage >= 0 && v.coverage <= 1)) return false;
  if (!Number.isInteger(v.iteration) || !Number.isInteger(v.max_iterations)) return false;
  if (!Array.isArray(v.reasons) || !v.reasons.every((r) => typeof r === 'string')) return false;
  return true;
}

// Latest result a given agent produced, or null.
function lastResult(history, agentId) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const e = history[i];
    if (e && e.agentId === agentId && e.packet && e.packet.result) return e.packet.result;
  }
  return null;
}

function clamp01(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Default GlobalKG coverage metric (a documented PLACEHOLDER for the FINAL architecture
// metric): the fraction of planned subspecializations whose staged KG carries at least one
// claim. The real GlobalKG (BOOKKEEPER_PROMOTE) is not built yet, so this reads the staged
// SubspecializationKGs; it stays meaningful (0 when nothing was retrieved, 1 when every
// planned area produced claims) and is replaceable via the computeCoverage seam.
export function defaultCoverage({ plannedIds, stagedKGs }) {
  const planned = plannedIds instanceof Set ? plannedIds : new Set(plannedIds || []);
  if (planned.size === 0) return 0;
  const byId = new Map((Array.isArray(stagedKGs) ? stagedKGs : []).map((k) => [k && k.subspecialization_id, k]));
  let withClaims = 0;
  for (const id of planned) {
    const kg = byId.get(id);
    if (kg && Array.isArray(kg.claims) && kg.claims.length > 0) withClaims += 1;
  }
  return withClaims / planned.size;
}

function summarize(result) {
  const met = CONDITION_KEYS.filter((k) => result.conditions[k]).length;
  return `Cessation ${result.state} (iteration ${result.iteration} of ${result.max_iterations}: ${met} of ${CONDITION_KEYS.length} conditions met, coverage ${result.coverage.toFixed(2)}).`;
}

// The MAX_REACHED milestone surfaced through Poe's overlay (Poe renders it; the
// orchestrator attaches an Acknowledge CTA that resumes the run). Declarative data only.
function buildMaxReachedOverlay({ reasons, coverage, coverageThreshold, iteration, maxIterations }) {
  return {
    variant: 'max-reached',
    tag: '[MAX_REACHED]',
    title: `Iteration limit reached (${iteration} of ${maxIterations})`,
    banners: [
      {
        kind: 'warning',
        tag: '[MAX_REACHED]',
        text: 'Reached the iteration cap before all cessation conditions were met.',
        reasons,
      },
    ],
    fields: [
      { label: 'COVERAGE', value: `${coverage.toFixed(2)} (threshold ${coverageThreshold.toFixed(2)})` },
      { label: 'OPEN_ISSUES', value: reasons, emptyText: 'none' },
    ],
  };
}

export function createP53Agent(deps = {}) {
  const maxIterations =
    Number.isInteger(deps.maxIterations) && deps.maxIterations > 0 ? deps.maxIterations : DEFAULT_MAX_ITERATIONS;
  const coverageThreshold =
    typeof deps.coverageThreshold === 'number' && deps.coverageThreshold >= 0 && deps.coverageThreshold <= 1
      ? deps.coverageThreshold
      : DEFAULT_COVERAGE_THRESHOLD;
  const computeCoverage = typeof deps.computeCoverage === 'function' ? deps.computeCoverage : defaultCoverage;
  // How a research round is counted (default: one per p53 evaluation; CONTINUE loops back
  // to PHASE_1 and returns to P53, so each round adds one p53 entry). Overridable.
  const countIterations =
    typeof deps.countIterations === 'function'
      ? deps.countIterations
      : (history) => history.filter((h) => h && h.agentId === 'p53').length + 1;
  const readKGs =
    typeof deps.readSubspecializationKGs === 'function' ? deps.readSubspecializationKGs : readSubspecializationKGs;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  // The cessation step the orchestrator runs at P53_EVALUATE.
  return async function p53Evaluate(ctx = {}) {
    const session = ctx.session || {};
    const history = Array.isArray(ctx.history) ? ctx.history : [];

    // Planned subspecializations (Fearless Leader) vs staged SubspecializationKGs (the
    // last packet carrying them: the Bookkeeper stage, else PHASE_1).
    const plan = lastResult(history, 'Fearless Leader');
    const plannedIds = new Set(
      (Array.isArray(plan && plan.subspecializations) ? plan.subspecializations : [])
        .map((s) => s && s.id)
        .filter(Boolean),
    );
    const stagedKGs = readKGs(history);
    const stagedIds = new Set(
      (Array.isArray(stagedKGs) ? stagedKGs : []).map((k) => k && k.subspecialization_id).filter(Boolean),
    );

    // Salvia uncertainty level (low / medium / high) + researcher acknowledgment.
    const salvia = lastResult(history, 'Salvia');
    const level = salvia && salvia.uncertainty_level;
    const acknowledged = Boolean(session.researcherAcknowledged);

    // Skips contradictions (carried on the Revision Check packet); a researcher may have
    // resolved some (session.resolvedContradictions: a set of "a::b" keys; default none).
    const revision = lastResult(history, 'Revision Check');
    const contradictions = Array.isArray(revision && revision.contradictions) ? revision.contradictions : [];
    const resolved = new Set(Array.isArray(session.resolvedContradictions) ? session.resolvedContradictions : []);
    const unresolved = contradictions.filter(
      (c) => c && !resolved.has(`${c.claim_a_id}::${c.claim_b_id}`),
    );

    const coverage = clamp01(
      computeCoverage({ plannedIds, stagedKGs, rqPacket: ctx.rqPacket, session }),
    );

    const conditions = {
      subspecializations_complete: plannedIds.size > 0 && [...plannedIds].every((id) => stagedIds.has(id)),
      uncertainty_acceptable: level === 'low' || (level === 'medium' && acknowledged),
      no_unresolved_contradictions: unresolved.length === 0,
      coverage_met: coverage >= coverageThreshold,
    };
    const conditionsMet = CONDITION_KEYS.every((k) => conditions[k]);

    // The specific reasons a condition is unmet (the MAX_REACHED overlay copy).
    const reasons = [];
    if (!conditions.subspecializations_complete) {
      reasons.push(
        plannedIds.size === 0
          ? 'no subspecialization plan yet'
          : `${[...plannedIds].filter((id) => stagedIds.has(id)).length} of ${plannedIds.size} planned subspecializations staged`,
      );
    }
    if (!conditions.coverage_met) {
      reasons.push(`GlobalKG coverage ${coverage.toFixed(2)} below threshold ${coverageThreshold.toFixed(2)}`);
    }
    if (!conditions.no_unresolved_contradictions) {
      reasons.push(`${unresolved.length} unresolved contradiction${unresolved.length === 1 ? '' : 's'}`);
    }
    if (!conditions.uncertainty_acceptable) {
      reasons.push(
        level === 'high'
          ? 'uncertainty level high'
          : level === 'medium'
            ? 'uncertainty medium, awaiting researcher acknowledgment'
            : 'uncertainty not yet assessed',
      );
    }

    const iteration = countIterations(history);
    const maxReached = iteration >= maxIterations;

    let state;
    let transition;
    let overlay = null;
    if (conditionsMet) {
      // Clean cessation: hand off to the Post-Doc final pass, then the Output Hook.
      state = P53_STATES.CEASE;
      transition = POSTDOC_FINAL;
    } else if (maxReached) {
      // Cap hit with open issues: surface the reasons through Poe's overlay and pause
      // (cessation proceeds only once the researcher acknowledges and resumes).
      state = P53_STATES.MAX_REACHED;
      transition = PAUSED;
      overlay = buildMaxReachedOverlay({ reasons, coverage, coverageThreshold, iteration, maxIterations });
    } else {
      // Not saturated and under the cap: run another research round.
      state = P53_STATES.CONTINUE;
      transition = PHASE_1;
    }

    const result = { state, conditions, coverage, iteration, max_iterations: maxIterations, reasons };
    try {
      logger({ type: 'p53:evaluated', state, iteration, max_iterations: maxIterations, coverage, reasons });
    } catch (_err) {
      // logging is best effort
    }

    return {
      agentId: 'p53',
      content: summarize(result),
      result,
      ...(overlay ? { overlay } : {}),
      control: { transition },
    };
  };
}

// Default app instance. main.js injects it into the Loop 2 orchestrator's agents map.
// Tests build isolated agents with createP53Agent({ ... }).
export const p53Agent = createP53Agent();
