import { describe, expect, it, vi } from 'vitest';
import {
  createRQSupervisorAgent,
  rqResultSchema,
  RQSUPERVISOR_SAFE_DEFAULT,
  EXTRACTION_TIER,
} from '../../../src/loops/loop1/agents/rqsupervisor.js';
import { RQSUPERVISOR_SYSTEM_PROMPT } from '../../../src/loops/loop1/prompts.js';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';

// RQSupervisor configured as the Loop 1 question-structure reviewer. Tests inject
// a fake dispatch; the RQPacket it reviews is opaque (FINAL), so tests hand it an
// arbitrary packet and check behavior, not packet shape.

const pass = { approved: true, paradigm: 'clinical', feedback: [], revision_required: false };
const revise = {
  approved: false,
  paradigm: 'clinical',
  feedback: ['the scope is too broad for one study'],
  revision_required: true,
};

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

describe('RQSupervisor Loop 1 question-structure reviewer', () => {
  it('runs on the extraction tier (Anthropic-first) and is attributed to RQSupervisor', async () => {
    const dispatch = vi.fn(async () => pass);
    const step = createRQSupervisorAgent({ dispatch });
    const packet = await step({ session: { rqPacket: { version: 4 }, rqVersion: 4 } });

    expect(packet.agentId).toBe('RQSupervisor');
    expect(packet.result).toEqual(pass);

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('RQSupervisor');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.failover[0]).toBe('anthropic');
    expect(spec.schema).toBe(rqResultSchema);
    expect(spec.safeDefault).toBe(RQSUPERVISOR_SAFE_DEFAULT);
  });

  it('sends the RQSupervisor prompt and the RQPacket it is handed', async () => {
    const dispatch = vi.fn(async () => pass);
    const step = createRQSupervisorAgent({ dispatch });
    await step({ session: { rqPacket: { version: 5, shape: 'opaque' } } });
    const msgs = dispatch.mock.calls[0][0].messages;
    expect(msgs[0]).toEqual({ role: 'system', content: RQSUPERVISOR_SYSTEM_PROMPT });
    const userMsg = msgs.find((m) => m.role === 'user');
    expect(userMsg.content).toContain('version 5');
    expect(userMsg.content).toContain('"shape": "opaque"');
  });

  it('on revision_required, routes back to Poe with the feedback in the summary', async () => {
    const dispatch = vi.fn(async () => revise);
    const step = createRQSupervisorAgent({ dispatch });
    const packet = await step({ session: { rqPacket: {} } });
    expect(packet.control).toEqual({ transition: STATES.POE_INTAKE });
    expect(packet.content).toContain('not approved');
    expect(packet.content).toContain('the scope is too broad for one study');
  });

  it('on approval with no revision, requests no transition so the chain proceeds forward', async () => {
    const dispatch = vi.fn(async () => pass);
    const step = createRQSupervisorAgent({ dispatch });
    const packet = await step({ session: { rqPacket: {} } });
    expect(packet.control).toEqual({});
    expect(packet.content).toContain('paradigm: clinical');
  });

  it('fails closed on an off-contract result and on the safe default', async () => {
    const bad = createRQSupervisorAgent({ dispatch: vi.fn(async () => ({ approved: 'yes' })) });
    const p1 = await bad({ session: { rqPacket: {} } });
    expect(p1.result).toEqual(RQSUPERVISOR_SAFE_DEFAULT);
    expect(p1.result.approved).toBe(false); // never a false approval
    expect(p1.control).toEqual({ transition: STATES.POE_INTAKE });

    const down = createRQSupervisorAgent({ dispatch: vi.fn(async (spec) => spec.safeDefault) });
    const p2 = await down({ session: { rqPacket: {} } });
    expect(p2.result).toEqual(RQSUPERVISOR_SAFE_DEFAULT);
  });

  it('rqResultSchema accepts the contract and rejects off-contract values', () => {
    expect(rqResultSchema(pass)).toBe(true);
    expect(rqResultSchema(revise)).toBe(true);
    expect(rqResultSchema({ approved: 'yes', paradigm: 'x', feedback: [], revision_required: false })).toBe(false);
    expect(rqResultSchema({ approved: true, paradigm: 1, feedback: [], revision_required: false })).toBe(false);
    expect(rqResultSchema({ approved: true, paradigm: 'x', feedback: 'no', revision_required: false })).toBe(false);
    expect(rqResultSchema({ approved: true, paradigm: 'x', feedback: [2], revision_required: false })).toBe(false);
    expect(rqResultSchema({ approved: true, paradigm: 'x', feedback: [] })).toBe(false); // missing revision_required
    expect(rqResultSchema(null)).toBe(false);
  });

  it('is backstage in the orchestrator: settles to the IO panel, never the conversation', async () => {
    const dispatch = vi.fn(async () => pass);
    const rq = createRQSupervisorAgent({ dispatch });
    const seen = [];
    const packetSink = { setPacket: (p) => seen.push(p) };
    const poe = fakePoe();
    // Stub Poe + stub CV (orchestrator defaults) carry the chain to RQ_SUPERVISOR;
    // inject only the real RQSupervisor.
    const orch = createLoop1Orchestrator({ poe, agents: { RQSupervisor: rq }, packet: packetSink });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('q');

    expect(poe.calls.settle).toContain('RQSupervisor');
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']); // not in the conversation
    const rqPacket = seen.find((p) => p.agentId === 'RQSupervisor');
    expect(rqPacket.result).toEqual(pass);
  });
});
