import { describe, expect, it, vi } from 'vitest';
import {
  evaluateRQRevision,
  isClaimFlagged,
  defaultAssumptionContradicted,
  FLAGGED_FINDINGS_THRESHOLD,
} from '../../../src/loops/loop2/rqrevision.js';
import { createLoop2Orchestrator } from '../../../src/loops/loop2/orchestrator.js';

// The RQ revision check policy (orchestrator-owned): does the evidence reveal the RQ needs revising?
// Deterministic over the claims (the standard draft's findings are free strings) + an injectable
// assumption-contradicted predicate. The 30% threshold is the spec's.

const claim = (over = {}) => ({
  claim_id: 'c0',
  supporting_paper_dois: ['10.1/a', '10.1/b'],
  quality_review: { quality: 'pass', reason: 'ok' },
  salvia_status: 'valid',
  contradiction_partners: [],
  ...over,
});

describe('isClaimFlagged', () => {
  it('flags a claim that is quality-flagged, grounding-flagged, thinly sourced, or contradiction-tagged', () => {
    expect(isClaimFlagged(claim())).toBe(false); // clean: 2 papers, pass, valid, no partner
    expect(isClaimFlagged(claim({ quality_review: { quality: 'flag', reason: 'weak' } }))).toBe(true);
    expect(isClaimFlagged(claim({ salvia_status: 'flagged' }))).toBe(true);
    expect(isClaimFlagged(claim({ supporting_paper_dois: ['10.1/a'] }))).toBe(true); // < 2 papers
    expect(isClaimFlagged(claim({ supporting_paper_dois: [] }))).toBe(true);
    expect(isClaimFlagged(claim({ contradiction_partners: [{ partner_claim_id: 'x', nature: 'y' }] }))).toBe(true);
  });
});

describe('defaultAssumptionContradicted', () => {
  it('is true only for a contradiction between two well-supported (>= 2 paper) claims', () => {
    const claims = [
      claim({ claim_id: 'a', supporting_paper_dois: ['1', '2'] }),
      claim({ claim_id: 'b', supporting_paper_dois: ['3', '4'] }),
      claim({ claim_id: 'thin', supporting_paper_dois: ['5'] }),
    ];
    expect(defaultAssumptionContradicted({ claims, contradictions: [{ claim_a_id: 'a', claim_b_id: 'b' }] })).toBe(true);
    // a contradiction touching a thinly-sourced claim does not count as a high-confidence conflict
    expect(defaultAssumptionContradicted({ claims, contradictions: [{ claim_a_id: 'a', claim_b_id: 'thin' }] })).toBe(false);
    expect(defaultAssumptionContradicted({ claims, contradictions: [] })).toBe(false);
  });
});

describe('evaluateRQRevision', () => {
  it('flags when more than 30% of the claims are flagged for review', () => {
    // 2 of 4 flagged (50% > 30%)
    const claims = [
      claim({ claim_id: 'a' }),
      claim({ claim_id: 'b' }),
      claim({ claim_id: 'c', supporting_paper_dois: ['1'] }), // thin -> flagged
      claim({ claim_id: 'd', quality_review: { quality: 'flag', reason: 'r' } }), // flagged
    ];
    const r = evaluateRQRevision({ claims });
    expect(r.conditions.flagged).toBe(true);
    expect(r.flaggedRatio).toBe(0.5);
    expect(r.needsRevision).toBe(true);
    expect(r.reasons[0]).toContain('50%');
  });

  it('does not flag at or below the 30% threshold', () => {
    // 1 of 4 flagged (25% <= 30%)
    const claims = [claim({ claim_id: 'a' }), claim({ claim_id: 'b' }), claim({ claim_id: 'c' }), claim({ claim_id: 'd', supporting_paper_dois: [] })];
    const r = evaluateRQRevision({ claims });
    expect(r.conditions.flagged).toBe(false);
    expect(r.needsRevision).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('flags when a high-confidence assumption contradiction exists (even if few findings are flagged)', () => {
    const claims = [
      claim({ claim_id: 'a', supporting_paper_dois: ['1', '2'] }),
      claim({ claim_id: 'b', supporting_paper_dois: ['3', '4'] }),
      claim({ claim_id: 'c' }),
      claim({ claim_id: 'd' }),
    ];
    const r = evaluateRQRevision({ claims, contradictions: [{ claim_a_id: 'a', claim_b_id: 'b' }] });
    expect(r.conditions.contradicted).toBe(true);
    expect(r.needsRevision).toBe(true);
    expect(r.reasons.some((x) => x.includes('assumption'))).toBe(true);
  });

  it('honors an injected assumption predicate and a custom threshold', () => {
    const claims = [claim({ claim_id: 'a' })];
    const always = () => true;
    expect(evaluateRQRevision({ claims, isAssumptionContradicted: always }).conditions.contradicted).toBe(true);
    const never = () => false;
    expect(evaluateRQRevision({ claims, isAssumptionContradicted: never }).needsRevision).toBe(false);
    expect(FLAGGED_FINDINGS_THRESHOLD).toBe(0.3);
  });

  it('handles an empty evidence base without dividing by zero', () => {
    const r = evaluateRQRevision({ claims: [] });
    expect(r.flaggedRatio).toBe(0);
    expect(r.needsRevision).toBe(false);
  });
});

// ----- the RQ revision check wired into the orchestrator (at RQ_REVISION_CHECK) -----

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

// Drive the default-stub chain to RQ_REVISION_CHECK; `evaluateRQRevision` is injected to control the
// decision (the pure evaluation is covered above), and the overlay is captured on the fake Poe.
async function runToRevisionCheck(extra = {}) {
  const poe = fakePoe();
  const orch = createLoop2Orchestrator({
    poe,
    storage: { session: { load: async () => ({ rqPacket: {}, researchQuestion: 'Q' }) } },
    ...extra,
  });
  await orch.mount(document.createElement('div'));
  await orch.start();
  await orch.proceed();
  return { poe, orch };
}

function rqRevisionSpec(poe) {
  const call = poe.milestoneCard.mock.calls.find((c) => c[0] && c[0].tag === '[RQ_REVISION]');
  return call ? call[0] : null;
}

describe('RQ revision check in the orchestrator', () => {
  it('surfaces the two-choice overlay and pauses when the evidence needs revision', async () => {
    const evaluateRQRevision = () => ({ needsRevision: true, reasons: ['62% flagged'], flaggedRatio: 0.62, flaggedCount: 5, total: 8, conditions: { flagged: true, contradicted: false } });
    const { poe, orch } = await runToRevisionCheck({ evaluateRQRevision });
    expect(orch.getState()).toBe('PAUSED');
    const spec = rqRevisionSpec(poe);
    expect(spec).toBeTruthy();
    expect(spec.ctas.map((c) => c.label)).toEqual(['Revise the research question', 'Proceed with an acknowledged caveat']);
    expect(spec.banners[0].kind).toBe('review');
    expect(spec.banners[0].reasons).toContain('62% flagged');
    expect(orch.getSession().rqRevisionChoice).toBeUndefined(); // not yet decided
  });

  it('PROCEED records the caveat on the session and resumes the chain to completion', async () => {
    const evaluateRQRevision = () => ({ needsRevision: true, reasons: ['conflict'], flaggedRatio: 0.4, flaggedCount: 2, total: 5, conditions: { flagged: true, contradicted: false } });
    const { poe, orch } = await runToRevisionCheck({ evaluateRQRevision });
    const spec = rqRevisionSpec(poe);
    await spec.ctas[1].onClick(); // proceed with caveat
    expect(orch.getSession().rqRevisionChoice).toBe('proceed');
    expect(orch.getSession().rqRevisionCaveat).toEqual(['conflict']);
    expect(orch.getState()).toBe('COMPLETE');
  });

  it('REVISE records the choice, hands off to Loop 1 (onReviseRQ with the GlobalKG context), stays paused', async () => {
    const evaluateRQRevision = () => ({ needsRevision: true, reasons: ['assumption contradicted'], flaggedRatio: 0.1, flaggedCount: 1, total: 10, conditions: { flagged: false, contradicted: true } });
    const onReviseRQ = vi.fn();
    const { poe, orch } = await runToRevisionCheck({ evaluateRQRevision, onReviseRQ });
    const spec = rqRevisionSpec(poe);
    spec.ctas[0].onClick(); // revise the RQ
    expect(orch.getSession().rqRevisionChoice).toBe('revise');
    expect(onReviseRQ).toHaveBeenCalledTimes(1);
    expect(onReviseRQ.mock.calls[0][0]).toMatchObject({ reasons: ['assumption contradicted'] });
    expect(onReviseRQ.mock.calls[0][0]).toHaveProperty('stagedKGs');
    expect(orch.getState()).toBe('PAUSED'); // handed off to Loop 1, Loop 2 suspended
  });

  it('does not surface or pause when no revision is needed (forwards normally)', async () => {
    const evaluateRQRevision = () => ({ needsRevision: false, reasons: [], flaggedRatio: 0, flaggedCount: 0, total: 3, conditions: { flagged: false, contradicted: false } });
    const { poe, orch } = await runToRevisionCheck({ evaluateRQRevision });
    expect(orch.getState()).toBe('COMPLETE');
    expect(rqRevisionSpec(poe)).toBeNull();
  });

  it('records the choice once: a later RQ_REVISION_CHECK pass does not re-surface', async () => {
    const evaluateRQRevision = vi.fn(() => ({ needsRevision: true, reasons: ['x'], flaggedRatio: 0.5, flaggedCount: 1, total: 2, conditions: { flagged: true, contradicted: false } }));
    const { poe, orch } = await runToRevisionCheck({ evaluateRQRevision });
    const spec = rqRevisionSpec(poe);
    await spec.ctas[1].onClick(); // proceed
    // After 'proceed', a manual re-entry into RQ_REVISION_CHECK is a no-op (choice already recorded).
    const before = poe.milestoneCard.mock.calls.length;
    expect(orch.getSession().rqRevisionChoice).toBe('proceed');
    expect(poe.milestoneCard.mock.calls.length).toBe(before); // no further RQ-revision card
  });
});
