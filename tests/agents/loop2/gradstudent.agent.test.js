import { describe, expect, it, vi } from 'vitest';
import {
  createGradStudentAgent,
  claimsResultSchema,
  gradStudentResultSchema,
  EXTRACTION_TIER,
} from '../../../src/agents/loop2/gradstudent.js';
import { GRAD_STUDENT_SYSTEM_PROMPT } from '../../../src/agents/loop2/prompts.js';

// The Grad Student: one per subspecialization, extracts claims from each of its papers via a
// STREAMED dispatch whose tokens drive progressive render events. Tests inject a fake dispatch
// that streams the body's JSON through onToken (exercising the incremental parser) then returns
// the full validated body - the authority.

const paper = (over = {}) => ({
  title: 'P',
  authors: ['A'],
  year: 2021,
  doi: '10.1/p',
  abstract: 'abs',
  source: 'pubmed',
  full_text_available: true,
  ...over,
});

const modelClaim = (over = {}) => ({
  claim_id: 'claim_subspec-1_0',
  text: 'Fasting aids memory',
  claim_type: ['causal'],
  entity_references: ['fasting', 'memory'],
  supporting_paper_dois: ['10.1/p'],
  ...over,
});

// A dispatch that streams JSON.stringify(body) through onToken in small chunks, then resolves
// with the full body (what a real streaming-then-validated dispatch does on the happy path).
function streamingDispatch(body) {
  return vi.fn(async (spec) => {
    if (typeof spec.onToken === 'function') {
      const s = JSON.stringify(body);
      for (let i = 0; i < s.length; i += 7) spec.onToken(s.slice(i, i + 7));
    }
    return body;
  });
}

describe('Grad Student Loop 2 streaming claim extractor', () => {
  it('streams extraction and renders open -> field -> settled(valid) for a claim', async () => {
    const dispatch = streamingDispatch({ claims: [modelClaim()] });
    const events = [];
    const agent = createGradStudentAgent({ dispatch });
    const packet = await agent({
      subspecialization: { id: 'subspec-1', label: 'Cognitive aging', query: 'fasting memory' },
      papers: [paper()],
      onClaimRender: (e) => events.push(e),
    });

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Grad Students');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.schema).toBe(claimsResultSchema);
    expect(typeof spec.onToken).toBe('function');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('open');
    expect(types).toContain('field');
    expect(types[types.length - 1]).toBe('settled');

    const open = events.find((e) => e.type === 'open');
    const settled = events.find((e) => e.type === 'settled');
    expect(settled.nodeId).toBe(open.nodeId); // loading node and final transition are the same node
    expect(settled.status).toBe('valid');
    // The full source paper record rides on the open + settled events (for the Post-Doc citation chips).
    expect(open.paper.doi).toBe('10.1/p');
    expect(settled.paper.doi).toBe('10.1/p');

    expect(packet.agentId).toBe('Grad Students');
    expect(packet.result.claims).toHaveLength(1);
    expect(packet.result.claims[0].confidence).toBeNull(); // Post-Doc assigns later
    expect(packet.result.claims[0].citation_boost_count).toBeNull();
    expect(packet.result.claims[0].salvia_status).toBe('valid');
  });

  it('flags a claim with no supporting papers through the Salvia seam', async () => {
    const dispatch = streamingDispatch({ claims: [modelClaim({ supporting_paper_dois: [] })] });
    const events = [];
    const agent = createGradStudentAgent({ dispatch });
    const packet = await agent({
      subspecialization: { id: 'subspec-1', label: 'L', query: 'q' },
      papers: [paper()],
      onClaimRender: (e) => events.push(e),
    });
    expect(packet.result.claims[0].salvia_status).toBe('flagged');
    const settled = events.find((e) => e.type === 'settled');
    expect(settled.status).toBe('flagged');
    expect(settled.reasons.length).toBeGreaterThan(0); // surfaced, not swallowed
  });

  it('honors an injected validate (Salvia) seam', async () => {
    const dispatch = streamingDispatch({ claims: [modelClaim()] });
    const validate = vi.fn(() => ({ status: 'rejected', reasons: ['nope'] }));
    const agent = createGradStudentAgent({ dispatch, validate });
    const packet = await agent({
      subspecialization: { id: 's', label: 'L', query: 'q' },
      papers: [paper()],
      onClaimRender: () => {},
    });
    expect(validate).toHaveBeenCalled();
    expect(packet.result.claims[0].salvia_status).toBe('rejected');
  });

  it('extracts papers in parallel and aggregates their claims', async () => {
    let n = 0;
    const dispatch = vi.fn(async (spec) => {
      const id = `c${n}`;
      n += 1;
      const body = { claims: [modelClaim({ claim_id: id })] };
      if (typeof spec.onToken === 'function') {
        const s = JSON.stringify(body);
        for (let i = 0; i < s.length; i += 9) spec.onToken(s.slice(i, i + 9));
      }
      return body;
    });
    const agent = createGradStudentAgent({ dispatch });
    const packet = await agent({
      subspecialization: { id: 'subspec-1', label: 'L', query: 'q' },
      papers: [paper({ doi: '10.1/a' }), paper({ doi: '10.1/b' })],
      onClaimRender: () => {},
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(packet.result.claims).toHaveLength(2);
  });

  it('returns no claims (and never throws) when dispatch yields the safe default', async () => {
    const dispatch = vi.fn(async (spec) => spec.safeDefault);
    const agent = createGradStudentAgent({ dispatch });
    const packet = await agent({
      subspecialization: { id: 's', label: 'L', query: 'q' },
      papers: [paper()],
      onClaimRender: () => {},
    });
    expect(packet.result.claims).toEqual([]);
    expect(gradStudentResultSchema(packet.result)).toBe(true);
  });

  it('assembles a valid result with grad_student_id and retrieval_density', async () => {
    const dispatch = streamingDispatch({ claims: [modelClaim()] });
    const agent = createGradStudentAgent({ dispatch, papersBudget: 40 });
    const packet = await agent({
      subspecialization: { id: 'subspec-1', label: 'Cognitive aging', query: 'q' },
      papers: [paper(), paper({ doi: '10.1/q' })],
      onClaimRender: () => {},
    });
    expect(gradStudentResultSchema(packet.result)).toBe(true);
    expect(packet.result.subspecialization_id).toBe('subspec-1');
    expect(packet.result.grad_student_id).toContain('subspec-1');
    expect(packet.result.metadata.retrieval_density).toBeCloseTo(2 / 40, 5);
  });

  it('sends the Grad Student prompt and the paper + subspecialization context', async () => {
    const dispatch = streamingDispatch({ claims: [] });
    const agent = createGradStudentAgent({ dispatch });
    await agent({
      subspecialization: { id: 's', label: 'Cognitive aging', query: 'q' },
      papers: [paper({ title: 'Paper X' })],
      onClaimRender: () => {},
    });
    const spec = dispatch.mock.calls[0][0];
    expect(spec.messages[0]).toEqual({ role: 'system', content: GRAD_STUDENT_SYSTEM_PROMPT });
    const user = spec.messages.find((m) => m.role === 'user');
    expect(user.content).toContain('Paper X');
    expect(user.content).toContain('Cognitive aging');
  });

  it('claimsResultSchema validates the model output contract', () => {
    expect(claimsResultSchema({ claims: [modelClaim()] })).toBe(true);
    expect(claimsResultSchema({ claims: [] })).toBe(true);
    expect(claimsResultSchema({ claims: [{ text: 'no id' }] })).toBe(false);
    expect(claimsResultSchema({ claims: [{ claim_id: 'x', text: '' }] })).toBe(false);
    expect(claimsResultSchema({ claims: [{ claim_id: 'x', text: 't', claim_type: [1] }] })).toBe(false);
    expect(claimsResultSchema({ claims: 'x' })).toBe(false);
    expect(claimsResultSchema(null)).toBe(false);
    // claim_type/entity_references/supporting_paper_dois may be omitted (filled at normalize)
    expect(claimsResultSchema({ claims: [{ claim_id: 'x', text: 't' }] })).toBe(true);
  });
});
