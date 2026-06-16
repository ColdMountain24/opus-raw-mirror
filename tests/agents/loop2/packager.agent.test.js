import { describe, expect, it, vi } from 'vitest';
import { createPackagerAgent, buildCessationCard, formatTrail } from '../../../src/agents/loop2/packager.js';
import { GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION } from '../../../src/agents/loop2/bookkeeper.js';

// The Packager (OUTPUT_HOOK): the Loop 2 Output Hook. CLIENT-SIDE (no dispatch). It reads the definitive
// LRSummary (session) + the GlobalKG (IndexedDB) + the real-time analysis trail (orchestrator) and builds the
// cessation card - the single LRSummary surface (reusing the Post-Doc's buildFinalCardSpec) plus the coverage
// summary, the collapsible analysis trail, and the "Proceed to Hypothesis Scrutiny" CTA.

const lrSummary = () => ({
  key_findings: [
    { text: 'Fasting helps; $d=0.8$.', claim_ids: ['s1::a'], rationale: 'Two papers.', supporting_paper_dois: ['10.1/x', '10.1/y'], paper_count: 2, confidence: 'high', confidence_label: 'Well-supported by multiple papers', cites_contradiction: false },
    { text: 'A single-source finding.', claim_ids: ['s2::b'], rationale: 'One paper.', supporting_paper_dois: ['10.1/z'], paper_count: 1, confidence: 'medium', confidence_label: 'Single-source, moderate confidence', cites_contradiction: false },
  ],
  evidence_strength: 'mixed',
  gaps: ['long-term effects'],
  contradictions_summary: 'One conflict.',
  requires_human_review: true,
});

const globalKg = () => ({ loop: 2, subspecialization_ids: ['s1', 's2'], claims: [], claim_count: 9, contradiction_count: 2, escalated_contradiction_count: 1, contradictions: [] });

function fakeKg(kg) {
  return {
    load: vi.fn(async (loopId, version) => (loopId === GLOBAL_KG_LOOP_ID && version === GLOBAL_KG_VERSION ? kg : null)),
    save: vi.fn(),
  };
}

function phase1History() {
  return [
    { state: 'PHASE_1', agentId: 'Grad Students', packet: { agentId: 'Grad Students', result: { subspecializations: [], papers_retrieved: 7, claims_extracted: 12 } } },
    { state: 'PHASE_1', agentId: 'Grad Students', packet: { agentId: 'Grad Students', result: { subspecializations: [], papers_retrieved: 3, claims_extracted: 4 } } },
  ];
}

const trail = () => [
  { seq: 0, type: 'sweep', round: 1, subspecializations: ['Cognitive aging', 'Metabolism'], targeted_fields: null },
  { seq: 1, type: 'claims_round', round: 1, extracted: 12, promoted: 9, rejected: 3 },
  { seq: 2, type: 'coverage', iteration: 1, coverage: 0.45, state: 'CONTINUE' },
  { seq: 3, type: 'unknown_field_sweep', iteration: 1, fields: ['dosage'] },
  { seq: 4, type: 'sweep', round: 2, subspecializations: ['Dosage'], targeted_fields: ['dosage'] },
  { seq: 5, type: 'claims_round', round: 2, extracted: 4, promoted: 3, rejected: 1 },
  { seq: 6, type: 'coverage', iteration: 2, coverage: 0.72, state: 'CEASE' },
  { seq: 7, type: 'fallback', kind: 'failover', from: 'anthropic', reason: 'timeout' },
  { seq: 8, type: 'fallback', kind: 'cache_hit', agentId: 'Skips' },
  { seq: 9, type: 'fallback', kind: 'corrective_retry', agentId: 'Salvia' },
  { seq: 10, type: 'contradiction_escalated', claim_a_id: 'a', claim_b_id: 'b' },
];

describe('formatTrail', () => {
  it('formats the trail entries into milestone fields (rounds, ratios, coverage, sweeps, fallbacks, escalations)', () => {
    const fields = formatTrail(trail());
    const by = (label) => fields.find((f) => f.label === label);
    expect(by('FEARLESS_LEADER_ROUNDS').value).toBe('2');
    expect(by('ROUND_1_CLAIMS').value).toBe('extracted 12, promoted 9, rejected 3');
    expect(by('ROUND_2_CLAIMS').value).toBe('extracted 4, promoted 3, rejected 1');
    expect(by('COVERAGE_BY_ITERATION').value).toEqual(['iter 1: 0.45', 'iter 2: 0.72']);
    expect(by('UNKNOWN_FIELD_SWEEP_1').value).toContain('dosage');
    const fb = by('FALLBACK_EVENTS').value;
    expect(fb).toContain('1 provider failover');
    expect(fb).toContain('1 cache hit');
    expect(fb).toContain('1 corrective retry');
    expect(by('ESCALATED_CONTRADICTIONS').value).toEqual(['a vs b']);
  });

  it('reports no fallbacks on a clean run', () => {
    const fields = formatTrail([{ type: 'sweep', round: 1, subspecializations: [], targeted_fields: null }]);
    expect(fields.find((f) => f.label === 'FALLBACK_EVENTS').value).toBe(''); // emptyText 'none' at render
  });
});

describe('Packager (OUTPUT_HOOK cessation card)', () => {
  async function run(extra = {}) {
    const onProceed = vi.fn();
    const kg = fakeKg('kg' in extra ? extra.kg : globalKg());
    const packager = createPackagerAgent({ onProceed, kg });
    const session = { lrSummary: 'lrSummary' in extra ? extra.lrSummary : lrSummary() };
    const packet = await packager({ state: 'OUTPUT_HOOK', session, storage: { kg }, history: phase1History(), trailLog: trail() });
    return { onProceed, kg, packet };
  }

  it('builds the cessation card: reused findings + chips, coverage fields, analysis-trail section, Proceed CTA', async () => {
    const { packet, onProceed } = await run();
    const overlay = packet.overlay;
    expect(overlay.tag).toBe('[ARCHIVE_COMPLETE]');

    // findings reused from buildFinalCardSpec: the first finding keeps its clickable citation chips
    const f1 = overlay.fields.find((f) => f.label === 'FINDING 1');
    expect(f1.chips).toEqual([
      { label: '10.1/x', title: '10.1/x', citation: '10.1/x' },
      { label: '10.1/y', title: '10.1/y', citation: '10.1/y' },
    ]);

    // the GlobalKG coverage summary
    const cov = (label) => overlay.fields.find((f) => f.label === label).value;
    expect(cov('SUBSPECIALIZATIONS')).toBe('2');
    expect(cov('PAPERS_RETRIEVED')).toBe('10'); // 7 + 3 (summed across PHASE_1 packets)
    expect(cov('CLAIMS_EXTRACTED')).toBe('16'); // 12 + 4
    expect(cov('CLAIMS_PROMOTED')).toBe('9'); // GlobalKG claim_count
    expect(cov('ESCALATED_CONTRADICTIONS')).toBe('1');

    // the collapsible analysis trail section
    expect(overlay.sections[0].summary).toBe('Show analysis trail');
    expect(overlay.sections[0].fields.find((f) => f.label === 'FEARLESS_LEADER_ROUNDS').value).toBe('2');

    // requires_human_review -> the review banner
    expect(overlay.banners[0].kind).toBe('review');

    // the Proceed CTA wired to onProceed
    expect(overlay.cta.label).toBe('Proceed to Hypothesis Scrutiny');
    overlay.cta.onClick();
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('reports the coverage summary on the result and makes no dispatch call (client-side)', async () => {
    const dispatch = vi.fn();
    const kg = fakeKg(globalKg());
    const packager = createPackagerAgent({ kg });
    const packet = await packager({ state: 'OUTPUT_HOOK', session: { lrSummary: lrSummary() }, storage: { kg }, history: phase1History(), trailLog: trail(), dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(packet.agentId).toBe('Packager');
    expect(packet.result.coverage.claims_promoted).toBe(9);
    expect(packet.result.trail_length).toBe(trail().length);
    expect(packet.control).toEqual({});
  });

  it('degrades to a minimal card when the LRSummary and GlobalKG are missing (never a dead end)', async () => {
    const { packet } = await run({ kg: null, lrSummary: null });
    const overlay = packet.overlay;
    expect(overlay.tag).toBe('[ARCHIVE_COMPLETE]');
    expect(overlay.fields.find((f) => f.label === 'CLAIMS_PROMOTED').value).toBe('0');
    expect(overlay.fields.some((f) => /^FINDING/.test(f.label))).toBe(false); // no findings, but still a card
    expect(overlay.sections[0].summary).toBe('Show analysis trail');
    expect(overlay.cta.label).toBe('Proceed to Hypothesis Scrutiny');
  });

  it('surfaces a GlobalKG load failure (no silent swallow) and still renders the card', async () => {
    const events = [];
    const kg = { load: vi.fn(async () => { throw new Error('idb down'); }), save: vi.fn() };
    const packager = createPackagerAgent({ kg, logger: (e) => events.push(e) });
    const packet = await packager({ state: 'OUTPUT_HOOK', session: { lrSummary: lrSummary() }, storage: { kg }, history: phase1History(), trailLog: trail() });
    expect(events.some((e) => e.type === 'packager:kg_load_error')).toBe(true);
    expect(packet.overlay.tag).toBe('[ARCHIVE_COMPLETE]');
    expect(packet.result.coverage.claims_promoted).toBe(0); // degraded, still on-contract
  });

  it('prefers the orchestrator-injected storage.kg over the configured default', async () => {
    const configured = fakeKg(globalKg());
    const injected = fakeKg({ ...globalKg(), claim_count: 99 });
    const packager = createPackagerAgent({ kg: configured });
    const packet = await packager({ state: 'OUTPUT_HOOK', session: { lrSummary: lrSummary() }, storage: { kg: injected }, history: phase1History(), trailLog: trail() });
    expect(injected.load).toHaveBeenCalled();
    expect(configured.load).not.toHaveBeenCalled();
    expect(packet.result.coverage.claims_promoted).toBe(99);
  });

  it('buildCessationCard is a pure projection (coverage + trail + CTA) usable without the agent', () => {
    const onProceed = vi.fn();
    const spec = buildCessationCard(lrSummary(), { subspecializations: 2, papers_retrieved: 10, claims_extracted: 16, claims_promoted: 9, escalated_contradictions: 0 }, trail(), onProceed);
    expect(spec.fields.find((f) => f.label === 'CLAIMS_PROMOTED').value).toBe('9');
    expect(spec.fields.some((f) => f.label === 'ESCALATED_CONTRADICTIONS')).toBe(false); // 0 -> omitted
    expect(spec.sections[0].fields.length).toBeGreaterThan(0);
  });
});
