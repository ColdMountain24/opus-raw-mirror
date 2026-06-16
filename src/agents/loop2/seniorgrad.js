// Senior Grad Student, the Loop 2 (The Archive) per-subspecialization quality reviewer.
//
// After a Grad Student extracts a subspecialization's claims, the Senior Grad Student reviews the
// whole batch in ONE dispatch (one call per subspecialization batch) for claim plausibility,
// supporting-evidence sufficiency, and extraction accuracy relative to the paper abstracts. It
// returns one verdict per claim: { claim_id, quality: 'pass' | 'flag' | 'reject', reason }.
// The coordinator (gradphase.js) then APPLIES the verdicts: a 'reject' drops the claim, a 'flag'
// keeps it in the KG with a quality flag, a 'pass' keeps it clean. Backstage: the verdicts are
// surfaced to the IO panel (the Observatory nodes + the claim card review log), never to Poe.
//
// Provider: the extraction tier, Anthropic-first, falling back through the dispatcher (HIPAA
// routing still overrides). One system prompt; the dispatcher's adapters differentiate it per
// provider.
//
// Charter boundary. The Senior Grad Student owns its output contract (the verdict schema, given
// verbatim by the spec) and its safe default. It does NOT own the claim schema (the architecture's
// SubspecializationKG Claim) - it judges the claims it is handed by their claim_id and never
// invents claim content. NOTE: the architecture doc also names a Senior Grad Student PHASE_2
// GeneralKG/CrossSubspecializationNotes synthesizer; that is a separate, still-deferred role (see
// Opus_DELTAS). This module is the quality reviewer the build spec defined.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { SENIOR_GRAD_STUDENT_SYSTEM_PROMPT } from './prompts.js';
// Tiers live under loop1/ (historical home). FUTURE: move to a shared path.
import { EXTRACTION_TIER } from '../../loops/loop1/tiers.js';

export { EXTRACTION_TIER };

// The three verdicts (spec). 'reject' drops the claim; 'flag' keeps it with a quality flag;
// 'pass' keeps it clean.
export const QUALITIES = Object.freeze(['pass', 'flag', 'reject']);

// One review verdict (the model output contract, given verbatim by the spec). Strict on identity
// (a non-empty claim_id the verdict applies to) and the quality enum; the reason is a string and
// may be empty (a verdict with no stated reason is still a verdict).
function isReview(r) {
  return (
    r &&
    typeof r === 'object' &&
    typeof r.claim_id === 'string' &&
    r.claim_id.length > 0 &&
    QUALITIES.includes(r.quality) &&
    typeof r.reason === 'string'
  );
}

export { isReview };

// The Senior Grad Student's output contract: a batch of per-claim verdicts. The dispatcher
// validates against this (corrective retry on a miss, then the safe default).
export function seniorGradResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!Array.isArray(v.reviews)) return false;
  return v.reviews.every(isReview);
}

// The dispatcher safe default when no provider is reachable: NO verdicts. This is deliberately
// non-destructive - applyQualityReviews keeps every claim it has no verdict for (a provider
// outage must never silently drop a subspecialization's claims). The unreviewed count is surfaced
// by the coordinator, not swallowed.
export const SENIOR_GRAD_SAFE_DEFAULT = Object.freeze({ reviews: [] });

// Apply a batch of verdicts to a Grad Student's claims (the spec's KG mutation):
//   reject -> drop the claim; flag -> keep with quality_review { quality:'flag', reason };
//   pass   -> keep with quality_review { quality:'pass', reason }; no verdict -> keep, null.
// Returns { kept, dropped, unreviewed } so the coordinator can render and surface the outcome.
// Pure: it copies each kept claim (never mutates the input) and annotates a quality_review field
// (a review-provenance annotation the later trust layer reads; it is not part of the FINAL claim
// schema, so it is added here, not invented inside the extractor).
export function applyQualityReviews(claims, reviews) {
  const list = Array.isArray(claims) ? claims : [];
  const byId = new Map();
  (Array.isArray(reviews) ? reviews : []).forEach((r) => {
    if (isReview(r) && !byId.has(r.claim_id)) byId.set(r.claim_id, r);
  });

  const kept = [];
  const dropped = [];
  let unreviewed = 0;

  list.forEach((claim) => {
    const verdict = claim && typeof claim.claim_id === 'string' ? byId.get(claim.claim_id) : undefined;
    if (!verdict) {
      unreviewed += 1;
      kept.push({ ...claim, quality_review: null });
      return;
    }
    if (verdict.quality === 'reject') {
      dropped.push({ claim_id: verdict.claim_id, reason: verdict.reason });
      return;
    }
    kept.push({ ...claim, quality_review: { quality: verdict.quality, reason: verdict.reason } });
  });

  return { kept, dropped, unreviewed };
}

// A compact, non-conversational summary for the IO panel.
function summarize(label, reviews) {
  const counts = { pass: 0, flag: 0, reject: 0 };
  reviews.forEach((r) => {
    if (counts[r.quality] !== undefined) counts[r.quality] += 1;
  });
  const n = reviews.length;
  return `Reviewed ${n} claim${n === 1 ? '' : 's'} for ${label || '(subspecialization)'}: ${
    counts.pass
  } passed, ${counts.flag} flagged, ${counts.reject} rejected.`;
}

export function createSeniorGradStudentAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || SENIOR_GRAD_STUDENT_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 1024;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Senior Grad Student', ...data });
    } catch (_err) {
      // logging is best effort and must never break a review
    }
  };

  function claimLine(c, i) {
    const types = Array.isArray(c.claim_type) ? c.claim_type.join(', ') : '';
    const dois = Array.isArray(c.supporting_paper_dois) ? c.supporting_paper_dois.join(', ') : '';
    return (
      `${i + 1}. claim_id: ${c.claim_id}\n` +
      `   text: ${c.text || ''}\n` +
      `   claim_type: ${types}\n` +
      `   supporting_paper_dois: ${dois}`
    );
  }

  function paperLine(p) {
    return `- ${p.title || '(untitled)'} (DOI ${p.doi || 'none'})\n  Abstract: ${p.abstract || ''}`;
  }

  function buildMessages(subspec, claims, papers) {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          `Subspecialization: ${subspec.name || subspec.label || subspec.id || '(unnamed)'} (id ${subspec.id || 'unknown'})\n\n` +
          `Papers the claims were extracted from:\n${papers.map(paperLine).join('\n')}\n\n` +
          `Claims to review (${claims.length}):\n${claims.map(claimLine).join('\n')}\n\n` +
          `Review each claim. Return one verdict per claim, using each claim's exact claim_id.`,
      },
    ];
  }

  // The review step. ctx carries the subspecialization, the Grad Student's claims for it, and the
  // papers they were drawn from. Returns the per-claim verdict batch, attributed to the Senior
  // Grad Student, with no control transition (it is an internal tool, not an orchestrator state).
  return async function seniorGradReview(ctx = {}) {
    const subspec = ctx.subspecialization || {};
    const claims = Array.isArray(ctx.claims) ? ctx.claims : [];
    const papers = Array.isArray(ctx.papers) ? ctx.papers : [];
    const session = ctx.session || {};
    const loopContext = ctx.loopContext || (session && session.loopContext) || undefined;
    const label = subspec.name || subspec.label || subspec.id || '';

    // Nothing to review: skip the dispatch entirely (no quota spent on an empty batch).
    if (claims.length === 0) {
      return {
        agentId: 'Senior Grad Student',
        content: `No claims to review for ${label || '(subspecialization)'}.`,
        result: { subspecialization_id: subspec.id || '', reviews: [] },
        control: {},
      };
    }

    let raw;
    try {
      raw = await dispatch({
        agentId: 'Senior Grad Student',
        tier: 'extraction',
        failover,
        messages: buildMessages(subspec, claims, papers),
        schema: seniorGradResultSchema,
        safeDefault: SENIOR_GRAD_SAFE_DEFAULT,
        maxTokens,
        loopContext,
      });
    } catch (cause) {
      // No silent swallowing: surface the failure, then degrade to "no verdicts" (every claim is
      // kept) rather than dropping the batch.
      emit('seniorgrad:review_error', {
        subspecialization: subspec.id,
        message: cause && cause.message ? cause.message : String(cause),
      });
      raw = SENIOR_GRAD_SAFE_DEFAULT;
    }

    const reviews = seniorGradResultSchema(raw) ? raw.reviews : [];

    return {
      agentId: 'Senior Grad Student',
      content: summarize(label, reviews),
      result: { subspecialization_id: subspec.id || '', reviews },
      control: {},
    };
  };
}

// Default app instance, built against the real dispatch singleton. The PHASE_1 coordinator
// (gradphase.js) injects this and runs it once per subspecialization after that subspecialization's
// Grad Student. Tests build isolated agents with createSeniorGradStudentAgent({ dispatch, ... }).
export const seniorGradStudentAgent = createSeniorGradStudentAgent();
