import { describe, expect, it, vi } from 'vitest';
import { createRQPacketAssembler, rqPacketAssembler } from '../../../src/loops/loop1/rqpacket.js';
import { createFrameworkRegistry } from '../../../src/utils/frameworkregistry.js';
import { createPoeAgent } from '../../../src/loops/loop1/agents/poe.js';

// The RQPacket assembler is Poe's real extractRQPacket seam: it carries the prior
// packet forward, stamps the version Poe assigned, and expands a framework id
// through the FrameworkRegistry (client-side, post-LLM, dispatch-free). These tests
// pin the mechanism and the framework content rule.

describe('RQPacket assembler', () => {
  it('stamps the version Poe assigned each turn', () => {
    const assemble = createRQPacketAssembler();
    expect(assemble({ previous: null, version: 1 })).toEqual({ version: 1 });
    expect(assemble({ previous: { version: 1 }, version: 2 })).toEqual({ version: 2 });
  });

  it('with no framework id carries the packet forward exactly like the prior default', () => {
    // Default frameworkIdOf returns null, so the registry path stays dormant and the
    // result is { ...previous, version } - byte-for-byte poe.js's prior behavior, so
    // no domain fields are invented.
    const assemble = createRQPacketAssembler();
    const previous = { version: 3, topic: 'fasting and memory', scope: 'older adults' };
    expect(assemble({ previous, version: 4 })).toEqual({
      version: 4,
      topic: 'fasting and memory',
      scope: 'older adults',
    });
  });

  it('does not mutate the previous packet', () => {
    const assemble = createRQPacketAssembler();
    const previous = Object.freeze({ version: 1, topic: 'x' });
    const next = assemble({ previous, version: 2 });
    expect(next).not.toBe(previous);
    expect(previous).toEqual({ version: 1, topic: 'x' }); // untouched
  });

  it('expands a framework id to its field set deterministically and dispatch-free', () => {
    const registry = createFrameworkRegistry({
      'clinical-rct': { population: null, intervention: null, comparator: null, outcome: null },
    });
    const assemble = createRQPacketAssembler({
      registry,
      frameworkIdOf: () => 'clinical-rct',
    });

    const first = assemble({ previous: { version: 1 }, version: 2 });
    const second = assemble({ previous: { version: 1 }, version: 2 });
    expect(first).toEqual({
      version: 2,
      population: null,
      intervention: null,
      comparator: null,
      outcome: null,
    });
    expect(second).toEqual(first); // deterministic: same id + state -> same packet
  });

  it('fails closed on an unknown framework id: carries forward and logs, never inventing fields', () => {
    const registry = createFrameworkRegistry(); // empty
    const logger = vi.fn();
    const assemble = createRQPacketAssembler({
      registry,
      frameworkIdOf: () => 'no-such-framework',
      logger,
    });

    const next = assemble({ previous: { version: 1, topic: 'x' }, version: 2 });
    // No fields invented: just the carry-forward plus the stamped version.
    expect(next).toEqual({ version: 2, topic: 'x' });
    // The miss is surfaced, not swallowed.
    expect(logger).toHaveBeenCalledWith({ type: 'framework:unknown', frameworkId: 'no-such-framework' });
  });

  it('reads the framework id off the extraction through the frameworkIdOf seam', () => {
    const registry = createFrameworkRegistry({ 'fw': { a: 1 } });
    const frameworkIdOf = vi.fn((args) => (args.extraction ? args.extraction.framework : null));
    const assemble = createRQPacketAssembler({ registry, frameworkIdOf });

    const withFw = assemble({ previous: {}, version: 1, extraction: { framework: 'fw' } });
    expect(withFw).toEqual({ version: 1, a: 1 });

    const withoutFw = assemble({ previous: {}, version: 2, extraction: {} });
    expect(withoutFw).toEqual({ version: 2 }); // null id -> carry-forward only
  });

  it('the default singleton uses the default (empty) registry: pure carry-forward', () => {
    expect(rqPacketAssembler({ previous: { version: 1 }, version: 2 })).toEqual({ version: 2 });
  });
});

describe('framework content rule (LLM prompts never carry framework content)', () => {
  it('expands the framework id client-side, after the LLM call, and never puts the content in Poe prompt', async () => {
    // A framework whose field set carries a unique sentinel string. If framework
    // content ever leaked into a prompt, the sentinel would show up there.
    const SENTINEL = 'FRAMEWORK_CONTENT_SENTINEL_5Q1';
    const registry = createFrameworkRegistry({
      'fw-1': { template: SENTINEL, population: null },
    });
    const assemble = createRQPacketAssembler({
      registry,
      frameworkIdOf: () => 'fw-1', // the LLM "emitted" this id; expansion is client-side
    });

    // Capture every message Poe sends to the model.
    const dispatch = vi.fn(async () => ({ message: 'Which population are you studying?' }));
    const step = createPoeAgent({ dispatch, extractRQPacket: assemble });

    const session = {};
    await step({ session, researchQuestion: 'I want to study fasting and memory.' });

    // The model was called once (the conversation turn); the registry expansion
    // added no LLM call - the lookup is a synchronous client-side map.
    expect(dispatch).toHaveBeenCalledTimes(1);

    // The framework content is NOT in any message sent to the model: Poe's prompt is
    // the system prompt + transcript, never the packet, so the framework template
    // the registry holds never reaches the LLM.
    const sent = JSON.stringify(dispatch.mock.calls[0][0].messages);
    expect(sent).not.toContain(SENTINEL);

    // The expansion still happened, client-side and after the call: the assembled
    // packet (built post-dispatch) carries the framework's field set.
    expect(session.rqPacket.template).toBe(SENTINEL);
    expect(session.rqPacket).toMatchObject({ template: SENTINEL, population: null, version: 1 });
  });
});
