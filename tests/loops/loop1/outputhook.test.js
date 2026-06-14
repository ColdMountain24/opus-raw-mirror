import { describe, expect, it, vi } from 'vitest';
import { createOutputHook } from '../../../src/loops/loop1/outputhook.js';
import { createP53Agent, P53_STATES } from '../../../src/loops/loop1/agents/p53.js';

// The Output Hook is the real implementation of p53's output seam: on CEASE it
// persists the RQPacket, unlocks the next loop, and renders the completion card with
// its trust layer (derived from the run history via trust.js). It is dispatch-free;
// tests inject fakes for Poe, storage, and the navigator.

function fakePoe() {
  const cards = [];
  return {
    cards,
    cessationCard: vi.fn((spec) => {
      cards.push(spec);
      return {};
    }),
  };
}

function fakeStorage(initial = null) {
  const saved = [];
  return {
    saved,
    session: {
      load: vi.fn(async () => initial),
      save: vi.fn(async (state) => {
        saved.push(state);
        return true;
      }),
    },
  };
}

const cv = (score, blocking = []) => ({
  agentId: 'CV',
  packet: { result: { status: 'pass', score, blocking_fields: blocking } },
});
const rq = (paradigm, feedback = []) => ({
  agentId: 'RQSupervisor',
  packet: { result: { approved: true, paradigm, feedback, revision_required: false } },
});
const novelty = (signal, rationale = '', overlapping = []) => ({
  agentId: 'Novelty Checker',
  packet: { result: { novelty_signal: signal, rationale, overlapping_papers: overlapping } },
});

describe('Loop 1 Output Hook', () => {
  it('on CEASE persists the RQPacket, unlocks the next loop, and renders the trust-layer card', async () => {
    const poe = fakePoe();
    const storage = fakeStorage();
    const markLoopComplete = vi.fn();
    const onProceed = vi.fn();
    const hook = createOutputHook({ poe, storage, markLoopComplete, onProceed, clock: () => 1234 });

    const history = [cv(0.95, []), rq('clinical', ['scope is appropriate']), novelty('high', 'novel work', ['Prior A'])];
    await hook({ version: 5 }, { researchQuestion: 'Does fasting improve memory in older adults?', history });

    // 1. persisted: the RQPacket and the completion record (with the trust flag).
    const state = storage.saved[0];
    expect(state.rqPacket).toEqual({ version: 5 });
    expect(state.completedLoops).toContain(1);
    expect(state.completedAt).toBe(1234);
    expect(state.paradigm).toBe('clinical');
    expect(state.requiresHumanReview).toBe(false);
    expect(state.confidence).toBe('high');

    // 2. unlocked.
    expect(markLoopComplete).toHaveBeenCalledWith(1);

    // 3. card spec carries the full trust model derived from history.
    const spec = poe.cards[0];
    expect(spec.researchQuestion).toBe('Does fasting improve memory in older adults?');
    expect(spec.paradigm).toBe('clinical');
    expect(spec.noveltySignal).toBe('high');
    expect(spec.confidence).toMatchObject({ level: 'high', label: 'Well-supported' });
    expect(spec.requiresHumanReview).toBe(false);
    expect(spec.evaluation.cvScore).toBe(0.95);
    expect(spec.evaluation.overlappingPapers).toEqual(['Prior A']);
    expect(spec.cta.label).toBe('Proceed to Literature Review');

    spec.cta.onClick();
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it('persists requires_human_review and passes it to the card when completeness is low', async () => {
    const poe = fakePoe();
    const storage = fakeStorage();
    const hook = createOutputHook({ poe, storage, markLoopComplete: () => {} });

    const history = [cv(0.7, []), rq('computational', []), novelty('high', 'x', [])];
    await hook({ version: 1 }, { researchQuestion: 'q', history });

    expect(storage.saved[0].requiresHumanReview).toBe(true);
    expect(poe.cards[0].requiresHumanReview).toBe(true);
    expect(poe.cards[0].reviewReasons.join(' ')).toMatch(/below 0\.85/);
  });

  it('threads the max-reached warning onto the card and persists maxReached', async () => {
    const poe = fakePoe();
    const storage = fakeStorage();
    const maxWarning = { kind: 'max_reached', iteration: 5, max_iterations: 5, message: 'at the limit' };
    const hook = createOutputHook({ poe, storage, markLoopComplete: () => {} });

    await hook({ version: 1 }, { researchQuestion: 'q', history: [], maxWarning });

    expect(poe.cards[0].maxWarning).toBe(maxWarning);
    expect(storage.saved[0].maxReached).toBe(true);
  });

  it('persists maxReached false and passes no warning when the cap was not hit', async () => {
    const poe = fakePoe();
    const storage = fakeStorage();
    const hook = createOutputHook({ poe, storage, markLoopComplete: () => {} });
    await hook({ version: 1 }, { researchQuestion: 'q', history: [] });
    expect(poe.cards[0].maxWarning).toBeNull();
    expect(storage.saved[0].maxReached).toBe(false);
  });

  it('merges completedLoops non-destructively over an existing session state', async () => {
    const storage = fakeStorage({ id: 'S7', completedLoops: [], foo: 'bar' });
    const hook = createOutputHook({ poe: fakePoe(), storage, markLoopComplete: () => {} });

    await hook({ version: 1 }, { researchQuestion: 'q', history: [] });

    const state = storage.saved[0];
    expect(state.id).toBe('S7'); // prior fields preserved
    expect(state.foo).toBe('bar');
    expect(state.completedLoops).toEqual([1]);
  });

  it('a persistence failure is surfaced (not swallowed) but does not block the unlock or the card', async () => {
    const poe = fakePoe();
    const storage = fakeStorage();
    storage.session.save = vi.fn(async () => {
      throw new Error('QuotaExceeded');
    });
    const markLoopComplete = vi.fn();
    const onError = vi.fn();
    const hook = createOutputHook({ poe, storage, markLoopComplete, onError });

    await hook({ version: 2 }, { researchQuestion: 'q', history: [] });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ step: 'persist', area: 'loop1.outputHook' });
    expect(markLoopComplete).toHaveBeenCalledWith(1);
    expect(poe.cessationCard).toHaveBeenCalledTimes(1);
  });

  it('honors an overridable CTA label and completed-loop number', async () => {
    const poe = fakePoe();
    const markLoopComplete = vi.fn();
    const hook = createOutputHook({
      poe,
      storage: fakeStorage(),
      markLoopComplete,
      ctaLabel: 'Onward',
      completedLoop: 3,
    });

    await hook({ version: 1 }, { researchQuestion: 'q', history: [] });

    expect(poe.cards[0].cta.label).toBe('Onward');
    expect(markLoopComplete).toHaveBeenCalledWith(3);
  });

  it('end to end with p53: a CEASE drives the hook and the trust model is derived from history', async () => {
    const poe = fakePoe();
    const markLoopComplete = vi.fn();
    const hook = createOutputHook({ poe, storage: fakeStorage(), markLoopComplete });
    const p53 = createP53Agent({ output: hook });

    const history = [
      { agentId: 'Poe', packet: { agentId: 'Poe', content: 'q' } },
      cv(1, []),
      rq('clinical', []),
      novelty('medium', 'some overlap', ['P1']),
    ];
    const session = { rqPacket: { version: 9 }, researcherConfirmed: true, researchQuestion: 'Does fasting improve memory?' };

    const packet = await p53({ session, history });
    expect(packet.result.state).toBe(P53_STATES.CEASE);

    const spec = poe.cards[0];
    expect(spec.researchQuestion).toBe('Does fasting improve memory?');
    expect(spec.paradigm).toBe('clinical');
    expect(spec.noveltySignal).toBe('medium');
    expect(spec.confidence.level).toBe('medium');
    expect(spec.evaluation.overlappingPapers).toEqual(['P1']);
    expect(markLoopComplete).toHaveBeenCalledWith(1);
  });
});
