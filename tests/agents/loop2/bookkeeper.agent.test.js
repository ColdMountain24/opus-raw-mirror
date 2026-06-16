import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createStorage } from '../../../src/utils/storage.js';
import {
  createBookkeeperAgent,
  buildSubspecializationKG,
  subspecializationKgSchema,
  readSubspecializationKGs,
  KG_LOOP_ID,
  GLOBAL_KG_LOOP_ID,
  GLOBAL_KG_VERSION,
  globalKgSchema,
  mergeIntoGlobalKG,
  buildGlobalViewElements,
} from '../../../src/agents/loop2/bookkeeper.js';
import { createLoop2Orchestrator } from '../../../src/loops/loop2/orchestrator.js';

// The Bookkeeper Phase 1 (BOOKKEEPER_STAGE): a CLIENT-SIDE (no LLM) agent that stages each
// subspecialization's surviving claims into a structured SubspecializationKG, persists it to
// IndexedDB, and emits the subspecialization node to the Observatory. Tests inject a fake/real kg.

const claim = (over = {}) => ({
  claim_id: 'claim_subspec-1_0',
  text: 'Fasting aids memory',
  claim_type: ['causal'],
  entity_references: ['fasting'],
  supporting_paper_dois: ['10.1/p'],
  confidence: null,
  salvia_status: 'valid',
  citation_boost_count: null,
  quality_review: { quality: 'pass', reason: 'solid' },
  ...over,
});

const gsKg = (over = {}) => ({
  subspecialization_id: 'subspec-1',
  subspecialization_label: 'Cognitive aging',
  grad_student_id: 'gs_subspec-1',
  claims: [claim()],
  edgar_queries: ['fasting memory'],
  metadata: { retrieval_density: 0.25 },
  ...over,
});

function phase1History(subspecializations) {
  return [
    { state: 'FEARLESS_LEADER', agentId: 'Fearless Leader', packet: { agentId: 'Fearless Leader', result: { subspecializations: [] } } },
    { state: 'PHASE_1', agentId: 'Grad Students', packet: { agentId: 'Grad Students', result: { subspecializations } } },
  ];
}

function fakeKg() {
  const store = new Map();
  return {
    save: vi.fn(async (loopId, version, data) => {
      store.set(`${loopId}::${version}`, data);
      return { loopId, version };
    }),
    load: vi.fn(async (loopId, version) => (store.has(`${loopId}::${version}`) ? store.get(`${loopId}::${version}`) : null)),
    _store: store,
  };
}

function fakePoe() {
  const calls = { settle: [], receive: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn(),
    showThinking: vi.fn(),
    milestoneCard: vi.fn(),
  };
}

describe('Bookkeeper Loop 2 Phase 1 (BOOKKEEPER_STAGE)', () => {
  it('stages + persists one SubspecializationKG per subspecialization and emits its node', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 1234 });
    const packet = await bookkeeper({
      state: 'BOOKKEEPER_STAGE',
      history: phase1History([gsKg({ subspecialization_id: 'subspec-1' }), gsKg({ subspecialization_id: 'subspec-2' })]),
    });

    expect(packet.agentId).toBe('Bookkeeper');
    expect(kg.save).toHaveBeenCalledTimes(2);
    // Keyed by [KG_LOOP_ID, subspecialization_id].
    expect(kg.save.mock.calls[0][0]).toBe(KG_LOOP_ID);
    expect(kg.save.mock.calls[0][1]).toBe('subspec-1');
    expect(subspecializationKgSchema(kg.save.mock.calls[0][2])).toBe(true);

    // A subspecialization node per subspecialization, for the Observatory.
    expect(packet.promoted.nodes.map((n) => n.data.id)).toEqual(['subspec-1', 'subspec-2']);
    expect(packet.promoted.nodes[0].data.type).toBe('subspecialization');
    expect(packet.promoted.edges).toEqual([]); // main.js wires the claim edges
    expect(packet.result.subspecializations).toHaveLength(2);
    expect(packet.control).toEqual({});
  });

  it('round-trips a staged KG through real IndexedDB (fake-indexeddb)', async () => {
    const kg = createStorage({ indexedDB: new IDBFactory() }).kg;
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 99 });
    await bookkeeper({ state: 'BOOKKEEPER_STAGE', history: phase1History([gsKg()]) });

    const loaded = await kg.load(KG_LOOP_ID, 'subspec-1');
    expect(loaded).not.toBeNull();
    expect(subspecializationKgSchema(loaded)).toBe(true);
    expect(loaded.subspecialization_label).toBe('Cognitive aging');
    expect(loaded.claims).toHaveLength(1);
    expect(loaded.claims[0].quality_review).toEqual({ quality: 'pass', reason: 'solid' });
    expect(loaded.metadata.staged_at).toBe(99);
  });

  it('promotes surviving claims and counts flagged; defensively drops a stray reject', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg });
    const claims = [
      claim({ claim_id: 'a', quality_review: { quality: 'pass', reason: 'r' } }),
      claim({ claim_id: 'b', quality_review: { quality: 'flag', reason: 'weak' } }),
      claim({ claim_id: 'c', quality_review: null }), // unreviewed but kept
      claim({ claim_id: 'd', quality_review: { quality: 'reject', reason: 'should not be here' } }),
    ];
    const packet = await bookkeeper({ state: 'BOOKKEEPER_STAGE', history: phase1History([gsKg({ claims })]) });
    const stored = packet.result.subspecializations[0];
    expect(stored.claims.map((c) => c.claim_id)).toEqual(['a', 'b', 'c']); // d dropped
    expect(stored.metadata.claim_count).toBe(3);
    expect(stored.metadata.flagged_count).toBe(1);
  });

  it('surfaces a persist failure and still stages the rest (no silent swallow)', async () => {
    const kg = fakeKg();
    kg.save.mockImplementationOnce(async () => {
      throw new Error('quota exceeded');
    });
    const events = [];
    const bookkeeper = createBookkeeperAgent({ kg, logger: (e) => events.push(e) });
    const packet = await bookkeeper({
      state: 'BOOKKEEPER_STAGE',
      history: phase1History([gsKg({ subspecialization_id: 'subspec-1' }), gsKg({ subspecialization_id: 'subspec-2' })]),
    });
    expect(events.some((e) => e.type === 'bookkeeper:persist_error')).toBe(true);
    expect(kg.save).toHaveBeenCalledTimes(2); // the second still attempted
    expect(packet.result.subspecializations).toHaveLength(2); // in-memory result stands
  });

  it('prefers the orchestrator-injected storage.kg over the configured default', async () => {
    const configured = fakeKg();
    const injected = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg: configured });
    await bookkeeper({ state: 'BOOKKEEPER_STAGE', history: phase1History([gsKg()]), storage: { kg: injected } });
    expect(injected.save).toHaveBeenCalledTimes(1);
    expect(configured.save).not.toHaveBeenCalled();
  });

  it('handles a missing PHASE_1 plan without throwing', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg });
    const packet = await bookkeeper({ state: 'BOOKKEEPER_STAGE', history: [] });
    expect(packet.result.subspecializations).toEqual([]);
    expect(packet.promoted.nodes).toEqual([]);
    expect(kg.save).not.toHaveBeenCalled();
  });

});

// ----- Phase 2 (BOOKKEEPER_PROMOTE): merge staged SubspecializationKGs into the GlobalKG -----

// A staged SubspecializationKG (the shape BOOKKEEPER_STAGE produced) carried on a BOOKKEEPER_STAGE
// packet, optionally with a Revision Check packet carrying Skips contradictions.
function stagedKg(over = {}) {
  return {
    subspecialization_id: 'subspec-1',
    subspecialization_label: 'Cognitive aging',
    metadata: { claim_count: 1 },
    claims: [claim()],
    entities: [], methods: [], datasets: [], design_recommendations: [], intra_contradictions: [], unknowns: [],
    ...over,
  };
}
function promoteHistory(stagedKGs, contradictions = []) {
  return [
    { state: 'BOOKKEEPER_STAGE', agentId: 'Bookkeeper', packet: { agentId: 'Bookkeeper', result: { subspecializations: stagedKGs } } },
    { state: 'RQ_REVISION_CHECK', agentId: 'Revision Check', packet: { agentId: 'Revision Check', result: { contradictions, unknown_fields: [] } } },
  ];
}

describe('Bookkeeper Phase 2 (BOOKKEEPER_PROMOTE)', () => {
  it('merges staged SubspecializationKGs into the GlobalKG and persists it to IndexedDB', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 100 });
    const staged = [
      stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 's1-c0' })] }),
      stagedKg({ subspecialization_id: 's2', claims: [claim({ claim_id: 's2-c0' })] }),
    ];
    const packet = await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory(staged) });

    expect(packet.agentId).toBe('Bookkeeper');
    expect(packet.result.promoted_to_global).toBe(true);
    expect(packet.result.claim_count).toBe(2);
    expect(packet.result.subspecialization_ids).toEqual(['s1', 's2']);
    expect(kg.save).toHaveBeenCalledWith(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION, expect.any(Object));
    const saved = kg._store.get(`${GLOBAL_KG_LOOP_ID}::${GLOBAL_KG_VERSION}`);
    expect(globalKgSchema(saved)).toBe(true);
    expect(saved.claims.map((c) => c.global_claim_id).sort()).toEqual(['s1::s1-c0', 's2::s2-c0']);
  });

  it('dedups (merges, does not duplicate) a claim already present in the GlobalKG across rounds', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 1 });
    // round 1: s1 with one paper
    await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory([stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'c0', supporting_paper_dois: ['10.1/a'] })] })]) });
    // round 2: same subspecialization + claim id, a NEW paper -> merge, not duplicate
    const packet = await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory([stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'c0', supporting_paper_dois: ['10.1/b'] })] })]) });

    expect(packet.result.claim_count).toBe(1); // not 2
    const saved = kg._store.get(`${GLOBAL_KG_LOOP_ID}::${GLOBAL_KG_VERSION}`);
    const merged = saved.claims.find((c) => c.global_claim_id === 's1::c0');
    expect(merged.supporting_paper_dois.sort()).toEqual(['10.1/a', '10.1/b']); // union
    expect(merged.promotion_count).toBe(2);
  });

  it('tags contradicting claims with their partner (from Skips, via the Revision Check packet)', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 1 });
    const staged = [
      stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'a' })] }),
      stagedKg({ subspecialization_id: 's2', claims: [claim({ claim_id: 'b' })] }),
    ];
    const contradictions = [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'a says up, b says down' }];
    const packet = await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory(staged, contradictions) });

    expect(packet.result.contradiction_count).toBe(1);
    const saved = kg._store.get(`${GLOBAL_KG_LOOP_ID}::${GLOBAL_KG_VERSION}`);
    const a = saved.claims.find((c) => c.global_claim_id === 's1::a');
    const b = saved.claims.find((c) => c.global_claim_id === 's2::b');
    // resolution defaults to 'open' (MATERIAL_CONTRADICTIONS surfaced none in this provider-only chain).
    expect(a.contradiction_partners).toEqual([{ partner_claim_id: 'b', nature: 'a says up, b says down', resolution: 'open' }]);
    expect(b.contradiction_partners).toEqual([{ partner_claim_id: 'a', nature: 'a says up, b says down', resolution: 'open' }]);
    // and it emits contradicts edges (keyed by global_claim_id) for the Observatory unified view
    expect(packet.promoted.edges).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ source: 's1::a', target: 's2::b', type: 'contradicts' }) }));
  });

  it('stamps each tagged contradiction with the researcher resolution (escalated tags the GlobalKG)', () => {
    const staged = [
      stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'a' })] }),
      stagedKg({ subspecialization_id: 's2', claims: [claim({ claim_id: 'b' })] }),
      stagedKg({ subspecialization_id: 's3', claims: [claim({ claim_id: 'c' })] }),
      stagedKg({ subspecialization_id: 's4', claims: [claim({ claim_id: 'd' })] }),
    ];
    const contradictions = [
      { claim_a_id: 'a', claim_b_id: 'b', nature: 'n1' },
      { claim_a_id: 'c', claim_b_id: 'd', nature: 'n2' },
    ];
    // keyed by contradictionKey (claim_a::claim_b), the orchestrator's MATERIAL_CONTRADICTIONS map.
    const resolutions = {
      'a::b': { status: 'escalated', stronger_claim_id: null },
      'c::d': { status: 'resolved', stronger_claim_id: 'c' },
    };
    const gkg = mergeIntoGlobalKG(null, staged, contradictions, 1, resolutions);

    expect(gkg.escalated_contradiction_count).toBe(1);
    const ab = gkg.contradictions.find((t) => t.claim_a_id === 'a');
    expect(ab.resolution).toBe('escalated');
    const cd = gkg.contradictions.find((t) => t.claim_a_id === 'c');
    expect(cd.resolution).toBe('resolved');
    expect(cd.stronger_claim_id).toBe('c');
    // the per-claim partner entries carry the resolution too (so the KG records it on both sides)
    const a = gkg.claims.find((cl) => cl.global_claim_id === 's1::a');
    expect(a.contradiction_partners[0]).toMatchObject({ partner_claim_id: 'b', resolution: 'escalated' });
  });

  it('defaults the resolution to "open" when MATERIAL_CONTRADICTIONS did not run (no resolutions)', () => {
    const staged = [
      stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'a' })] }),
      stagedKg({ subspecialization_id: 's2', claims: [claim({ claim_id: 'b' })] }),
    ];
    const gkg = mergeIntoGlobalKG(null, staged, [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }], 1);
    expect(gkg.contradictions[0].resolution).toBe('open');
    expect(gkg.escalated_contradiction_count).toBe(0);
  });

  it('the agent reads the resolutions off the session and escalates in the persisted GlobalKG', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 1 });
    const staged = [
      stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'a' })] }),
      stagedKg({ subspecialization_id: 's2', claims: [claim({ claim_id: 'b' })] }),
    ];
    const packet = await bookkeeper({
      state: 'BOOKKEEPER_PROMOTE',
      history: promoteHistory(staged, [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }]),
      session: { contradictionResolutions: { 'a::b': { status: 'escalated', stronger_claim_id: null } } },
    });
    expect(packet.result.escalated_contradiction_count).toBe(1);
    expect(packet.content).toContain('escalated for Loop 3');
    const saved = kg._store.get(`${GLOBAL_KG_LOOP_ID}::${GLOBAL_KG_VERSION}`);
    expect(saved.contradictions[0].resolution).toBe('escalated');
  });

  it('round-trips the GlobalKG through real IndexedDB (fake-indexeddb)', async () => {
    const kg = createStorage({ indexedDB: new IDBFactory() }).kg;
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 42 });
    await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory([stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'c0' })] })]) });
    const loaded = await kg.load(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION);
    expect(globalKgSchema(loaded)).toBe(true);
    expect(loaded.claims[0].global_claim_id).toBe('s1::c0');
  });

  it('is client-side: makes no dispatch call', async () => {
    const kg = fakeKg();
    const dispatch = vi.fn();
    const bookkeeper = createBookkeeperAgent({ kg });
    await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory([stagedKg()]), dispatch });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('globalKgSchema rejects off-contract objects', () => {
    const ok = mergeIntoGlobalKG(null, [stagedKg()], [], 1);
    expect(globalKgSchema(ok)).toBe(true);
    expect(globalKgSchema(null)).toBe(false);
    expect(globalKgSchema({ ...ok, loop: 1 })).toBe(false);
    expect(globalKgSchema({ ...ok, claims: 'x' })).toBe(false);
    expect(globalKgSchema({ ...ok, claim_count: 'n' })).toBe(false);
  });

  it('emits the unified GlobalKG view: deduped claim nodes (view global) + subspec nodes + edges', async () => {
    const kg = fakeKg();
    const bookkeeper = createBookkeeperAgent({ kg, clock: () => 1 });
    const staged = [
      stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'a', claim_type: ['causal'], supporting_paper_dois: ['10.1/x', '10.1/y'], quality_review: { quality: 'flag', reason: 'r' } })] }),
      stagedKg({ subspecialization_id: 's2', claims: [claim({ claim_id: 'b', claim_type: ['descriptive'], supporting_paper_dois: ['10.1/z'] })] }),
      stagedKg({ subspecialization_id: 's3', claims: [claim({ claim_id: 'c', claim_type: ['descriptive'], supporting_paper_dois: ['10.1/w'] })] }),
    ];
    const contradictions = [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'tension' }];
    const packet = await bookkeeper({ state: 'BOOKKEEPER_PROMOTE', history: promoteHistory(staged, contradictions) });

    const nodeById = new Map(packet.promoted.nodes.map((n) => [n.data.id, n.data]));
    // One global claim node per claim, id == global_claim_id, tagged view 'global'.
    const a = nodeById.get('s1::a');
    expect(a.type).toBe('claim');
    expect(a.view).toBe('global');
    expect(a.subspecialization_id).toBe('s1');
    expect(a.claim_type).toEqual(['causal']);
    expect(a.confidence).toBe(null); // still null (Post-Doc deferred)
    expect(a.quality).toBe('flag'); // from quality_review.quality
    expect(a.supportCount).toBe(2); // supporting_paper_dois.length, drives node sizing
    expect(a.contradiction).toBe(1); // it has a contradiction partner -> red halo
    expect(nodeById.get('s2::b').contradiction).toBe(1); // the other side of the contradiction
    expect(nodeById.get('s3::c').contradiction).toBe(0); // no partner -> no halo
    // One subspecialization node per id, namespaced + carrying its claim count.
    expect(nodeById.get('gsub::s1').type).toBe('subspecialization');
    expect(nodeById.get('gsub::s1').view).toBe('global');
    expect(nodeById.get('gsub::s1').claimCount).toBe(1);
    // Edges: a derived-from per claim (claim -> its gsub) and contradicts between the real global nodes.
    expect(packet.promoted.edges).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ source: 's1::a', target: 'gsub::s1', type: 'derived-from' }) }));
    expect(packet.promoted.edges).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ source: 's1::a', target: 's2::b', type: 'contradicts' }) }));
  });

  it('buildGlobalViewElements is a pure projection of the GlobalKG (no nodes when empty)', () => {
    const empty = buildGlobalViewElements({ claims: [], subspecialization_ids: [], contradictions: [] });
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
    const gkg = mergeIntoGlobalKG(null, [stagedKg({ subspecialization_id: 's1', claims: [claim({ claim_id: 'c0' })] })], [], 1);
    const view = buildGlobalViewElements(gkg);
    expect(view.nodes.filter((n) => n.data.type === 'claim').map((n) => n.data.id)).toEqual(['s1::c0']);
    expect(view.nodes.some((n) => n.data.id === 'gsub::s1')).toBe(true);
  });
});

describe('buildSubspecializationKG + subspecializationKgSchema + readSubspecializationKGs', () => {
  it('builds the claims-scoped stored shape with the architecture-named empty sections', () => {
    const built = buildSubspecializationKG(gsKg(), () => 7);
    expect(subspecializationKgSchema(built)).toBe(true);
    expect(built.metadata.grad_student_id).toBe('gs_subspec-1');
    expect(built.metadata.retrieval_density).toBe(0.25);
    expect(built.metadata.edgar_queries).toEqual(['fasting memory']);
    expect(built.entities).toEqual([]);
    expect(built.design_recommendations).toEqual([]);
    expect(built.unknowns).toEqual([]);
  });

  it('subspecializationKgSchema rejects off-contract objects', () => {
    const ok = buildSubspecializationKG(gsKg(), () => 0);
    expect(subspecializationKgSchema(ok)).toBe(true);
    expect(subspecializationKgSchema(null)).toBe(false);
    expect(subspecializationKgSchema({ ...ok, subspecialization_id: '' })).toBe(false);
    expect(subspecializationKgSchema({ ...ok, claims: 'x' })).toBe(false);
    expect(subspecializationKgSchema({ ...ok, entities: 'x' })).toBe(false);
    expect(subspecializationKgSchema({ ...ok, metadata: { claim_count: 'n' } })).toBe(false);
  });

  it('reads the most recent PHASE_1 subspecializations from history', () => {
    const subs = [gsKg()];
    expect(readSubspecializationKGs(phase1History(subs))).toBe(subs);
    expect(readSubspecializationKGs([])).toEqual([]);
    // a PHASE_2 packet is not read as PHASE_1
    const h = [{ state: 'PHASE_2', agentId: 'Grad Students', packet: { result: { subspecializations: [gsKg()] } } }];
    expect(readSubspecializationKGs(h)).toEqual([]);
  });
});

describe('Bookkeeper in the orchestrator (backstage + promotion)', () => {
  it('settles to the IO panel (never the conversation) and fires onPromote with subspecialization scope', async () => {
    const kg = fakeKg();
    const poe = fakePoe();
    const seenPackets = [];
    const promotes = [];
    const gradStub = async ({ state }) =>
      state === 'PHASE_2'
        ? { agentId: 'Grad Students', content: 'p2', result: { subspecializations: [] }, control: {} }
        : { agentId: 'Grad Students', content: 'p1', result: { subspecializations: [gsKg()] }, control: {} };

    const orch = createLoop2Orchestrator({
      poe,
      agents: { 'Grad Students': gradStub, Bookkeeper: createBookkeeperAgent({ kg }) },
      packet: { setPacket: (p) => seenPackets.push(p) },
      storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) }, kg },
      onPromote: (nodes, edges, meta) => promotes.push({ nodes, edges, meta }),
    });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(poe.calls.settle).toContain('Bookkeeper');
    expect(poe.calls.receive.map((p) => p.agentId)).not.toContain('Bookkeeper'); // backstage
    expect(kg.save).toHaveBeenCalled();

    const stagePromote = promotes.find((p) => p.meta && p.meta.scope === 'subspecialization');
    expect(stagePromote).toBeTruthy();
    expect(stagePromote.nodes.some((n) => n.data.type === 'subspecialization')).toBe(true);
  });
});
