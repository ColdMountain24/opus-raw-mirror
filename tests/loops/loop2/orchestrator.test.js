import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoop2Orchestrator,
  STATES,
  AGENT_BY_STATE,
} from '../../../src/loops/loop2/orchestrator.js';
import { STATUS_COPY } from '../../../src/loops/loop2/registry.js';
import { createTurnGate } from '../../../src/loops/loop1/turngate.js';
import { createPoe } from '../../../src/components/poe.js';

// Loop 2 orchestrator. Driven on a fake Poe (records every call so we can prove the
// orchestrator writes the conversation only through Poe) plus injected stub agents.

function fakePoe() {
  const calls = { mount: [], setStatus: [], receive: [], settle: [], stream: [], milestoneCard: [] };
  return {
    calls,
    mount: vi.fn((target, opts) => calls.mount.push({ target, opts })),
    setStatus: vi.fn((agentId, key) => calls.setStatus.push({ agentId, key })),
    receive: vi.fn((packet) => calls.receive.push(packet)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn((agentId, chunk) => calls.stream.push({ agentId, chunk })),
    showThinking: vi.fn(),
    milestoneCard: vi.fn((spec) => calls.milestoneCard.push(spec)),
  };
}

function fakeConsole() {
  let seq = 0;
  const entries = new Map();
  return {
    entries,
    pushEntry: vi.fn(({ agent, message, state }) => {
      const id = `e${(seq += 1)}`;
      entries.set(id, { agent, message, state });
      return id;
    }),
    updateEntry: vi.fn((id, patch) => {
      const e = entries.get(id);
      if (e) Object.assign(e, patch);
      return true;
    }),
    complete: vi.fn((id, message) => {
      const e = entries.get(id);
      if (e) {
        e.state = 'done';
        if (typeof message === 'string') e.message = message;
      }
      return true;
    }),
  };
}

// A session store carrying the RQPacket Loop 1 finalized.
function fakeStorage(saved = { rqPacket: { KnowledgeGap: 'gap' }, researchQuestion: 'Does X cause Y?' }) {
  return { session: { load: async () => saved } };
}

const LINEAR_STATES = [
  STATES.ENTRY,
  STATES.POE_INTAKE,
  STATES.FEARLESS_LEADER,
  STATES.PHASE_1,
  STATES.PHASE_2,
  STATES.BOOKKEEPER_STAGE,
  STATES.POSTDOC_STANDARD,
  STATES.RQ_REVISION_CHECK,
  STATES.MATERIAL_CONTRADICTIONS,
  STATES.BOOKKEEPER_PROMOTE,
  STATES.UNKNOWN_FIELD_SURFACING,
  STATES.P53_EVALUATE,
  STATES.POSTDOC_FINAL,
  STATES.OUTPUT_HOOK,
  STATES.COMPLETE,
];

// Backstage agents (every agent-run state but the Poe-driven MATERIAL_CONTRADICTIONS).
const BACKSTAGE_SETTLES = [
  'Fearless Leader',
  'Grad Students', // PHASE_1
  'Grad Students', // PHASE_2
  'Bookkeeper', // BOOKKEEPER_STAGE
  'Post-Doc', // POSTDOC_STANDARD
  'Revision Check', // RQ_REVISION_CHECK (deterministic)
  'Bookkeeper', // BOOKKEEPER_PROMOTE
  'Salvia', // UNKNOWN_FIELD_SURFACING
  'p53', // P53_EVALUATE
  'Post-Doc', // POSTDOC_FINAL
  'Packager', // OUTPUT_HOOK (deterministic)
];

describe('loop 2 orchestrator', () => {
  let host;
  let poe;
  let con;

  beforeEach(() => {
    host = document.createElement('div');
    poe = fakePoe();
    con = fakeConsole();
  });

  it('mount inherits the RQPacket, warms the Loop 2 surface, and mounts Poe with the registry', async () => {
    const root = document.createElement('div');
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage() });
    const ret = await orch.mount(host, { root });

    expect(poe.mount).toHaveBeenCalledTimes(1);
    expect(poe.calls.mount[0].opts.registry).toBe(STATUS_COPY);
    expect(poe.calls.mount[0].opts.console).toBe(con);
    // The inherited RQPacket + research question are read from the session store.
    expect(orch.getSession().rqPacket).toEqual({ KnowledgeGap: 'gap' });
    expect(orch.getSession().researchQuestion).toBe('Does X cause Y?');
    // The app root is warmed to Loop 2 (the aged-paper tint).
    expect(root.dataset.loop).toBe('2');
    expect(orch.getState()).toBe(STATES.ENTRY);
    expect(ret).toBe(orch);
  });

  it('start arms the autonomous intake gate (Poe running + an intake card) and waits', async () => {
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage() });
    await orch.mount(host);
    const resting = await orch.start();
    expect(resting).toBe(STATES.POE_INTAKE);
    expect(poe.calls.setStatus.at(-1)).toEqual({ agentId: 'Poe', key: 'running' });
    // A brief "add more papers?" card is offered; no agent has run yet.
    expect(poe.calls.milestoneCard).toHaveLength(1);
    expect(poe.calls.milestoneCard[0].cta.label).toBe('Begin literature review');
    expect(poe.receive).not.toHaveBeenCalled();
  });

  it('proceed walks the chain to COMPLETE; only Poe renders a card (contradictions), the rest settle', async () => {
    const seen = [];
    const orch = createLoop2Orchestrator({
      poe,
      console: con,
      storage: fakeStorage(),
      onStateChange: (s) => seen.push(s),
    });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();

    expect(orch.getState()).toBe(STATES.COMPLETE);
    expect(seen).toEqual(LINEAR_STATES);
    // MATERIAL_CONTRADICTIONS is the only Poe-driven agent turn -> one conversation card.
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']);
    // Every backstage agent settled, in order (PHASE_1/PHASE_2 both Grad Students).
    expect(poe.calls.settle).toEqual(BACKSTAGE_SETTLES);
    // Chain done: the global indicator is hidden last.
    expect(poe.calls.setStatus.at(-1)).toEqual({ agentId: null, key: undefined });
  });

  it('proceed records extra papers onto the session', async () => {
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage() });
    await orch.mount(host);
    await orch.start();
    await orch.proceed(['arXiv:1234', 'doi:10.1/x']);
    expect(orch.getSession().extraPapers).toEqual(['arXiv:1234', 'doi:10.1/x']);
  });

  it('maps every state to an agent that has registered status copy', () => {
    const drivers = new Set(Object.values(AGENT_BY_STATE));
    drivers.forEach((agentId) => expect(STATUS_COPY[agentId]).toBeTruthy());
  });

  it('allows a legal back-edge (p53 -> POSTDOC_STANDARD) and re-converges to COMPLETE', async () => {
    let p53Calls = 0;
    const agents = {
      p53: async () => {
        p53Calls += 1;
        // First evaluation: not ceasing -> loop back to re-synthesize; second: proceed.
        const transition = p53Calls === 1 ? STATES.POSTDOC_STANDARD : undefined;
        return { agentId: 'p53', content: 'eval', control: { transition } };
      },
    };
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage(), agents });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.COMPLETE);
    expect(p53Calls).toBeGreaterThanOrEqual(2); // looped back through p53 at least once
  });

  it('an illegal forward-skip transition is surfaced and parks at PAUSED', async () => {
    const errors = [];
    const agents = {
      'Fearless Leader': async () => ({
        agentId: 'Fearless Leader',
        content: 'jump the queue',
        control: { transition: STATES.COMPLETE }, // illegal forward skip
      }),
    };
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage(), agents, onError: (e) => errors.push(e) });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(errors[0]).toMatchObject({ state: STATES.FEARLESS_LEADER, agentId: 'Fearless Leader' });
    expect(errors[0].message).toMatch(/illegal transition FEARLESS_LEADER -> COMPLETE/);
  });

  it('a packet attributed to the wrong agent is rejected and parks at PAUSED', async () => {
    const errors = [];
    const agents = { 'Fearless Leader': async () => ({ agentId: 'NOPE', content: 'x' }) };
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage(), agents, onError: (e) => errors.push(e) });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(errors[0].message).toMatch(/attributed to NOPE/);
  });

  it('a thrown agent step parks at PAUSED and never leaks the TurnGate', async () => {
    const gate = createTurnGate();
    const agents = {
      'Grad Students': async () => {
        throw new Error('extraction service offline');
      },
    };
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage(), agents, turngate: gate, onError: () => {} });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(orch.getLastError().message).toMatch(/extraction service offline/);
    expect(gate.isHeld()).toBe(false);
  });

  it('external pause from intake parks the machine; resume returns to waiting intake', async () => {
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage() });
    await orch.mount(host);
    await orch.start();
    expect(orch.getState()).toBe(STATES.POE_INTAKE);

    orch.pause();
    expect(orch.getState()).toBe(STATES.PAUSED);

    await orch.resume();
    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.COMPLETE);
  });

  it('runs each agent call inside the interval Poe holds the gate; free at rest', async () => {
    const gate = createTurnGate();
    const observed = [];
    const record = (agentId) => async () => {
      observed.push({ held: gate.isHeld(), by: gate.heldBy() });
      return { agentId, content: 'x', control: {} };
    };
    const agents = {
      'Fearless Leader': record('Fearless Leader'),
      'Grad Students': record('Grad Students'),
      Bookkeeper: record('Bookkeeper'),
      'Post-Doc': record('Post-Doc'),
      'Revision Check': record('Revision Check'),
      Poe: record('Poe'),
      Salvia: record('Salvia'),
      p53: record('p53'),
      Packager: record('Packager'),
    };
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage(), agents, turngate: gate });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.COMPLETE);
    expect(observed.length).toBe(12); // every agent-run state
    observed.forEach((o) => {
      expect(o.held).toBe(true);
      expect(o.by).toBe('Poe');
    });
    expect(gate.isHeld()).toBe(false);
  });

  it('surfaces each validated packet to the IO panel packet sink when wired', async () => {
    const seen = [];
    const packet = { setPacket: (p) => seen.push(p.agentId) };
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage(), packet });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(seen).toEqual([
      'Fearless Leader',
      'Grad Students',
      'Grad Students',
      'Bookkeeper',
      'Post-Doc',
      'Revision Check',
      'Poe',
      'Bookkeeper',
      'Salvia',
      'p53',
      'Post-Doc',
      'Packager',
    ]);
  });

  it('guards methods before mount and proceed out of order', async () => {
    const orch = createLoop2Orchestrator({ poe, console: con, storage: fakeStorage() });
    await expect(orch.start()).rejects.toThrow(/call mount/);
    await expect(orch.proceed()).rejects.toThrow(/call mount/);
    await expect(orch.mount(null)).rejects.toThrow(/target is required/);

    await orch.mount(host); // ENTRY, not awaiting intake
    await expect(orch.proceed()).rejects.toThrow(/awaiting intake/);
  });

  it('fires onPromote at the Bookkeeper states with the scope, for the Observatory', async () => {
    const promotions = [];
    const agents = {
      Bookkeeper: async ({ state }) => ({
        agentId: 'Bookkeeper',
        content: 'promoted',
        promoted: { nodes: [{ data: { id: `${state}-n`, type: 'claim', confidence: 'high' } }], edges: [] },
        control: {},
      }),
    };
    const orch = createLoop2Orchestrator({
      poe,
      console: con,
      storage: fakeStorage(),
      agents,
      onPromote: (nodes, edges, meta) => promotions.push({ ids: nodes.map((n) => n.data.id), scope: meta.scope }),
    });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();

    // Two Bookkeeper states promoted: STAGE (subspecialization) then PROMOTE (global).
    expect(promotions).toEqual([
      { ids: ['BOOKKEEPER_STAGE-n'], scope: 'subspecialization' },
      { ids: ['BOOKKEEPER_PROMOTE-n'], scope: 'global' },
    ]);
  });

  it('does not fire onPromote when the Bookkeeper packet carries no promoted elements (stub)', async () => {
    const promotions = [];
    const orch = createLoop2Orchestrator({
      poe,
      console: con,
      storage: fakeStorage(),
      onPromote: () => promotions.push(1),
    });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(promotions).toHaveLength(0); // the default stub Bookkeeper promotes nothing
  });

  it('renders the real intake-card copy and status through the real Poe', async () => {
    const realPoe = createPoe();
    const orch = createLoop2Orchestrator({ poe: realPoe, console: fakeConsole(), storage: fakeStorage() });
    await orch.mount(host);
    await orch.start();
    // The registry running copy shows on the indicator; the intake card carries the prompt.
    expect(host.querySelector('.poe-status-copy').textContent).toBe('Preparing the archive...');
    expect(host.querySelector('.poe-milestone-tag').textContent).toBe('[INTAKE]');
    expect(host.querySelector('.poe-milestone-cta').textContent).toBe('Begin literature review');
  });
});

// ----- the analysis trail (real-time audit log) + the OUTPUT_HOOK cessation card -----

describe('loop 2 orchestrator analysis trail', () => {
  let host;
  beforeEach(() => {
    host = document.createElement('div');
  });

  it('builds the analysis trail incrementally as the chain runs (getTrailLog)', async () => {
    const agents = {
      'Fearless Leader': async () => ({ agentId: 'Fearless Leader', content: 'fl', result: { subspecializations: [{ id: 's1', name: 'Aging' }] }, control: {} }),
      'Grad Students': async ({ state }) =>
        state === 'PHASE_2'
          ? { agentId: 'Grad Students', content: 'p2', result: { subspecializations: [] }, control: {} }
          : {
              agentId: 'Grad Students',
              content: 'p1',
              result: { subspecializations: [{ subspecialization_id: 's1', claims: [{ claim_id: 'a' }, { claim_id: 'b' }] }], papers_retrieved: 5, claims_extracted: 3, claims_rejected: 1 },
              control: {},
            },
      p53: async () => ({ agentId: 'p53', content: 'p53', result: { state: 'CEASE', coverage: 0.8, iteration: 1, conditions: {}, max_iterations: 3, reasons: [] }, control: {} }),
    };
    const orch = createLoop2Orchestrator({ poe: fakePoe(), storage: fakeStorage(), agents });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.COMPLETE);

    const trail = orch.getTrailLog();
    expect(trail.map((e) => e.seq)).toEqual(trail.map((_, i) => i)); // monotonic, push-order
    const sweep = trail.find((e) => e.type === 'sweep');
    expect(sweep.round).toBe(1);
    expect(sweep.subspecializations).toEqual(['Aging']);
    const cr = trail.find((e) => e.type === 'claims_round');
    expect(cr).toMatchObject({ round: 1, extracted: 3, promoted: 2, rejected: 1 });
    const cov = trail.find((e) => e.type === 'coverage');
    expect(cov).toMatchObject({ iteration: 1, coverage: 0.8, state: 'CEASE' });
  });

  it('noteFallback maps dispatcher fallback events into the trail (and ignores the rest)', async () => {
    const orch = createLoop2Orchestrator({ poe: fakePoe(), storage: fakeStorage() });
    await orch.mount(host);
    orch.noteFallback({ type: 'failover:next', from: 'anthropic', reason: 'timeout' });
    orch.noteFallback({ type: 'cache:hit', agentId: 'Skips' });
    orch.noteFallback({ type: 'validate:fail', agentId: 'Salvia', provider: 'groq' });
    orch.noteFallback({ type: 'dispatch:start' }); // not a fallback -> ignored
    const fb = orch.getTrailLog().filter((e) => e.type === 'fallback');
    expect(fb.map((e) => e.kind)).toEqual(['failover', 'cache_hit', 'corrective_retry']);
    expect(fb[0]).toMatchObject({ from: 'anthropic', reason: 'timeout' });
  });

  it('mount resets the trail (a fresh run starts empty)', async () => {
    const orch = createLoop2Orchestrator({ poe: fakePoe(), storage: fakeStorage() });
    await orch.mount(host);
    orch.noteFallback({ type: 'cache:hit', agentId: 'X' });
    expect(orch.getTrailLog().length).toBe(1);
    await orch.mount(host);
    expect(orch.getTrailLog()).toEqual([]);
  });

  it('raises the Packager cessation card at OUTPUT_HOOK via the overlay seam, then COMPLETES', async () => {
    const cessation = { tag: '[ARCHIVE_COMPLETE]', title: 'Literature review complete.', fields: [], sections: [{ summary: 'Show analysis trail', fields: [] }], cta: { label: 'Proceed to Hypothesis Scrutiny', onClick: () => {} } };
    const poe = fakePoe();
    const orch = createLoop2Orchestrator({
      poe,
      storage: fakeStorage(),
      agents: { Packager: async () => ({ agentId: 'Packager', content: 'pkg', result: {}, overlay: cessation, control: {} }) },
    });
    await orch.mount(host);
    await orch.start();
    await orch.proceed();
    expect(orch.getState()).toBe(STATES.COMPLETE);
    const card = poe.calls.milestoneCard.find((c) => c && c.tag === '[ARCHIVE_COMPLETE]');
    expect(card).toBeTruthy();
    expect(card.cta.label).toBe('Proceed to Hypothesis Scrutiny');
    expect(poe.calls.receive.map((p) => p.agentId)).not.toContain('Packager'); // backstage, never the conversation
  });
});
