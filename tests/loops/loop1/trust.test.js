import { describe, expect, it } from 'vitest';
import {
  confidenceFromNovelty,
  requiresHumanReview,
  buildTrustModel,
  REVIEW_SCORE_THRESHOLD,
} from '../../../src/loops/loop1/trust.js';

// trust.js derives the cessation card's trust model from the run's history. The
// confidence labels, the 0.85 threshold, and the novelty-low rule are spec-given;
// these tests pin them and the fail-safe defaults.

const cv = (score, blocking = []) => ({
  agentId: 'CV',
  packet: { result: { status: score >= 1 ? 'pass' : 'pass', score, blocking_fields: blocking } },
});
const rq = (paradigm, feedback = []) => ({
  agentId: 'RQSupervisor',
  packet: { result: { approved: true, paradigm, feedback, revision_required: false } },
});
const novelty = (signal, rationale = '', overlapping = []) => ({
  agentId: 'Novelty Checker',
  packet: { result: { novelty_signal: signal, rationale, overlapping_papers: overlapping } },
});

describe('confidenceFromNovelty', () => {
  it('maps each signal to its level and natural-language label', () => {
    expect(confidenceFromNovelty('high')).toEqual({ level: 'high', label: 'Well-supported' });
    expect(confidenceFromNovelty('medium')).toEqual({ level: 'medium', label: 'Moderate confidence' });
    expect(confidenceFromNovelty('low')).toEqual({ level: 'low', label: 'Needs review' });
  });

  it('fails safe to the lowest level for an unknown or missing signal', () => {
    expect(confidenceFromNovelty(null)).toEqual({ level: 'low', label: 'Needs review' });
    expect(confidenceFromNovelty('bogus')).toEqual({ level: 'low', label: 'Needs review' });
  });
});

describe('requiresHumanReview', () => {
  it('flags a completeness score below the 0.85 threshold', () => {
    expect(REVIEW_SCORE_THRESHOLD).toBe(0.85);
    expect(requiresHumanReview({ cvScore: 0.84, noveltySignal: 'high' })).toBe(true);
    expect(requiresHumanReview({ cvScore: 0.85, noveltySignal: 'high' })).toBe(false); // boundary: not below
    expect(requiresHumanReview({ cvScore: 0.92, noveltySignal: 'high' })).toBe(false);
  });

  it('flags a low novelty signal regardless of score', () => {
    expect(requiresHumanReview({ cvScore: 1, noveltySignal: 'low' })).toBe(true);
    expect(requiresHumanReview({ cvScore: 1, noveltySignal: 'medium' })).toBe(false);
  });
});

describe('buildTrustModel', () => {
  it('derives the full model from the run history', () => {
    const history = [
      { agentId: 'Poe', packet: { agentId: 'Poe', content: 'q' } },
      cv(0.4, ['the population', 'the outcome']), // an earlier failing CV turn
      cv(0.95, []), // the passing CV turn
      rq('clinical', ['scope is appropriate']),
      novelty('high', 'No close prior work found.', ['A prior trial']),
    ];

    const model = buildTrustModel({ history, researchQuestion: 'Does fasting help memory?' });

    expect(model.researchQuestion).toBe('Does fasting help memory?');
    expect(model.paradigm).toBe('clinical');
    expect(model.noveltySignal).toBe('high');
    expect(model.confidence).toMatchObject({ level: 'high', label: 'Well-supported' });
    // tooltip = novelty rationale + RQSupervisor feedback
    expect(model.confidence.tooltip).toContain('No close prior work found.');
    expect(model.confidence.tooltip).toContain('scope is appropriate');
    expect(model.requiresHumanReview).toBe(false);

    // resolved blocking fields = the union across all CV turns (none remain at pass)
    expect(model.evaluation.cvScore).toBe(0.95);
    expect(model.evaluation.resolvedBlockingFields).toEqual(['the population', 'the outcome']);
    expect(model.evaluation.paradigm).toBe('clinical');
    expect(model.evaluation.overlappingPapers).toEqual(['A prior trial']);
    expect(model.evaluation.noveltyRationale).toBe('No close prior work found.');
  });

  it('flags human review when the completeness score is below threshold', () => {
    const history = [cv(0.7, []), rq('computational', []), novelty('high', 'novel', [])];
    const model = buildTrustModel({ history, researchQuestion: 'q' });
    expect(model.requiresHumanReview).toBe(true);
    expect(model.reviewReasons.join(' ')).toMatch(/completeness 0\.70 is below 0\.85/);
  });

  it('flags human review and lowers confidence on a low novelty signal', () => {
    const history = [cv(0.99, []), rq('synthesis', []), novelty('low', 'lots of overlap', ['P1', 'P2'])];
    const model = buildTrustModel({ history, researchQuestion: 'q' });
    expect(model.confidence.level).toBe('low');
    expect(model.requiresHumanReview).toBe(true);
    expect(model.reviewReasons).toContain('novelty signal is low');
  });

  it('fails safe with no results: lowest confidence and requires review', () => {
    const model = buildTrustModel({ history: [], researchQuestion: 'q' });
    expect(model.confidence.level).toBe('low');
    expect(model.requiresHumanReview).toBe(true);
    expect(model.evaluation.resolvedBlockingFields).toEqual([]);
    expect(model.evaluation.overlappingPapers).toEqual([]);
  });
});
