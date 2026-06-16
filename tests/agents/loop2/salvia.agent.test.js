import { describe, expect, it, vi } from 'vitest';
import {
  createSalviaAgent,
  salviaResultSchema,
  scanForUncertainty,
  readSubspecializationKGs,
  UNCERTAINTY_LEVELS,
  EXTRACTION_TIER,
} from '../../../src/agents/loop2/salvia.js';
import { SALVIA_SYSTEM_PROMPT } from '../../../src/agents/loop2/prompts.js';
import { createLoop2Orchestrator } from '../../../src/loops/loop2/orchestrator.js';

// Salvia, the Loop 2 uncertainty surveyor at UNKNOWN_FIELD_SURFACING. Reads the staged
// SubspecializationKGs + the RQPacket and returns { uncertain_claims, unaddressed_rq_fields,
// uncertainty_level }, which feeds p53. Tests inject a fake dispatch and craft a history.

const claim = (over = {}) => ({
  claim_id: 'c1',
  text: 'Fasting aids memory',
  claim_type: ['causal'],
  supporting_paper_dois: ['10.1/p'],
  confidence: null,
  salvia_status: 'valid',
  citation_boost_count: null,
  quality_review: { quality: 'pass', reason: 'ok' },
  ...over,
});

const kg = (over = {}) => ({
  subspecialization_id: 'subspec-1',
  subspecialization_label: 'Cognitive aging',
  claims: [claim()],
  ...over,
});

function historyWith(subspecializations, state = 'BOOKKEEPER_STAGE', agentId = 'Bookkeeper') {
  return [{ state, agentId, packet: { agentId, result: { subspecializations } } }];
}

const okResult = { uncertain_claims: [], unaddressed_rq_fields: [], uncertainty_level: 'low' };

function fakePoe() {
  const calls = { settle: [], receive: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((a) => calls.settle.push(a)),
    stream: vi.fn(),
    showThinking: vi.fn(),
    milestoneCard: vi.fn(),
  };
}

describe('Salvia Loop 2 uncertainty surveyor', () => {
  it('runs on the extraction tier, attributed to Salvia, with the schema + on-contract safe default', async () => {
    const dispatch = vi.fn(async () => okResult);
    const salvia = createSalviaAgent({ dispatch });
    const packet = await salvia({ history: historyWith([kg()]), session: { rqPacket: { version: 4 } } });

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Salvia');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.schema).toBe(salviaResultSchema);
    expect(salviaResultSchema(spec.safeDefault)).toBe(true);

    expect(packet.agentId).toBe('Salvia');
    expect(salviaResultSchema(packet.result)).toBe(true);
    expect(packet.control).toEqual({});
  });

  it('sends the Salvia prompt, the SubspecializationKG claims, and the RQPacket', async () => {
    const dispatch = vi.fn(async () => okResult);
    const salvia = createSalviaAgent({ dispatch });
    await salvia({
      history: historyWith([kg({ claims: [claim({ claim_id: 'cX', text: 'Claim X text' })] })]),
      session: { rqPacket: { version: 5, shape: 'opaque' } },
    });
    const spec = dispatch.mock.calls[0][0];
    expect(spec.messages[0]).toEqual({ role: 'system', content: SALVIA_SYSTEM_PROMPT });
    const user = spec.messages.find((m) => m.role === 'user');
    expect(user.content).toContain('cX');
    expect(user.content).toContain('Claim X text');
    expect(user.content).toContain('"shape": "opaque"');
    expect(user.content).toContain('Cognitive aging');
  });

  it('unions the deterministic flagged claims with the model uncertain claims (a flag is never missed)', async () => {
    // c1 is quality-flagged (deterministic); the model only reports c2 (a conflict it judged).
    const claims = [
      claim({ claim_id: 'c1', quality_review: { quality: 'flag', reason: 'weak' } }),
      claim({ claim_id: 'c2', quality_review: { quality: 'pass', reason: 'ok' } }),
    ];
    const dispatch = vi.fn(async () => ({ uncertain_claims: ['c2'], unaddressed_rq_fields: ['mechanism'], uncertainty_level: 'medium' }));
    const salvia = createSalviaAgent({ dispatch });
    const packet = await salvia({ history: historyWith([kg({ claims })]) });
    expect(packet.result.uncertain_claims.sort()).toEqual(['c1', 'c2']);
    expect(packet.result.unaddressed_rq_fields).toEqual(['mechanism']);
    expect(packet.result.uncertainty_level).toBe('medium');
  });

  it('filters claim_ids the model invented (keeps only ids present in the KGs)', async () => {
    const dispatch = vi.fn(async () => ({ uncertain_claims: ['c1', 'ghost'], unaddressed_rq_fields: [], uncertainty_level: 'low' }));
    const salvia = createSalviaAgent({ dispatch });
    const packet = await salvia({ history: historyWith([kg({ claims: [claim({ claim_id: 'c1' })] })]) });
    expect(packet.result.uncertain_claims).toEqual(['c1']); // 'ghost' dropped
  });

  it('falls back to the deterministic scan when the dispatcher returns the safe default', async () => {
    const claims = [
      claim({ claim_id: 'c1', quality_review: { quality: 'flag', reason: 'weak' } }),
      claim({ claim_id: 'c2', salvia_status: 'flagged' }),
      claim({ claim_id: 'c3' }),
    ];
    const salvia = createSalviaAgent({ dispatch: vi.fn(async (spec) => spec.safeDefault) });
    const packet = await salvia({ history: historyWith([kg({ claims })]) });
    expect(packet.result.uncertain_claims.sort()).toEqual(['c1', 'c2']); // both flagged signals
    expect(packet.result.uncertainty_level).toBe('high'); // 2/3 flagged
  });

  it('falls back to the safe default on an off-contract model result', async () => {
    const salvia = createSalviaAgent({ dispatch: vi.fn(async () => ({ uncertainty_level: 'nope' })) });
    const packet = await salvia({ history: historyWith([kg()]) });
    expect(salviaResultSchema(packet.result)).toBe(true);
  });
});

describe('scanForUncertainty + salviaResultSchema + readSubspecializationKGs', () => {
  it('detects flagged claims via quality_review and salvia_status, and grades the level', () => {
    expect(scanForUncertainty([kg({ claims: [claim(), claim({ claim_id: 'c2' })] })]).uncertainty_level).toBe('low'); // none flagged
    const some = scanForUncertainty([
      kg({ claims: [claim({ claim_id: 'a', quality_review: { quality: 'flag', reason: 'r' } }), claim({ claim_id: 'b' }), claim({ claim_id: 'c' }), claim({ claim_id: 'd' })] }),
    ]);
    expect(some.uncertain_claims).toEqual(['a']);
    expect(some.uncertainty_level).toBe('medium'); // 1/4
    const lots = scanForUncertainty([kg({ claims: [claim({ claim_id: 'a', salvia_status: 'flagged' }), claim({ claim_id: 'b', salvia_status: 'flagged' })] })]);
    expect(lots.uncertainty_level).toBe('high'); // 2/2
  });

  it('grades an empty sweep as high uncertainty', () => {
    expect(scanForUncertainty([]).uncertainty_level).toBe('high');
    expect(scanForUncertainty([kg({ claims: [] })]).uncertainty_level).toBe('high');
  });

  it('salviaResultSchema accepts the contract and rejects off-contract values', () => {
    expect(salviaResultSchema(okResult)).toBe(true);
    expect(salviaResultSchema({ uncertain_claims: ['c1'], unaddressed_rq_fields: ['x'], uncertainty_level: 'high' })).toBe(true);
    expect(salviaResultSchema(null)).toBe(false);
    expect(salviaResultSchema({ uncertain_claims: 'x', unaddressed_rq_fields: [], uncertainty_level: 'low' })).toBe(false);
    expect(salviaResultSchema({ uncertain_claims: [], unaddressed_rq_fields: [1], uncertainty_level: 'low' })).toBe(false);
    expect(salviaResultSchema({ uncertain_claims: [], unaddressed_rq_fields: [], uncertainty_level: 'maybe' })).toBe(false);
    expect(UNCERTAINTY_LEVELS).toEqual(['low', 'medium', 'high']);
  });

  it('reads the most recent SubspecializationKGs (Bookkeeper stage supersedes PHASE_1)', () => {
    const phase1 = kg({ subspecialization_id: 'p1' });
    const staged = kg({ subspecialization_id: 'staged' });
    const history = [
      { state: 'PHASE_1', agentId: 'Grad Students', packet: { result: { subspecializations: [phase1] } } },
      { state: 'BOOKKEEPER_STAGE', agentId: 'Bookkeeper', packet: { result: { subspecializations: [staged] } } },
    ];
    expect(readSubspecializationKGs(history)[0].subspecialization_id).toBe('staged');
    expect(readSubspecializationKGs([])).toEqual([]);
  });
});

describe('Salvia in the orchestrator (backstage at UNKNOWN_FIELD_SURFACING)', () => {
  it('settles to the IO panel (never the conversation) and produces an uncertainty result', async () => {
    const poe = fakePoe();
    const seen = [];
    const salviaDispatch = vi.fn(async () => ({ uncertain_claims: ['c1'], unaddressed_rq_fields: ['mechanism'], uncertainty_level: 'medium' }));
    // A Grad Students stub seeds PHASE_1 subspecializations so the chain has KGs for Salvia to scan.
    const gradStub = async ({ state }) =>
      state === 'PHASE_2'
        ? { agentId: 'Grad Students', content: 'p2', result: { subspecializations: [] }, control: {} }
        : { agentId: 'Grad Students', content: 'p1', result: { subspecializations: [kg({ claims: [claim({ claim_id: 'c1' })] })] }, control: {} };

    const orch = createLoop2Orchestrator({
      poe,
      agents: { 'Grad Students': gradStub, Salvia: createSalviaAgent({ dispatch: salviaDispatch }) },
      packet: { setPacket: (p) => seen.push(p) },
      storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } },
      // This test pins Salvia's BACKSTAGE behavior; disable the unknown-field re-sweep loop so
      // Salvia's unaddressed_rq_fields don't route the machine into a Fearless Leader re-sweep
      // (the loop itself is covered in the orchestrator suite).
      maxUnknownFieldIterations: 0,
    });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(poe.calls.settle).toContain('Salvia');
    expect(poe.calls.receive.map((p) => p.agentId)).not.toContain('Salvia'); // backstage
    const salviaPacket = seen.find((p) => p.agentId === 'Salvia');
    expect(salviaPacket).toBeTruthy();
    expect(salviaResultSchema(salviaPacket.result)).toBe(true);
    expect(salviaPacket.result.uncertain_claims).toContain('c1');
  });
});
