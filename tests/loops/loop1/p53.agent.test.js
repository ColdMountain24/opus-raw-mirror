import { describe, expect, it, vi } from 'vitest';
import { createP53Agent, p53ResultSchema, P53_STATES } from '../../../src/loops/loop1/agents/p53.js';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';

// p53 configured as the Loop 1 cessation controller. It is deterministic (no
// dispatch): tests craft history + session and assert the state, routing, and the
// output-hook emission.

const cvPass = { agentId: 'CV', packet: { result: { status: 'pass', score: 1, blocking_fields: [] } } };
const rqOk = {
  agentId: 'RQSupervisor',
  packet: { result: { approved: true, paradigm: 'clinical', feedback: [], revision_required: false } },
};
const noveltyRan = {
  agentId: 'Novelty Checker',
  packet: { result: { novelty_signal: 'high', rationale: 'x', overlapping_papers: [] } },
};
const poeTurn = { agentId: 'Poe', packet: { agentId: 'Poe', content: 'q' } };

// History reaching p53 after one round, all reviewers passed.
const reachedHistory = () => [poeTurn, cvPass, rqOk, noveltyRan];

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

describe('p53 Loop 1 cessation controller', () => {
  it('CONTINUE when the researcher has not confirmed; routes back to Poe', async () => {
    const step = createP53Agent();
    const packet = await step({ session: { rqPacket: { version: 1 }, researcherConfirmed: false }, history: reachedHistory() });
    expect(packet.result.state).toBe(P53_STATES.CONTINUE);
    expect(packet.result.conditions).toEqual({
      cv_passed: true,
      rq_approved: true,
      novelty_ran: true,
      researcher_confirmed: false,
    });
    expect(packet.control).toEqual({ transition: STATES.POE_INTAKE });
    expect(packet.agentId).toBe('p53');
  });

  it('CEASE when all conditions are met; emits the completed RQPacket to the output hook and completes', async () => {
    const emitted = [];
    const step = createP53Agent({ output: (rq) => emitted.push(rq) });
    const session = { rqPacket: { version: 4 }, researcherConfirmed: true };
    const packet = await step({ session, history: reachedHistory() });

    expect(packet.result.state).toBe(P53_STATES.CEASE);
    expect(packet.control).toEqual({ transition: STATES.COMPLETE });
    expect(packet.rqPacket).toEqual({ version: 4 });
    expect(emitted).toEqual([{ version: 4 }]); // emitted to the output hook
  });

  it('on CEASE forwards the run context (question + history) to the output hook', async () => {
    const calls = [];
    const step = createP53Agent({ output: (rq, meta) => calls.push({ rq, meta }) });
    const session = {
      rqPacket: { version: 4 },
      researcherConfirmed: true,
      researchQuestion: 'Does fasting improve memory in older adults?',
    };
    const history = reachedHistory();
    await step({ session, history });

    expect(calls).toHaveLength(1);
    expect(calls[0].rq).toEqual({ version: 4 }); // RQPacket stays the first argument
    // p53 forwards the question and the history; the Output Hook derives the trust
    // layer (paradigm, novelty, confidence) from history via trust.js.
    expect(calls[0].meta.researchQuestion).toBe('Does fasting improve memory in older adults?');
    expect(calls[0].meta.history).toEqual(history);
  });

  it('CONTINUE when a reviewer condition is not met (CV did not pass)', async () => {
    const step = createP53Agent();
    const history = [poeTurn, rqOk, noveltyRan]; // no CV pass
    const packet = await step({ session: { researcherConfirmed: true }, history });
    expect(packet.result.conditions.cv_passed).toBe(false);
    expect(packet.result.state).toBe(P53_STATES.CONTINUE);
    expect(packet.control).toEqual({ transition: STATES.POE_INTAKE });
  });

  it('MAX_REACHED is a warning, not a stop: routes through Poe and never cascades directly to CEASE', async () => {
    // Cap of 2; two Poe turns in history reaches the cap. All conditions are also
    // met, but p53 must still emit MAX_REACHED first, not CEASE.
    const emitted = [];
    const step = createP53Agent({ maxIterations: 2, output: (rq) => emitted.push(rq) });
    const session = { rqPacket: { version: 7 }, researcherConfirmed: true };
    const history = [poeTurn, poeTurn, cvPass, rqOk, noveltyRan];

    const first = await step({ session, history });
    expect(first.result.state).toBe(P53_STATES.MAX_REACHED);
    expect(first.control).toEqual({ transition: STATES.POE_INTAKE }); // routed through Poe, not ceased
    expect(first.warning).toMatchObject({ kind: 'max_reached', iteration: 2, max_iterations: 2 });
    expect(emitted).toEqual([]); // nothing emitted: it did NOT cease
    expect(session.maxWarningSurfaced).toBe(true);

    // After the warning has been surfaced, a later evaluation may CEASE.
    const second = await step({ session, history });
    expect(second.result.state).toBe(P53_STATES.CEASE);
    expect(second.control).toEqual({ transition: STATES.COMPLETE });
    expect(emitted).toEqual([{ version: 7 }]);
  });

  it('p53ResultSchema accepts the contract and rejects off-contract values', () => {
    const ok = {
      state: 'CEASE',
      conditions: { cv_passed: true, rq_approved: true, novelty_ran: true, researcher_confirmed: true },
    };
    expect(p53ResultSchema(ok)).toBe(true);
    expect(p53ResultSchema({ ...ok, state: 'STOP' })).toBe(false);
    expect(p53ResultSchema({ state: 'CEASE', conditions: { cv_passed: true } })).toBe(false);
    expect(p53ResultSchema({ state: 'CEASE', conditions: { cv_passed: 'yes', rq_approved: true, novelty_ran: true, researcher_confirmed: true } })).toBe(false);
    expect(p53ResultSchema({ state: 'CONTINUE' })).toBe(false);
    expect(p53ResultSchema(null)).toBe(false);
  });

  it('in the orchestrator: backstage (settles, no conversation card), CONTINUE routes to POE_INTAKE', async () => {
    // Real p53 at P53_EVALUATE via a control hint from a stub upstream chain; no
    // confirmation, so it CONTINUEs back to Poe.
    const p53 = createP53Agent();
    const seen = [];
    const poe = fakePoe();
    const orch = createLoop1Orchestrator({
      poe,
      agents: { p53 },
      packet: { setPacket: (p) => seen.push(p) },
    });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('q'); // stub chain reaches p53; p53 CONTINUE -> POE_INTAKE -> waits

    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    expect(poe.calls.settle).toContain('p53');
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']); // p53 not in the conversation
    expect(seen.find((p) => p.agentId === 'p53')).toBeTruthy();
  });
});
