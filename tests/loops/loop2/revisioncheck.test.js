import { describe, expect, it, vi } from 'vitest';
import { createRevisionCheck } from '../../../src/loops/loop2/revisioncheck.js';

// Revision Check (RQ_REVISION_CHECK): invokes Skips and FORWARDS (default edge), carrying the Skips
// result. Contradictions ride to MATERIAL_CONTRADICTIONS; unknown_fields ride to the orchestrator's
// UNKNOWN_FIELD_SURFACING loop. Revision Check no longer routes the re-sweep itself (that moved into
// the orchestrator), so its control is always {}.

const skipsPacket = (contradictions = [], unknown_fields = []) => ({ agentId: 'Skips', result: { contradictions, unknown_fields } });

describe('Revision Check', () => {
  it('invokes Skips and default-forwards when there is nothing to revise', async () => {
    const skips = vi.fn(async () => skipsPacket([], []));
    const rc = createRevisionCheck({ skips });
    const packet = await rc({ history: [] });
    expect(skips).toHaveBeenCalledTimes(1);
    expect(packet.agentId).toBe('Revision Check');
    expect(packet.control).toEqual({}); // default forward edge -> MATERIAL_CONTRADICTIONS
    expect(packet.result).toEqual({ contradictions: [], unknown_fields: [] });
  });

  it('carries unknown_fields forward without routing (the UNKNOWN_FIELD_SURFACING loop owns the re-sweep)', async () => {
    const skips = vi.fn(async () => skipsPacket([], ['long-term effects']));
    const rc = createRevisionCheck({ skips });
    const packet = await rc({ history: [] });
    expect(packet.result.unknown_fields).toEqual(['long-term effects']);
    expect(packet.control).toEqual({}); // forwarded, not re-swept here
  });

  it('carries contradictions forward (to MATERIAL_CONTRADICTIONS) on the default edge', async () => {
    const c = [{ claim_a_id: 'a', claim_b_id: 'b', nature: 'opposed' }];
    const skips = vi.fn(async () => skipsPacket(c, []));
    const rc = createRevisionCheck({ skips });
    const packet = await rc({ history: [] });
    expect(packet.result.contradictions).toEqual(c);
    expect(packet.control).toEqual({});
  });
});
