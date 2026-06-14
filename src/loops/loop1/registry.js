// S1 status-copy registry for Loop 1 (The Agora).
//
// Poe resolves status copy as registry[agentId][key]; the orchestrator drives it
// with two keys per agent: "running" (shown while the agent works) and "complete"
// (the confirmed message shown as its turn finalizes). The agent ids are the same
// strings the orchestrator maps states to, and Poe renders them verbatim as the
// [AGENT] bracket, so they must not be renamed.
//
// The copy itself is supplied by the architecture (not Opus-owned). There is no
// generic "Loading..." anywhere: every agent has unique running and complete copy.

export const STATUS_COPY = Object.freeze({
  Poe: { running: 'Listening...', complete: 'Ready' },
  CV: {
    running: 'Validating research question...',
    complete: 'Completeness check done',
  },
  RQSupervisor: {
    running: 'Reviewing question structure...',
    complete: 'Supervision complete',
  },
  p53: {
    running: 'Evaluating cessation conditions...',
    complete: 'Cessation evaluated',
  },
  'Novelty Checker': {
    running: 'Scanning for novelty signals...',
    complete: 'Novelty check complete',
  },
  'Edgar Allan': {
    running: 'Retrieving literature...',
    complete: 'Literature retrieved',
  },
});
