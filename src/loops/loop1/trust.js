// Loop 1 (The Agora) trust model.
//
// At cessation the completion card surfaces a trust layer over the run's results.
// This module derives that trust model from history (the same backstage results the
// agents already produced: CV completeness, RQSupervisor structure, Novelty signal),
// so the Output Hook stays thin and the Poe card stays a pure renderer. It mirrors
// review.js: a single place that reads the FINAL agent result shapes and returns a
// presentation model, never defining those shapes.
//
// Charter boundary. The confidence labels, the review threshold (0.85), and the
// novelty-low rule are given by the phase spec (user-owned), implemented verbatim;
// this module invents no agent logic. It fails SAFE: when a result is missing it
// reports the lowest confidence and requires human review, so an incomplete run is
// never presented as well supported.

// Confidence is keyed off the novelty signal (the three levels the spec names). The
// pill color is a CSS concern resolved from data-level; this returns level + label.
const CONFIDENCE_LABELS = Object.freeze({
  high: 'Well-supported',
  medium: 'Moderate confidence',
  low: 'Needs review',
});

// The CV completeness score below which a human should review the result.
export const REVIEW_SCORE_THRESHOLD = 0.85;

export function confidenceFromNovelty(signal) {
  const level = signal === 'high' || signal === 'medium' || signal === 'low' ? signal : 'low';
  return { level, label: CONFIDENCE_LABELS[level] };
}

// requires_human_review when completeness is below the threshold OR novelty is low.
export function requiresHumanReview({ cvScore, noveltySignal } = {}) {
  const lowScore = typeof cvScore === 'number' && !Number.isNaN(cvScore) && cvScore < REVIEW_SCORE_THRESHOLD;
  return Boolean(lowScore || noveltySignal === 'low');
}

// Latest result a given agent produced, or null (same scan as p53 / review.js).
function lastResult(history, agentId) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && entry.agentId === agentId && entry.packet && entry.packet.result) {
      return entry.packet.result;
    }
  }
  return null;
}

// The union of every blocking field CV ever reported across the run: at the passing
// cessation none remain, so this is exactly the set that was resolved.
function resolvedBlockingFields(history) {
  const seen = [];
  for (const entry of history) {
    const result = entry && entry.agentId === 'CV' && entry.packet ? entry.packet.result : null;
    if (result && Array.isArray(result.blocking_fields)) {
      for (const field of result.blocking_fields) {
        if (typeof field === 'string' && !seen.includes(field)) seen.push(field);
      }
    }
  }
  return seen;
}

function reviewReasons(cvScore, noveltySignal) {
  const reasons = [];
  if (typeof cvScore === 'number' && !Number.isNaN(cvScore) && cvScore < REVIEW_SCORE_THRESHOLD) {
    reasons.push(`completeness ${cvScore.toFixed(2)} is below ${REVIEW_SCORE_THRESHOLD}`);
  }
  if (noveltySignal === 'low') reasons.push('novelty signal is low');
  // Fail-safe: a missing reviewer result means the result cannot be confirmed.
  if (cvScore == null || noveltySignal == null) reasons.push('evaluation results are incomplete');
  return reasons;
}

// Build the full trust model the completion card renders. history is the run's agent
// turns (CV, RQSupervisor, Novelty already settled by the time p53 ceases).
export function buildTrustModel({ history = [], researchQuestion } = {}) {
  const turns = Array.isArray(history) ? history : [];
  const cv = lastResult(turns, 'CV');
  const rq = lastResult(turns, 'RQSupervisor');
  const novelty = lastResult(turns, 'Novelty Checker');

  const cvScore = cv && typeof cv.score === 'number' ? cv.score : null;
  const noveltySignal = novelty && typeof novelty.novelty_signal === 'string' ? novelty.novelty_signal : null;
  const paradigm = rq && typeof rq.paradigm === 'string' ? rq.paradigm : null;
  const paradigmRationale = rq && Array.isArray(rq.feedback) ? rq.feedback.filter((f) => typeof f === 'string') : [];
  const noveltyRationale = novelty && typeof novelty.rationale === 'string' ? novelty.rationale : '';
  const overlappingPapers =
    novelty && Array.isArray(novelty.overlapping_papers)
      ? novelty.overlapping_papers.filter((p) => typeof p === 'string')
      : [];

  const confidence = confidenceFromNovelty(noveltySignal);
  // The tooltip carries the raw rationale from the Novelty Checker plus the
  // RQSupervisor feedback (the two reviewers behind the confidence).
  confidence.tooltip = [noveltyRationale, ...paradigmRationale].filter(Boolean).join(' / ');

  // Fail safe: the spec rule plus missing data (an unconfirmable result needs eyes).
  const dataIncomplete = cvScore == null || noveltySignal == null;
  const needsReview = requiresHumanReview({ cvScore, noveltySignal }) || dataIncomplete;

  return {
    researchQuestion: researchQuestion == null ? null : String(researchQuestion),
    paradigm,
    noveltySignal,
    confidence,
    requiresHumanReview: needsReview,
    reviewReasons: reviewReasons(cvScore, noveltySignal),
    evaluation: {
      cvScore,
      resolvedBlockingFields: resolvedBlockingFields(turns),
      paradigm,
      paradigmRationale,
      noveltySignal,
      noveltyRationale,
      overlappingPapers,
    },
  };
}
