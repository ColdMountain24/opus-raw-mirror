import { describe, expect, it, vi } from 'vitest';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';
import { createPoeAgent } from '../../../src/loops/loop1/agents/poe.js';
import { createCVAgent } from '../../../src/loops/loop1/agents/cv.js';
import { createRQSupervisorAgent } from '../../../src/loops/loop1/agents/rqsupervisor.js';
import { createNoveltyCheckerAgent } from '../../../src/loops/loop1/agents/noveltychecker.js';
import { createP53Agent } from '../../../src/loops/loop1/agents/p53.js';
import { createExtractor } from '../../../src/loops/loop1/extraction.js';
import { createOutputHook } from '../../../src/loops/loop1/outputhook.js';
import { reviewVerdictFromHistory } from '../../../src/loops/loop1/review.js';

// End to end: a research question runs the whole Loop 1 pipeline with the real agents
// (fake dispatches stand in for the providers) and reaches a validated RQPacket in
// the session store, Loop 2 unlocked, and the cessation card with its trust layer.

const completeExtraction = {
  KnowledgeGap: 'unclear whether fasting aids memory',
  ObjectOfInquiry: 'intermittent fasting and working memory',
  InvestigationWorkflow: 'a 12 week parallel randomized trial',
  ValidationCriteria: 'change in n-back score at 12 weeks',
  Claims: 'fasting improves working memory',
  Scope: {
    Population: 'adults 50 to 70',
    Setting: 'outpatient clinic',
    InclusionCriteria: 'healthy adults',
    ExclusionCriteria: 'diabetes',
    Timeframe: '12 weeks',
    SpatialBoundary: 'single site',
    DomainBoundary: 'cognitive aging',
  },
  ParadigmClass: 'clinical',
  Subdomain: 'cognitive aging',
  Design: 'randomized_controlled_trial',
  StudyPhase: null,
  UnknownFields: [],
  IrrelevantFields: [],
};

function fakePoe() {
  const cards = [];
  const calls = { receive: [], settle: [] };
  return {
    cards,
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((id) => calls.settle.push(id)),
    stream: vi.fn(),
    showThinking: vi.fn(),
    cessationCard: vi.fn((spec) => cards.push(spec)),
  };
}

describe('Loop 1 pipeline (end to end)', () => {
  it('a confirmed research question produces a validated RQPacket, unlocks Loop 2, and renders the trust-layer card', async () => {
    const poe = fakePoe();
    const saved = [];
    const unlocked = [];
    let proceeded = 0;
    const storage = { session: { load: async () => null, save: async (s) => saved.push(s) } };

    const outputHook = createOutputHook({
      poe,
      storage,
      markLoopComplete: (n) => unlocked.push(n),
      onProceed: () => { proceeded += 1; },
      clock: () => 42,
    });

    const fakeEdgar = async () => ({
      agentId: 'Edgar Allan',
      result: { papers: [], query_used: 'fasting memory', retrieval_count: 0 },
      control: {},
    });

    const agents = {
      Poe: createPoeAgent({
        dispatch: async () => ({ message: 'Which population and over what timeframe?' }),
        extractRQPacket: createExtractor({ dispatch: async () => completeExtraction }),
        readReviewVerdict: reviewVerdictFromHistory,
      }),
      CV: createCVAgent(), // deterministic over the extracted packet
      RQSupervisor: createRQSupervisorAgent({
        dispatch: async () => ({ approved: true, paradigm: 'clinical', feedback: [], revision_required: false }),
      }),
      'Novelty Checker': createNoveltyCheckerAgent({
        edgar: fakeEdgar,
        dispatch: async () => ({ novelty_signal: 'high', rationale: 'no close prior work', overlapping_papers: [] }),
      }),
      p53: createP53Agent({ output: outputHook }),
    };

    const composerStates = [];
    const orch = createLoop1Orchestrator({ poe, agents, onComposer: (s) => composerStates.push(s) });
    orch.mount(document.createElement('div'));
    await orch.start();

    // The researcher states the question. The chain runs: extraction fills the packet,
    // CV passes it (complete), RQSupervisor approves, Novelty checks, p53 continues
    // (not yet confirmed) and the machine waits at POE_INTAKE.
    await orch.submit('Does intermittent fasting improve working memory in older adults?');
    expect(orch.getState()).toBe(STATES.POE_INTAKE);

    // The packet CV scored is complete (a real, validated packet), with the framework
    // resolved from the design.
    const packet = orch.getSession().rqPacket;
    expect(packet.KnowledgeGap).toBe('unclear whether fasting aids memory');
    expect(packet.Frameworks).toEqual(['CONSORT']);

    // Confirm is now available (the review passed).
    expect(orch.canConfirm()).toBe(true);
    expect(saved).toHaveLength(0); // nothing ceased yet

    // The researcher confirms: p53 ceases, the Output Hook fires.
    await orch.confirm();
    expect(orch.getState()).toBe(STATES.COMPLETE);

    // 1. a validated RQPacket in the session store.
    expect(saved).toHaveLength(1);
    expect(saved[0].rqPacket.KnowledgeGap).toBe('unclear whether fasting aids memory');
    expect(saved[0].rqPacket.Frameworks).toEqual(['CONSORT']);
    expect(saved[0].requiresHumanReview).toBe(false); // CV 1.0 + high novelty
    expect(saved[0].completedLoops).toEqual([1]);

    // 2. Loop 2 unlocked in the navigator.
    expect(unlocked).toEqual([1]);

    // 3. the cessation card with its trust layer, in the conversation.
    expect(poe.cards).toHaveLength(1);
    const card = poe.cards[0];
    expect(card.researchQuestion).toBe('Does intermittent fasting improve working memory in older adults?');
    expect(card.paradigm).toBe('clinical');
    expect(card.confidence.level).toBe('high');
    expect(card.requiresHumanReview).toBe(false);
    expect(card.evaluation.cvScore).toBe(1);

    // The CTA proceeds to Loop 2; the composer is locked.
    card.cta.onClick();
    expect(proceeded).toBe(1);
    expect(composerStates.at(-1)).toEqual({ awaitingInput: false, canConfirm: false, locked: true });
  });

  it('an incomplete question never reaches confirm: CV blocks and the loop keeps eliciting', async () => {
    const poe = fakePoe();
    const partial = { ...completeExtraction, KnowledgeGap: null, Scope: { ...completeExtraction.Scope, Population: null } };

    const agents = {
      Poe: createPoeAgent({
        dispatch: async () => ({ message: 'Tell me more about the population.' }),
        extractRQPacket: createExtractor({ dispatch: async () => partial }),
        readReviewVerdict: reviewVerdictFromHistory,
      }),
      CV: createCVAgent(),
    };

    const orch = createLoop1Orchestrator({ poe, agents });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('half an idea');

    // CV failed (incomplete), routing back to Poe; confirm is not available.
    expect(orch.getState()).toBe(STATES.POE_INTAKE);
    expect(orch.canConfirm()).toBe(false);
  });
});
