import { describe, expect, it, vi } from 'vitest';
import { createLoop2Orchestrator, STATES } from '../../../src/loops/loop2/orchestrator.js';

// The unknown-field surfacing loop (orchestrator-owned). When the surfacing state (Salvia) reports
// unknown RQ fields - its unaddressed_rq_fields UNION Skips' unknown_fields (Revision Check) - and the
// iteration cap is not hit, the orchestrator re-sweeps via Fearless Leader (targeting them) and tracks
// the count in its own state; once clear or capped it falls through to P53_EVALUATE. Tests drive the
// real orchestrator with injected stubs (mirroring the salvia/p53 integration style).

function fakePoe() {
  const calls = { receive: [], settle: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    milestoneCard: vi.fn(),
    stream: vi.fn(),
    showThinking: vi.fn(),
  };
}

const storage = () => ({ session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } });

// Stubs. Fearless Leader records the staged unknown-field context it is handed each run.
function fearlessRecorder(seenContext) {
  return async (ctx) => {
    seenContext.push(ctx.session ? ctx.session.unknownFields : undefined);
    return { agentId: 'Fearless Leader', content: 'plan', result: { subspecializations: [{ id: 's1', name: 's1', query: 's1', grad_student_count: 1 }], rationale: 'r' }, control: {} };
  };
}
const salviaStub = (unaddressed_rq_fields) => async () => ({ agentId: 'Salvia', content: 'u', result: { uncertain_claims: [], unaddressed_rq_fields, uncertainty_level: 'low' }, control: {} });
const revisionStub = (unknown_fields) => async () => ({ agentId: 'Revision Check', content: 'rc', result: { contradictions: [], unknown_fields }, control: {} });

function buildOrch({ salviaFields = [], skipsFields = [], maxUnknownFieldIterations, onIteration, events } = {}) {
  const seenContext = [];
  const orch = createLoop2Orchestrator({
    poe: fakePoe(),
    packet: { setPacket: () => {} },
    storage: storage(),
    maxUnknownFieldIterations,
    onIteration,
    logger: events ? (e) => events.push(e) : undefined,
    agents: {
      'Fearless Leader': fearlessRecorder(seenContext),
      Salvia: salviaStub(salviaFields),
      'Revision Check': revisionStub(skipsFields),
    },
  });
  return { orch, seenContext };
}

describe('unknown-field surfacing loop (orchestrator-owned)', () => {
  it('re-sweeps via Fearless Leader when fields remain, then caps and falls through to p53', async () => {
    const onIteration = vi.fn();
    const events = [];
    const { orch, seenContext } = buildOrch({ salviaFields: ['mechanism'], maxUnknownFieldIterations: 1, onIteration, events });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    // one re-sweep (cap 1), then capped -> forward to p53 -> COMPLETE
    expect(orch.getUnknownFieldIterations()).toBe(1);
    expect(onIteration).toHaveBeenCalledTimes(1);
    expect(onIteration).toHaveBeenCalledWith({ iteration: 1, max: 1, fields: ['mechanism'] });
    expect(orch.getState()).toBe(STATES.COMPLETE);
    // the orchestrator staged the fields as Fearless Leader context for the re-sweep
    expect(seenContext).toContainEqual(['mechanism']);
    // events: one re-sweep, one cap_reached
    expect(events.filter((e) => e.type === 'unknownfield:resweep')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'unknownfield:cap_reached')).toHaveLength(1);
  });

  it('forwards straight to p53 (no loop) when there are no unknown fields', async () => {
    const onIteration = vi.fn();
    const { orch } = buildOrch({ salviaFields: [], skipsFields: [], onIteration });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(orch.getUnknownFieldIterations()).toBe(0);
    expect(onIteration).not.toHaveBeenCalled();
    expect(orch.getState()).toBe(STATES.COMPLETE);
  });

  it("Skips' unknown_fields alone trigger the loop (union source), even when Salvia's are empty", async () => {
    const onIteration = vi.fn();
    const { orch } = buildOrch({ salviaFields: [], skipsFields: ['dosage'], maxUnknownFieldIterations: 1, onIteration });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(onIteration).toHaveBeenCalledTimes(1);
    expect(onIteration).toHaveBeenCalledWith({ iteration: 1, max: 1, fields: ['dosage'] });
    expect(orch.getState()).toBe(STATES.COMPLETE);
  });

  it('respects the cap: with the loop disabled (cap 0) it never re-sweeps', async () => {
    const onIteration = vi.fn();
    const { orch } = buildOrch({ salviaFields: ['mechanism'], maxUnknownFieldIterations: 0, onIteration });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(orch.getUnknownFieldIterations()).toBe(0);
    expect(onIteration).not.toHaveBeenCalled();
    expect(orch.getState()).toBe(STATES.COMPLETE);
  });

  it('resets the iteration counter on (re-)mount', async () => {
    const { orch } = buildOrch({ salviaFields: ['mechanism'], maxUnknownFieldIterations: 2 });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();
    expect(orch.getUnknownFieldIterations()).toBe(2);
    await orch.mount(document.createElement('div'));
    expect(orch.getUnknownFieldIterations()).toBe(0);
  });
});
