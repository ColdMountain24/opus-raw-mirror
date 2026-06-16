// Revision Check, the RQ_REVISION_CHECK control point. It checks the question against the evidence
// by invoking Skips (the cross-subspecialization analyst, an internal tool) and FORWARDS (the default
// edge -> MATERIAL_CONTRADICTIONS, where Poe surfaces the contradictions Skips found), carrying the
// Skips result on its packet so the downstream states (and the IO panel) can read it:
//   - contradictions  -> surfaced to the researcher at MATERIAL_CONTRADICTIONS (Poe).
//   - unknown_fields  -> consumed by the UNKNOWN_FIELD_SURFACING loop (orchestrator-owned): the
//     orchestrator unions them with Salvia's unaddressed fields and re-sweeps via Fearless Leader.
// The scan uses the extraction tier (Skips). Revision Check no longer routes the re-sweep itself; the
// loop + its iteration cap moved into the orchestrator (the UNKNOWN_FIELD_SURFACING state).
//
// Charter boundary. This is a MECHANISM (invoke the scan, forward its structured result). It owns no
// claim/contradiction content (Skips does) and adds no routing edges beyond the user-supplied table.

import { skipsAgent } from '../../agents/loop2/skips.js';

export function createRevisionCheck(deps = {}) {
  const skips = deps.skips || skipsAgent;

  function summarize(contradictions, unknownFields) {
    const c = contradictions.length;
    const u = unknownFields.length;
    const tail = c ? 'surfacing contradictions for review' : u ? 'unknown fields open for re-sweep' : 'no revision needed';
    return `Revision check: ${c} contradiction${c === 1 ? '' : 's'}, ${u} unknown field${u === 1 ? '' : 's'} (${tail}).`;
  }

  // The RQ_REVISION_CHECK step. Returns a Revision Check packet carrying the Skips result and the
  // default forward edge (no re-sweep routing here; the UNKNOWN_FIELD_SURFACING loop owns that).
  return async function revisionCheck(ctx = {}) {
    const skipsPacket = await skips(ctx);
    const result = (skipsPacket && skipsPacket.result) || { contradictions: [], unknown_fields: [] };
    const contradictions = Array.isArray(result.contradictions) ? result.contradictions : [];
    const unknownFields = Array.isArray(result.unknown_fields) ? result.unknown_fields : [];

    return {
      agentId: 'Revision Check',
      content: summarize(contradictions, unknownFields),
      // The contradictions/unknown_fields ride along for MATERIAL_CONTRADICTIONS (Poe), the IO panel,
      // and the UNKNOWN_FIELD_SURFACING loop.
      result: { contradictions, unknown_fields: unknownFields },
      control: {},
    };
  };
}

// Default app instance. main.js injects this as the orchestrator's `Revision Check` step. Tests build
// isolated instances with createRevisionCheck({ skips }).
export const revisionCheck = createRevisionCheck();
