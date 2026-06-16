import { describe, expect, it, vi } from 'vitest';
import {
  createPostDocAgent,
  lrSummaryDraftSchema,
  deterministicDraft,
  readKnowledgeGraph,
  finalModelSchema,
  finalLRSummarySchema,
  confidenceFor,
  buildFinalCardSpec,
  EXTRACTION_TIER,
} from '../../../src/agents/loop2/postdoc.js';
import { POSTDOC_STANDARD_SYSTEM_PROMPT, POSTDOC_FINAL_SYSTEM_PROMPT } from '../../../src/agents/loop2/prompts.js';
import { createLoop2Orchestrator } from '../../../src/loops/loop2/orchestrator.js';

// Post-Doc standard pass at POSTDOC_STANDARD: reads the knowledge graph (the written GlobalKG, else
// the staged SubspecializationKGs) + the RQPacket, synthesizes a draft LRSummary, stores it on the
// session, and settles backstage to the IO panel. Extraction tier. Tests inject a fake dispatch.

const okDraft = {
  key_findings: ['Fasting improves working memory in older adults'],
  evidence_strength: 'moderate',
  gaps: ['long-term effects unstudied'],
  contradictions_summary: 'One conflict on dosage.',
};

const claim = (over = {}) => ({
  claim_id: 'c1',
  text: 'Fasting aids memory',
  claim_type: ['causal'],
  supporting_paper_dois: ['10.1/p'],
  quality_review: { quality: 'pass', reason: 'ok' },
  ...over,
});

const stagedKg = (over = {}) => ({
  subspecialization_id: 'subspec-1',
  subspecialization_label: 'Cognitive aging',
  claims: [claim()],
  ...over,
});

// History carrying staged SubspecializationKGs (the round-1 fallback source) + optional contradictions.
function stageHistory(subspecializations, contradictions = []) {
  return [
    { state: 'BOOKKEEPER_STAGE', agentId: 'Bookkeeper', packet: { agentId: 'Bookkeeper', result: { subspecializations } } },
    { state: 'RQ_REVISION_CHECK', agentId: 'Revision Check', packet: { agentId: 'Revision Check', result: { contradictions, unknown_fields: [] } } },
  ];
}

// A fake kg store holding one global snapshot.
function fakeKg(global = null) {
  return {
    load: vi.fn(async (loopId, version) => (loopId === 'loop-2' && version === 'global' ? global : null)),
    save: vi.fn(async () => {}),
  };
}

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

describe('Post-Doc standard pass', () => {
  it('runs on the extraction tier, attributed to Post-Doc, with the schema + on-contract safe default', async () => {
    const dispatch = vi.fn(async () => okDraft);
    const postdoc = createPostDocAgent({ dispatch });
    const packet = await postdoc({ state: 'POSTDOC_STANDARD', history: stageHistory([stagedKg()]), session: { rqPacket: { version: 4 } } });

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Post-Doc');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.schema).toBe(lrSummaryDraftSchema);
    expect(lrSummaryDraftSchema(spec.safeDefault)).toBe(true);

    expect(packet.agentId).toBe('Post-Doc');
    expect(lrSummaryDraftSchema(packet.result)).toBe(true);
    expect(packet.result).toEqual(okDraft);
    expect(packet.control).toEqual({});
  });

  it('sends the Post-Doc prompt, the claims, the contradictions, and the RQPacket', async () => {
    const dispatch = vi.fn(async () => okDraft);
    const postdoc = createPostDocAgent({ dispatch });
    await postdoc({
      state: 'POSTDOC_STANDARD',
      history: stageHistory(
        [stagedKg({ claims: [claim({ claim_id: 'cX', text: 'Claim X text' })] })],
        [{ claim_a_id: 'cX', claim_b_id: 'cY', nature: 'dosage conflict' }],
      ),
      session: { rqPacket: { version: 5, shape: 'opaque' } },
    });
    const spec = dispatch.mock.calls[0][0];
    expect(spec.messages[0]).toEqual({ role: 'system', content: POSTDOC_STANDARD_SYSTEM_PROMPT });
    const user = spec.messages.find((m) => m.role === 'user');
    expect(user.content).toContain('cX');
    expect(user.content).toContain('Claim X text');
    expect(user.content).toContain('dosage conflict');
    expect(user.content).toContain('"shape": "opaque"');
  });

  it('stores the draft LRSummary on the session for the later passes', async () => {
    const dispatch = vi.fn(async () => okDraft);
    const postdoc = createPostDocAgent({ dispatch });
    const session = { rqPacket: {} };
    await postdoc({ state: 'POSTDOC_STANDARD', history: stageHistory([stagedKg()]), session });
    expect(session.lrSummary).toEqual(okDraft);
    expect(session.lrSummaryPass).toBe('standard');
  });

  it('falls back to the deterministic draft on an off-contract model result', async () => {
    const postdoc = createPostDocAgent({ dispatch: vi.fn(async () => ({ evidence_strength: 5 })) });
    const session = {};
    const packet = await postdoc({ state: 'POSTDOC_STANDARD', history: stageHistory([stagedKg()]), session });
    expect(lrSummaryDraftSchema(packet.result)).toBe(true);
    // the structural floor: the claim text became a key finding
    expect(packet.result.key_findings).toContain('Fasting aids memory');
    expect(session.lrSummary).toEqual(packet.result);
  });

  it('prefers the written GlobalKG over the staged KGs when present', async () => {
    const global = {
      loop: 2,
      subspecialization_ids: ['s1'],
      claims: [{ global_claim_id: 's1::g0', claim_id: 'g0', subspecialization_id: 's1', text: 'Global claim text', claim_type: ['causal'], supporting_paper_dois: ['10.1/x', '10.1/y'] }],
      contradictions: [],
      claim_count: 1,
      contradiction_count: 0,
    };
    const dispatch = vi.fn(async (spec) => spec.safeDefault);
    const postdoc = createPostDocAgent({ dispatch });
    const packet = await postdoc({
      state: 'POSTDOC_STANDARD',
      // staged history also present, but the GlobalKG wins
      history: stageHistory([stagedKg()]),
      storage: { kg: fakeKg(global) },
      session: {},
    });
    const user = dispatch.mock.calls[0][0].messages.find((m) => m.role === 'user');
    expect(user.content).toContain('source: global');
    expect(user.content).toContain('Global claim text');
    // the safe default (used here) draws from the GlobalKG claim
    expect(packet.result.key_findings).toContain('Global claim text');
  });

});

// ----- the FINAL pass: the definitive LRSummary + the full trust stack -----

// A written GlobalKG with three claims: one well-supported (2 papers), one single-source, one
// contradiction-tagged - exercising all three confidence tiers.
function finalGlobalKg() {
  return {
    loop: 2,
    subspecialization_ids: ['s1', 's2'],
    claims: [
      { global_claim_id: 's1::a', claim_id: 'a', subspecialization_id: 's1', text: 'Effect holds.', claim_type: ['causal'], supporting_paper_dois: ['10.1/x', '10.1/y'], contradiction_partners: [] },
      { global_claim_id: 's2::b', claim_id: 'b', subspecialization_id: 's2', text: 'Single source.', claim_type: ['descriptive'], supporting_paper_dois: ['10.1/z'], contradiction_partners: [] },
      { global_claim_id: 's1::c', claim_id: 'c', subspecialization_id: 's1', text: 'Contested.', claim_type: [], supporting_paper_dois: ['10.1/p', '10.1/q'], contradiction_partners: [{ partner_claim_id: 'd', nature: 'x' }] },
    ],
    contradictions: [{ claim_a_id: 'c', claim_b_id: 'd', nature: 'x' }],
    claim_count: 3,
    contradiction_count: 1,
  };
}

const finalModel = {
  key_findings: [
    { text: 'Fasting helps; effect \\(d=0.8\\).', claim_ids: ['s1::a'], rationale: 'Two papers agree.' },
    { text: 'A single-source finding.', claim_ids: ['s2::b'], rationale: 'One paper only.' },
    { text: 'A disputed finding.', claim_ids: ['s1::c'], rationale: 'Conflicts with another claim.' },
  ],
  evidence_strength: 'mixed',
  gaps: ['long-term effects'],
  contradictions_summary: 'One conflict on claim c.',
};

describe('Post-Doc FINAL pass (the trust stack)', () => {
  async function runFinal(model = finalModel, extra = {}) {
    const dispatch = vi.fn(async (spec) => (model === '__safe__' ? spec.safeDefault : model));
    const postdoc = createPostDocAgent({ dispatch });
    const session = { rqPacket: {} };
    const packet = await postdoc({ state: 'POSTDOC_FINAL', storage: { kg: fakeKg(finalGlobalKg()) }, session, ...extra });
    return { dispatch, packet, session };
  }

  it('runs on the extraction tier with the final prompt + the model schema + on-contract safe default', async () => {
    const { dispatch, packet } = await runFinal();
    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Post-Doc');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.schema).toBe(finalModelSchema);
    expect(finalModelSchema(spec.safeDefault)).toBe(true);
    expect(spec.messages[0]).toEqual({ role: 'system', content: POSTDOC_FINAL_SYSTEM_PROMPT });
    expect(finalLRSummarySchema(packet.result)).toBe(true);
    expect(packet.control).toEqual({});
  });

  it('assigns confidence deterministically (papers + contradictions), not from the model', async () => {
    const { packet } = await runFinal();
    const [a, b, c] = packet.result.key_findings;
    expect(a.paper_count).toBe(2);
    expect(a.confidence).toBe('high');
    expect(a.confidence_label).toBe('Well-supported by multiple papers');
    expect(b.paper_count).toBe(1);
    expect(b.confidence).toBe('medium');
    expect(b.confidence_label).toBe('Single-source, moderate confidence');
    expect(c.cites_contradiction).toBe(true);
    expect(c.confidence).toBe('low');
    expect(c.confidence_label).toBe('Conflicting evidence');
  });

  it('sets requires_human_review when a finding is under-sourced or cites a contradiction', async () => {
    const { packet, session } = await runFinal();
    expect(packet.result.requires_human_review).toBe(true); // b is single-source, c cites a contradiction
    expect(session.lrSummary).toEqual(packet.result);
    expect(session.lrSummaryPass).toBe('final');

    // A clean KG (every finding multi-sourced, no contradiction) -> no review flag.
    const cleanModel = { key_findings: [{ text: 'Solid.', claim_ids: ['s1::a'], rationale: 'Two papers.' }], evidence_strength: 'strong', gaps: [], contradictions_summary: '' };
    const { packet: clean } = await runFinal(cleanModel);
    expect(clean.result.requires_human_review).toBe(false);
  });

  it('normalizes math delimiters in the synthesis (\\(...\\) -> $...$)', async () => {
    const { packet } = await runFinal();
    expect(packet.result.key_findings[0].text).toBe('Fasting helps; effect $d=0.8$.');
  });

  it('does NOT raise its own overlay (the OUTPUT_HOOK cessation card is the single LRSummary surface)', async () => {
    const { packet } = await runFinal();
    expect(packet.overlay).toBeUndefined();
  });

  it('the LRSummary builds a card spec (buildFinalCardSpec): review banner, per-finding fields with math + badge + clickable chips', async () => {
    // The Post-Doc no longer emits the card; the Packager reuses buildFinalCardSpec(session.lrSummary) at
    // OUTPUT_HOOK. The builder contract is unchanged - assert it over the stored LRSummary.
    const { packet } = await runFinal();
    const overlay = buildFinalCardSpec(packet.result);
    expect(overlay.tag).toBe('[ARCHIVE]');
    // the review banner (flagged), with reasons
    expect(overlay.banners[0].kind).toBe('review');
    expect(overlay.banners.length).toBe(1);
    // per-finding field: math value + a confidence badge + chips carrying the citation DOI
    const f1 = overlay.fields.find((f) => f.label === 'FINDING 1');
    expect(f1.math).toBe(true);
    expect(f1.badge.level).toBe('high');
    expect(f1.badge.label).toBe('Well-supported by multiple papers');
    expect(f1.badge.tooltip).toContain('2 supporting papers');
    expect(f1.badge.tooltip).toContain('s1::a');
    expect(f1.chips).toEqual([
      { label: '10.1/x', title: '10.1/x', citation: '10.1/x' },
      { label: '10.1/y', title: '10.1/y', citation: '10.1/y' },
    ]);
    // the evidence / gaps / contradictions fields are present
    expect(overlay.fields.some((f) => f.label === 'EVIDENCE')).toBe(true);
    expect(overlay.fields.some((f) => f.label === 'GAPS')).toBe(true);
    expect(overlay.fields.some((f) => f.label === 'CONTRADICTIONS')).toBe(true);
  });

  it('falls back to the deterministic final model on an off-contract result (a usable summary)', async () => {
    const { packet, session } = await runFinal('__safe__');
    expect(finalLRSummarySchema(packet.result)).toBe(true);
    expect(packet.result.key_findings.length).toBeGreaterThan(0);
    expect(session.lrSummary).toEqual(packet.result);
    expect(buildFinalCardSpec(packet.result).fields.length).toBeGreaterThan(0);
  });
});

describe('confidenceFor + finalModelSchema + finalLRSummarySchema + buildFinalCardSpec', () => {
  it('confidenceFor maps the three trust tiers (contradiction dominates)', () => {
    expect(confidenceFor(3, false)).toEqual({ confidence: 'high', confidence_label: 'Well-supported by multiple papers' });
    expect(confidenceFor(1, false)).toEqual({ confidence: 'medium', confidence_label: 'Single-source, moderate confidence' });
    expect(confidenceFor(0, false).confidence).toBe('medium');
    expect(confidenceFor(5, true)).toEqual({ confidence: 'low', confidence_label: 'Conflicting evidence' }); // contradiction wins over paper count
  });

  it('finalModelSchema + finalLRSummarySchema accept/reject their contracts', () => {
    expect(finalModelSchema(finalModel)).toBe(true);
    expect(finalModelSchema({ ...finalModel, key_findings: [{ text: 'x' }] })).toBe(false); // missing claim_ids/rationale
    expect(finalModelSchema(null)).toBe(false);
    const enriched = { key_findings: [{ text: 'x', claim_ids: [], rationale: 'r', supporting_paper_dois: [], paper_count: 0, cites_contradiction: false, confidence: 'medium', confidence_label: 'L' }], evidence_strength: 's', gaps: [], contradictions_summary: '', requires_human_review: true };
    expect(finalLRSummarySchema(enriched)).toBe(true);
    expect(finalLRSummarySchema({ ...enriched, requires_human_review: 'yes' })).toBe(false);
    expect(finalLRSummarySchema({ ...enriched, key_findings: [{ ...enriched.key_findings[0], confidence: 'nope' }] })).toBe(false);
  });

  it('buildFinalCardSpec omits the banner when no review is required', () => {
    const summary = { key_findings: [{ text: 'A', claim_ids: ['x'], rationale: 'r', supporting_paper_dois: ['1', '2'], paper_count: 2, cites_contradiction: false, confidence: 'high', confidence_label: 'L' }], evidence_strength: 'strong', gaps: [], contradictions_summary: '', requires_human_review: false };
    const spec = buildFinalCardSpec(summary);
    expect(spec.banners).toEqual([]);
    expect(spec.badge.level).toBe('high');
  });
});

describe('deterministicDraft + lrSummaryDraftSchema + readKnowledgeGraph', () => {
  it('lrSummaryDraftSchema accepts the contract and rejects off-contract values', () => {
    expect(lrSummaryDraftSchema(okDraft)).toBe(true);
    expect(lrSummaryDraftSchema(null)).toBe(false);
    expect(lrSummaryDraftSchema({ ...okDraft, key_findings: 'x' })).toBe(false);
    expect(lrSummaryDraftSchema({ ...okDraft, evidence_strength: 3 })).toBe(false);
    expect(lrSummaryDraftSchema({ ...okDraft, gaps: [1] })).toBe(false);
    expect(lrSummaryDraftSchema({ ...okDraft, contradictions_summary: null })).toBe(false);
  });

  it('deterministicDraft summarizes the KG structure (findings, strength, contradiction count)', () => {
    const strong = deterministicDraft({ claims: [{ text: 'A', supporting_paper_dois: ['1', '2', '3'] }], contradictions: [] });
    expect(strong.key_findings).toEqual(['A']);
    expect(strong.evidence_strength).toBe('strong');
    expect(strong.contradictions_summary).toBe('No material contradictions flagged.');
    const empty = deterministicDraft({ claims: [], contradictions: [] });
    expect(empty.evidence_strength).toBe('insufficient');
    const conflicted = deterministicDraft({ claims: [{ text: 'A', supporting_paper_dois: [] }], contradictions: [{}, {}] });
    expect(conflicted.evidence_strength).toBe('limited');
    expect(conflicted.contradictions_summary).toContain('2 contradictions');
  });

  it('readKnowledgeGraph falls back to the staged KGs when no GlobalKG exists', async () => {
    const kg = await readKnowledgeGraph({ history: stageHistory([stagedKg({ claims: [claim({ claim_id: 'cZ' })] })]), storage: { kg: fakeKg(null) } });
    expect(kg.source).toBe('staged');
    expect(kg.claims.map((c) => c.id)).toEqual(['cZ']);
    expect(kg.subspecialization_ids).toEqual(['subspec-1']);
  });

  it('readKnowledgeGraph surfaces a kg.load failure and degrades to the staged KGs (never throws)', async () => {
    const emit = vi.fn();
    const throwingKg = { load: vi.fn(async () => { throw new Error('idb down'); }) };
    const kg = await readKnowledgeGraph({ history: stageHistory([stagedKg()]), storage: { kg: throwingKg } }, emit);
    expect(kg.source).toBe('staged');
    expect(emit).toHaveBeenCalledWith('postdoc:kg_load_error', expect.objectContaining({ message: 'idb down' }));
  });
});

describe('Post-Doc in the orchestrator (backstage at POSTDOC_STANDARD)', () => {
  it('settles to the IO panel (never the conversation) and drafts the LRSummary onto the session', async () => {
    const poe = fakePoe();
    const seen = [];
    const postdocDispatch = vi.fn(async () => okDraft);
    // A Grad Students stub seeds PHASE_1 subspecializations so the chain has KGs for the Post-Doc.
    const gradStub = async ({ state }) =>
      state === 'PHASE_2'
        ? { agentId: 'Grad Students', content: 'p2', result: { subspecializations: [] }, control: {} }
        : { agentId: 'Grad Students', content: 'p1', result: { subspecializations: [stagedKg({ claims: [claim({ claim_id: 'c1' })] })] }, control: {} };

    const orch = createLoop2Orchestrator({
      poe,
      agents: { 'Grad Students': gradStub, 'Post-Doc': createPostDocAgent({ dispatch: postdocDispatch }) },
      packet: { setPacket: (p) => seen.push(p) },
      storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } },
    });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(poe.calls.settle).toContain('Post-Doc');
    expect(poe.calls.receive.map((p) => p.agentId)).not.toContain('Post-Doc'); // backstage
    // The STANDARD pass (the first Post-Doc packet) drafted onto the session backstage.
    const pdPacket = seen.find((p) => p.agentId === 'Post-Doc' && p.result);
    expect(pdPacket).toBeTruthy();
    expect(pdPacket.result).toEqual(okDraft);
    expect(lrSummaryDraftSchema(pdPacket.result)).toBe(true);
    // The chain ran on through the FINAL pass (p53 stub CEASE -> POSTDOC_FINAL), which overwrote the
    // session draft with the definitive LRSummary.
    expect(orch.getSession().lrSummaryPass).toBe('final');
    expect(finalLRSummarySchema(orch.getSession().lrSummary)).toBe(true);
  });
});
