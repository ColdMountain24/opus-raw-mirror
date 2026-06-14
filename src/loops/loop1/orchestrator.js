// Loop 1 (The Agora) orchestrator.
//
// A state machine that drives the six S1 agents in sequence and owns the Loop 1
// conversation surface. It mounts Poe with the Loop 1 status-copy registry and
// talks to the conversation layer only through Poe's method API (setStatus /
// receive); it never writes a conversation node itself (the TurnGate rule).
//
// Boundary (Autonomy Charter): inter-agent routing and packet schemas are FINAL,
// not Opus-owned. This orchestrator is therefore a mechanism, not a policy. It
// runs a legal-adjacency state machine and reads a small, documented control
// envelope off each agent's output to decide the next state; it never defines
// what an agent decides or what a packet contains. The default next state (when
// an agent requests nothing) is the linear successor, so the happy path walks
// ENTRY -> POE_INTAKE -> CV_CHECK -> RQ_SUPERVISOR -> NOVELTY_CHECK ->
// EDGAR_RETRIEVE -> P53_EVALUATE -> COMPLETE.
//
// Agents are injected step functions. This phase ships placeholder stubs; later
// phases replace them with real dispatch()-backed agents. The factory takes all
// collaborators by injection (poe, agents, console, dispatch, storage, clock,
// callbacks) so the machine runs on virtual time against in-memory fakes in tests
// (the same DI rationale as the dispatcher).

import { poe as defaultPoe } from '../../components/poe.js';
import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { session as sessionStore, kg as kgStore } from '../../utils/storage.js';
import { STATUS_COPY } from './registry.js';
import { createTurnGate } from './turngate.js';
import { reviewVerdictFromHistory } from './review.js';

// Confirm is only surfaceable when the latest review passed (the question is
// well-defined). Default predicate; injectable so the orchestrator stays decoupled.
function defaultConfirmReady(history) {
  const verdict = reviewVerdictFromHistory(history);
  return Boolean(verdict && verdict.passed);
}

// ---------------------------------------------------------------------------
// States and the state -> agent map. The agent ids match the registry keys and
// are used verbatim by Poe for attribution.
// ---------------------------------------------------------------------------
export const STATES = Object.freeze({
  ENTRY: 'ENTRY',
  POE_INTAKE: 'POE_INTAKE',
  CV_CHECK: 'CV_CHECK',
  RQ_SUPERVISOR: 'RQ_SUPERVISOR',
  NOVELTY_CHECK: 'NOVELTY_CHECK',
  EDGAR_RETRIEVE: 'EDGAR_RETRIEVE',
  P53_EVALUATE: 'P53_EVALUATE',
  COMPLETE: 'COMPLETE',
  PAUSED: 'PAUSED',
});

export const AGENT_BY_STATE = Object.freeze({
  [STATES.POE_INTAKE]: 'Poe',
  [STATES.CV_CHECK]: 'CV',
  [STATES.RQ_SUPERVISOR]: 'RQSupervisor',
  [STATES.NOVELTY_CHECK]: 'Novelty Checker',
  [STATES.EDGAR_RETRIEVE]: 'Edgar Allan',
  [STATES.P53_EVALUATE]: 'p53',
});

// Legal transitions out of each state. The FIRST entry of each list is the
// default (linear) successor used when an agent requests no transition. Forward
// skips are illegal; refine back-edges and PAUSED are legal. PAUSED and COMPLETE
// have no normal out-edges (resume restores the pre-pause state; COMPLETE is
// terminal). This is the routing mechanism; the concrete policy that picks among
// the legal edges (CV-fail, p53-refine) lives in agent outputs, set later.
export const ADJACENCY = Object.freeze({
  [STATES.ENTRY]: [STATES.POE_INTAKE],
  [STATES.POE_INTAKE]: [STATES.CV_CHECK, STATES.PAUSED],
  [STATES.CV_CHECK]: [STATES.RQ_SUPERVISOR, STATES.POE_INTAKE, STATES.PAUSED],
  [STATES.RQ_SUPERVISOR]: [STATES.NOVELTY_CHECK, STATES.POE_INTAKE, STATES.PAUSED],
  // P53_EVALUATE is a legal edge because the real Novelty Checker invokes Edgar
  // itself and routes straight to p53, past the EDGAR_RETRIEVE state (which the
  // stub linear chain still uses as the default first edge).
  [STATES.NOVELTY_CHECK]: [
    STATES.EDGAR_RETRIEVE,
    STATES.P53_EVALUATE,
    STATES.RQ_SUPERVISOR,
    STATES.POE_INTAKE,
    STATES.PAUSED,
  ],
  [STATES.EDGAR_RETRIEVE]: [
    STATES.P53_EVALUATE,
    STATES.RQ_SUPERVISOR,
    STATES.POE_INTAKE,
    STATES.PAUSED,
  ],
  [STATES.P53_EVALUATE]: [
    STATES.COMPLETE,
    STATES.RQ_SUPERVISOR,
    STATES.POE_INTAKE,
    STATES.PAUSED,
  ],
  [STATES.COMPLETE]: [],
  [STATES.PAUSED]: [],
});

function defaultNext(state) {
  const edges = ADJACENCY[state];
  return edges && edges.length ? edges[0] : null;
}

// Placeholder agent steps. Each returns a minimally valid packet attributed to
// its agent with no control hint, so the default-next walk reaches COMPLETE.
// Later phases inject real dispatch()-backed steps over the top of these.
function makeDefaultAgents() {
  const stub = (agentId) => async () => ({
    agentId,
    content: `placeholder ${agentId} output (stub, no dispatch wired)`,
    control: {},
  });
  return {
    Poe: stub('Poe'),
    CV: stub('CV'),
    RQSupervisor: stub('RQSupervisor'),
    'Novelty Checker': stub('Novelty Checker'),
    'Edgar Allan': stub('Edgar Allan'),
    p53: stub('p53'),
  };
}

// ---------------------------------------------------------------------------
// Factory.
// ---------------------------------------------------------------------------
export function createLoop1Orchestrator(deps = {}) {
  const poe = deps.poe || defaultPoe;
  const registry = deps.registry || STATUS_COPY;
  const consoleApi = deps.console || null;
  const agents = { ...makeDefaultAgents(), ...(deps.agents || {}) };
  const dispatch = deps.dispatch || defaultDispatch;
  const storage = deps.storage || { session: sessionStore, kg: kgStore };
  // The TurnGate is the conversation-write mutex: only Poe ever holds it, and the
  // orchestrator holds it (as Poe) across each user-facing turn. Injectable so
  // tests can observe the floor; defaults to a fresh per-instance gate.
  const turngate = deps.turngate || createTurnGate({ logger: (e) => emit(e.type, e) });
  // The conversation writer is the only agent whose packet becomes a conversation
  // card (it is the TurnGate owner: only Poe writes the conversation). Every other
  // agent is backstage and surfaces in the IO panel only.
  const conversationWriter = turngate.owner;
  // Optional IO-panel packet sink. When wired, each agent's validated packet is
  // surfaced in the packet inspector (agents write to the IO panel, not the
  // conversation). Off by default so the conversation path is unaffected.
  const ioPacket = deps.packet || null;
  const clock = deps.clock || (() => Date.now());
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  const onStateChange = deps.onStateChange;
  const onComplete = deps.onComplete;
  const onError = deps.onError;
  // Whether the researcher may confirm right now (latest review passed). Injectable.
  const confirmReady = typeof deps.confirmReady === 'function' ? deps.confirmReady : defaultConfirmReady;
  // Notified whenever the composer's enable/confirm/lock state should change.
  const onComposer = typeof deps.onComposer === 'function' ? deps.onComposer : null;
  // Notified with the latest extracted RQPacket after each turn (and cleared on
  // mount). Drives the file-cabinet drawer (a data view, not a conversation write);
  // additive and optional, so it never affects the conversation or the chain.
  const onPacket = typeof deps.onPacket === 'function' ? deps.onPacket : null;

  let session = deps.session || { researchQuestion: null };
  let current = STATES.ENTRY;
  let mounted = false;
  let awaitingIntake = false;
  let resumeTarget = null;
  let lastError = null;
  const history = [];

  // Best-effort event sink to the agent console / trace; never breaks a run.
  const emit = (type, data = {}) => {
    try {
      logger({ type, loop: 1, ...data });
    } catch (_err) {
      // logging is best effort
    }
  };

  function ensureMounted(method) {
    if (!mounted) throw new Error(`loop1.${method}: call mount(target) first`);
  }

  function setState(next) {
    current = next;
    emit('state:change', { state: next });
    if (typeof onStateChange === 'function') onStateChange(next);
  }

  // No silent swallowing: surface the failure with reproducible context, then
  // route to PAUSED so the run can be inspected and resumed (re-entering the
  // failed state retries it). Returns PAUSED.
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
    // The state is already COMPLETE (set by enter()); just finalize the surface.
    poe.setStatus(null); // chain done: hide the single global indicator
    emit('complete', { researchQuestion: session.researchQuestion, turns: history.length });
    const result = { session, history: history.slice() };
    if (typeof onComplete === 'function') onComplete(result);
    notifyComposer(); // locked: the loop has ceased
    return STATES.COMPLETE;
  }

  // The composer (researcher input) enable state. awaitingInput is true only while
  // Poe waits for the researcher at POE_INTAKE; canConfirm adds "the latest review
  // passed"; locked is true once the loop has ceased (post-CEASE edits lock).
  function composerStatus() {
    const awaitingInput = current === STATES.POE_INTAKE && awaitingIntake;
    return {
      awaitingInput,
      canConfirm: awaitingInput && confirmReady(history),
      locked: current === STATES.COMPLETE,
    };
  }

  function notifyComposer() {
    if (onComposer) onComposer(composerStatus());
  }

  // Surface the latest RQPacket to the file-cabinet drawer (a data view). Poe's step
  // re-extracts session.rqPacket each turn; this reflects it without touching the feed.
  function notifyPacket() {
    if (onPacket) onPacket(session.rqPacket || null);
  }

  // Validate a requested transition against the legal adjacency and act on it.
  function transition(from, to) {
    const legal = ADJACENCY[from] || [];
    if (!legal.includes(to)) {
      return fail(from, AGENT_BY_STATE[from] || null, new Error(`illegal transition ${from} -> ${to}`));
    }
    if (to === STATES.PAUSED) {
      // An agent paused the chain after finishing: resume continues forward.
      resumeTarget = defaultNext(from);
      poe.setStatus(null);
      setState(STATES.PAUSED);
      emit('paused', { from, resumeTarget });
      return STATES.PAUSED;
    }
    return enter(to);
  }

  // Run one agent state. Poe holds the TurnGate for the whole user-facing turn:
  // status -> step (the agent runs here, writing to the IO panel only) ->
  // validate attribution -> Poe renders the card under the gate -> confirm. The
  // gate is released before the machine transitions, so the next turn re-acquires
  // it cleanly and no turn is ever written off the floor.
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
          researchQuestion: session.researchQuestion,
          history: history.slice(),
          dispatch,
          storage,
          clock,
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

        // Confirmed: show the registry complete copy (green signals confirmed,
        // not only running). The conversation writer (Poe) renders a card under
        // the gate; every other agent is backstage, so its turn is settled (its
        // console entry closed) without a conversation card and its packet goes
        // to the IO panel below.
        poe.setStatus(agentId, 'complete');
        if (agentId === conversationWriter) {
          poe.receive(packet);
        } else {
          // Surface the backstage agent's outcome AND where the pipeline routes next, so
          // the agent console reads as a concrete, debuggable step-trace (CV pass ->
          // RQSupervisor, RQSupervisor not approved -> Poe, Novelty -> p53, ...). The next
          // state is read from the same source the transition uses below.
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
      // A thrown step (or a thrown render) propagates out of withTurn after the
      // gate is released in its finally; never a gate leak.
      failure = cause;
    }

    if (failure) return fail(state, agentId, failure);

    // Agent output also surfaces in the IO panel packet inspector when wired
    // (agents write to the IO panel, not the conversation). Outside the gate:
    // the gate guards only the conversation layer.
    if (ioPacket && typeof ioPacket.setPacket === 'function') ioPacket.setPacket(packet);
    // Refresh the file-cabinet drawer with the RQPacket as it stands after this turn.
    notifyPacket();

    const requested = packet.control && packet.control.transition;
    return transition(state, requested || defaultNext(state));
  }

  // Enter a state: waiting states (POE_INTAKE) arm and return; agent states run;
  // terminal states finalize. Returns the resting state (a promise for the agent
  // walk, a string for waiting/terminal states).
  function enter(state) {
    setState(state);
    switch (state) {
      case STATES.POE_INTAKE:
        awaitingIntake = true;
        poe.setStatus(AGENT_BY_STATE[STATES.POE_INTAKE], 'running');
        emit('intake:awaiting', {});
        notifyComposer(); // awaiting the researcher; confirm may now be available
        return STATES.POE_INTAKE;
      case STATES.CV_CHECK:
      case STATES.RQ_SUPERVISOR:
      case STATES.NOVELTY_CHECK:
      case STATES.EDGAR_RETRIEVE:
      case STATES.P53_EVALUATE:
        return runAgentState(state);
      case STATES.COMPLETE:
        return complete();
      case STATES.PAUSED:
        poe.setStatus(null);
        return STATES.PAUSED;
      default:
        return state;
    }
  }

  // ----- public API -----
  function mount(target) {
    if (!target) throw new Error('loop1.mount: target is required');
    // Poe re-mounts with the Loop 1 registry; the orchestrator keeps only Poe's
    // method API and never holds a conversation node.
    poe.mount(target, { registry, console: consoleApi });
    mounted = true;
    history.length = 0;
    // Fresh run: a re-mount (NEW SESSION / RESET) must not leak the prior run's
    // packet, confirmation, or warnings into the next one.
    session = deps.session || { researchQuestion: null };
    awaitingIntake = false;
    resumeTarget = null;
    lastError = null;
    notifyPacket(); // fresh run: clear the file-cabinet drawer to placeholders
    setState(STATES.ENTRY);
    return api;
  }

  async function start() {
    ensureMounted('start');
    if (current !== STATES.ENTRY) return current;
    return enter(STATES.POE_INTAKE);
  }

  async function submit(researchQuestion) {
    ensureMounted('submit');
    if (current !== STATES.POE_INTAKE || !awaitingIntake) {
      throw new Error(`loop1.submit: only valid while awaiting intake (state=${current})`);
    }
    session.researchQuestion = String(researchQuestion == null ? '' : researchQuestion);
    awaitingIntake = false;
    // The turn is now processing: disable the composer immediately so the researcher
    // cannot submit again mid-chain (which would hit a non-POE_INTAKE state and error).
    // enter(POE_INTAKE) re-enables it when the chain rests back at Poe.
    notifyComposer();
    // Render the researcher's own message into the feed (Poe is the only conversation
    // writer; the composer never writes it). Guarded so minimal test fakes are fine.
    if (typeof poe.userTurn === 'function') poe.userTurn(session.researchQuestion);
    emit('intake:received', { researchQuestion: session.researchQuestion });
    return runAgentState(STATES.POE_INTAKE);
  }

  // The researcher actively confirms the question. Only valid while awaiting intake
  // and only once the latest review passed (the composer surfaces the affordance only
  // then, and this guards it too). Sets the cessation flag and routes straight to p53,
  // which now has every condition met and ceases.
  async function confirm() {
    ensureMounted('confirm');
    if (current !== STATES.POE_INTAKE || !awaitingIntake) {
      throw new Error(`loop1.confirm: only valid while awaiting intake (state=${current})`);
    }
    if (!confirmReady(history)) {
      throw new Error('loop1.confirm: the question has not passed review yet');
    }
    session.researcherConfirmed = true;
    awaitingIntake = false;
    // Disable the composer while the cessation evaluation runs (re-enabled if p53
    // routes back to Poe; locked on COMPLETE).
    notifyComposer();
    emit('intake:confirmed', {});
    return enter(STATES.P53_EVALUATE);
  }

  function canConfirm() {
    return composerStatus().canConfirm;
  }

  function pause() {
    ensureMounted('pause');
    if (current === STATES.PAUSED || current === STATES.COMPLETE) return current;
    resumeTarget = current; // re-enter the same state on resume
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
    submit,
    confirm,
    canConfirm,
    composerStatus,
    pause,
    resume,
    getState: () => current,
    getHistory: () => history.slice(),
    getSession: () => session,
    getLastError: () => lastError,
    getTurnGate: () => turngate,
  };
  return api;
}

// Default app singleton, built with the Poe singleton and default collaborators.
// main.js constructs its own configured instance (injecting the agent console and
// the completion/error callbacks), mirroring how configureDispatcher binds the
// dispatcher app instance.
export const loop1 = createLoop1Orchestrator();
