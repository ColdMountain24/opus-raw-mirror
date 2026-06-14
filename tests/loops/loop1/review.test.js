import { describe, expect, it } from 'vitest';
import { reviewVerdictFromHistory } from '../../../src/loops/loop1/review.js';

// The review adapter: maps the latest CV or RQSupervisor packet in the
// orchestrator history to Poe's { passed, blocking } interface.

const poeTurn = { agentId: 'Poe', packet: { agentId: 'Poe', content: 'q' } };
const cvTurn = (status, blocking_fields) => ({
  agentId: 'CV',
  packet: { agentId: 'CV', result: { status, score: status === 'pass' ? 1 : 0.3, blocking_fields } },
});
const rqTurn = (revision_required, feedback, paradigm = 'clinical') => ({
  agentId: 'RQSupervisor',
  packet: {
    agentId: 'RQSupervisor',
    result: { approved: !revision_required, paradigm, feedback, revision_required },
  },
});

describe('reviewVerdictFromHistory', () => {
  it('returns null when no reviewer has run', () => {
    expect(reviewVerdictFromHistory([])).toBe(null);
    expect(reviewVerdictFromHistory([poeTurn])).toBe(null);
  });

  it('maps a CV verdict to { passed, blocking }', () => {
    expect(reviewVerdictFromHistory([poeTurn, cvTurn('fail', ['the population'])])).toEqual({
      passed: false,
      blocking: ['the population'],
    });
    expect(reviewVerdictFromHistory([poeTurn, cvTurn('pass', [])])).toEqual({
      passed: true,
      blocking: [],
    });
  });

  it('maps an RQSupervisor verdict, using its feedback as the blocking items', () => {
    expect(
      reviewVerdictFromHistory([poeTurn, cvTurn('pass', []), rqTurn(true, ['scope is too broad'])]),
    ).toEqual({ passed: false, blocking: ['scope is too broad'] });
    expect(
      reviewVerdictFromHistory([poeTurn, cvTurn('pass', []), rqTurn(false, [])]),
    ).toEqual({ passed: true, blocking: [] });
  });

  it('returns the most recent reviewer when both have run', () => {
    // CV passed, then RQSupervisor required a revision: the structure revision wins.
    const history = [poeTurn, cvTurn('pass', []), rqTurn(true, ['inconsistent outcome'])];
    expect(reviewVerdictFromHistory(history)).toEqual({
      passed: false,
      blocking: ['inconsistent outcome'],
    });
    // A later CV re-check after another Poe turn supersedes the RQSupervisor entry.
    history.push(poeTurn, cvTurn('fail', ['missing comparison']));
    expect(reviewVerdictFromHistory(history)).toEqual({
      passed: false,
      blocking: ['missing comparison'],
    });
  });

  it('tolerates malformed entries and missing fields', () => {
    expect(reviewVerdictFromHistory([null, { agentId: 'CV' }, {}])).toBe(null);
    expect(reviewVerdictFromHistory([{ agentId: 'CV', packet: { result: { status: 'fail' } } }])).toEqual({
      passed: false,
      blocking: [],
    });
  });
});
