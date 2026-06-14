// p53, the Loop 1 (The Agora) cessation controller.
//
// p53 decides when Loop 1 may stop. It evaluates whether all cessation conditions
// are met: CV has passed, RQSupervisor has approved, the Novelty Checker has run,
// and the researcher has confirmed. It emits one of three states:
//   - CONTINUE:     conditions not yet met; route back to Poe to keep going.
//   - MAX_REACHED:  the iteration cap was hit; a WARNING, not a stop. It routes
//                   back through Poe so the warning is surfaced, and never
//                   cascades directly to CEASE: a max that is reached for the
//                   first time always becomes MAX_REACHED, never CEASE, even if
//                   every other condition is met. The next evaluation (after the
//                   warning has been surfaced) may CEASE.
//   - CEASE:        all conditions met (and any max warning already surfaced);
//                   emit the completed RQPacket to the output hook and complete.
//
// p53 is deterministic: it reads prior agents' results from history and flags from
// session, and applies rules. It does NOT use the LLM dispatcher. It is backstage:
// it writes to the IO panel only (the orchestrator settles it and surfaces its
// packet to the Packet Inspector), never the conversation layer.
//
// Charter boundary. p53 owns its cessation rules and output contract (the three
// states). It does NOT own the RQPacket schema: on CEASE it emits the RQPacket as
// it stands (session.rqPacket) to the output hook; the real assembly, validation,
// persistence, and Loop 2 unlock are the COMPLETE-seam / RQPacket-schema phases.
// The iteration cap and the confirmation flag are seams (defaults documented).

export const P53_STATES = Object.freeze({
  CONTINUE: 'CONTINUE',
  MAX_REACHED: 'MAX_REACHED',
  CEASE: 'CEASE',
});

const CONDITION_KEYS = ['cv_passed', 'rq_approved', 'novelty_ran', 'researcher_confirmed'];

// p53's output contract: a state plus the boolean conditions it read.
export function p53ResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.state !== P53_STATES.CONTINUE && v.state !== P53_STATES.MAX_REACHED && v.state !== P53_STATES.CEASE) {
    return false;
  }
  if (!v.conditions || typeof v.conditions !== 'object') return false;
  return CONDITION_KEYS.every((k) => typeof v.conditions[k] === 'boolean');
}

// Orchestrator state names p53 routes to. Literals so the agent does not depend on
// the orchestrator module; the orchestrator validates them against its legal
// adjacency (P53_EVALUATE -> [COMPLETE, RQ_SUPERVISOR, POE_INTAKE, PAUSED]).
const POE_INTAKE = 'POE_INTAKE';
const COMPLETE = 'COMPLETE';

// Latest result a given agent produced, or null.
function lastResult(history, agentId) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const e = history[i];
    if (e && e.agentId === agentId && e.packet && e.packet.result) return e.packet.result;
  }
  return null;
}

function summarize(result) {
  const c = result.conditions;
  const met = [
    c.cv_passed && 'CV',
    c.rq_approved && 'structure',
    c.novelty_ran && 'novelty',
    c.researcher_confirmed && 'confirmed',
  ]
    .filter(Boolean)
    .join(', ');
  return `Cessation ${result.state} (iteration ${result.iteration} of ${result.max_iterations}). Met: ${met || 'none'}.`;
}

export function createP53Agent(deps = {}) {
  const maxIterations = Number.isInteger(deps.maxIterations) && deps.maxIterations > 0 ? deps.maxIterations : 5;
  // The output hook (CEASE emits the completed RQPacket here). The persistence /
  // Loop 2 unlock phase supplies the real implementation.
  const output = typeof deps.output === 'function' ? deps.output : () => {};
  // How an iteration is counted (default: one per Poe turn). Overridable.
  const countIterations =
    typeof deps.countIterations === 'function'
      ? deps.countIterations
      : (history) => history.filter((h) => h && h.agentId === 'Poe').length;

  // The cessation step the orchestrator runs at P53_EVALUATE. Returns a packet
  // attributed to p53 whose `result` is the validated cessation decision.
  return async function p53Evaluate(ctx = {}) {
    const session = ctx.session || {};
    const history = Array.isArray(ctx.history) ? ctx.history : [];

    const cv = lastResult(history, 'CV');
    const rq = lastResult(history, 'RQSupervisor');
    const novelty = lastResult(history, 'Novelty Checker');
    const conditions = {
      cv_passed: Boolean(cv && cv.status === 'pass'),
      rq_approved: Boolean(rq && rq.approved === true),
      novelty_ran: novelty != null,
      researcher_confirmed: Boolean(session.researcherConfirmed),
    };
    const conditionsMet = CONDITION_KEYS.every((k) => conditions[k]);

    const iteration = countIterations(history);
    const maxReached = iteration >= maxIterations;

    let state;
    let transition;
    let warning = null;
    let completedRQPacket;

    if (maxReached && !session.maxWarningSurfaced) {
      // The cap is reached and the warning has not been surfaced yet: emit
      // MAX_REACHED and route through Poe. Never cascade straight to CEASE.
      state = P53_STATES.MAX_REACHED;
      transition = POE_INTAKE;
      warning = {
        kind: 'max_reached',
        iteration,
        max_iterations: maxIterations,
        message: `This study has been through ${iteration} rounds, at the configured limit of ${maxIterations}. You can confirm and proceed, or keep refining.`,
      };
      session.maxWarning = warning;
      // Mark the warning as routed through Poe so a later evaluation may CEASE.
      session.maxWarningSurfaced = true;
    } else if (conditionsMet) {
      // All conditions met and any max warning already surfaced: cease.
      state = P53_STATES.CEASE;
      transition = COMPLETE;
      completedRQPacket = session.rqPacket;
      // Emit the completed RQPacket to the output hook, plus the run context the hook
      // needs to build the completion card's trust layer: the finalized question and
      // the history (the Output Hook derives the confidence, the review flag, and the
      // evaluation breakdown from the run's CV / RQSupervisor / Novelty results via
      // trust.js, so p53 stays a forwarder and does not own that presentation). The
      // RQPacket stays the first argument (the Phase 8 contract). Awaited so the
      // completion effects (persist, unlock, card) finish while Poe holds the floor
      // and before the orchestrator advances to COMPLETE; awaiting a synchronous hook
      // is a no-op, so this stays backward compatible.
      await output(completedRQPacket, {
        researchQuestion: session.researchQuestion,
        history,
        // The max-reached warning (if the cap was hit earlier in the run) is carried
        // to the cessation card as a non-blocking note, not a stop.
        maxWarning: session.maxWarning || null,
      });
    } else {
      // Not done yet: keep eliciting / await confirmation.
      state = P53_STATES.CONTINUE;
      transition = POE_INTAKE;
    }

    const result = { state, conditions, iteration, max_iterations: maxIterations };

    return {
      agentId: 'p53',
      content: summarize(result),
      result,
      warning, // MAX_REACHED warning (null otherwise); the cessation card surfaces it through Poe
      ...(state === P53_STATES.CEASE ? { rqPacket: completedRQPacket } : {}),
      control: { transition },
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance. main.js injects a configured instance (with the output
// hook). Tests build isolated agents with createP53Agent({ ... }).
export const p53Agent = createP53Agent();
