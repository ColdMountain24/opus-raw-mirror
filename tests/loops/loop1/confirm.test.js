import { describe, expect, it, vi } from 'vitest';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';
import { createP53Agent } from '../../../src/loops/loop1/agents/p53.js';

// The researcher-confirmation flow: after a passing review cycle the machine rests at
// POE_INTAKE; the composer surfaces Confirm only then; confirm() sets the flag and
// routes to p53, which ceases.

function fakePoe() {
  const calls = { receive: [], settle: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn(),
    showThinking: vi.fn(),
  };
}

// Backstage agents that produce a PASSING review cycle in history.
const passingAgents = (extra = {}) => ({
  Poe: async () => ({ agentId: 'Poe', content: 'a question', control: {} }),
  CV: async () => ({ agentId: 'CV', result: { status: 'pass', score: 1, blocking_fields: [] }, control: {} }),
  RQSupervisor: async () => ({
    agentId: 'RQSupervisor',
    result: { approved: true, paradigm: 'clinical', feedback: [], revision_required: false },
    control: {},
  }),
  'Novelty Checker': async () => ({
    agentId: 'Novelty Checker',
    result: { novelty_signal: 'high', rationale: 'novel', overlapping_papers: [] },
    control: { transition: STATES.P53_EVALUATE },
  }),
  ...extra,
});

describe('researcher confirmation', () => {
  it('rests at POE_INTAKE after a passing cycle, exposes confirm, then ceases on confirm()', async () => {
    const emitted = [];
    const composerStates = [];
    const p53 = createP53Agent({ output: (rq) => emitted.push(rq) });
    const orch = createLoop1Orchestrator({
      poe: fakePoe(),
      agents: passingAgents({ p53 }),
      onComposer: (s) => composerStates.push(s),
    });
    orch.mount(document.createElement('div'));
    await orch.start();
    // A complete packet so that, post-confirm, nothing else blocks (p53 only checks
    // its own conditions; the RQPacket is what gets emitted).
    orch.getSession().rqPacket = { version: 1 };

    await orch.submit('Does fasting improve memory?');

    // p53 CONTINUEs (not confirmed), so the machine waits at POE_INTAKE.
    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    // The latest review passed, so confirm is available.
    expect(orch.canConfirm()).toBe(true);
    expect(composerStates.at(-1)).toEqual({ awaitingInput: true, canConfirm: true, locked: false });
    expect(emitted).toEqual([]); // nothing ceased yet

    await orch.confirm();

    expect(orch.getSession().researcherConfirmed).toBe(true);
    expect(orch.getState()).toBe(STATES.COMPLETE);
    expect(emitted).toEqual([{ version: 1 }]); // p53 ceased and emitted the RQPacket
    // The composer is now locked.
    expect(composerStates.at(-1)).toEqual({ awaitingInput: false, canConfirm: false, locked: true });
  });

  it('confirm is not available, and confirm() throws, when the latest review has not passed', async () => {
    // CV fails, routing back to Poe; the question has not passed review.
    const agents = passingAgents({
      CV: async () => ({
        agentId: 'CV',
        result: { status: 'fail', score: 0.4, blocking_fields: ['the population'] },
        control: { transition: STATES.POE_INTAKE },
      }),
    });
    const orch = createLoop1Orchestrator({ poe: fakePoe(), agents });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('half an idea');

    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    expect(orch.canConfirm()).toBe(false);
    await expect(orch.confirm()).rejects.toThrow(/has not passed review/);
  });

  it('confirm() is rejected when not awaiting intake', async () => {
    const orch = createLoop1Orchestrator({ poe: fakePoe() });
    orch.mount(document.createElement('div'));
    // Before start: not awaiting.
    await expect(orch.confirm()).rejects.toThrow(/awaiting intake/);
  });

  it('disables the composer the instant a turn starts processing (no mid-chain submit)', async () => {
    // Regression: the composer stayed enabled while a turn was processing, so the
    // researcher could submit again mid-chain and hit a non-POE_INTAKE state error.
    const composerStates = [];
    const orch = createLoop1Orchestrator({
      poe: fakePoe(),
      agents: passingAgents({ p53: createP53Agent({ output: () => {} }) }),
      onComposer: (s) => composerStates.push(s),
    });
    orch.mount(document.createElement('div'));
    await orch.start();
    composerStates.length = 0; // ignore the initial enable

    await orch.submit('a question');
    // submit() disables the composer first thing (so a second submit cannot fire)...
    expect(composerStates[0]).toMatchObject({ awaitingInput: false });
    // ...and it rests re-enabled once the cycle returns to Poe.
    expect(composerStates.at(-1)).toMatchObject({ awaitingInput: true });
  });
});
