# Workflow Eval LLM-Judge Rubric

This rubric defines how an LLM judge grades a workflow eval run. The five evals in
`workflows.js` are the deterministic, executable gate (they pass or fail on exact
assertions). This rubric is the qualitative layer on top: it scores the behavior a
run exhibits so regressions in quality (not just hard failures) can be tracked
over time against a baseline.

Scope note: in S0 there is no live LLM judge wired (no real network, no agent
output to grade). The deterministic gate (`gate.js`, `run.js`) is what actually
blocks a session. This rubric is the framework a judge will apply once loops drive
real LLM calls; per the Autonomy Charter, the judge grades observable spine and
agent behavior, it does not define agent semantics.

## What the judge reads

Per eval, the judge is given: the eval name and description, the call spec(s)
dispatched, the value(s) returned to the caller, the per-provider call counts, the
circuit-breaker state, and the ordered event log the spine emitted. It scores each
criterion below from that transcript.

## Criteria

Each criterion is scored 0-4:

- **4** fully correct, no concerns
- **3** correct with a minor concern
- **2** partially correct (a material gap)
- **1** mostly incorrect
- **0** absent or wrong

### task_completion
Did the workflow reach the correct end state for its intent? The right value
reached the caller, the call landed on (or was correctly withheld from) the
expected provider, and the observable outcome matches the eval's description.
- 4: exact expected outcome (correct value, correct provider/routing).
- 2: an outcome was produced but via the wrong path or with the wrong attribution.
- 0: wrong or no result.

### schema_validity
Does every value handed back to the caller satisfy the caller schema, or, when
validation could not be satisfied, is it exactly the caller-supplied safe default?
The dispatcher never invents or partially returns agent values.
- 4: returned value passes the schema, or is precisely the declared safe default.
- 2: a borderline or coerced value slips through.
- 0: an unvalidated or malformed value reaches the caller.

### no_silent_errors
Is every failure path observable? Each retry, failover, breaker transition, cache
event, HIPAA enforcement, and safe-default fallback emits a typed event; nothing
is swallowed; degradation is honest (no fabricated success).
- 4: every transition and failure is represented in the event log with context.
- 2: an event is missing or under-specified but the outcome is still inferable.
- 0: a failure happened with no trace (silent swallow) or a faked success.

### fallback_path_correct
Did routing follow the PLAYBOOK order: HIPAA enforced before provider selection,
cache checked before any call, failover walking the configured sequence, breaker
gating an OPEN provider, retry honoring retry-after and only on 429/5xx/timeout,
corrective retry before safe default?
- 4: the path matches the PLAYBOOK exactly for the scenario.
- 2: the right destination via a slightly wrong path (e.g., an out-of-order step).
- 0: wrong routing (e.g., a hosted call under HIPAA, or a 4xx retried).

## Weights

The weighted score is the dot product of criterion scores and these weights:

| Criterion             | Weight |
| --------------------- | ------ |
| task_completion       | 0.35   |
| fallback_path_correct | 0.30   |
| schema_validity       | 0.20   |
| no_silent_errors      | 0.15   |

Weights sum to 1.0, so the weighted average is on the same 0-4 scale as the
individual criteria. A run's overall score is the mean weighted score across the
five evals.

## Baseline

The baseline is a clean run: every criterion scores **4.0**, so the weighted
average baseline is **4.0**. Record the baseline scores alongside each release so
drift is measured against the last known-good run, not against the abstract max.

## Alert thresholds

Raise an alert when, compared with the recorded baseline:

- **any single criterion drops more than 50%** (from a baseline of 4.0, a score
  below **2.0**), or
- **the weighted average drops more than 30%** (from a baseline of 4.0, below
  **2.8**).

An alert is a regression signal for review; it is independent of the deterministic
gate, which blocks a session on any hard eval FAIL regardless of these scores.
