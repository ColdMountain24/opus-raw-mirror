import { describe, expect, it, vi } from 'vitest';
import { createCVAgent, cvResultSchema, CV_SAFE_DEFAULT } from '../../../src/loops/loop1/agents/cv.js';
import { emptyRQPacket, TOP_LEVEL_REQUIRED, SCOPE_UNIVERSAL, SCOPE_CONDITIONAL } from '../../../src/loops/loop1/rqschema.js';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';
import { createPoeAgent } from '../../../src/loops/loop1/agents/poe.js';
import { reviewVerdictFromHistory } from '../../../src/loops/loop1/review.js';

// CV is the Loop 1 completeness validator. It is DETERMINISTIC (no dispatch): it
// scores the structured RQPacket against the FINAL rule (rqschema.scoreCompleteness).
// Tests build packets and check CV's behavior, plus a `score` seam for orchestrator
// integration without constructing full packets.

function fullPacket() {
  const p = emptyRQPacket();
  for (const f of TOP_LEVEL_REQUIRED) p[f] = `${f} content`;
  for (const f of [...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL]) p.Scope[f] = `${f} content`;
  return p;
}

function fakePoe() {
  const calls = { receive: [], settle: [], setStatus: [] };
  return {
    calls,
    mount: vi.fn(),
    setStatus: vi.fn((agentId, key) => calls.setStatus.push({ agentId, key })),
    receive: vi.fn((p) => calls.receive.push(p)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn(),
    showThinking: vi.fn(),
  };
}

describe('CV Loop 1 completeness validator (deterministic)', () => {
  it('passes a complete packet at the 1.0 threshold and requests no transition', async () => {
    const step = createCVAgent();
    const packet = await step({ session: { rqPacket: fullPacket(), rqVersion: 2 } });
    expect(packet.agentId).toBe('CV');
    expect(packet.result.status).toBe('pass');
    expect(packet.result.score).toBe(1);
    expect(packet.result.blocking_fields).toEqual([]);
    expect(packet.control).toEqual({}); // pass proceeds along the default forward edge
    expect(packet.rqVersion).toBe(2);
  });

  it('fails an incomplete packet, names the blocking fields, and routes back to Poe', async () => {
    const p = fullPacket();
    p.KnowledgeGap = null;
    p.Scope.Population = null;
    const step = createCVAgent();
    const packet = await step({ session: { rqPacket: p } });
    expect(packet.result.status).toBe('fail');
    expect(packet.result.blocking_fields).toEqual(expect.arrayContaining(['KnowledgeGap', 'Population']));
    expect(packet.control).toEqual({ transition: STATES.POE_INTAKE });
    expect(packet.content).toContain('Blocking');
  });

  it('fails closed with no packet and when the scorer throws', async () => {
    const noPacket = await createCVAgent()({ session: {} });
    expect(noPacket.result.status).toBe('fail'); // never a false pass

    const thrower = createCVAgent({ score: () => { throw new Error('boom'); } });
    const p = await thrower({ session: { rqPacket: {} } });
    expect(p.result).toEqual(CV_SAFE_DEFAULT);
    expect(p.control).toEqual({ transition: STATES.POE_INTAKE });
  });

  it('cvResultSchema accepts the contract and rejects every off-contract value', () => {
    expect(cvResultSchema({ status: 'pass', score: 1, blocking_fields: [] })).toBe(true);
    expect(cvResultSchema({ status: 'fail', score: 0, blocking_fields: ['a', 'b'] })).toBe(true);
    expect(cvResultSchema({ status: 'maybe', score: 1, blocking_fields: [] })).toBe(false);
    expect(cvResultSchema({ status: 'pass', score: '1', blocking_fields: [] })).toBe(false);
    expect(cvResultSchema({ status: 'pass', score: 1, blocking_fields: 'x' })).toBe(false);
    expect(cvResultSchema({ status: 'pass', score: 1, blocking_fields: [1] })).toBe(false);
    expect(cvResultSchema(null)).toBe(false);
  });

  it('writes to the IO panel (packet sink) and never the conversation, in the orchestrator', async () => {
    const cv = createCVAgent({ score: () => ({ status: 'pass', score: 1, blocking_fields: [] }) });
    const seen = [];
    const packetSink = { setPacket: (p) => seen.push(p) };
    const poe = fakePoe();
    const orch = createLoop1Orchestrator({ poe, agents: { CV: cv }, packet: packetSink });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('q'); // stub Poe renders; CV runs real (pass) and the chain proceeds

    expect(poe.calls.settle).toContain('CV');
    expect(poe.calls.receive.map((p) => p.agentId)).toEqual(['Poe']); // CV not in the conversation
    const cvPacket = seen.find((p) => p.agentId === 'CV');
    expect(cvPacket.result).toEqual({ status: 'pass', score: 1, blocking_fields: [] });
  });

  it('closes the Poe <-> CV loop: CV fail feeds Poe blocking fields on the next turn', async () => {
    const cv = createCVAgent({ score: () => ({ status: 'fail', score: 0.5, blocking_fields: ['the comparison group'] }) });
    const poeDispatch = vi.fn(async () => ({ message: 'A follow-up question.' }));
    const poeStep = createPoeAgent({ dispatch: poeDispatch, readReviewVerdict: reviewVerdictFromHistory });

    const poe = fakePoe();
    const orch = createLoop1Orchestrator({ poe, agents: { Poe: poeStep, CV: cv } });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('Initial idea.'); // Poe -> CV(fail) -> back to POE_INTAKE
    expect(orch.getState()).toBe(STATES.POE_INTAKE);

    await orch.submit('A refinement.'); // Poe runs again, now with a CV verdict
    const lastPoeSpec = poeDispatch.mock.calls.at(-1)[0];
    const sys = lastPoeSpec.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(sys).toContain('the comparison group');
  });
});
