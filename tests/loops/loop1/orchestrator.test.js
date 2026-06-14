import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createLoop1Orchestrator,
  STATES,
  AGENT_BY_STATE,
} from '../../../src/loops/loop1/orchestrator.js';
import { STATUS_COPY } from '../../../src/loops/loop1/registry.js';
import { createTurnGate } from '../../../src/loops/loop1/turngate.js';
import { createPoe } from '../../../src/components/poe.js';

// Loop 1 orchestrator. Driven on a fake Poe (records every method call so we can
// prove the orchestrator only ever writes the conversation through Poe) plus
// injected stub agents. One integration test uses the real Poe to prove the
// registry copy actually renders.

function fakePoe() {
  const calls = { mount: [], setStatus: [], receive: [], settle: [], stream: [], showThinking: [] };
  return {
    calls,
    mount: vi.fn((target, opts) => calls.mount.push({ target, opts })),
    setStatus: vi.fn((agentId, key) => calls.setStatus.push({ agentId, key })),
    receive: vi.fn((packet) => calls.receive.push(packet)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn((agentId, chunk) => calls.stream.push({ agentId, chunk })),
    showThinking: vi.fn((agentId, steps) => calls.showThinking.push({ agentId, steps })),
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

const LINEAR_AGENTS = ['Poe', 'CV', 'RQSupervisor', 'Novelty Checker', 'Edgar Allan', 'p53'];
const LINEAR_STATES = [
  STATES.ENTRY,
  STATES.POE_INTAKE,
  STATES.CV_CHECK,
  STATES.RQ_SUPERVISOR,
  STATES.NOVELTY_CHECK,
  STATES.EDGAR_RETRIEVE,
  STATES.P53_EVALUATE,
  STATES.COMPLETE,
];

describe('loop 1 orchestrator', () => {
  let host;
  let poe;
  let con;

  beforeEach(() => {
    host = document.createElement('div');
    poe = fakePoe();
    con = fakeConsole();
  });

  it('mount owns the Poe mount with the S1 registry and the console, and sets ENTRY', () => {
    const orch = createLoop1Orchestrator({ poe, console: con });
    const ret = orch.mount(host);
    expect(poe.mount).toHaveBeenCalledTimes(1);
    const opts = poe.calls.mount[0].opts;
    expect(opts.registry).toBe(STATUS_COPY);
    expect(opts.console).toBe(con);
    expect(orch.getState()).toBe(STATES.ENTRY);
    expect(ret).toBe(orch); // mount returns the API
  });

  it('start arms POE_INTAKE with Poe "running" and waits', async () => {
    const orch = createLoop1Orchestrator({ poe, console: con });
    orch.mount(host);
    const resting = await orch.start();
    expect(resting).toBe(STATES.POE_INTAKE);
    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    expect(poe.calls.setStatus.at(-1)).toEqual({ agentId: 'Poe', key: 'running' });
    // No agent has rendered yet: it is waiting for submit().
    expect(poe.receive).not.toHaveBeenCalled();
  });

  it('submit walks the linear chain to COMPLETE; only Poe renders a card, the rest settle', async () => {
    const seen = [];
    const orch = createLoop1Orchestrator({ poe, console: con, onStateChange: (s) => seen.push(s) });
    orch.mount(host);
    await orch.start();
    await orch.submit('Does intermittent fasting improve working memory in adults?');

    expect(orch.getState()).toBe(STATES.COMPLETE);
    expect(seen).toEqual(LINEAR_STATES);
    // Only the conversation writer (Poe) renders a conversation card; the five
    // backstage agents are settled (IO panel only), never rendered.
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']);
    expect(poe.calls.settle).toEqual(['CV', 'RQSupervisor', 'Novelty Checker', 'Edgar Allan', 'p53']);
    // Every agent got a running and a complete status, in agent order.
    LINEAR_AGENTS.forEach((agentId) => {
      expect(poe.calls.setStatus).toContainEqual({ agentId, key: 'running' });
      expect(poe.calls.setStatus).toContainEqual({ agentId, key: 'complete' });
    });
    // Chain done: the global indicator is hidden last.
    expect(poe.calls.setStatus.at(-1)).toEqual({ agentId: null, key: undefined });
  });

  it('renders the conversation only through poe.receive (Poe only), never stream/DOM here', async () => {
    const orch = createLoop1Orchestrator({ poe, console: con });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');
    // One conversation card (Poe); the five backstage agents settle instead.
    expect(poe.receive).toHaveBeenCalledTimes(1);
    expect(poe.settle).toHaveBeenCalledTimes(5);
    expect(poe.stream).not.toHaveBeenCalled();
    // The orchestrator exposes no conversation node, only methods.
    const api = orch;
    Object.keys(api).forEach((k) => expect(typeof api[k]).toBe('function'));
  });

  it('every status uses registered copy (never generic) via the real Poe', async () => {
    const realPoe = createPoe();
    const realCon = fakeConsole();
    const orch = createLoop1Orchestrator({ poe: realPoe, console: realCon });
    orch.mount(host);
    await orch.start();
    // While intake waits, the real indicator shows the registry running copy.
    expect(host.querySelector('.poe-status-copy').textContent).toBe('Listening...');

    await orch.submit('Does caffeine improve memory?');
    // Each agent's console entry (IO panel) ends done. Poe (the conversation writer)
    // carries its registry complete copy; the backstage agents surface their own
    // outcome summary (the packet content) so the console shows the verdict, not a
    // generic line. The registry running copy is still used (the indicator, above).
    const byAgent = new Map();
    realCon.entries.forEach((e) => byAgent.set(e.agent, e));
    Object.keys(STATUS_COPY).forEach((agentId) => {
      const entry = byAgent.get(agentId);
      expect(entry).toBeTruthy();
      expect(entry.state).toBe('done');
    });
    expect(byAgent.get('Poe').message).toBe(STATUS_COPY.Poe.complete);
    // A backstage agent's entry shows its content summary (unique, never generic) plus
    // where the pipeline routes next, so the console is a concrete step-trace.
    expect(byAgent.get('CV').message).toContain('CV');
    expect(byAgent.get('CV').message).toContain('-> RQSupervisor');
    // The feed shows the researcher's own turn ([YOU]) and the conversation writer's
    // reply ([Poe]); the backstage agents leave no card in the feed.
    const rendered = [...host.querySelectorAll('.poe-card-agent')].map((n) => n.textContent);
    expect(rendered).toEqual(['[YOU]', '[Poe]']);
  });

  it('an agent that requests PAUSED halts after rendering; resume continues forward', async () => {
    const agents = {
      CV: async () => ({ agentId: 'CV', content: 'paused here', control: { transition: STATES.PAUSED } }),
    };
    const orch = createLoop1Orchestrator({ poe, console: con, agents });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');

    expect(orch.getState()).toBe(STATES.PAUSED);
    // Poe rendered its card; CV ran (backstage) and settled before the pause.
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']);
    expect(poe.calls.settle).toEqual(['CV']);

    await orch.resume();
    expect(orch.getState()).toBe(STATES.COMPLETE);
    // Still only Poe in the conversation; the rest settled to the IO panel.
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']);
    expect(poe.calls.settle).toEqual(['CV', 'RQSupervisor', 'Novelty Checker', 'Edgar Allan', 'p53']);
  });

  it('external pause from intake parks the machine; resume returns to waiting intake', async () => {
    const orch = createLoop1Orchestrator({ poe, console: con });
    orch.mount(host);
    await orch.start();
    expect(orch.getState()).toBe(STATES.POE_INTAKE);

    orch.pause();
    expect(orch.getState()).toBe(STATES.PAUSED);

    await orch.resume();
    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    await orch.submit('q');
    expect(orch.getState()).toBe(STATES.COMPLETE);
  });

  it('an illegal transition is surfaced (not swallowed) and parks at PAUSED', async () => {
    const errors = [];
    const agents = {
      RQSupervisor: async () => ({
        agentId: 'RQSupervisor',
        content: 'jump the queue',
        control: { transition: STATES.COMPLETE }, // illegal: forward skip
      }),
    };
    const orch = createLoop1Orchestrator({ poe, console: con, agents, onError: (e) => errors.push(e) });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');

    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ state: STATES.RQ_SUPERVISOR, agentId: 'RQSupervisor' });
    expect(errors[0].message).toMatch(/illegal transition RQ_SUPERVISOR -> COMPLETE/);
  });

  it('a packet attributed to the wrong agent is rejected and parks at PAUSED', async () => {
    const errors = [];
    const agents = { CV: async () => ({ agentId: 'NOT_CV', content: 'x' }) };
    const orch = createLoop1Orchestrator({ poe, console: con, agents, onError: (e) => errors.push(e) });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');
    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(errors[0].message).toMatch(/attributed to NOT_CV/);
  });

  it('a thrown agent step is surfaced and parks at PAUSED, never swallowed', async () => {
    const errors = [];
    const agents = {
      'Novelty Checker': async () => {
        throw new Error('novelty index offline');
      },
    };
    const orch = createLoop1Orchestrator({ poe, console: con, agents, onError: (e) => errors.push(e) });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');
    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(errors[0]).toMatchObject({ agentId: 'Novelty Checker' });
    expect(errors[0].message).toMatch(/novelty index offline/);
  });

  it('onComplete fires with the assembled history and the captured question', async () => {
    let result;
    const orch = createLoop1Orchestrator({ poe, console: con, onComplete: (r) => (result = r) });
    orch.mount(host);
    await orch.start();
    await orch.submit('Does sleep debt impair decision making?');

    expect(result).toBeTruthy();
    expect(result.history.map((h) => h.agentId)).toEqual(LINEAR_AGENTS);
    expect(result.history.map((h) => h.state)).toEqual([
      STATES.POE_INTAKE,
      STATES.CV_CHECK,
      STATES.RQ_SUPERVISOR,
      STATES.NOVELTY_CHECK,
      STATES.EDGAR_RETRIEVE,
      STATES.P53_EVALUATE,
    ]);
    expect(result.session.researchQuestion).toBe('Does sleep debt impair decision making?');
  });

  it('guards methods before mount and submit out of order', async () => {
    const orch = createLoop1Orchestrator({ poe, console: con });
    await expect(orch.start()).rejects.toThrow(/call mount/);
    await expect(orch.submit('q')).rejects.toThrow(/call mount/);
    expect(() => orch.mount(null)).toThrow(/target is required/);

    orch.mount(host); // ENTRY, not awaiting intake
    await expect(orch.submit('q')).rejects.toThrow(/awaiting intake/);
  });

  it('exposes a state->agent map that matches the registry keys exactly', () => {
    const mapped = Object.values(AGENT_BY_STATE).sort();
    const registered = Object.keys(STATUS_COPY).sort();
    expect(mapped).toEqual(registered);
  });

  // ----- TurnGate integration -----

  it('holds the TurnGate as Poe for every agent turn and leaves it free at rest', async () => {
    const orch = createLoop1Orchestrator({ poe, console: con });
    orch.mount(host);
    await orch.start();
    // Waiting for intake: the floor is free (no message being written).
    expect(orch.getTurnGate().isHeld()).toBe(false);

    await orch.submit('q');
    expect(orch.getState()).toBe(STATES.COMPLETE);
    // After the chain rests the gate is released, never leaked.
    expect(orch.getTurnGate().isHeld()).toBe(false);
  });

  it('runs each agent call inside the interval Poe holds the gate', async () => {
    const gate = createTurnGate();
    const observed = [];
    const record = (agentId) => async () => {
      // At the moment the agent runs, Poe must hold the floor.
      observed.push({ agentId, held: gate.isHeld(), by: gate.heldBy() });
      return { agentId, content: 'x', control: {} };
    };
    const agents = {
      Poe: record('Poe'),
      CV: record('CV'),
      RQSupervisor: record('RQSupervisor'),
      'Novelty Checker': record('Novelty Checker'),
      'Edgar Allan': record('Edgar Allan'),
      p53: record('p53'),
    };
    const orch = createLoop1Orchestrator({ poe, console: con, agents, turngate: gate });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');

    expect(observed).toHaveLength(6);
    observed.forEach((o) => {
      expect(o.held).toBe(true);
      expect(o.by).toBe('Poe');
    });
    expect(gate.isHeld()).toBe(false);
  });

  it('releases the gate on an agent failure so the machine pauses cleanly', async () => {
    const gate = createTurnGate();
    const agents = {
      CV: async () => {
        throw new Error('cv offline');
      },
    };
    const orch = createLoop1Orchestrator({ poe, console: con, agents, turngate: gate, onError: () => {} });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');

    expect(orch.getState()).toBe(STATES.PAUSED);
    expect(gate.isHeld()).toBe(false); // no gate leak on failure
  });

  it('surfaces each validated packet to the IO panel packet sink when wired', async () => {
    const seen = [];
    const packet = { setPacket: (p) => seen.push(p.agentId) };
    const orch = createLoop1Orchestrator({ poe, console: con, packet });
    orch.mount(host);
    await orch.start();
    await orch.submit('q');
    expect(seen).toEqual(LINEAR_AGENTS);
  });
});
