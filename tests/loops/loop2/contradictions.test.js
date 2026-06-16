import { describe, expect, it, vi } from 'vitest';
import {
  createContradictionSurfacer,
  readContradictions,
  enrichContradictions,
  contradictionKey,
  pendingContradictions,
  escalatedFrom,
} from '../../../src/loops/loop2/contradictions.js';
import { createLoop2Orchestrator } from '../../../src/loops/loop2/orchestrator.js';

// MATERIAL_CONTRADICTIONS: Poe surfaces the cross-subspecialization contradictions Skips found (carried on
// the Revision Check packet) for resolution (resolved / unresolved / escalated) BEFORE the GlobalKG promotion.

function historyWithContradictions(contradictions) {
  return [{ state: 'RQ_REVISION_CHECK', agentId: 'Revision Check', packet: { agentId: 'Revision Check', result: { contradictions } } }];
}

describe('contradiction surfacer', () => {
  it('surfaces a lead-in attributed to Poe (the conversation writer), carrying the raw contradictions', async () => {
    const surface = createContradictionSurfacer();
    const packet = await surface({
      history: historyWithContradictions([{ claim_a_id: 'cA', claim_b_id: 'cB', nature: 'A says up, B says down' }]),
    });
    expect(packet.agentId).toBe('Poe');
    expect(packet.content).toContain('1 material');
    expect(packet.result.contradictions).toHaveLength(1);
    expect(packet.contradictions).toHaveLength(1);
  });

  it('states plainly when there are no contradictions', async () => {
    const surface = createContradictionSurfacer();
    const packet = await surface({ history: [] });
    expect(packet.agentId).toBe('Poe');
    expect(packet.content).toContain('No material');
    expect(packet.result.contradictions).toEqual([]);
  });

  it('readContradictions reads the latest contradictions packet', () => {
    const c = [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }];
    expect(readContradictions(historyWithContradictions(c))).toEqual(c);
    expect(readContradictions([])).toEqual([]);
  });
});

// ----- pure resolution helpers -----

describe('enrichContradictions', () => {
  it('resolves the paper sources + text + subspecialization on each side from the staged KGs', () => {
    const stagedKGs = [
      { subspecialization_id: 's1', claims: [{ claim_id: 'a', text: 'A', supporting_paper_dois: ['10/a'] }] },
      { subspecialization_id: 's2', claims: [{ claim_id: 'b', text: 'B', supporting_paper_dois: ['10/b1', '10/b2'] }] },
    ];
    const [e] = enrichContradictions({ contradictions: [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }], stagedKGs });
    expect(e.side_a).toEqual({ claim_id: 'a', text: 'A', paper_dois: ['10/a'], subspecialization_id: 's1' });
    expect(e.side_b.paper_dois).toEqual(['10/b1', '10/b2']);
    expect(e.side_b.subspecialization_id).toBe('s2');
  });

  it('falls back to the claim id (no sources) when a side is not in the staged KGs', () => {
    const [e] = enrichContradictions({ contradictions: [{ claim_a_id: 'x', claim_b_id: 'y', nature: 'n' }], stagedKGs: [] });
    expect(e.side_a).toEqual({ claim_id: 'x', text: '', paper_dois: [], subspecialization_id: '' });
  });

  it('drops a malformed pair (missing claim ids)', () => {
    expect(enrichContradictions({ contradictions: [{ claim_a_id: 'a' }], stagedKGs: [] })).toEqual([]);
  });
});

describe('contradictionKey / pendingContradictions / escalatedFrom', () => {
  it('contradictionKey is the directed claim_a::claim_b pair', () => {
    expect(contradictionKey({ claim_a_id: 'a', claim_b_id: 'b' })).toBe('a::b');
  });

  it('pendingContradictions filters out decided pairs', () => {
    const enriched = [{ claim_a_id: 'a', claim_b_id: 'b' }, { claim_a_id: 'c', claim_b_id: 'd' }];
    const pending = pendingContradictions(enriched, { 'a::b': { status: 'resolved' } });
    expect(pending.map((c) => c.claim_a_id)).toEqual(['c']);
  });

  it('escalatedFrom returns only the escalated pairs', () => {
    const enriched = [{ claim_a_id: 'a', claim_b_id: 'b' }, { claim_a_id: 'c', claim_b_id: 'd' }];
    const esc = escalatedFrom(enriched, { 'a::b': { status: 'escalated' }, 'c::d': { status: 'unresolved' } });
    expect(esc.map((c) => c.claim_a_id)).toEqual(['a']);
  });
});

// ----- the material-contradictions resolution wired into the orchestrator (at MATERIAL_CONTRADICTIONS) -----

function fakePoe() {
  return {
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn(),
    settle: vi.fn(),
    stream: vi.fn(),
    showThinking: vi.fn(),
    milestoneCard: vi.fn(),
    hideOverlay: vi.fn(),
  };
}

// Drive the default-stub chain to MATERIAL_CONTRADICTIONS, injecting a 'Poe' step (the MATERIAL_CONTRADICTIONS
// agent) that carries the contradictions to surface; extra agents (e.g. a Bookkeeper that stages claims so the
// enrichment resolves paper sources) and orchestrator deps pass through.
async function runToMaterialContradictions({ contradictions = [], agents = {}, ...extra } = {}) {
  const poe = fakePoe();
  const poeStep = async () => ({ agentId: 'Poe', content: 'lead-in', result: { contradictions }, contradictions, control: {} });
  const orch = createLoop2Orchestrator({
    poe,
    storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } },
    agents: { Poe: poeStep, ...agents },
    ...extra,
  });
  await orch.mount(document.createElement('div'));
  await orch.start();
  await orch.proceed();
  return { poe, orch };
}

function contradictionSpec(poe) {
  const calls = poe.milestoneCard.mock.calls.filter((c) => c[0] && c[0].tag === '[CONTRADICTION]');
  return calls.length ? calls[calls.length - 1][0] : null; // the latest contradiction card
}

const CTA_LABELS = ['Side A is stronger (resolve)', 'Side B is stronger (resolve)', 'Acknowledge, leave unresolved', 'Escalate for Loop 3 scrutiny'];

describe('material contradictions surfacing in the orchestrator', () => {
  it('surfaces the first contradiction (one at a time, three-way mark) and pauses', async () => {
    const { poe, orch } = await runToMaterialContradictions({
      contradictions: [
        { claim_a_id: 'a', claim_b_id: 'b', nature: 'a up, b down' },
        { claim_a_id: 'c', claim_b_id: 'd', nature: 'c vs d' },
      ],
    });
    expect(orch.getState()).toBe('PAUSED');
    const spec = contradictionSpec(poe);
    expect(spec).toBeTruthy();
    expect(spec.title).toContain('1 of 2');
    expect(spec.ctas.map((c) => c.label)).toEqual(CTA_LABELS);
    expect(spec.banners[0].text).toBe('a up, b down');
    expect(orch.getSession().contradictionResolutions).toEqual({}); // nothing decided yet
  });

  it('records each decision and resumes the chain to completion once all are decided', async () => {
    const { poe, orch } = await runToMaterialContradictions({
      contradictions: [
        { claim_a_id: 'a', claim_b_id: 'b', nature: 'n1' },
        { claim_a_id: 'c', claim_b_id: 'd', nature: 'n2' },
      ],
    });
    let spec = contradictionSpec(poe);
    await spec.ctas[0].onClick(); // resolve: side A stronger (pair 1)
    expect(orch.getSession().contradictionResolutions['a::b']).toMatchObject({ status: 'resolved', stronger_claim_id: 'a' });
    expect(orch.getState()).toBe('PAUSED'); // one remains

    spec = contradictionSpec(poe);
    expect(spec.title).toContain('2 of 2');
    await spec.ctas[3].onClick(); // escalate (pair 2)
    expect(orch.getSession().contradictionResolutions['c::d']).toMatchObject({ status: 'escalated' });
    expect(orch.getState()).toBe('COMPLETE');
    // the escalated subset is stashed for the GlobalKG tag + the Loop3Input packet (OUTPUT_HOOK reads it)
    expect(orch.getSession().escalatedContradictions.map((c) => c.claim_a_id)).toEqual(['c']);
  });

  it('escalate records the choice and populates session.escalatedContradictions', async () => {
    const { poe, orch } = await runToMaterialContradictions({
      contradictions: [{ claim_a_id: 'x', claim_b_id: 'y', nature: 'n' }],
    });
    const spec = contradictionSpec(poe);
    await spec.ctas[3].onClick(); // escalate
    expect(orch.getState()).toBe('COMPLETE');
    expect(orch.getSession().contradictionResolutions['x::y'].status).toBe('escalated');
    expect(orch.getSession().escalatedContradictions).toHaveLength(1);
  });

  it('escalating appends a contradiction_escalated entry to the analysis trail (for the cessation card)', async () => {
    const { poe, orch } = await runToMaterialContradictions({
      contradictions: [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }],
    });
    const spec = contradictionSpec(poe);
    await spec.ctas[3].onClick(); // escalate
    const esc = orch.getTrailLog().filter((e) => e.type === 'contradiction_escalated');
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ claim_a_id: 'a', claim_b_id: 'b' });
  });

  it('does not surface or pause when there are no contradictions (forwards normally)', async () => {
    const { poe, orch } = await runToMaterialContradictions({ contradictions: [] });
    expect(orch.getState()).toBe('COMPLETE');
    expect(contradictionSpec(poe)).toBeNull();
  });

  it('shows the paper sources on each side (enriched from the staged KGs) as clickable citation chips', async () => {
    const bookkeeper = async ({ state }) =>
      state === 'BOOKKEEPER_STAGE'
        ? {
            agentId: 'Bookkeeper',
            content: 'staged',
            result: {
              // Both sides well-sourced (>= 2 papers) so the RQ-revision flagged-findings check does not
              // pause the chain before MATERIAL_CONTRADICTIONS; here we are exercising the contradiction card.
              subspecializations: [
                { subspecialization_id: 's1', claims: [{ claim_id: 'a', text: 'A claim', supporting_paper_dois: ['10.1/a1', '10.1/a2'] }] },
                { subspecialization_id: 's2', claims: [{ claim_id: 'b', text: 'B claim', supporting_paper_dois: ['10.1/b1', '10.1/b2'] }] },
              ],
            },
            control: {},
          }
        : { agentId: 'Bookkeeper', content: 'promoted', result: {}, control: {} };
    const { poe } = await runToMaterialContradictions({
      contradictions: [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'tension' }],
      agents: { Bookkeeper: bookkeeper },
    });
    const spec = contradictionSpec(poe);
    const sideA = spec.fields.find((f) => f.label === 'SIDE_A');
    expect(sideA.value).toBe('A claim');
    expect(sideA.chips.map((c) => c.citation)).toEqual(['10.1/a1', '10.1/a2']); // clickable -> the [PAPER] tab
    const sideB = spec.fields.find((f) => f.label === 'SIDE_B');
    expect(sideB.chips.map((c) => c.citation)).toEqual(['10.1/b1', '10.1/b2']);
    expect(spec.fields.find((f) => f.label === 'SUBSPECS').value).toBe('s1 vs s2');
  });

  it('records a decision once: a stale re-click after completion is a no-op', async () => {
    const { poe, orch } = await runToMaterialContradictions({
      contradictions: [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }],
    });
    const spec = contradictionSpec(poe);
    await spec.ctas[2].onClick(); // unresolved
    expect(orch.getState()).toBe('COMPLETE');
    const before = poe.milestoneCard.mock.calls.length;
    await spec.ctas[0].onClick(); // re-click the stale card: already decided
    expect(orch.getSession().contradictionResolutions['a::b'].status).toBe('unresolved'); // not overwritten
    expect(poe.milestoneCard.mock.calls.length).toBe(before); // no further card
  });
});
