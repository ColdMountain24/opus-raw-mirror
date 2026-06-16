// S2 status-copy registry for Loop 2 (The Archive).
//
// Same contract as Loop 1's registry: Poe resolves status copy as
// registry[agentId][key] with two keys per agent, "running" (shown while the agent
// works) and "complete" (the confirmed message as its turn finalizes). The agent ids
// are the strings the orchestrator maps states to (and Poe renders verbatim as the
// [AGENT] bracket), so they must not be renamed.
//
// The nine worker agents' copy is the user-supplied FINAL table; Poe and the two
// DETERMINISTIC control points (Revision Check = RQ_REVISION_CHECK, Packager =
// OUTPUT_HOOK; no LLM) carry presentation copy Opus owns. Senior Grad Student, Skips,
// and Edgar Allan are internal tools (no dedicated state) - their copy is here for the
// later phases that invoke them inside a parent agent's step. No generic "Loading...".

export const STATUS_COPY = Object.freeze({
  Poe: { running: 'Preparing the archive...', complete: 'Ready' },
  'Fearless Leader': {
    running: 'Mapping subspecializations...',
    complete: 'Subspecialization plan ready',
  },
  'Grad Students': {
    running: 'Extracting claims from literature...',
    complete: 'Extraction complete',
  },
  'Senior Grad Student': {
    running: 'Reviewing extraction quality...',
    complete: 'Quality review done',
  },
  Bookkeeper: {
    running: 'Promoting to knowledge graph...',
    complete: 'KG updated',
  },
  'Post-Doc': {
    running: 'Synthesizing findings...',
    complete: 'Synthesis complete',
  },
  Salvia: {
    running: 'Detecting uncertainty signals...',
    complete: 'Uncertainty check done',
  },
  Skips: {
    running: 'Scanning for contradictions and unknowns...',
    complete: 'Contradiction scan complete',
  },
  'Edgar Allan': {
    running: 'Retrieving papers for subspecialization...',
    complete: 'Literature retrieved',
  },
  p53: {
    running: 'Evaluating cessation conditions...',
    complete: 'Cessation evaluated',
  },
  // Deterministic control points (no LLM): unique copy so the indicator is never generic.
  'Revision Check': {
    running: 'Checking the question against the evidence...',
    complete: 'Revision check done',
  },
  Packager: {
    running: 'Packaging the Loop 3 input...',
    complete: 'Packaged for Loop 3',
  },
});
