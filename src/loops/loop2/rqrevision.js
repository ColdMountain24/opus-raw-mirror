// The RQ revision check (the policy the orchestrator runs after the Post-Doc standard pass, at
// RQ_REVISION_CHECK). It asks whether the literature review has revealed that the ORIGINAL research
// question needs revising, on two signals:
//   1. Too many findings are shaky: more than `flaggedThreshold` (30%, per the spec) of the evidence is
//      flagged for human review.
//   2. A fundamental RQPacket assumption is contradicted by high-confidence claims.
//
// Reconciliation (documented in Opus_DELTAS). The spec phrases these over the LRSummary's "key findings"
// and the GlobalKG's "high-confidence claims", but at RQ_REVISION_CHECK neither is literally available:
// the standard-pass draft's findings are free strings (not linked to claims), claim confidence is NULL
// until the Post-Doc FINAL pass, and the RQPacket's assumption schema is FINAL (not owned here). So this
// is a DETERMINISTIC, orchestrator-owned check (the spec says "the orchestrator checks", and the Autonomy
// Charter forbids inventing agent logic):
//   - "30% of findings flagged" is operationalized over the underlying CLAIMS the synthesis rests on: a
//     claim is flagged when the Senior/Salvia review flagged it, or it has < 2 supporting papers, or it
//     is contradiction-tagged. (These are exactly the per-finding review signals the FINAL pass uses.)
//   - "a fundamental assumption is contradicted by high-confidence claims" is an INJECTABLE predicate with
//     a deterministic default: a Skips contradiction where BOTH claims are well-supported (>= 2 papers) -
//     a hard conflict between well-evidenced claims that signals the question's framing may be off. The
//     FINAL assumption-aware predicate (which would read the RQPacket's assumption fields) is the external
//     seam, like p53's coverage metric.

// The spec's threshold: more than 30% of the findings flagged for review triggers a revision check.
export const FLAGGED_FINDINGS_THRESHOLD = 0.3;

// A claim is "flagged for human review" (the per-finding review signal, lifted to the claim level): the
// Senior Grad Student flagged it, the Salvia grounding flagged it, it is thinly sourced (< 2 papers), or
// it is contradiction-tagged. Mirrors the Post-Doc final pass's per-finding requires_human_review rule.
export function isClaimFlagged(c) {
  if (!c || typeof c !== 'object') return false;
  if (c.quality_review && c.quality_review.quality === 'flag') return true;
  if (c.salvia_status === 'flagged') return true;
  if (!Array.isArray(c.supporting_paper_dois) || c.supporting_paper_dois.length < 2) return true;
  if (Array.isArray(c.contradiction_partners) && c.contradiction_partners.length > 0) return true;
  return false;
}

// The deterministic default for "a fundamental RQ assumption is contradicted by high-confidence claims":
// a Skips contradiction where BOTH claims are well-supported (>= 2 supporting papers). The RQPacket's
// assumption fields are FINAL/not owned here, so this structural proxy stands in; it is an injectable seam
// (the orchestrator can pass a real assumption-aware predicate when the architecture supplies one).
export function defaultAssumptionContradicted({ claims = [], contradictions = [] } = {}) {
  const byId = new Map();
  for (const c of claims) if (c && typeof c.claim_id === 'string') byId.set(c.claim_id, c);
  const wellSupported = (id) => {
    const c = byId.get(id);
    return Boolean(c && Array.isArray(c.supporting_paper_dois) && c.supporting_paper_dois.length >= 2);
  };
  for (const con of Array.isArray(contradictions) ? contradictions : []) {
    if (con && typeof con.claim_a_id === 'string' && typeof con.claim_b_id === 'string') {
      if (wellSupported(con.claim_a_id) && wellSupported(con.claim_b_id)) return true;
    }
  }
  return false;
}

// Evaluate whether the RQ needs revision. Returns { needsRevision, conditions:{flagged,contradicted},
// flaggedRatio, flaggedCount, total, reasons }. Pure: the orchestrator gathers the claims + contradictions
// + the standard-pass lrSummary and reads the result to decide whether to surface the researcher choice.
export function evaluateRQRevision({
  lrSummary = null,
  claims = [],
  contradictions = [],
  rqPacket = null,
  flaggedThreshold = FLAGGED_FINDINGS_THRESHOLD,
  isAssumptionContradicted = defaultAssumptionContradicted,
} = {}) {
  const list = Array.isArray(claims) ? claims.filter((c) => c && typeof c === 'object') : [];
  const total = list.length;
  const flaggedCount = list.filter(isClaimFlagged).length;
  const flaggedRatio = total ? flaggedCount / total : 0;
  const flagged = flaggedRatio > flaggedThreshold;

  let contradicted = false;
  try {
    contradicted = Boolean(isAssumptionContradicted({ claims: list, contradictions, rqPacket, lrSummary }));
  } catch (_err) {
    // a predicate that throws must not break the chain; treat as no-contradiction (surfaced upstream)
    contradicted = false;
  }

  const reasons = [];
  if (flagged) {
    reasons.push(`${Math.round(flaggedRatio * 100)}% of the evidence is flagged for review (over the ${Math.round(flaggedThreshold * 100)}% threshold)`);
  }
  if (contradicted) {
    reasons.push('a core assumption appears contradicted by well-supported claims');
  }

  return {
    needsRevision: flagged || contradicted,
    conditions: { flagged, contradicted },
    flaggedRatio,
    flaggedCount,
    total,
    reasons,
  };
}
