import { describe, expect, it, vi } from 'vitest';
import {
  createPoeAgent,
  CONVERSATION_TIER,
  poeMessageSchema,
  POE_SAFE_DEFAULT,
} from '../../../src/loops/loop1/agents/poe.js';
import { POE_SYSTEM_PROMPT } from '../../../src/loops/loop1/prompts.js';
import { createLoop1Orchestrator, STATES } from '../../../src/loops/loop1/orchestrator.js';

// Poe configured as the Loop 1 elicitation agent. Tests inject a fake dispatch
// (Poe never touches a provider directly) and fake seams for the FINAL pieces
// (RQPacket extraction, CV verdict), so the agent's own behavior is verified
// without inventing those shapes.

function fakePoe() {
  const calls = { mount: [], setStatus: [], receive: [], settle: [], stream: [], showThinking: [] };
  return {
    calls,
    mount: vi.fn((target, opts) => calls.mount.push({ target, opts })),
    setStatus: vi.fn((agentId, key) => calls.setStatus.push({ agentId, key })),
    receive: vi.fn((packet) => calls.receive.push(packet)),
    settle: vi.fn((agentId) => calls.settle.push(agentId)),
    stream: vi.fn((agentId, chunk) => calls.stream.push({ agentId, chunk })),
    showThinking: vi.fn((agentId, steps) => calls.showThinking.push({ agentId, steps })),
  };
}

const systemText = (spec) =>
  spec.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

describe('Poe Loop 1 elicitation agent', () => {
  it('runs on the conversation tier (Groq-first) and returns a Poe-attributed question', async () => {
    const dispatch = vi.fn(async () => ({ message: 'Which population are you studying?' }));
    const step = createPoeAgent({ dispatch });

    const packet = await step({ session: {}, researchQuestion: 'I want to study fasting and memory.' });

    expect(packet.agentId).toBe('Poe');
    expect(packet.content).toBe('Which population are you studying?');
    expect(packet.control).toEqual({}); // no transition: the orchestrator triggers CV

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Poe');
    expect(spec.tier).toBe('conversation');
    expect(spec.failover).toEqual(CONVERSATION_TIER);
    expect(spec.failover[0]).toBe('groq'); // Groq leads for streaming speed
    expect(spec.schema).toBe(poeMessageSchema);
    expect(spec.safeDefault).toBe(POE_SAFE_DEFAULT);
  });

  it('sends the system prompt plus a transcript that accumulates across turns', async () => {
    const dispatch = vi.fn(async () => ({ message: 'Q1' }));
    const step = createPoeAgent({ dispatch });
    const session = {};

    await step({ session, researchQuestion: 'Initial idea.' });
    const first = dispatch.mock.calls[0][0].messages;
    expect(first[0]).toEqual({ role: 'system', content: POE_SYSTEM_PROMPT });
    expect(first).toContainEqual({ role: 'user', content: 'Initial idea.' });

    await step({ session, researchQuestion: 'A clarifying answer.' });
    const second = dispatch.mock.calls[1][0].messages;
    expect(second).toContainEqual({ role: 'user', content: 'Initial idea.' });
    expect(second).toContainEqual({ role: 'assistant', content: 'Q1' }); // Poe's own prior turn
    expect(second).toContainEqual({ role: 'user', content: 'A clarifying answer.' });
  });

  it('re-extracts and re-versions the RQPacket every turn through the extractor seam', async () => {
    const versions = [];
    const extractRQPacket = vi.fn(({ version }) => {
      versions.push(version);
      return { version, fromSeam: true };
    });
    const dispatch = vi.fn(async () => ({ message: 'Q' }));
    const step = createPoeAgent({ dispatch, extractRQPacket });
    const session = {};

    const p1 = await step({ session, researchQuestion: 'a' });
    expect(session.rqVersion).toBe(1);
    expect(p1.rqVersion).toBe(1);
    expect(session.rqPacket).toEqual({ version: 1, fromSeam: true });

    await step({ session, researchQuestion: 'b' });
    expect(session.rqVersion).toBe(2);
    expect(versions).toEqual([1, 2]);
    // The extractor is handed the previous packet so it can re-version, not rebuild.
    expect(extractRQPacket.mock.calls[1][0].previous).toEqual({ version: 1, fromSeam: true });
  });

  it('default extractor carries the packet forward with the bumped version and no invented fields', async () => {
    const dispatch = vi.fn(async () => ({ message: 'Q' }));
    const step = createPoeAgent({ dispatch }); // default extractRQPacket
    const session = {};
    await step({ session, researchQuestion: 'a' });
    expect(session.rqPacket).toEqual({ version: 1 });
    await step({ session, researchQuestion: 'b' });
    expect(session.rqPacket).toEqual({ version: 2 });
  });

  it('without a passing review, Poe is told not to finalize the question (gate enforced in the prompt)', async () => {
    const dispatch = vi.fn(async () => ({ message: 'Q' }));
    const step = createPoeAgent({ dispatch }); // default readReviewVerdict -> null
    await step({ session: {}, researchQuestion: 'a', history: [] });
    const sys = systemText(dispatch.mock.calls[0][0]);
    expect(sys).toContain(POE_SYSTEM_PROMPT);
    expect(sys).toMatch(/Do not tell the researcher it is final or ready to confirm/i);
    expect(sys).not.toMatch(/invite the researcher to confirm/i);
  });

  it('surfaces review blocking items verbatim and still refuses to finalize', async () => {
    const readReviewVerdict = () => ({ passed: false, blocking: ['the population', 'the outcome measure'] });
    const dispatch = vi.fn(async () => ({ message: 'Q' }));
    const step = createPoeAgent({ dispatch, readReviewVerdict });
    await step({ session: {}, researchQuestion: 'a', history: [] });
    const sys = systemText(dispatch.mock.calls[0][0]);
    expect(sys).toContain('the population');
    expect(sys).toContain('the outcome measure');
    expect(sys).toMatch(/Do not tell the researcher the question is final/i);
  });

  it('invites confirmation only when the latest review passes', async () => {
    const readReviewVerdict = () => ({ passed: true, blocking: [] });
    const dispatch = vi.fn(async () => ({ message: 'It is well defined. Please confirm it.' }));
    const step = createPoeAgent({ dispatch, readReviewVerdict });
    await step({ session: {}, researchQuestion: 'a', history: [] });
    const sys = systemText(dispatch.mock.calls[0][0]);
    expect(sys).toMatch(/invite the researcher to confirm the research question/i);
  });

  it('falls back to Poe unique safe default when no provider is reachable', async () => {
    // A real dispatch with no transports wired returns spec.safeDefault.
    const dispatch = vi.fn(async (spec) => spec.safeDefault);
    const step = createPoeAgent({ dispatch });
    const session = {};
    const packet = await step({ session, researchQuestion: 'a' });

    expect(packet.content).toBe(POE_SAFE_DEFAULT.message);
    expect(packet.content).not.toMatch(/loading/i); // never a generic placeholder
    expect(session.transcript.at(-1)).toEqual({ role: 'assistant', content: POE_SAFE_DEFAULT.message });
  });

  it('poeMessageSchema accepts a non-empty message and rejects everything else', () => {
    expect(poeMessageSchema({ message: 'hi' })).toBe(true);
    expect(poeMessageSchema({ message: '   ' })).toBe(false);
    expect(poeMessageSchema({ message: '' })).toBe(false);
    expect(poeMessageSchema({})).toBe(false);
    expect(poeMessageSchema(null)).toBe(false);
    expect(poeMessageSchema('hi')).toBe(false);
  });

  it('the conversation tier and safe default obey the project copy law', () => {
    expect(CONVERSATION_TIER[0]).toBe('groq');
    expect(POE_SAFE_DEFAULT.message).not.toContain('—'); // no em dash
    expect(POE_SAFE_DEFAULT.message).not.toMatch(/loading/i);
  });

  it('plugs into the orchestrator: Poe renders its dispatched question and the chain advances', async () => {
    const dispatch = vi.fn(async () => ({ message: 'Which population, and over what timeframe?' }));
    const step = createPoeAgent({ dispatch });
    const poe = fakePoe();
    const orch = createLoop1Orchestrator({ poe, agents: { Poe: step } });
    orch.mount(document.createElement('div'));
    await orch.start();
    await orch.submit('I want to study fasting and memory.');

    // Poe's real (dispatched) question is what Poe renders for the Poe turn.
    const poeCard = poe.calls.receive.find((p) => p.agentId === 'Poe');
    expect(poeCard.content).toBe('Which population, and over what timeframe?');
    // The stub CV (still a stub this phase) advances the chain to COMPLETE.
    expect(orch.getState()).toBe(STATES.COMPLETE);
  });
});
