import { describe, expect, it, vi } from 'vitest';
import { createGradStudentPhase } from '../../../src/agents/loop2/gradphase.js';

// The PHASE_1 coordinator: the orchestrator's 'Grad Students' step. Reads Fearless Leader's
// subspecializations, calls Edgar per subspecialization, fans out one Grad Student per
// subspecialization in parallel, then runs the Senior Grad Student quality review per batch and
// applies the verdicts. Tests inject fake edgar + gradStudent + seniorGrad.

function flHistory(subspecializations) {
  return [
    {
      state: 'FEARLESS_LEADER',
      agentId: 'Fearless Leader',
      packet: { agentId: 'Fearless Leader', result: { subspecializations } },
    },
  ];
}

// A Senior Grad Student fake that passes every claim it is handed (no drops), unless `verdicts`
// maps a claim_id to a specific quality.
function passingSenior(verdicts = {}) {
  return vi.fn(async ({ subspecialization, claims }) => ({
    agentId: 'Senior Grad Student',
    result: {
      subspecialization_id: subspecialization.id,
      reviews: claims.map((c) => ({ claim_id: c.claim_id, quality: verdicts[c.claim_id] || 'pass', reason: 'r' })),
    },
    control: {},
  }));
}

describe('Grad Student PHASE_1 coordinator', () => {
  it('runs Edgar + a Grad Student + the Senior review per subspecialization and aggregates the KGs', async () => {
    const edgar = vi.fn(async ({ subspecializationId }) => ({
      result: { papers: [{ title: 'P', doi: `10/${subspecializationId}` }], subspecialization_id: subspecializationId, retrieval_count: 1 },
    }));
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: { subspecialization_id: subspecialization.id, claims: [{ claim_id: 'c', text: 't' }] },
      control: {},
    }));
    const seniorGrad = passingSenior();
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad });
    const packet = await phase({
      state: 'PHASE_1',
      history: flHistory([{ id: 'subspec-1', query: 'q1' }, { id: 'subspec-2', query: 'q2' }]),
      onClaimRender: () => {},
      session: {},
    });

    expect(edgar).toHaveBeenCalledTimes(2);
    expect(gradStudent).toHaveBeenCalledTimes(2);
    expect(seniorGrad).toHaveBeenCalledTimes(2);
    expect(packet.agentId).toBe('Grad Students');
    expect(packet.result.subspecializations).toHaveLength(2);
  });

  it('passes Edgar papers, the subspecialization, and the render seam to each Grad Student', async () => {
    const papers = [{ title: 'X', doi: '10/x' }];
    const edgar = vi.fn(async () => ({ result: { papers, subspecialization_id: 's', retrieval_count: 1 } }));
    const seen = {};
    const gradStudent = vi.fn(async (ctx) => {
      seen.ctx = ctx;
      return { agentId: 'Grad Students', result: { subspecialization_id: ctx.subspecialization.id, claims: [] }, control: {} };
    });
    const onClaimRender = () => {};
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad: passingSenior() });
    await phase({ state: 'PHASE_1', history: flHistory([{ id: 'subspec-1', query: 'q' }]), onClaimRender, session: {} });

    expect(seen.ctx.papers).toBe(papers);
    expect(seen.ctx.onClaimRender).toBe(onClaimRender);
    expect(seen.ctx.subspecialization.id).toBe('subspec-1');
  });

  it('passes the Grad Student claims AND the Edgar papers to the Senior review', async () => {
    const papers = [{ title: 'X', doi: '10/x', abstract: 'a' }];
    const edgar = vi.fn(async () => ({ result: { papers, subspecialization_id: 's', retrieval_count: 1 } }));
    const claims = [{ claim_id: 'c1', text: 't1' }];
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: { subspecialization_id: subspecialization.id, claims },
      control: {},
    }));
    const seen = {};
    const seniorGrad = vi.fn(async (ctx) => {
      seen.ctx = ctx;
      return { agentId: 'Senior Grad Student', result: { subspecialization_id: ctx.subspecialization.id, reviews: [] }, control: {} };
    });
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad });
    await phase({ state: 'PHASE_1', history: flHistory([{ id: 'subspec-1', query: 'q' }]), onClaimRender: () => {}, session: {} });
    expect(seen.ctx.claims).toBe(claims);
    expect(seen.ctx.papers).toBe(papers);
    expect(seen.ctx.subspecialization.id).toBe('subspec-1');
  });

  it('drops rejected claims and flags flagged ones in the aggregated KG', async () => {
    const edgar = vi.fn(async () => ({ result: { papers: [], subspecialization_id: 's', retrieval_count: 0 } }));
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: {
        subspecialization_id: subspecialization.id,
        claims: [{ claim_id: 'keep', text: 'k' }, { claim_id: 'flag', text: 'f' }, { claim_id: 'drop', text: 'd' }],
      },
      control: {},
    }));
    const seniorGrad = passingSenior({ flag: 'flag', drop: 'reject' });
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad });
    const packet = await phase({ state: 'PHASE_1', history: flHistory([{ id: 's', query: 'q' }]), onClaimRender: () => {}, session: {} });

    const kg = packet.result.subspecializations[0];
    expect(kg.claims.map((c) => c.claim_id)).toEqual(['keep', 'flag']); // 'drop' removed
    expect(kg.claims.find((c) => c.claim_id === 'flag').quality_review).toEqual({ quality: 'flag', reason: 'r' });
    expect(kg.claims.find((c) => c.claim_id === 'keep').quality_review).toEqual({ quality: 'pass', reason: 'r' });
  });

  it('emits a review render event per verdict to the IO panel (not the conversation)', async () => {
    const edgar = vi.fn(async () => ({ result: { papers: [], subspecialization_id: 's', retrieval_count: 0 } }));
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: { subspecialization_id: subspecialization.id, claims: [{ claim_id: 'a', text: 't' }, { claim_id: 'b', text: 't' }] },
      control: {},
    }));
    const events = [];
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad: passingSenior({ b: 'reject' }) });
    await phase({
      state: 'PHASE_1',
      history: flHistory([{ id: 'subspec-1', name: 'Cognitive aging', query: 'q' }]),
      onClaimRender: (e) => events.push(e),
      session: {},
    });
    const reviews = events.filter((e) => e.type === 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews.map((r) => r.claimId).sort()).toEqual(['a', 'b']);
    const b = reviews.find((r) => r.claimId === 'b');
    expect(b.quality).toBe('reject');
    expect(b.subspecializationId).toBe('subspec-1');
    expect(b.subspecializationLabel).toBe('Cognitive aging');
  });

  it('keeps the subspecialization claims when the Senior review throws (no silent loss)', async () => {
    const edgar = vi.fn(async () => ({ result: { papers: [], subspecialization_id: 's', retrieval_count: 0 } }));
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: { subspecialization_id: subspecialization.id, claims: [{ claim_id: 'a', text: 't' }] },
      control: {},
    }));
    const seniorGrad = vi.fn(async () => {
      throw new Error('reviewer down');
    });
    const events = [];
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad, logger: (e) => events.push(e) });
    const packet = await phase({ state: 'PHASE_1', history: flHistory([{ id: 's', query: 'q' }]), onClaimRender: () => {} });
    expect(packet.result.subspecializations[0].claims.map((c) => c.claim_id)).toEqual(['a']);
    expect(packet.result.subspecializations[0].claims[0].quality_review).toBeNull(); // unreviewed, kept
    expect(events.some((e) => e.type === 'gradphase:review_error')).toBe(true);
  });

  it('aggregates the round audit counts (papers_retrieved / claims_extracted / claims_rejected) for the analysis trail', async () => {
    const edgar = vi.fn(async ({ subspecializationId }) => ({
      result: { papers: [{ doi: `10/${subspecializationId}-1` }, { doi: `10/${subspecializationId}-2` }], subspecialization_id: subspecializationId, retrieval_count: 2 },
    }));
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: { subspecialization_id: subspecialization.id, claims: [{ claim_id: 'a', text: 't' }, { claim_id: 'b', text: 't' }] },
      control: {},
    }));
    const seniorGrad = passingSenior({ b: 'reject' }); // drop 'b' in each subspecialization
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad });
    const packet = await phase({
      state: 'PHASE_1',
      history: flHistory([{ id: 's1', query: 'q' }, { id: 's2', query: 'q' }]),
      onClaimRender: () => {},
      session: {},
    });
    expect(packet.result.papers_retrieved).toBe(4); // 2 papers x 2 subspecializations
    expect(packet.result.claims_extracted).toBe(4); // 2 claims x 2 (pre-review)
    expect(packet.result.claims_rejected).toBe(2); // 'b' rejected in each
    const surviving = packet.result.subspecializations.reduce((n, kg) => n + kg.claims.length, 0);
    expect(surviving).toBe(2); // extracted - rejected
  });

  it('PHASE_2 is a pass-through (Senior Grad Student synthesis deferred)', async () => {
    const edgar = vi.fn();
    const gradStudent = vi.fn();
    const seniorGrad = vi.fn();
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad });
    const packet = await phase({ state: 'PHASE_2', history: [], onClaimRender: () => {} });
    expect(edgar).not.toHaveBeenCalled();
    expect(gradStudent).not.toHaveBeenCalled();
    expect(seniorGrad).not.toHaveBeenCalled();
    expect(packet.agentId).toBe('Grad Students');
  });

  it('handles a missing Fearless Leader plan without throwing', async () => {
    const phase = createGradStudentPhase({ edgar: vi.fn(), gradStudent: vi.fn(), seniorGrad: vi.fn() });
    const packet = await phase({ state: 'PHASE_1', history: [], onClaimRender: () => {} });
    expect(packet.result.subspecializations).toEqual([]);
  });

  it('surfaces a failed subspecialization and keeps the others', async () => {
    const edgar = vi.fn(async ({ subspecializationId }) => {
      if (subspecializationId === 'bad') throw new Error('edgar down');
      return { result: { papers: [], subspecialization_id: subspecializationId, retrieval_count: 0 } };
    });
    const gradStudent = vi.fn(async ({ subspecialization }) => ({
      agentId: 'Grad Students',
      result: { subspecialization_id: subspecialization.id, claims: [] },
      control: {},
    }));
    const events = [];
    const phase = createGradStudentPhase({ edgar, gradStudent, seniorGrad: passingSenior(), logger: (e) => events.push(e) });
    const packet = await phase({
      state: 'PHASE_1',
      history: flHistory([{ id: 'good', query: 'q' }, { id: 'bad', query: 'q' }]),
      onClaimRender: () => {},
    });
    expect(packet.result.subspecializations.map((s) => s.subspecialization_id)).toEqual(['good']);
    expect(events.some((e) => e.type === 'gradphase:subspec_error')).toBe(true);
  });
});
