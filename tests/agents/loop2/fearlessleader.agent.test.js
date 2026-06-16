import { describe, expect, it, vi } from 'vitest';
import {
  createFearlessLeaderAgent,
  fearlessLeaderResultSchema,
  buildSafeDefault,
  FALLBACK_QUERY,
  EXTRACTION_TIER,
} from '../../../src/agents/loop2/fearlessleader.js';
import { FEARLESS_LEADER_SYSTEM_PROMPT } from '../../../src/agents/loop2/prompts.js';
import { createLoop2Orchestrator, STATES } from '../../../src/loops/loop2/orchestrator.js';

// Fearless Leader, the Loop 2 (The Archive) sweep planner. Tests inject a fake
// dispatch; the RQPacket it plans from is opaque (FINAL), so tests hand it an
// arbitrary packet and assert on behavior, never on packet shape.

const plan = {
  subspecializations: [
    { id: 'subspec-1', name: 'Cognitive aging', query: 'fasting working memory older adults', grad_student_count: 2 },
    { id: 'subspec-2', name: 'Metabolic pathways', query: 'intermittent fasting ketone neuroprotection', grad_student_count: 1 },
  ],
  rationale: 'Two distinct subfields the question spans; aging is denser, so it gets more students.',
};

function fakePoe() {
  const calls = { mount: [], setStatus: [], receive: [], settle: [], milestoneCard: [] };
  return {
    calls,
    mount: vi.fn((t, o) => calls.mount.push({ t, o })),
    setStatus: vi.fn(),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn(),
    showThinking: vi.fn(),
    milestoneCard: vi.fn((spec) => calls.milestoneCard.push(spec)),
  };
}

describe('Fearless Leader Loop 2 sweep planner', () => {
  it('runs on the extraction tier (Anthropic-first) and is attributed to Fearless Leader', async () => {
    const dispatch = vi.fn(async () => plan);
    const step = createFearlessLeaderAgent({ dispatch });
    const packet = await step({ rqPacket: { version: 4 }, session: { researchQuestion: 'Does fasting aid memory?' } });

    expect(packet.agentId).toBe('Fearless Leader');
    expect(packet.result).toEqual(plan);

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Fearless Leader');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.failover[0]).toBe('anthropic');
    expect(spec.schema).toBe(fearlessLeaderResultSchema);
    // The safe default handed to the dispatcher is itself on-contract.
    expect(fearlessLeaderResultSchema(spec.safeDefault)).toBe(true);
  });

  it('sends the Fearless Leader prompt, the research question, and the RQPacket', async () => {
    const dispatch = vi.fn(async () => plan);
    const step = createFearlessLeaderAgent({ dispatch });
    await step({ rqPacket: { version: 5, shape: 'opaque' }, session: { researchQuestion: 'Does fasting aid memory?' } });
    const msgs = dispatch.mock.calls[0][0].messages;
    expect(msgs[0]).toEqual({ role: 'system', content: FEARLESS_LEADER_SYSTEM_PROMPT });
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(userMsg.content).toContain('Does fasting aid memory?');
    expect(userMsg.content).toContain('"shape": "opaque"');
  });

  it('threads the unknown-field surfacing context into the prompt and consumes it (consume-once)', async () => {
    const dispatch = vi.fn(async () => plan);
    const step = createFearlessLeaderAgent({ dispatch });
    const session = { researchQuestion: 'Q?', unknownFields: ['long-term effects', 'dosage'] };
    await step({ session, rqPacket: {} });
    const userMsg = dispatch.mock.calls[0][0].messages.find((m) => m.role === 'user');
    expect(userMsg.content).toContain('TARGET them');
    expect(userMsg.content).toContain('long-term effects; dosage');
    // consumed: cleared so the next (non-loop) sweep is not polluted
    expect(session.unknownFields).toEqual([]);
  });

  it('omits the targeted directive on the initial sweep (no unknownFields)', async () => {
    const dispatch = vi.fn(async () => plan);
    const step = createFearlessLeaderAgent({ dispatch });
    await step({ session: { researchQuestion: 'Q?' }, rqPacket: {} });
    const userMsg = dispatch.mock.calls[0][0].messages.find((m) => m.role === 'user');
    expect(userMsg.content).not.toContain('TARGET them');
  });

  it('requests no transition so the chain proceeds forward to PHASE_1', async () => {
    const dispatch = vi.fn(async () => plan);
    const step = createFearlessLeaderAgent({ dispatch });
    const packet = await step({ session: { rqPacket: {} } });
    expect(packet.control).toEqual({});
  });

  it('summarizes the plan (count, students, names) for the IO panel, not the conversation', async () => {
    const dispatch = vi.fn(async () => plan);
    const step = createFearlessLeaderAgent({ dispatch });
    const packet = await step({ session: { rqPacket: {} } });
    expect(packet.content).toContain('2 subspecializations');
    expect(packet.content).toContain('Cognitive aging');
    expect(packet.content).toContain('Metabolic pathways');
    expect(packet.content).toContain('3 grad students'); // 2 + 1
  });

  it('falls back to a degraded single-pass plan on an off-contract result', async () => {
    const bad = createFearlessLeaderAgent({ dispatch: vi.fn(async () => ({ subspecializations: 'nope' })) });
    const packet = await bad({ session: { researchQuestion: 'Does fasting aid memory?' } });
    expect(fearlessLeaderResultSchema(packet.result)).toBe(true);
    expect(packet.result.subspecializations).toHaveLength(1);
    // The degraded sweep queries the inherited research question rather than inventing topics.
    expect(packet.result.subspecializations[0].query).toBe('Does fasting aid memory?');
  });

  it('falls back to the safe default the dispatcher returns when every provider is down', async () => {
    const down = createFearlessLeaderAgent({ dispatch: vi.fn(async (spec) => spec.safeDefault) });
    const packet = await down({ session: { researchQuestion: 'Q?' } });
    expect(fearlessLeaderResultSchema(packet.result)).toBe(true);
    expect(packet.result.subspecializations[0].query).toBe('Q?');
  });

  it('buildSafeDefault is on-contract and uses a generic query when no question is present', () => {
    const withQ = buildSafeDefault({ researchQuestion: 'How does X affect Y?' });
    expect(fearlessLeaderResultSchema(withQ)).toBe(true);
    expect(withQ.subspecializations[0].query).toBe('How does X affect Y?');

    const noQ = buildSafeDefault({});
    expect(fearlessLeaderResultSchema(noQ)).toBe(true);
    expect(noQ.subspecializations[0].query).toBe(FALLBACK_QUERY);
  });

  it('fearlessLeaderResultSchema accepts the contract and rejects off-contract values', () => {
    expect(fearlessLeaderResultSchema(plan)).toBe(true);
    // empty sweep is not a plan
    expect(fearlessLeaderResultSchema({ subspecializations: [], rationale: 'x' })).toBe(false);
    // subspecializations must be an array
    expect(fearlessLeaderResultSchema({ subspecializations: 'x', rationale: 'x' })).toBe(false);
    // rationale must be a string
    expect(fearlessLeaderResultSchema({ subspecializations: plan.subspecializations })).toBe(false);
    // each item needs a non-empty id/name/query
    expect(fearlessLeaderResultSchema({ subspecializations: [{ id: '', name: 'n', query: 'q', grad_student_count: 1 }], rationale: 'x' })).toBe(false);
    expect(fearlessLeaderResultSchema({ subspecializations: [{ id: 'i', name: '', query: 'q', grad_student_count: 1 }], rationale: 'x' })).toBe(false);
    expect(fearlessLeaderResultSchema({ subspecializations: [{ id: 'i', name: 'n', query: '', grad_student_count: 1 }], rationale: 'x' })).toBe(false);
    // grad_student_count must be a positive integer
    expect(fearlessLeaderResultSchema({ subspecializations: [{ id: 'i', name: 'n', query: 'q', grad_student_count: 0 }], rationale: 'x' })).toBe(false);
    expect(fearlessLeaderResultSchema({ subspecializations: [{ id: 'i', name: 'n', query: 'q', grad_student_count: 1.5 }], rationale: 'x' })).toBe(false);
    expect(fearlessLeaderResultSchema({ subspecializations: [{ id: 'i', name: 'n', query: 'q', grad_student_count: '2' }], rationale: 'x' })).toBe(false);
    expect(fearlessLeaderResultSchema(null)).toBe(false);
  });

  it('is backstage in the orchestrator: settles to the IO panel, never the conversation', async () => {
    const dispatch = vi.fn(async () => plan);
    const fl = createFearlessLeaderAgent({ dispatch });
    const seen = [];
    const packetSink = { setPacket: (p) => seen.push(p) };
    const poe = fakePoe();
    const storage = { session: { load: async () => ({ rqPacket: { version: 1 }, researchQuestion: 'Q?' }) } };
    // Inject only the real Fearless Leader; the orchestrator's stub agents carry the
    // rest of the chain. Driven start() -> proceed() through the intake gate.
    const orch = createLoop2Orchestrator({
      poe,
      agents: { 'Fearless Leader': fl },
      packet: packetSink,
      storage,
    });
    await orch.mount(document.createElement('div'));
    await orch.start();
    await orch.proceed();

    expect(poe.calls.settle).toContain('Fearless Leader');
    // The only thing written to the conversation is Poe's own intake card; the plan is not.
    expect(poe.calls.receive.map((p) => p.agentId)).not.toContain('Fearless Leader');
    const flPacket = seen.find((p) => p.agentId === 'Fearless Leader');
    expect(flPacket.result).toEqual(plan);
  });
});
