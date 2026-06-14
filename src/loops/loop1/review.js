// Loop 1 review verdicts.
//
// The backstage review agents (CV completeness, RQSupervisor structure) can each
// send the chain back to Poe with something for the researcher to address. Poe
// consumes the latest such verdict through its readReviewVerdict seam; this module
// is the adapter from those agents' FINAL packets to Poe's { passed, blocking }
// interface.
//
// Charter boundary: the reviewers' packet shapes (CV's { status, blocking_fields },
// RQSupervisor's { revision_required, feedback }) are FINAL. This module reads the
// small documented fields it was told about and normalizes them; it owns Poe's
// consumption interface, not the reviewers' contracts.

// Map one reviewer's result to Poe's interface, or null if the entry is not a
// recognized reviewer packet.
function verdictOf(entry) {
  if (!entry || !entry.packet) return null;
  const result = entry.packet.result;
  if (!result || typeof result !== 'object') return null;
  if (entry.agentId === 'CV') {
    return {
      passed: result.status === 'pass',
      blocking: Array.isArray(result.blocking_fields) ? result.blocking_fields : [],
    };
  }
  if (entry.agentId === 'RQSupervisor') {
    return {
      passed: !result.revision_required,
      blocking: Array.isArray(result.feedback) ? result.feedback : [],
    };
  }
  return null;
}

// Scan the orchestrator history back to the most recent reviewer to weigh in (CV
// or RQSupervisor) and return its verdict for Poe, or null when none has run. The
// latest reviewer is what Poe must address next: a fresh CV completeness fail, or
// an RQSupervisor structure revision, whichever happened last.
export function reviewVerdictFromHistory(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const verdict = verdictOf(history[i]);
    if (verdict) return verdict;
  }
  return null;
}
