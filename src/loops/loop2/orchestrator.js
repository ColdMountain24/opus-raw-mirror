// Loop 2 (The Archive) orchestrator.
//
// A legal-adjacency state machine modeled on the Loop 1 orchestrator
// (src/loops/loop1/orchestrator.js): it drives injected agent step-functions, reads a
// small control envelope off each packet to pick the next state, and talks to the
// conversation only through Poe (the TurnGate rule). It is a MECHANISM, not a policy:
// the FINAL routing (states, the state->agent map, the adjacency) is user-supplied
// (v0.5.x architecture); the agent LOGIC, the Loop3Input/GlobalKG schemas, and the real
// OUTPUT_HOOK packaging are injected/stubbed and land in later phases (Autonomy Charter).
//
// Differences from Loop 1: it INHERITS a finalized RQPacket from the session store on
// mount (Loop 1 produced it) and sets data-loop="2" on the app root to warm the Loop 2
// surface; intake is autonomous with a brief "add more papers?" gate (proceed()) rather
// than a researcher composer; PHASE_1/PHASE_2 are both Grad Students (the step branches
// on state); MATERIAL_CONTRADICTIONS is a Poe conversation turn; RQ_REVISION_CHECK and
// OUTPUT_HOOK are deterministic control points (no dispatch).

import { poe as defaultPoe } from '../../components/poe.js';
import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { session as sessionStore, kg as kgStore } from '../../utils/storage.js';
import { STATUS_COPY } from './registry.js';
import { evaluateRQRevision as evaluateRQRevisionDefault } from './rqrevision.js';
import { enrichContradictions, contradictionKey, pendingContradictions, escalatedFrom } from './contradictions.js';
import { readStagedSubspecializationKGs, GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION } from '../../agents/loop2/bookkeeper.js';
// The TurnGate is loop-agnostic (a single-holder 'Poe' mutex); reused from Loop 1.
// FUTURE: move turngate.js to a shared path now that two loops consume it.
import { createTurnGate } from '../loop1/turngate.js';

// ---------------------------------------------------------------------------
// States and the state -> agent map (user-supplied FINAL routing). The agent ids
// match the registry keys and are used verbatim by Poe for attribution.
// ---------------------------------------------------------------------------
export const STATES = Object.freeze({
  ENTRY: 'ENTRY',
  POE_INTAKE: 'POE_INTAKE',
  FEARLESS_LEADER: 'FEARLESS_LEADER',
  PHASE_1: 'PHASE_1',
  PHASE_2: 'PHASE_2',
  BOOKKEEPER_STAGE: 'BOOKKEEPER_STAGE',
  POSTDOC_STANDARD: 'POSTDOC_STANDARD',
  RQ_REVISION_CHECK: 'RQ_REVISION_CHECK',
  MATERIAL_CONTRADICTIONS: 'MATERIAL_CONTRADICTIONS',
  BOOKKEEPER_PROMOTE: 'BOOKKEEPER_PROMOTE',
  UNKNOWN_FIELD_SURFACING: 'UNKNOWN_FIELD_SURFACING',
  P53_EVALUATE: 'P53_EVALUATE',
  POSTDOC_FINAL: 'POSTDOC_FINAL',
  OUTPUT_HOOK: 'OUTPUT_HOOK',
  COMPLETE: 'COMPLETE',
  PAUSED: 'PAUSED',
});

// Poe drives POE_INTAKE (a waiting gate, handled specially in enter) and
// MATERIAL_CONTRADICTIONS (a conversation turn). 'Revision Check' and 'Packager' are
// deterministic control points (no LLM). Senior Grad Student / Skips / Edgar Allan are
// internal tools (no dedicated state), invoked inside a parent agent's step later.
export const AGENT_BY_STATE = Object.freeze({
  [STATES.POE_INTAKE]: 'Poe',
  [STATES.FEARLESS_LEADER]: 'Fearless Leader',
  [STATES.PHASE_1]: 'Grad Students',
  [STATES.PHASE_2]: 'Grad Students',
  [STATES.BOOKKEEPER_STAGE]: 'Bookkeeper',
  [STATES.POSTDOC_STANDARD]: 'Post-Doc',
  [STATES.RQ_REVISION_CHECK]: 'Revision Check',
  [STATES.MATERIAL_CONTRADICTIONS]: 'Poe',
  [STATES.BOOKKEEPER_PROMOTE]: 'Bookkeeper',
  [STATES.UNKNOWN_FIELD_SURFACING]: 'Salvia',
  [STATES.P53_EVALUATE]: 'p53',
  [STATES.POSTDOC_FINAL]: 'Post-Doc',
  [STATES.OUTPUT_HOOK]: 'Packager',
});

// Legal transitions out of each state. The FIRST entry is the default (linear)
// successor used when an agent requests no transition. Forward skips are illegal;
// the refinement back-edges and PAUSED are legal. The concrete policy that picks a
// back-edge (RQ revision, material contradiction, p53 continue) lives in agent
// outputs, supplied in later phases.
export const ADJACENCY = Object.freeze({
  [STATES.ENTRY]: [STATES.POE_INTAKE],
  [STATES.POE_INTAKE]: [STATES.FEARLESS_LEADER, STATES.PAUSED],
  [STATES.FEARLESS_LEADER]: [STATES.PHASE_1, STATES.PAUSED],
  [STATES.PHASE_1]: [STATES.PHASE_2, STATES.PAUSED],
  [STATES.PHASE_2]: [STATES.BOOKKEEPER_STAGE, STATES.PHASE_1, STATES.PAUSED],
  [STATES.BOOKKEEPER_STAGE]: [STATES.POSTDOC_STANDARD, STATES.PAUSED],
  [STATES.POSTDOC_STANDARD]: [STATES.RQ_REVISION_CHECK, STATES.PAUSED],
  [STATES.RQ_REVISION_CHECK]: [STATES.MATERIAL_CONTRADICTIONS, STATES.PHASE_1, STATES.POSTDOC_STANDARD, STATES.PAUSED],
  [STATES.MATERIAL_CONTRADICTIONS]: [STATES.BOOKKEEPER_PROMOTE, STATES.POSTDOC_STANDARD, STATES.PAUSED],
  [STATES.BOOKKEEPER_PROMOTE]: [STATES.UNKNOWN_FIELD_SURFACING, STATES.PAUSED],
  // Unknown-field surfacing loop (orchestrator-owned): when unknown RQ fields remain (Skips +
  // Salvia) and the iteration cap is not hit, re-sweep via a NEW Fearless Leader plan targeting
  // them. Kept off index 0 so the default forward edge stays P53_EVALUATE (the loop falls through
  // to p53 once the unknowns clear or the cap is reached).
  [STATES.UNKNOWN_FIELD_SURFACING]: [STATES.P53_EVALUATE, STATES.FEARLESS_LEADER, STATES.PAUSED],
  [STATES.P53_EVALUATE]: [STATES.POSTDOC_FINAL, STATES.POSTDOC_STANDARD, STATES.PHASE_1, STATES.PAUSED],
  [STATES.POSTDOC_FINAL]: [STATES.OUTPUT_HOOK, STATES.PAUSED],
  [STATES.OUTPUT_HOOK]: [STATES.COMPLETE],
  [STATES.COMPLETE]: [],
  [STATES.PAUSED]: [],
});

function defaultNext(state) {
  const edges = ADJACENCY[state];
  return edges && edges.length ? edges[0] : null;
}

// The two Bookkeeper states emit promotions to the Observatory: BOOKKEEPER_STAGE
// stages into the SubspecializationKG, BOOKKEEPER_PROMOTE into the GlobalKG. The
// scope rides along so the renderer (and later the IndexedDB write) can distinguish.
const PROMOTE_SCOPE = Object.freeze({
  [STATES.BOOKKEEPER_STAGE]: 'subspecialization',
  [STATES.BOOKKEEPER_PROMOTE]: 'global',
});

// Placeholder agent steps. Each returns a minimally valid packet attributed to its
// agent with no control hint, so the default-next walk reaches COMPLETE. Later phases
// inject real dispatch()-backed steps (the Grad Students step branches on state for
// PHASE_1 vs PHASE_2; Bookkeeper for STAGE vs PROMOTE; Post-Doc for STANDARD vs FINAL).
function makeDefaultAgents() {
  const stub = (agentId) => async ({ state }) => ({
    agentId,
    content: `placeholder ${agentId} output (${state}, stub, no dispatch wired)`,
    control: {},
  });
  return {
    Poe: stub('Poe'),
    'Fearless Leader': stub('Fearless Leader'),
    'Grad Students': stub('Grad Students'),
    Bookkeeper: stub('Bookkeeper'),
    'Post-Doc': stub('Post-Doc'),
    'Revision Check': stub('Revision Check'),
    Salvia: stub('Salvia'),
    p53: stub('p53'),
    Packager: stub('Packager'),
  };
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------
export function createLoop2Orchestrator(deps = {}) {
  const poe = deps.poe || defaultPoe;
  const registry = deps.registry || STATUS_COPY;
  const consoleApi = deps.console || null;
  const agents = { ...makeDefaultAgents(), ...(deps.agents || {}) };
  const dispatch = deps.dispatch || defaultDispatch;
  const storage = deps.storage || { session: sessionStore, kg: kgStore };
  const turngate = deps.turngate || createTurnGate({ logger: (e) => emit(e.type, e) });
  const conversationWriter = turngate.owner; // only Poe writes the conversation
  const ioPacket = deps.packet || null;
  const clock = deps.clock || (() => Date.now());
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  const onStateChange = deps.onStateChange;
  const onComplete = deps.onComplete;
  const onError = deps.onError;
  // Notified when a Bookkeeper state promotes nodes/edges, so the Observatory can render
  // them incrementally: onPromote(nodes, edges, { scope, state }). The stub Bookkeeper
  // emits none; the real one carries `packet.promoted = { nodes, edges }` in a later phase.
  const onPromote = typeof deps.onPromote === 'function' ? deps.onPromote : null;
  // Progressive claim render seam, threaded into the Grad Students step's ctx (PHASE_1/PHASE_2).
  // Distinct from onPromote (the Bookkeeper promotion seam): Grad Students are not a promote
  // state, they stream claim nodes/cards as they extract. The orchestrator just forwards it.
  const onClaimRender = typeof deps.onClaimRender === 'function' ? deps.onClaimRender : null;
  // The app root whose data-loop attribute warms the Loop 2 surface (main.js injects
  // the shell element). Optional so tests can omit it.
  const rootEl = deps.root || null;
  // The unknown-field surfacing loop's iteration cap. A documented PLACEHOLDER for the
  // architecture-doc maximum (external/FINAL, like p53's maxIterations and the coverage
  // threshold); overridable. Once the cap is hit the loop falls through to P53_EVALUATE.
  const maxUnknownFieldIterations =
    Number.isInteger(deps.maxUnknownFieldIterations) && deps.maxUnknownFieldIterations >= 0
      ? deps.maxUnknownFieldIterations
      : 3;
  // Notified once per unknown-field re-sweep: onIteration({ iteration, max, fields }). main.js
  // surfaces the count in the IO panel; the Phase-19 analysis trail subscribes to the same seam.
  const onIteration = typeof deps.onIteration === 'function' ? deps.onIteration : null;
  // RQ revision check (at RQ_REVISION_CHECK, after the Post-Doc standard pass). The evaluation policy is
  // injectable (default the deterministic one in rqrevision.js); the flagged-findings threshold is the
  // spec's 30% (overridable for tests); the assumption-contradicted predicate is an injectable seam.
  const evaluateRevision = typeof deps.evaluateRQRevision === 'function' ? deps.evaluateRQRevision : evaluateRQRevisionDefault;
  const rqRevisionThreshold = typeof deps.rqRevisionThreshold === 'number' ? deps.rqRevisionThreshold : 0.3;
  const isAssumptionContradicted = typeof deps.isAssumptionContradicted === 'function' ? deps.isAssumptionContradicted : undefined;
  // Fired when the researcher chooses to REVISE the RQ: onReviseRQ({ globalKg, lrSummary, reasons }). main.js
  // navigates back to Loop 1 with the GlobalKG as context. The Loop 2 run stays paused (handed off).
  const onReviseRQ = typeof deps.onReviseRQ === 'function' ? deps.onReviseRQ : null;

  let session = deps.session || { rqPacket: null, researchQuestion: null, extraPapers: [] };
  let current = STATES.ENTRY;
  let mounted = false;
  let awaitingIntake = false;
  let intakeRendered = false;
  let resumeTarget = null;
  let lastError = null;
  // The unknown-field surfacing loop counter, tracked in orchestrator state (reset on mount).
  let unknownFieldIterations = 0;
  // The current round's enriched material contradictions, captured while the researcher decides them one
  // at a time at MATERIAL_CONTRADICTIONS (reset on mount). The recorded decisions live on the session.
  let materialContradictions = [];
  // The analysis trail: a REAL-TIME audit log appended as the chain runs (reset on mount). The OUTPUT_HOOK
  // cessation card (the Packager) reads it; it is never reconstructed from model output. Fed by the
  // transitions in runAgentState (sweeps, claim ratios, coverage) plus the dispatcher fallback seam (noteFallback).
  let trailLog = [];
  let trailSeq = 0;
  // The unknown fields a re-sweep targeted, staged by planUnknownFieldResweep and consumed by the next
  // FEARLESS_LEADER trail entry (so the trail records which fields/subspecs the unknown-field loop added).
  let pendingResweepFields = null;
  const history = [];

  const emit = (type, data = {}) => {
    try {
      logger({ type, loop: 2, ...data });
    } catch (_err) {
      // logging is best effort
    }
  };

  // Append one entry to the analysis trail (the real-time audit log the cessation card reads). Stamped with
  // a monotonic seq + the clock so the Packager can order and format it. Best effort: a malformed entry
  // never breaks the chain.
  function appendTrail(type, data = {}) {
    try {
      trailLog.push({ seq: trailSeq, at: clock(), type, ...data });
      trailSeq += 1;
    } catch (_err) {
      // the trail is best effort; never break a turn over it
    }
  }

  // Map a DISPATCHER event to a trail entry (the fallback events the cessation card summarizes: provider
  // failovers, corrective retries, cache hits, safe-default fallbacks, circuit opens). main.js feeds these
  // from the shared dispatcher logger while Loop 2 is the active loop. Unrecognized events are ignored.
  function noteFallback(event) {
    if (!event || typeof event !== 'object') return;
    switch (event.type) {
      case 'failover:next':
        appendTrail('fallback', { kind: 'failover', from: event.from, reason: event.reason });
        break;
      case 'cache:hit':
        appendTrail('fallback', { kind: 'cache_hit', agentId: event.agentId });
        break;
      case 'validate:fail':
        appendTrail('fallback', { kind: 'corrective_retry', agentId: event.agentId, provider: event.provider });
        break;
      case 'providers:exhausted':
        appendTrail('fallback', { kind: 'safe_default', agentId: event.agentId });
        break;
      case 'circuit:transition':
        if (event.to === 'OPEN') appendTrail('fallback', { kind: 'circuit_open', provider: event.provider });
        break;
      default:
        break;
    }
  }

  // Append the audit entry for a just-completed agent state: a FEARLESS_LEADER sweep (round + the subspecs it
  // planned + which unknown fields it targeted), a PHASE_1 extraction round's claim ratios (extracted /
  // promoted / rejected), or a P53_EVALUATE coverage point (the per-iteration coverage delta). Other states
  // contribute their own entries through dedicated seams (unknown-field re-sweep, contradiction escalation).
  function recordTrailForState(state, packet) {
    const result = (packet && packet.result) || {};
    if (state === STATES.FEARLESS_LEADER) {
      const names = (Array.isArray(result.subspecializations) ? result.subspecializations : [])
        .map((s) => (s && (s.name || s.id)) || null)
        .filter(Boolean);
      const round = history.filter((h) => h.state === STATES.FEARLESS_LEADER).length;
      appendTrail('sweep', { round, subspecializations: names, targeted_fields: pendingResweepFields || null });
      pendingResweepFields = null; // consumed: the next re-sweep stages its own targeting
    } else if (state === STATES.PHASE_1) {
      const promoted = (Array.isArray(result.subspecializations) ? result.subspecializations : []).reduce(
        (n, kg) => n + (Array.isArray(kg.claims) ? kg.claims.length : 0),
        0,
      );
      const round = history.filter((h) => h.state === STATES.PHASE_1).length;
      appendTrail('claims_round', {
        round,
        extracted: Number.isFinite(result.claims_extracted) ? result.claims_extracted : promoted,
        promoted,
        rejected: Number.isFinite(result.claims_rejected) ? result.claims_rejected : 0,
      });
    } else if (state === STATES.P53_EVALUATE) {
      appendTrail('coverage', {
        iteration: Number.isInteger(result.iteration) ? result.iteration : null,
        coverage: typeof result.coverage === 'number' ? result.coverage : null,
        state: typeof result.state === 'string' ? result.state : null,
      });
    }
  }

  function ensureMounted(method) {
    if (!mounted) throw new Error(`loop2.${method}: call mount(target) first`);
  }

  function setState(next) {
    current = next;
    emit('state:change', { state: next });
    if (typeof onStateChange === 'function') onStateChange(next);
  }

  // No silent swallowing: surface with reproducible context, then route to PAUSED so
  // the run can be inspected and resumed (re-entering the failed state retries it).
  function fail(state, agentId, cause) {
    const message = cause && cause.message ? cause.message : String(cause);
    lastError = { state, agentId, message, cause };
    emit('error', { state, agentId, message });
    if (typeof onError === 'function') onError(lastError);
    resumeTarget = state;
    poe.setStatus(null);
    setState(STATES.PAUSED);
    return STATES.PAUSED;
  }

  function complete() {
    poe.setStatus(null); // chain done: hide the single global indicator
    emit('complete', { turns: history.length });
    const result = { session, history: history.slice() };
    if (typeof onComplete === 'function') onComplete(result);
    return STATES.COMPLETE;
  }

  // The brief autonomous intake gate: a Poe card asking whether to add more papers
  // before the review, with a "Begin literature review" CTA wired to proceed(). The
  // inherited research question is shown for context. Rendered once per run.
  function renderIntakeCard() {
    if (intakeRendered || typeof poe.milestoneCard !== 'function') return;
    poe.milestoneCard({
      variant: 'intake',
      tag: '[INTAKE]',
      title: 'Add any more papers before the literature review?',
      fields: [
        { label: 'RESEARCH_QUESTION', value: session.researchQuestion, math: true, emptyText: 'inherited from Loop 1' },
      ],
      cta: {
        label: 'Begin literature review',
        onClick: () => {
          Promise.resolve(proceed()).catch((e) => fail(STATES.POE_INTAKE, 'Poe', e));
        },
      },
    });
    intakeRendered = true;
  }

  // Validate a requested transition against the legal adjacency and act on it.
  function transition(from, to) {
    const legal = ADJACENCY[from] || [];
    if (!legal.includes(to)) {
      return fail(from, AGENT_BY_STATE[from] || null, new Error(`illegal transition ${from} -> ${to}`));
    }
    if (to === STATES.PAUSED) {
      resumeTarget = defaultNext(from);
      poe.setStatus(null);
      setState(STATES.PAUSED);
      emit('paused', { from, resumeTarget });
      return STATES.PAUSED;
    }
    return enter(to);
  }

  // Run one agent state. Poe holds the TurnGate for the whole turn: status -> step
  // (the agent runs, writing to the IO panel only) -> validate attribution -> Poe
  // renders a card for the conversation writer (MATERIAL_CONTRADICTIONS) or settles a
  // backstage agent -> transition. The gate is released before transitioning.
  async function runAgentState(state) {
    const agentId = AGENT_BY_STATE[state];
    if (!agentId) return fail(state, null, new Error(`no agent mapped to ${state}`));
    const step = agents[agentId];
    if (typeof step !== 'function') {
      return fail(state, agentId, new Error(`no step registered for ${agentId}`));
    }

    let packet = null;
    let failure = null;
    try {
      await turngate.withTurn('Poe', async () => {
        emit('agent:start', { state, agentId });
        poe.setStatus(agentId, 'running');

        const produced = await step({
          state,
          agentId,
          session,
          rqPacket: session.rqPacket,
          history: history.slice(),
          trailLog: trailLog.slice(),
          dispatch,
          storage,
          clock,
          onClaimRender,
        });

        if (!produced || typeof produced !== 'object') {
          failure = new Error(`agent ${agentId} returned no packet`);
          return;
        }
        if (produced.agentId !== agentId) {
          failure = new Error(`agent ${agentId} packet attributed to ${produced.agentId}`);
          return;
        }

        packet = produced;
        history.push({ state, agentId, packet });

        poe.setStatus(agentId, 'complete');
        if (agentId === conversationWriter) {
          poe.receive(packet);
        } else {
          const nextState = (packet.control && packet.control.transition) || defaultNext(state);
          const nextLabel =
            nextState === STATES.COMPLETE
              ? 'cessation'
              : nextState === STATES.PAUSED
                ? 'paused'
                : AGENT_BY_STATE[nextState] || nextState;
          const summary =
            typeof packet.content === 'string' ? `${packet.content} -> ${nextLabel}` : undefined;
          poe.settle(agentId, summary);
        }
        emit('agent:done', { state, agentId });
      });
    } catch (cause) {
      failure = cause; // a thrown step/render propagates after the gate releases in finally
    }

    if (failure) return fail(state, agentId, failure);

    if (ioPacket && typeof ioPacket.setPacket === 'function') ioPacket.setPacket(packet);

    // Append this state's audit entry to the analysis trail (real-time; the cessation card reads it).
    recordTrailForState(state, packet);

    // A backstage agent may request that a declarative milestone be surfaced through Poe.
    // In Loop 2 Poe is the slide-up overlay, so this RAISES the panel (p53 uses it to show
    // the MAX_REACHED reasons). Poe owns the rendering (Autonomy Charter): the orchestrator
    // only forwards the spec. When the agent also routes to PAUSED, attach an Acknowledge CTA
    // that resumes the run, so cessation proceeds only after the researcher has seen the
    // reasons. A render failure is surfaced, never swallowed, and never breaks the chain.
    if (packet.overlay && typeof packet.overlay === 'object' && typeof poe.milestoneCard === 'function') {
      const requested = packet.control && packet.control.transition;
      const spec = { ...packet.overlay };
      if (requested === STATES.PAUSED && !spec.cta) {
        spec.cta = {
          label: 'Acknowledge and continue',
          // Return the resume promise so a caller can await the cessation chain; the UI
          // button fires it un-awaited, which is fine.
          onClick: () => Promise.resolve(resume()).catch((cause) => fail(state, agentId, cause)),
        };
      }
      try {
        poe.milestoneCard(spec);
      } catch (cause) {
        emit('error', { state, agentId, message: cause && cause.message ? cause.message : String(cause) });
      }
    }

    // Feed Bookkeeper promotions to the Observatory (incremental render). Reads the
    // promoted elements off the packet; the stub carries none, so this is a no-op until
    // the real Bookkeeper supplies `packet.promoted`.
    if (onPromote && PROMOTE_SCOPE[state]) {
      const promoted = (packet && packet.promoted) || {};
      const nodes = Array.isArray(promoted.nodes) ? promoted.nodes : [];
      const edges = Array.isArray(promoted.edges) ? promoted.edges : [];
      if (nodes.length || edges.length) {
        try {
          onPromote(nodes, edges, { scope: PROMOTE_SCOPE[state], state });
        } catch (cause) {
          // A render failure must not break the chain; surface it, do not swallow.
          emit('error', { state, agentId, message: cause && cause.message ? cause.message : String(cause) });
        }
      }
    }

    // Unknown-field surfacing loop: when the surfacing agent (Salvia) requested no transition,
    // the orchestrator decides whether to re-sweep (-> FEARLESS_LEADER, targeting the unknowns)
    // or fall through to the default (P53_EVALUATE). Owned here so the iteration count lives in
    // orchestrator state, as the spec requires.
    let requested = packet.control && packet.control.transition;
    if (state === STATES.UNKNOWN_FIELD_SURFACING && !requested) {
      requested = planUnknownFieldResweep(packet) || requested;
    }
    // RQ revision check: after the Post-Doc standard pass (RQ_REVISION_CHECK runs the Skips packet), the
    // orchestrator may surface a researcher decision (revise the RQ / proceed with caveat) and PAUSE.
    if (state === STATES.RQ_REVISION_CHECK && !requested) {
      requested = (await planRQRevision(packet)) || requested;
    }
    // Material contradictions: after the Poe surfacer reads Skips' contradictions, the orchestrator
    // surfaces each undecided one for resolution (resolved/unresolved/escalated) and PAUSES; resuming
    // (all decided) forwards to BOOKKEEPER_PROMOTE, where escalations are tagged into the GlobalKG.
    if (state === STATES.MATERIAL_CONTRADICTIONS && !requested) {
      requested = planMaterialContradictions(packet) || requested;
    }
    return transition(state, requested || defaultNext(state));
  }

  // The latest validated result a given agent produced in history, or null.
  function lastResult(agentId) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const e = history[i];
      if (e && e.agentId === agentId && e.packet && e.packet.result) return e.packet.result;
    }
    return null;
  }

  // The unknown RQ fields still open at the surfacing state: Salvia's unaddressed_rq_fields
  // (the packet just produced) UNION Skips' unknown_fields (carried on the latest Revision Check
  // packet). Deduped, non-empty strings only. Neither agent owns the loop; this only reads them.
  function collectUnknownFields(salviaPacket) {
    const fromSalvia =
      salviaPacket && salviaPacket.result && Array.isArray(salviaPacket.result.unaddressed_rq_fields)
        ? salviaPacket.result.unaddressed_rq_fields
        : [];
    const revision = lastResult('Revision Check');
    const fromSkips = revision && Array.isArray(revision.unknown_fields) ? revision.unknown_fields : [];
    const seen = new Set();
    const fields = [];
    for (const f of [...fromSalvia, ...fromSkips]) {
      if (typeof f === 'string' && f.trim() && !seen.has(f)) {
        seen.add(f);
        fields.push(f);
      }
    }
    return fields;
  }

  // Decide the surfacing-state transition: re-sweep via Fearless Leader (targeting the unknowns)
  // when fields remain and the cap is not hit, else null (fall through to P53_EVALUATE). On a
  // re-sweep it increments the counter, stages the fields as Fearless Leader context, and fires
  // the iteration seam (IO panel + the Phase-19 analysis trail).
  function planUnknownFieldResweep(packet) {
    const fields = collectUnknownFields(packet);
    if (!fields.length) return null;
    if (unknownFieldIterations >= maxUnknownFieldIterations) {
      emit('unknownfield:cap_reached', { iterations: unknownFieldIterations, max: maxUnknownFieldIterations, fields });
      return null;
    }
    unknownFieldIterations += 1;
    session.unknownFields = fields; // consumed (and cleared) by the next Fearless Leader run
    // Record the re-sweep on the analysis trail, and stage the targeted fields for the next FEARLESS_LEADER
    // entry (so the trail shows which subspecs the unknown-field loop added for which fields).
    pendingResweepFields = fields;
    appendTrail('unknown_field_sweep', { iteration: unknownFieldIterations, fields });
    const info = { iteration: unknownFieldIterations, max: maxUnknownFieldIterations, fields };
    emit('unknownfield:resweep', info);
    if (onIteration) {
      try {
        onIteration(info);
      } catch (cause) {
        // The IO/trail surface is best effort; surface it, never break the loop.
        emit('error', { state: STATES.UNKNOWN_FIELD_SURFACING, message: cause && cause.message ? cause.message : String(cause) });
      }
    }
    return STATES.FEARLESS_LEADER;
  }

  // ----- RQ revision check (orchestrator-owned, at RQ_REVISION_CHECK) -----

  // Gather the evidence the revision check reads: the claims from the latest staged SubspecializationKGs
  // (this round) plus a prior GlobalKG if one is written, and the staged KGs + GlobalKG themselves for the
  // revise hand-off context. A failed GlobalKG read is surfaced, never thrown.
  async function readRevisionEvidence() {
    const stagedKGs = readStagedSubspecializationKGs(history);
    const claims = [];
    for (const kg of stagedKGs) for (const c of Array.isArray(kg.claims) ? kg.claims : []) claims.push(c);
    let globalKg = null;
    try {
      if (storage && storage.kg && typeof storage.kg.load === 'function') {
        globalKg = await storage.kg.load(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION);
      }
    } catch (cause) {
      emit('error', { state: STATES.RQ_REVISION_CHECK, message: cause && cause.message ? cause.message : String(cause) });
    }
    if (globalKg && Array.isArray(globalKg.claims)) for (const c of globalKg.claims) claims.push(c);
    return { claims, globalKg, stagedKGs };
  }

  // The RQ-revision decision at RQ_REVISION_CHECK (after the Revision Check / Skips packet). If the evidence
  // reveals the RQ may need revising AND the researcher has not already decided this run, surface the
  // two-choice researcher decision through Poe's overlay and PAUSE (the resume target -> MATERIAL_CONTRADICTIONS,
  // the proceed-with-caveat path). Returns STATES.PAUSED to pause, or null to forward normally.
  async function planRQRevision(packet) {
    if (session.rqRevisionChoice) return null; // recorded once per run; do not re-surface
    const { claims, globalKg, stagedKGs } = await readRevisionEvidence();
    const contradictions = packet && packet.result && Array.isArray(packet.result.contradictions) ? packet.result.contradictions : [];
    const evaluation = evaluateRevision({
      lrSummary: session.lrSummary || null,
      claims,
      contradictions,
      rqPacket: session.rqPacket,
      flaggedThreshold: rqRevisionThreshold,
      ...(isAssumptionContradicted ? { isAssumptionContradicted } : {}),
    });
    if (!evaluation || !evaluation.needsRevision) return null;
    const context = { globalKg: globalKg || null, stagedKGs, lrSummary: session.lrSummary || null, reasons: evaluation.reasons };
    surfaceRQRevisionOverlay(evaluation, context);
    emit('rqrevision:surfaced', { reasons: evaluation.reasons, flaggedRatio: evaluation.flaggedRatio, conditions: evaluation.conditions });
    return STATES.PAUSED;
  }

  // Build + raise the RQ-revision decision card (two CTAs) through Poe's overlay. Poe owns the rendering;
  // the orchestrator owns the choice wiring (it cannot live in the backstage agent). A render failure is
  // surfaced, never swallowed.
  function surfaceRQRevisionOverlay(evaluation, context) {
    if (typeof poe.milestoneCard !== 'function') return;
    const spec = {
      variant: 'rq-revision',
      tag: '[RQ_REVISION]',
      title: 'The evidence suggests the research question may need revision.',
      banners: [{ kind: 'review', tag: '[REVIEW]', text: 'Researcher decision required', reasons: evaluation.reasons }],
      fields: [
        { label: 'FLAGGED', value: `${evaluation.flaggedCount}/${evaluation.total} claims flagged (${Math.round(evaluation.flaggedRatio * 100)}%)`, emptyText: 'none' },
        { label: 'ASSUMPTION', value: evaluation.conditions.contradicted ? 'a core assumption appears contradicted by well-supported claims' : 'no high-confidence assumption conflict' },
      ],
      ctas: [
        { label: 'Revise the research question', onClick: () => chooseReviseRQ(evaluation, context) },
        { label: 'Proceed with an acknowledged caveat', onClick: () => chooseProceedWithCaveat(evaluation) },
      ],
    };
    try {
      poe.milestoneCard(spec);
    } catch (cause) {
      emit('error', { state: STATES.RQ_REVISION_CHECK, message: cause && cause.message ? cause.message : String(cause) });
    }
  }

  // The researcher chose to REVISE the RQ: record the choice on the session, hand off to Loop 1 with the
  // GlobalKG as context (onReviseRQ), and leave the Loop 2 run paused. Guarded against a double click.
  function chooseReviseRQ(evaluation, context) {
    if (session.rqRevisionChoice) return;
    session.rqRevisionChoice = 'revise';
    session.rqRevisionReasons = evaluation.reasons;
    emit('rqrevision:revise', { reasons: evaluation.reasons });
    if (onReviseRQ) {
      try {
        onReviseRQ(context);
      } catch (cause) {
        fail(STATES.RQ_REVISION_CHECK, 'Revision Check', cause);
      }
    }
  }

  // The researcher chose to PROCEED with an acknowledged caveat: record the choice + the caveat on the
  // session, then resume the chain from the pause (the resume target is MATERIAL_CONTRADICTIONS).
  function chooseProceedWithCaveat(evaluation) {
    if (session.rqRevisionChoice) return;
    session.rqRevisionChoice = 'proceed';
    session.rqRevisionCaveat = evaluation.reasons;
    emit('rqrevision:proceed', { reasons: evaluation.reasons });
    return Promise.resolve(resume()).catch((cause) => fail(STATES.RQ_REVISION_CHECK, 'Revision Check', cause));
  }

  // ----- material contradictions surfacing (orchestrator-owned, at MATERIAL_CONTRADICTIONS) -----

  // The material-contradictions decision (after the Poe surfacer reads Skips' cross-subspecialization
  // contradictions). When contradictions remain undecided this run, ENRICH each with the paper sources on
  // both sides (from the staged KGs), surface the first undecided one through Poe's overlay (resolved /
  // unresolved / escalated CTAs), and PAUSE. Returns STATES.PAUSED to pause, or null to forward to
  // BOOKKEEPER_PROMOTE (no contradictions, or all already decided). Synchronous (reads history + packet).
  function planMaterialContradictions(packet) {
    const raw =
      packet && packet.result && Array.isArray(packet.result.contradictions)
        ? packet.result.contradictions
        : Array.isArray(packet && packet.contradictions)
          ? packet.contradictions
          : [];
    if (!raw.length) return null;
    materialContradictions = enrichContradictions({ contradictions: raw, stagedKGs: readStagedSubspecializationKGs(history) });
    if (!session.contradictionResolutions) session.contradictionResolutions = {};
    const pending = pendingContradictions(materialContradictions, session.contradictionResolutions);
    if (!pending.length) return null; // every contradiction already decided this run
    surfaceContradictionOverlay(pending[0], materialContradictions.length - pending.length, materialContradictions.length);
    emit('contradictions:surfaced', { total: materialContradictions.length, pending: pending.length });
    return STATES.PAUSED;
  }

  // Build + raise the decision card for ONE contradiction (one at a time, so the flat CTA row fits the
  // three-way mark). Each side shows the claim text + clickable citation chips (the paper sources, opened
  // via the same setOnCitation/papersIndex seam as the Post-Doc card). Poe owns the rendering; a render
  // failure is surfaced, never swallowed.
  function surfaceContradictionOverlay(c, decidedCount, total) {
    if (typeof poe.milestoneCard !== 'function') return;
    const key = contradictionKey(c);
    const sideField = (label, sideObj) => ({
      label,
      value: sideObj && sideObj.text ? sideObj.text : (sideObj && sideObj.claim_id) || '(claim unavailable)',
      math: true,
      chips: (sideObj && Array.isArray(sideObj.paper_dois) ? sideObj.paper_dois : []).map((doi) => ({ label: doi, title: `Open ${doi}`, citation: doi })),
      emptyText: 'no sources on record',
    });
    const spec = {
      variant: 'material-contradiction',
      tag: '[CONTRADICTION]',
      title: `Material contradiction ${decidedCount + 1} of ${total} - your resolution`,
      banners: [{ kind: 'warning', tag: '[CROSS_SUBSPEC]', text: c.nature || 'Cross-subspecialization conflict' }],
      fields: [
        sideField('SIDE_A', c.side_a),
        sideField('SIDE_B', c.side_b),
        { label: 'SUBSPECS', value: `${(c.side_a && c.side_a.subspecialization_id) || '?'} vs ${(c.side_b && c.side_b.subspecialization_id) || '?'}` },
      ],
      ctas: [
        { label: 'Side A is stronger (resolve)', onClick: () => recordContradictionDecision(key, { status: 'resolved', stronger_claim_id: c.claim_a_id }) },
        { label: 'Side B is stronger (resolve)', onClick: () => recordContradictionDecision(key, { status: 'resolved', stronger_claim_id: c.claim_b_id }) },
        { label: 'Acknowledge, leave unresolved', onClick: () => recordContradictionDecision(key, { status: 'unresolved', stronger_claim_id: null }) },
        { label: 'Escalate for Loop 3 scrutiny', onClick: () => recordContradictionDecision(key, { status: 'escalated', stronger_claim_id: null }) },
      ],
    };
    try {
      poe.milestoneCard(spec);
    } catch (cause) {
      emit('error', { state: STATES.MATERIAL_CONTRADICTIONS, message: cause && cause.message ? cause.message : String(cause) });
    }
  }

  // Record one researcher decision (resolved/unresolved/escalated, with the stronger side for a resolution),
  // then surface the next undecided contradiction or, when all are decided, stash the escalations on the
  // session (the Bookkeeper tags them into the GlobalKG at BOOKKEEPER_PROMOTE; the OUTPUT_HOOK phase forwards
  // them into the Loop3Input packet) and resume the chain. Guarded: a key is recorded once (double-click safe).
  function recordContradictionDecision(key, decision) {
    if (!session.contradictionResolutions) session.contradictionResolutions = {};
    if (session.contradictionResolutions[key]) return undefined; // already decided
    session.contradictionResolutions[key] = {
      status: decision.status,
      stronger_claim_id: decision.stronger_claim_id || null,
      at: clock(),
    };
    emit('contradiction:decided', { key, status: decision.status });
    if (decision.status === 'escalated') {
      const c = materialContradictions.find((x) => contradictionKey(x) === key);
      appendTrail('contradiction_escalated', {
        claim_a_id: c ? c.claim_a_id : null,
        claim_b_id: c ? c.claim_b_id : null,
      });
    }
    const pending = pendingContradictions(materialContradictions, session.contradictionResolutions);
    if (pending.length) {
      surfaceContradictionOverlay(pending[0], materialContradictions.length - pending.length, materialContradictions.length);
      return undefined;
    }
    session.escalatedContradictions = escalatedFrom(materialContradictions, session.contradictionResolutions);
    emit('contradictions:all_decided', { escalated: session.escalatedContradictions.length });
    return Promise.resolve(resume()).catch((cause) => fail(STATES.MATERIAL_CONTRADICTIONS, 'Poe', cause));
  }

  // Enter a state: the intake gate arms and returns; agent states run; terminal states
  // finalize.
  function enter(state) {
    setState(state);
    switch (state) {
      case STATES.POE_INTAKE:
        awaitingIntake = true;
        poe.setStatus(AGENT_BY_STATE[STATES.POE_INTAKE], 'running');
        renderIntakeCard();
        emit('intake:awaiting', {});
        return STATES.POE_INTAKE;
      case STATES.COMPLETE:
        return complete();
      case STATES.PAUSED:
        poe.setStatus(null);
        return STATES.PAUSED;
      default:
        return runAgentState(state);
    }
  }

  // ----- public API -----
  // mount reads the inherited RQPacket from the session store and warms the Loop 2
  // surface (data-loop="2"), then mounts Poe with the Loop 2 registry. Async because
  // the session store read is async.
  async function mount(target, { root } = {}) {
    if (!target) throw new Error('loop2.mount: target is required');
    poe.mount(target, { registry, console: consoleApi });
    mounted = true;
    history.length = 0;
    session = deps.session || { rqPacket: null, researchQuestion: null, extraPapers: [] };
    awaitingIntake = false;
    intakeRendered = false;
    resumeTarget = null;
    lastError = null;
    unknownFieldIterations = 0;
    materialContradictions = [];
    trailLog = [];
    trailSeq = 0;
    pendingResweepFields = null;

    // Inherit the finalized RQPacket (and the research question) Loop 1 persisted.
    try {
      const saved =
        storage && storage.session && typeof storage.session.load === 'function'
          ? await storage.session.load()
          : null;
      if (saved && typeof saved === 'object') {
        session.rqPacket = saved.rqPacket != null ? saved.rqPacket : null;
        session.researchQuestion = saved.researchQuestion != null ? saved.researchQuestion : null;
      }
    } catch (cause) {
      // A failed read is surfaced, not swallowed; the loop can still run with no packet.
      emit('error', { state: STATES.ENTRY, message: cause && cause.message ? cause.message : String(cause) });
      if (typeof onError === 'function') {
        onError({ state: STATES.ENTRY, agentId: null, message: cause && cause.message ? cause.message : String(cause), cause });
      }
    }

    // Warm the Loop 2 surface: the app root's data-loop attribute drives the aged-paper
    // canvas tint (tokens.css [data-loop="2"]). The orchestrator owns this per spec.
    const el = root || rootEl;
    if (el && el.dataset) el.dataset.loop = '2';

    setState(STATES.ENTRY);
    return api;
  }

  async function start() {
    ensureMounted('start');
    if (current !== STATES.ENTRY) return current;
    return enter(STATES.POE_INTAKE);
  }

  // The brief intake gate's advance: proceed (optionally adding more papers) into the
  // autonomous chain. Only valid while awaiting intake.
  async function proceed(extraPapers) {
    ensureMounted('proceed');
    if (current !== STATES.POE_INTAKE || !awaitingIntake) {
      throw new Error(`loop2.proceed: only valid while awaiting intake (state=${current})`);
    }
    if (Array.isArray(extraPapers) && extraPapers.length) {
      session.extraPapers = [...(session.extraPapers || []), ...extraPapers];
    }
    awaitingIntake = false;
    // Loop 2's Poe is a slide-up overlay: the intake gate raised it, so lower it as the
    // researcher leaves the gate, returning the (undimmed) Observatory for the autonomous
    // sweep. Guarded so the plain Poe singleton (no overlay chrome) is unaffected.
    if (typeof poe.hideOverlay === 'function') poe.hideOverlay();
    emit('intake:proceeded', { added: (session.extraPapers || []).length });
    return enter(STATES.FEARLESS_LEADER);
  }

  function pause() {
    ensureMounted('pause');
    if (current === STATES.PAUSED || current === STATES.COMPLETE) return current;
    resumeTarget = current;
    awaitingIntake = false;
    poe.setStatus(null);
    setState(STATES.PAUSED);
    emit('paused', { from: resumeTarget, resumeTarget });
    return current;
  }

  async function resume() {
    ensureMounted('resume');
    if (current !== STATES.PAUSED) return current;
    const target = resumeTarget || STATES.POE_INTAKE;
    resumeTarget = null;
    emit('resumed', { target });
    return enter(target);
  }

  const api = {
    mount,
    start,
    proceed,
    pause,
    resume,
    getState: () => current,
    getHistory: () => history.slice(),
    getSession: () => session,
    getLastError: () => lastError,
    getTurnGate: () => turngate,
    getUnknownFieldIterations: () => unknownFieldIterations,
    // The analysis trail (real-time audit log) the OUTPUT_HOOK cessation card reads.
    getTrailLog: () => trailLog.slice(),
    // Fed by main.js from the shared dispatcher logger while Loop 2 is active, to capture provider
    // failovers / corrective retries / cache hits into the trail.
    noteFallback,
  };
  return api;
}

// Default app singleton, built with the Poe singleton and default collaborators.
// main.js constructs its own configured instance (injecting the agent console, the IO
// packet sink, and the app root), mirroring how Loop 1 wires its orchestrator.
export const loop2 = createLoop2Orchestrator();
