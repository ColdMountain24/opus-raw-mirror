import { describe, expect, it, vi } from 'vitest';
import {
  createP53Agent,
  p53Agent,
  p53ResultSchema,
  defaultCoverage,
  P53_STATES,
  CONDITION_KEYS,
} from '../../../src/agents/loop2/p53.js';
import { createLoop2Orchestrator } from '../../../src/loops/loop2/orchestrator.js';

// p53 configured as the Loop 2 cessation controller at P53_EVALUATE. Deterministic (no
// dispatch): tests craft history + session and assert the conditions, the state, the
// routing, the unmet-condition reasons, and the MAX_REACHED overlay payload.

const plan = (ids = ['s1', 's2']) => ({
  state: 'FEARLESS_LEADER',
  agentId: 'Fearless Leader',
  packet: { agentId: 'Fearless Leader', result: { subspecializations: ids.map((id) => ({ id, name: id, query: id, grad_student_count: 1 })), rationale: 'r' } },
});

const claim = (id) => ({ claim_id: id, text: 't', claim_type: ['causal'], supporting_paper_dois: ['10.1/p'], confidence: null, salvia_status: 'valid', citation_boost_count: null });

// The staged SubspecializationKGs ride on the LAST packet carrying result.subspecializations
// (the Bookkeeper stage). claimsById: how many claims each staged subspecialization has.
const staged = (claimsById = { s1: 1, s2: 1 }) => ({
  state: 'BOOKKEEPER_STAGE',
  agentId: 'Bookkeeper',
  packet: {
    agentId: 'Bookkeeper',
    result: {
      subspecializations: Object.entries(claimsById).map(([id, n]) => ({
        subspecialization_id: id,
        claims: Array.from({ length: n }, (_v, i) => claim(`${id}-c${i}`)),
      })),
    },
  },
});

const salviaTurn = (uncertainty_level) => ({ state: 'UNKNOWN_FIELD_SURFACING', agentId: 'Salvia', packet: { agentId: 'Salvia', result: { uncertain_claims: [], unaddressed_rq_fields: [], uncertainty_level } } });
const revisionTurn = (contradictions = []) => ({ state: 'RQ_REVISION_CHECK', agentId: 'Revision Check', packet: { agentId: 'Revision Check', result: { contradictions, unknown_fields: [] } } });

// A history that reaches p53 with all four conditions clean.
const cleanHistory = () => [plan(['s1', 's2']), staged({ s1: 1, s2: 1 }), salviaTurn('low'), revisionTurn([])];

describe('p53 Loop 2 cessation controller', () => {
  it('CEASE when all conditions are met; routes to POSTDOC_FINAL, no overlay', async () => {
    const step = createP53Agent();
    const packet = await step({ session: {}, history: cleanHistory() });
    expect(packet.agentId).toBe('p53');
    expect(packet.result.state).toBe(P53_STATES.CEASE);
    expect(packet.result.conditions).toEqual({
      subspecializations_complete: true,
      uncertainty_acceptable: true,
      no_unresolved_contradictions: true,
      coverage_met: true,
    });
    expect(packet.control.transition).toBe('POSTDOC_FINAL');
    expect(packet.overlay).toBeUndefined();
    expect(p53ResultSchema(packet.result)).toBe(true);
  });

  it('CONTINUE when a condition is unmet and the cap is not reached; routes to PHASE_1', async () => {
    const step = createP53Agent({ maxIterations: 3 });
    // coverage gap: s2 staged with no claims
    const history = [plan(['s1', 's2']), staged({ s1: 1, s2: 0 }), salviaTurn('low'), revisionTurn([])];
    const packet = await step({ session: {}, history });
    expect(packet.result.state).toBe(P53_STATES.CONTINUE);
    expect(packet.result.conditions.coverage_met).toBe(false);
    expect(packet.control.transition).toBe('PHASE_1');
    expect(packet.overlay).toBeUndefined();
  });

  it('MAX_REACHED when the cap is reached with open issues; pauses and carries the reasons overlay', async () => {
    const step = createP53Agent({ maxIterations: 1 });
    // unmet: high uncertainty + a contradiction, cap reached on the first eval
    const history = [
      plan(['s1', 's2']),
      staged({ s1: 0, s2: 0 }),
      salviaTurn('high'),
      revisionTurn([{ claim_a_id: 's1-c0', claim_b_id: 's2-c0', nature: 'opposed' }]),
    ];
    const packet = await step({ session: {}, history });
    expect(packet.result.state).toBe(P53_STATES.MAX_REACHED);
    expect(packet.control.transition).toBe('PAUSED');
    expect(packet.overlay).toBeTruthy();
    expect(packet.overlay.tag).toBe('[MAX_REACHED]');
    // the specific reasons (coverage gaps, unresolved contradictions, uncertainty) are carried
    const reasonText = packet.result.reasons.join(' | ');
    expect(reasonText).toMatch(/coverage/i);
    expect(reasonText).toMatch(/contradiction/i);
    expect(reasonText).toMatch(/uncertainty/i);
    expect(packet.overlay.banners[0].reasons).toEqual(packet.result.reasons);
  });

  it('condition: all planned subspecializations must be staged', async () => {
    const step = createP53Agent();
    // s2 planned but not staged -> incomplete (and coverage gap)
    const history = [plan(['s1', 's2']), staged({ s1: 1 }), salviaTurn('low'), revisionTurn([])];
    const packet = await step({ session: {}, history });
    expect(packet.result.conditions.subspecializations_complete).toBe(false);
    expect(packet.result.reasons.join(' ')).toMatch(/1 of 2 planned subspecializations staged/);
  });

  it('condition: uncertainty low passes; medium needs acknowledgment; high fails', async () => {
    const step = createP53Agent();
    const base = [plan(['s1']), staged({ s1: 1 }), revisionTurn([])];
    const at = async (level, session = {}) => (await step({ session, history: [...base, salviaTurn(level)] })).result.conditions.uncertainty_acceptable;
    expect(await at('low')).toBe(true);
    expect(await at('medium')).toBe(false);
    expect(await at('medium', { researcherAcknowledged: true })).toBe(true);
    expect(await at('high', { researcherAcknowledged: true })).toBe(false);
  });

  it('condition: unresolved Skips contradictions block cessation (resolved ones do not)', async () => {
    const step = createP53Agent();
    const c = { claim_a_id: 'a', claim_b_id: 'b', nature: 'n' };
    const history = [plan(['s1']), staged({ s1: 1 }), salviaTurn('low'), revisionTurn([c])];
    expect((await step({ session: {}, history })).result.conditions.no_unresolved_contradictions).toBe(false);
    // a researcher-resolved contradiction (a::b) clears it
    expect((await step({ session: { resolvedContradictions: ['a::b'] }, history })).result.conditions.no_unresolved_contradictions).toBe(true);
  });

  it('condition: GlobalKG coverage compares the (injectable) metric against the (injectable) threshold', async () => {
    // default metric = fraction of planned subspecializations with >=1 staged claim
    expect(defaultCoverage({ plannedIds: new Set(['s1', 's2']), stagedKGs: [{ subspecialization_id: 's1', claims: [claim('x')] }] })).toBe(0.5);
    const step = createP53Agent({ coverageThreshold: 0.4, computeCoverage: () => 0.5 });
    const history = [plan(['s1', 's2']), staged({ s1: 1, s2: 1 }), salviaTurn('low'), revisionTurn([])];
    const packet = await step({ session: {}, history });
    expect(packet.result.coverage).toBe(0.5);
    expect(packet.result.conditions.coverage_met).toBe(true); // 0.5 >= 0.4
  });

  it('counts an iteration per p53 evaluation and respects a custom cap', async () => {
    const step = createP53Agent({ maxIterations: 2 });
    const priorP53 = { state: 'P53_EVALUATE', agentId: 'p53', packet: { agentId: 'p53', result: {} } };
    // one prior p53 entry -> this is iteration 2 -> cap reached
    const history = [plan(['s1']), staged({ s1: 0 }), salviaTurn('high'), revisionTurn([]), priorP53];
    const packet = await step({ session: {}, history });
    expect(packet.result.iteration).toBe(2);
    expect(packet.result.max_iterations).toBe(2);
    expect(packet.result.state).toBe(P53_STATES.MAX_REACHED);
  });

  it('is deterministic: needs no dispatch and is the default singleton', async () => {
    const dispatch = vi.fn();
    const packet = await p53Agent({ session: {}, history: cleanHistory(), dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(packet.agentId).toBe('p53');
    expect(CONDITION_KEYS).toHaveLength(4);
  });

  it('schema rejects off-contract results', () => {
    expect(p53ResultSchema({ state: 'CEASE', conditions: {}, coverage: 0.5, iteration: 1, max_iterations: 3, reasons: [] })).toBe(false); // missing condition keys
    expect(p53ResultSchema({ state: 'NOPE', conditions: { subspecializations_complete: true, uncertainty_acceptable: true, no_unresolved_contradictions: true, coverage_met: true }, coverage: 0.5, iteration: 1, max_iterations: 3, reasons: [] })).toBe(false); // bad state
    expect(p53ResultSchema({ state: 'CEASE', conditions: { subspecializations_complete: true, uncertainty_acceptable: true, no_unresolved_contradictions: true, coverage_met: true }, coverage: 2, iteration: 1, max_iterations: 3, reasons: [] })).toBe(false); // coverage out of range
  });
});

// ----- orchestrator integration -----

function fakePoe() {
  const calls = { receive: [], settle: [], milestoneCard: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    milestoneCard: vi.fn((spec) => calls.milestoneCard.push(spec)),
    stream: vi.fn(),
    showThinking: vi.fn(),
  };
}

// Stubs that seed the conditions p53 reads, so the chain reaches P53_EVALUATE with real data.
const fearlessStub = async () => ({ agentId: 'Fearless Leader', content: 'plan', result: { subspecializations: [{ id: 's1', name: 's1', query: 's1', grad_student_count: 1 }], rationale: 'r' }, control: {} });
const gradStub = async ({ state }) => (state === 'PHASE_2'
  ? { agentId: 'Grad Students', content: 'p2', result: { subspecializations: [] }, control: {} }
  : { agentId: 'Grad Students', content: 'p1', result: { subspecializations: [{ subspecialization_id: 's1', claims: [{ claim_id: 's1-c0', text: 't' }] }] }, control: {} });
const salviaStub = (level) => async () => ({ agentId: 'Salvia', content: 'u', result: { uncertain_claims: [], unaddressed_rq_fields: [], uncertainty_level: level }, control: {} });
const revisionStub = async () => ({ agentId: 'Revision Check', content: 'rc', result: { contradictions: [], unknown_fields: [] }, control: {} });

describe('p53 in the orchestrator (backstage at P53_EVALUATE)', () => {
  it('CEASE: settles backstage and routes the chain to POSTDOC_FINAL then COMPLETE', async () => {
    const poe = fakePoe();
    const seen = [];
    const orch = createLoop2Orchestrator({
      poe,
      packet: { setPacket: (p) => seen.push(p) },
      storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } },
      agents: {
        'Fearless Leader': fearlessStub,
        'Grad Students': gradStub,
        Salvia: salviaStub('low'),
        'Revision Check': revisionStub,
        p53: createP53Agent({ coverageThreshold: 0.5 }),
      },
    });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    const p53Packet = seen.find((p) => p.agentId === 'p53');
    expect(p53Packet).toBeTruthy();
    expect(p53Packet.result.state).toBe(P53_STATES.CEASE);
    expect(poe.calls.settle).toContain('p53'); // backstage
    expect(poe.calls.receive.map((p) => p.agentId)).not.toContain('p53');
    expect(orch.getState()).toBe('COMPLETE');
  });

  it('MAX_REACHED: surfaces the reasons through Poe (milestoneCard) with an Acknowledge CTA, and pauses', async () => {
    const poe = fakePoe();
    const orch = createLoop2Orchestrator({
      poe,
      packet: { setPacket: () => {} },
      storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } },
      agents: {
        'Fearless Leader': fearlessStub,
        'Grad Students': gradStub,
        Salvia: salviaStub('high'), // unmet -> with cap 1, first eval is MAX_REACHED
        'Revision Check': revisionStub,
        p53: createP53Agent({ maxIterations: 1, coverageThreshold: 0.99 }),
      },
    });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(orch.getState()).toBe('PAUSED');
    const maxCard = poe.calls.milestoneCard.find((s) => s.tag === '[MAX_REACHED]');
    expect(maxCard).toBeTruthy();
    expect(maxCard.banners[0].reasons.length).toBeGreaterThan(0);
    expect(typeof maxCard.cta.onClick).toBe('function'); // orchestrator-injected Acknowledge CTA
    expect(maxCard.cta.label).toBe('Acknowledge and continue');

    // acknowledging resumes the run toward cessation (POSTDOC_FINAL -> ... -> COMPLETE)
    await maxCard.cta.onClick();
    expect(orch.getState()).toBe('COMPLETE');
  });
});
