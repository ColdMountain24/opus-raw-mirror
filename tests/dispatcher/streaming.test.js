import { describe, it, expect } from 'vitest';
import * as sim from '../../src/dispatcher/simulator.js';
import { buildSpine, virtualTime, memStorage, recorder, counted } from '../evals/harness.js';

// The SSE streaming seam, driven through the real spine on the deterministic
// simulator. The contract the PLAYBOOK fixes:
//   - prose tokens reach the caller's onToken sink, in order, for perceived speed;
//   - the dispatcher still returns the FULL schema-validated body (a partial is
//     never validated and never returned downstream);
//   - a cache hit serves the warm body with zero streaming;
//   - a corrective retry does not re-stream, and the streamed-but-invalid first
//     attempt never reaches the caller.
describe('dispatch streaming (onToken)', () => {
  it('forwards prose chunks in order, then returns the full validated body', async () => {
    const vt = virtualTime();
    const log = recorder();
    const full = { ok: true, text: 'Hello world' };
    const transport = counted(sim.streamSuccess(['Hel', 'lo ', 'wor', 'ld'], { body: full }));
    const d = buildSpine({ transports: { anthropic: transport }, failoverSequence: ['anthropic'], vt, logger: log });

    const tokens = [];
    const out = await d.dispatch({
      agentId: 'streamer',
      tier: 'large',
      messages: [{ role: 'user', content: 'stream please' }],
      // The schema only passes on the complete body, so a returned partial would fail.
      schema: (v) => Boolean(v && v.ok === true && v.text === 'Hello world'),
      safeDefault: { ok: false, text: '' },
      onToken: (chunk) => tokens.push(chunk),
    });

    expect(tokens).toEqual(['Hel', 'lo ', 'wor', 'ld']);
    expect(out).toEqual(full);
    expect(transport.calls).toBe(1);
  });

  it('does not stream on a cache hit (zero tokens on the warm repeat)', async () => {
    const vt = virtualTime();
    const log = recorder();
    const transport = counted(sim.streamSuccess(['a', 'b', 'c'], { body: { plan: 'abc' } }));
    const d = buildSpine({ transports: { anthropic: transport }, failoverSequence: ['anthropic'], vt, storage: memStorage(), logger: log });

    const tokens = [];
    const spec = {
      agentId: 'planner',
      tier: 'large',
      messages: [{ role: 'user', content: 'draft' }],
      schema: (v) => Boolean(v && typeof v.plan === 'string'),
      safeDefault: { plan: '' },
      onToken: (chunk) => tokens.push(chunk),
    };

    const first = await d.dispatch(spec);
    expect(first).toEqual({ plan: 'abc' });
    expect(tokens).toEqual(['a', 'b', 'c']);

    const second = await d.dispatch(spec);
    expect(second).toEqual({ plan: 'abc' });
    // The cache short-circuits before any provider call, so no new tokens stream.
    expect(tokens).toEqual(['a', 'b', 'c']);
    expect(transport.calls).toBe(1);
    expect(log.types()).toContain('cache:hit');
  });

  it('streams only the first attempt; the corrective retry is silent and only the valid body returns', async () => {
    const vt = virtualTime();
    const log = recorder();
    let call = 0;
    const transport = counted(async (req, ctx) => {
      call += 1;
      // First attempt streams a (schema-invalid) partial; the corrective retry
      // (dispatched with no onToken) returns the valid body without streaming.
      if (call === 1) return sim.streamSuccess(['par', 'tial'], { body: { text: 'bad' } })(req, ctx);
      return { status: 200, headers: {}, body: { text: 'good' } };
    });
    const d = buildSpine({ transports: { anthropic: transport }, failoverSequence: ['anthropic'], vt, logger: log });

    const tokens = [];
    const out = await d.dispatch({
      agentId: 'grader',
      messages: [{ role: 'user', content: 'grade' }],
      schema: (v) => Boolean(v && v.text === 'good'),
      safeDefault: { text: 'SAFE' },
      onToken: (chunk) => tokens.push(chunk),
    });

    expect(out).toEqual({ text: 'good' });
    // Only the first attempt streamed; the corrective retry did not.
    expect(tokens).toEqual(['par', 'tial']);
    expect(call).toBe(2);
    expect(log.types()).toContain('validate:fail');
    expect(log.types()).not.toContain('validate:safe_default');
  });

  it('omits streaming when no onToken is supplied (back-compat)', async () => {
    const vt = virtualTime();
    const transport = counted(sim.streamSuccess(['x', 'y'], { body: { ok: true } }));
    const d = buildSpine({ transports: { anthropic: transport }, failoverSequence: ['anthropic'], vt });

    const out = await d.dispatch({
      agentId: 'plain',
      messages: [{ role: 'user', content: 'no stream' }],
      schema: (v) => Boolean(v && v.ok === true),
      safeDefault: { ok: false },
    });

    expect(out).toEqual({ ok: true });
    expect(transport.calls).toBe(1);
  });
});
