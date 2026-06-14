import { describe, expect, it, vi } from 'vitest';
import {
  createNoveltyCheckerAgent,
  noveltyResultSchema,
  NOVELTY_SAFE_DEFAULT,
  EXTRACTION_TIER,
} from '../../../src/loops/loop1/agents/noveltychecker.js';
import { NOVELTY_SYSTEM_PROMPT } from '../../../src/loops/loop1/prompts.js';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';

// Novelty Checker configured as the Loop 1 novelty assessor. Tests inject a fake
// dispatch and a fake Edgar (the Novelty Checker invokes Edgar as its tool).

const high = { novelty_signal: 'high', rationale: 'Distinct combination.', overlapping_papers: [] };
const low = {
  novelty_signal: 'low',
  rationale: 'Closely mirrors prior work.',
  overlapping_papers: ['A prior study'],
};

// A fake Edgar that returns a retrieval packet and records the ctx it was given.
function fakeEdgar(papers = []) {
  const fn = vi.fn(async (ctx) => {
    fn.ctx = ctx;
    return {
      agentId: 'Edgar Allan',
      result: { papers, query_used: 'q', retrieval_count: papers.length },
    };
  });
  return fn;
}

function fakePoe() {
  const calls = { receive: [], settle: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn(),
    showThinking: vi.fn(),
  };
}

describe('Novelty Checker Loop 1 novelty assessor', () => {
  it('invokes Edgar, runs on the extraction tier, and is attributed to the Novelty Checker', async () => {
    const edgar = fakeEdgar([{ title: 'P' }]);
    const dispatch = vi.fn(async () => high);
    const step = createNoveltyCheckerAgent({ dispatch, edgar });
    const packet = await step({ session: { rqPacket: { version: 6 }, rqVersion: 6 } });

    expect(edgar).toHaveBeenCalledTimes(1);
    expect(packet.agentId).toBe('Novelty Checker');
    expect(packet.result).toEqual(high);
    expect(packet.retrieval).toEqual({ papers: [{ title: 'P' }], query_used: 'q', retrieval_count: 1 });

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Novelty Checker');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.schema).toBe(noveltyResultSchema);
    expect(spec.safeDefault).toBe(NOVELTY_SAFE_DEFAULT);
  });

  it('passes the RQSupervisor paradigm from history to Edgar', async () => {
    const edgar = fakeEdgar();
    const dispatch = vi.fn(async () => high);
    const step = createNoveltyCheckerAgent({ dispatch, edgar });
    await step({
      session: { rqPacket: {}, researchQuestion: 'does X cause Y' },
      history: [
        { agentId: 'RQSupervisor', packet: { agentId: 'RQSupervisor', result: { paradigm: 'clinical' } } },
      ],
    });
    expect(edgar.ctx.paradigm).toBe('clinical');
    expect(edgar.ctx.researchQuestion).toBe('does X cause Y');
  });

  it('sends the RQPacket and the retrieved papers to dispatch', async () => {
    const edgar = fakeEdgar([{ title: 'Overlap', source: 'arxiv' }]);
    const dispatch = vi.fn(async () => high);
    const step = createNoveltyCheckerAgent({ dispatch, edgar });
    await step({ session: { rqPacket: { version: 2, q: 'opaque' } } });
    const msgs = dispatch.mock.calls[0][0].messages;
    expect(msgs[0]).toEqual({ role: 'system', content: NOVELTY_SYSTEM_PROMPT });
    const user = msgs.find((m) => m.role === 'user');
    expect(user.content).toContain('"q": "opaque"');
    expect(user.content).toContain('"title": "Overlap"');
  });

  it('always routes forward to p53 (high signal does not block)', async () => {
    const step = createNoveltyCheckerAgent({ dispatch: vi.fn(async () => high), edgar: fakeEdgar() });
    const packet = await step({ session: { rqPacket: {} } });
    expect(packet.control).toEqual({ transition: STATES.P53_EVALUATE });
    expect(packet.warning).toBe(null);
  });

  it('on a low signal, attaches a non-blocking warning and still routes forward', async () => {
    const session = { rqPacket: {} };
    const step = createNoveltyCheckerAgent({ dispatch: vi.fn(async () => low), edgar: fakeEdgar() });
    const packet = await step({ session });
    // Warning carried, but the chain still proceeds to p53: the researcher decides.
    expect(packet.control).toEqual({ transition: STATES.P53_EVALUATE });
    expect(packet.warning).toMatchObject({ kind: 'low_novelty', overlapping_papers: ['A prior study'] });
    expect(session.noveltyWarning).toBe(packet.warning); // carried forward for the cessation card
  });

  it('falls back to a low, cautioning safe default when novelty cannot be assessed', async () => {
    const step = createNoveltyCheckerAgent({
      dispatch: vi.fn(async (spec) => spec.safeDefault),
      edgar: fakeEdgar(),
    });
    const packet = await step({ session: { rqPacket: {} } });
    expect(packet.result).toEqual(NOVELTY_SAFE_DEFAULT);
    expect(packet.result.novelty_signal).toBe('low');
    expect(packet.warning).toMatchObject({ kind: 'low_novelty' });
    expect(packet.control).toEqual({ transition: STATES.P53_EVALUATE }); // still does not block
  });

  it('noveltyResultSchema accepts the contract and rejects off-contract values', () => {
    expect(noveltyResultSchema(high)).toBe(true);
    expect(noveltyResultSchema(low)).toBe(true);
    expect(noveltyResultSchema({ novelty_signal: 'none', rationale: 'x', overlapping_papers: [] })).toBe(false);
    expect(noveltyResultSchema({ novelty_signal: 'high', rationale: 1, overlapping_papers: [] })).toBe(false);
    expect(noveltyResultSchema({ novelty_signal: 'high', rationale: 'x', overlapping_papers: 'no' })).toBe(false);
    expect(noveltyResultSchema({ novelty_signal: 'high', rationale: 'x', overlapping_papers: [3] })).toBe(false);
    expect(noveltyResultSchema(null)).toBe(false);
  });

  it('in the orchestrator: routes past EDGAR_RETRIEVE to p53, settles to the IO panel', async () => {
    const seen = [];
    const novelty = createNoveltyCheckerAgent({ dispatch: vi.fn(async () => high), edgar: fakeEdgar([{ title: 'P' }]) });
    const states = [];
    const poe = fakePoe();
    const orch = createLoop1Orchestrator({
      poe,
      agents: { 'Novelty Checker': novelty },
      packet: { setPacket: (p) => seen.push(p) },
      onStateChange: (s) => states.push(s),
    });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('q');

    expect(orch.getState()).toBe(STATES.COMPLETE);
    // The walk skips EDGAR_RETRIEVE: Novelty invoked Edgar itself.
    expect(states).not.toContain(STATES.EDGAR_RETRIEVE);
    expect(states).toContain(STATES.P53_EVALUATE);
    // Backstage: settled, never a conversation card; its packet went to the IO panel.
    expect(poe.calls.settle).toContain('Novelty Checker');
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']);
    const np = seen.find((p) => p.agentId === 'Novelty Checker');
    expect(np.result).toEqual(high);
    expect(np.retrieval.retrieval_count).toBe(1);
  });
});
