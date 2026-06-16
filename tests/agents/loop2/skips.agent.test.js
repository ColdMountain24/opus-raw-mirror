import { describe, expect, it, vi } from 'vitest';
import {
  createSkipsAgent,
  skipsResultSchema,
  readSubspecializationKGs,
  SKIPS_SAFE_DEFAULT,
  EXTRACTION_TIER,
} from '../../../src/agents/loop2/skips.js';
import { SKIPS_SYSTEM_PROMPT } from '../../../src/agents/loop2/prompts.js';

// Skips, the cross-subspecialization analyst (internal tool). Reads all SubspecializationKGs + the
// RQPacket and returns { contradictions, unknown_fields }. Tests inject a fake dispatch + a history.

const claim = (id, text = 't') => ({ claim_id: id, text, supporting_paper_dois: ['10.1/p'] });

const kg = (id, claims) => ({ subspecialization_id: id, subspecialization_label: id, claims });

function historyWith(subspecializations) {
  return [{ state: 'BOOKKEEPER_STAGE', agentId: 'Bookkeeper', packet: { agentId: 'Bookkeeper', result: { subspecializations } } }];
}

describe('Skips Loop 2 cross-subspecialization analyst', () => {
  it('runs on the extraction tier, attributed to Skips, with the schema + on-contract safe default', async () => {
    const dispatch = vi.fn(async () => SKIPS_SAFE_DEFAULT);
    const skips = createSkipsAgent({ dispatch });
    const packet = await skips({ history: historyWith([kg('s1', [claim('c1')])]), session: { rqPacket: { version: 4 } } });

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Skips');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.schema).toBe(skipsResultSchema);
    expect(skipsResultSchema(spec.safeDefault)).toBe(true);

    expect(packet.agentId).toBe('Skips');
    expect(skipsResultSchema(packet.result)).toBe(true);
    expect(packet.control).toEqual({});
  });

  it('sends the Skips prompt with claims from ALL subspecializations and the RQPacket', async () => {
    const dispatch = vi.fn(async () => SKIPS_SAFE_DEFAULT);
    const skips = createSkipsAgent({ dispatch });
    await skips({
      history: historyWith([kg('s1', [claim('cA', 'Claim A')]), kg('s2', [claim('cB', 'Claim B')])]),
      session: { rqPacket: { version: 5, shape: 'opaque' } },
    });
    const user = dispatch.mock.calls[0][0].messages.find((m) => m.role === 'user');
    expect(dispatch.mock.calls[0][0].messages[0]).toEqual({ role: 'system', content: SKIPS_SYSTEM_PROMPT });
    expect(user.content).toContain('Claim A');
    expect(user.content).toContain('Claim B');
    expect(user.content).toContain('cA');
    expect(user.content).toContain('cB');
    expect(user.content).toContain('"shape": "opaque"');
  });

  it('returns the model contradictions + unknown fields', async () => {
    const dispatch = vi.fn(async () => ({
      contradictions: [{ claim_a_id: 'cA', claim_b_id: 'cB', nature: 'A says up, B says down' }],
      unknown_fields: ['long-term effects'],
    }));
    const skips = createSkipsAgent({ dispatch });
    const packet = await skips({ history: historyWith([kg('s1', [claim('cA')]), kg('s2', [claim('cB')])]) });
    expect(packet.result.contradictions).toEqual([{ claim_a_id: 'cA', claim_b_id: 'cB', nature: 'A says up, B says down' }]);
    expect(packet.result.unknown_fields).toEqual(['long-term effects']);
  });

  it('filters contradictions referencing claim_ids that do not exist (no hallucinated ids)', async () => {
    const dispatch = vi.fn(async () => ({
      contradictions: [
        { claim_a_id: 'cA', claim_b_id: 'cB', nature: 'real' },
        { claim_a_id: 'cA', claim_b_id: 'ghost', nature: 'invented endpoint' },
      ],
      unknown_fields: [],
    }));
    const skips = createSkipsAgent({ dispatch });
    const packet = await skips({ history: historyWith([kg('s1', [claim('cA')]), kg('s2', [claim('cB')])]) });
    expect(packet.result.contradictions).toEqual([{ claim_a_id: 'cA', claim_b_id: 'cB', nature: 'real' }]);
  });

  it('falls back to the empty safe default on an off-contract result', async () => {
    const skips = createSkipsAgent({ dispatch: vi.fn(async () => ({ contradictions: 'nope' })) });
    const packet = await skips({ history: historyWith([kg('s1', [claim('c1')])]) });
    expect(packet.result).toEqual({ contradictions: [], unknown_fields: [] });
  });

  it('returns the safe default the dispatcher yields when every provider is down', async () => {
    const skips = createSkipsAgent({ dispatch: vi.fn(async (spec) => spec.safeDefault) });
    const packet = await skips({ history: historyWith([kg('s1', [claim('c1')])]) });
    expect(packet.result).toEqual({ contradictions: [], unknown_fields: [] });
  });
});

describe('skipsResultSchema + readSubspecializationKGs', () => {
  it('accepts the contract and rejects off-contract values', () => {
    expect(skipsResultSchema(SKIPS_SAFE_DEFAULT)).toBe(true);
    expect(skipsResultSchema({ contradictions: [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'n' }], unknown_fields: ['x'] })).toBe(true);
    expect(skipsResultSchema(null)).toBe(false);
    expect(skipsResultSchema({ contradictions: 'x', unknown_fields: [] })).toBe(false);
    expect(skipsResultSchema({ contradictions: [{ claim_a_id: 'a', claim_b_id: '', nature: 'n' }], unknown_fields: [] })).toBe(false);
    expect(skipsResultSchema({ contradictions: [{ claim_a_id: 'a', claim_b_id: 'b' }], unknown_fields: [] })).toBe(false); // missing nature
    expect(skipsResultSchema({ contradictions: [], unknown_fields: [1] })).toBe(false);
  });

  it('reads the latest SubspecializationKGs from history', () => {
    const subs = [kg('s1', [claim('c1')])];
    expect(readSubspecializationKGs(historyWith(subs))).toBe(subs);
    expect(readSubspecializationKGs([])).toEqual([]);
  });
});
