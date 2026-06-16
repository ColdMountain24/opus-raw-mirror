import { describe, expect, it, vi } from 'vitest';
import {
  createSeniorGradStudentAgent,
  seniorGradResultSchema,
  applyQualityReviews,
  isReview,
  QUALITIES,
  SENIOR_GRAD_SAFE_DEFAULT,
  EXTRACTION_TIER,
} from '../../../src/agents/loop2/seniorgrad.js';
import { SENIOR_GRAD_STUDENT_SYSTEM_PROMPT } from '../../../src/agents/loop2/prompts.js';

// The Senior Grad Student: the per-subspecialization quality reviewer. One dispatch per batch on
// the extraction tier; returns one { claim_id, quality, reason } verdict per claim. Tests inject a
// fake dispatch and assert on the verdicts + the apply-to-KG behavior (reject drops, flag keeps).

const claim = (over = {}) => ({
  claim_id: 'claim_subspec-1_0',
  text: 'Fasting aids memory',
  claim_type: ['causal'],
  entity_references: ['fasting', 'memory'],
  supporting_paper_dois: ['10.1/p'],
  confidence: null,
  salvia_status: 'valid',
  citation_boost_count: null,
  ...over,
});

const paper = (over = {}) => ({ title: 'P', doi: '10.1/p', abstract: 'abs', ...over });

describe('Senior Grad Student Loop 2 quality reviewer', () => {
  it('runs ONE dispatch per batch on the extraction tier, attributed to Senior Grad Student', async () => {
    const reviews = [{ claim_id: 'claim_subspec-1_0', quality: 'pass', reason: 'well supported' }];
    const dispatch = vi.fn(async () => ({ reviews }));
    const review = createSeniorGradStudentAgent({ dispatch });
    const packet = await review({
      subspecialization: { id: 'subspec-1', name: 'Cognitive aging' },
      claims: [claim()],
      papers: [paper()],
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Senior Grad Student');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.failover[0]).toBe('anthropic');
    expect(spec.schema).toBe(seniorGradResultSchema);
    expect(seniorGradResultSchema(spec.safeDefault)).toBe(true);

    expect(packet.agentId).toBe('Senior Grad Student');
    expect(packet.result.subspecialization_id).toBe('subspec-1');
    expect(packet.result.reviews).toEqual(reviews);
    expect(packet.control).toEqual({}); // internal tool: no transition
  });

  it('sends the Senior Grad Student prompt, the claims, and the paper abstracts', async () => {
    const dispatch = vi.fn(async () => ({ reviews: [] }));
    const review = createSeniorGradStudentAgent({ dispatch });
    await review({
      subspecialization: { id: 's', name: 'Cognitive aging' },
      claims: [claim({ claim_id: 'cX', text: 'Claim X text' })],
      papers: [paper({ title: 'Paper Title Y', abstract: 'Grounding abstract Z' })],
    });
    const spec = dispatch.mock.calls[0][0];
    expect(spec.messages[0]).toEqual({ role: 'system', content: SENIOR_GRAD_STUDENT_SYSTEM_PROMPT });
    const user = spec.messages.find((m) => m.role === 'user');
    expect(user.content).toContain('cX');
    expect(user.content).toContain('Claim X text');
    expect(user.content).toContain('Paper Title Y');
    expect(user.content).toContain('Grounding abstract Z');
    expect(user.content).toContain('Cognitive aging');
  });

  it('does not dispatch when there are no claims to review', async () => {
    const dispatch = vi.fn();
    const review = createSeniorGradStudentAgent({ dispatch });
    const packet = await review({ subspecialization: { id: 's', name: 'L' }, claims: [], papers: [] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(packet.result.reviews).toEqual([]);
    expect(packet.agentId).toBe('Senior Grad Student');
  });

  it('summarizes the verdict counts for the IO panel (pass/flag/reject)', async () => {
    const reviews = [
      { claim_id: 'a', quality: 'pass', reason: 'ok' },
      { claim_id: 'b', quality: 'flag', reason: 'weak support' },
      { claim_id: 'c', quality: 'reject', reason: 'unsupported' },
    ];
    const review = createSeniorGradStudentAgent({ dispatch: vi.fn(async () => ({ reviews })) });
    const packet = await review({
      subspecialization: { id: 's', name: 'Cognitive aging' },
      claims: [claim({ claim_id: 'a' }), claim({ claim_id: 'b' }), claim({ claim_id: 'c' })],
      papers: [paper()],
    });
    expect(packet.content).toContain('1 passed');
    expect(packet.content).toContain('1 flagged');
    expect(packet.content).toContain('1 rejected');
    expect(packet.content).toContain('Cognitive aging');
  });

  it('degrades to no verdicts (every claim kept) when the dispatch throws, surfacing the error', async () => {
    const events = [];
    const dispatch = vi.fn(async () => {
      throw new Error('all providers down');
    });
    const review = createSeniorGradStudentAgent({ dispatch, logger: (e) => events.push(e) });
    const packet = await review({
      subspecialization: { id: 's', name: 'L' },
      claims: [claim()],
      papers: [paper()],
    });
    expect(packet.result.reviews).toEqual([]); // no verdicts -> applyQualityReviews keeps all
    expect(events.some((e) => e.type === 'seniorgrad:review_error')).toBe(true);
  });

  it('falls back to the safe default the dispatcher returns when every provider is down', async () => {
    const review = createSeniorGradStudentAgent({ dispatch: vi.fn(async (spec) => spec.safeDefault) });
    const packet = await review({ subspecialization: { id: 's', name: 'L' }, claims: [claim()], papers: [paper()] });
    expect(seniorGradResultSchema(packet.result)).toBe(true);
    expect(packet.result.reviews).toEqual([]);
  });

  it('keeps off-contract dispatcher output from corrupting the batch (treated as no verdicts)', async () => {
    const review = createSeniorGradStudentAgent({ dispatch: vi.fn(async () => ({ reviews: 'nope' })) });
    const packet = await review({ subspecialization: { id: 's', name: 'L' }, claims: [claim()], papers: [paper()] });
    expect(packet.result.reviews).toEqual([]);
  });
});

describe('seniorGradResultSchema + isReview', () => {
  it('accepts the contract and rejects off-contract verdicts', () => {
    expect(seniorGradResultSchema({ reviews: [] })).toBe(true);
    expect(seniorGradResultSchema({ reviews: [{ claim_id: 'a', quality: 'pass', reason: 'r' }] })).toBe(true);
    expect(seniorGradResultSchema({ reviews: [{ claim_id: 'a', quality: 'flag', reason: '' }] })).toBe(true); // empty reason ok
    expect(seniorGradResultSchema({ reviews: 'x' })).toBe(false);
    expect(seniorGradResultSchema(null)).toBe(false);
    // quality must be in the enum
    expect(seniorGradResultSchema({ reviews: [{ claim_id: 'a', quality: 'maybe', reason: 'r' }] })).toBe(false);
    // claim_id must be a non-empty string
    expect(seniorGradResultSchema({ reviews: [{ claim_id: '', quality: 'pass', reason: 'r' }] })).toBe(false);
    // reason must be a string
    expect(seniorGradResultSchema({ reviews: [{ claim_id: 'a', quality: 'pass' }] })).toBe(false);
  });

  it('exposes the three quality verdicts', () => {
    expect(QUALITIES).toEqual(['pass', 'flag', 'reject']);
    expect(isReview({ claim_id: 'a', quality: 'reject', reason: 'r' })).toBe(true);
    expect(isReview({ claim_id: 'a', quality: 'x', reason: 'r' })).toBe(false);
  });

  it('SENIOR_GRAD_SAFE_DEFAULT is on-contract and empty', () => {
    expect(seniorGradResultSchema(SENIOR_GRAD_SAFE_DEFAULT)).toBe(true);
    expect(SENIOR_GRAD_SAFE_DEFAULT.reviews).toEqual([]);
  });
});

describe('applyQualityReviews', () => {
  const claims = [claim({ claim_id: 'a' }), claim({ claim_id: 'b' }), claim({ claim_id: 'c' }), claim({ claim_id: 'd' })];

  it('drops rejected claims, keeps flagged with a quality flag, keeps passed clean, keeps unreviewed', () => {
    const reviews = [
      { claim_id: 'a', quality: 'pass', reason: 'solid' },
      { claim_id: 'b', quality: 'flag', reason: 'weak support' },
      { claim_id: 'c', quality: 'reject', reason: 'misread' },
      // 'd' has no verdict
    ];
    const { kept, dropped, unreviewed } = applyQualityReviews(claims, reviews);

    expect(kept.map((c) => c.claim_id)).toEqual(['a', 'b', 'd']); // c dropped
    expect(dropped).toEqual([{ claim_id: 'c', reason: 'misread' }]);
    expect(unreviewed).toBe(1);

    const a = kept.find((c) => c.claim_id === 'a');
    const b = kept.find((c) => c.claim_id === 'b');
    const d = kept.find((c) => c.claim_id === 'd');
    expect(a.quality_review).toEqual({ quality: 'pass', reason: 'solid' });
    expect(b.quality_review).toEqual({ quality: 'flag', reason: 'weak support' });
    expect(d.quality_review).toBeNull(); // unreviewed: kept, not dropped
  });

  it('does not mutate the input claims', () => {
    const input = [claim({ claim_id: 'a' })];
    applyQualityReviews(input, [{ claim_id: 'a', quality: 'flag', reason: 'r' }]);
    expect(input[0].quality_review).toBeUndefined();
  });

  it('keeps every claim when there are no verdicts (provider-outage safety)', () => {
    const { kept, dropped, unreviewed } = applyQualityReviews(claims, []);
    expect(kept).toHaveLength(4);
    expect(dropped).toEqual([]);
    expect(unreviewed).toBe(4);
  });
});
