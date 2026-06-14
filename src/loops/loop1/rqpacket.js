// RQPacket assembler: builds and versions the RQPacket from Poe's extraction.
//
// This is the real implementation of Poe's `extractRQPacket` seam (poe.js calls it
// once per user turn, before CV, with { transcript, previous, version, userMessage }).
// poe.js owns the version counter (session.rqVersion, bumped every turn); the
// assembler stamps that version onto the packet and otherwise carries the prior
// packet forward.
//
// The one new capability over poe.js's deferred default is FRAMEWORK EXPANSION.
// When Poe's extraction names a framework (a single id the LLM emitted), the
// assembler asks the FrameworkRegistry for that framework's full field set and
// merges it in. The lookup is deterministic and client-side (post-LLM): framework
// CONTENT never goes into a prompt, only its id comes back from the model. The
// assembler does NOT use the dispatcher.
//
// Charter boundary. The assembler owns the assembly MECHANISM (carry-forward,
// version stamping, registry expansion). It does NOT own the FINAL RQPacket field
// schema, so it invents no domain field names: it copies the previous packet,
// applies whatever the registry/extraction provide, and stamps `version`. The way
// a framework id is read off the extraction (`frameworkIdOf`) and the way a field
// set is merged (`mergeFieldSet`) are seams with mechanism defaults: until the real
// extraction phase wires a framework id, `frameworkIdOf` returns null and the
// assembler degrades to exactly poe.js's prior carry-forward ({ ...previous, version }).

import { frameworkRegistry as defaultRegistry } from '../../utils/frameworkregistry.js';

function isObject(v) {
  return Boolean(v) && typeof v === 'object';
}

// Default field-id reader. Real extraction (a later phase) supplies the framework
// id; until then no id is known, so this returns null and the registry path stays
// dormant. Kept a seam so the FINAL extraction's key name is supplied there, not
// invented here.
function defaultFrameworkIdOf() {
  return null;
}

// Default merge of a framework's field set into the packet under construction. A
// shallow merge treats the registry's field set as the packet's domain fields. The
// FINAL RQPacket schema may place them differently; override this seam then.
function defaultMergeFieldSet(base, fieldSet) {
  return { ...base, ...(isObject(fieldSet) ? fieldSet : {}) };
}

export function createRQPacketAssembler(deps = {}) {
  const registry = deps.registry || defaultRegistry;
  const frameworkIdOf = typeof deps.frameworkIdOf === 'function' ? deps.frameworkIdOf : defaultFrameworkIdOf;
  const mergeFieldSet = typeof deps.mergeFieldSet === 'function' ? deps.mergeFieldSet : defaultMergeFieldSet;
  // No-op logger by default; main.js / tests inject one to observe a fail-closed
  // unknown-framework event. Nothing is swallowed silently.
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  // Implements extractRQPacket(args). Pure and dispatch-free: same inputs (and the
  // same registry state) always produce the same packet.
  return function assemble(args = {}) {
    const { previous, version, extraction } = args;
    // Carry the prior packet forward without mutating it.
    const base = { ...(isObject(previous) ? previous : {}) };

    let next = base;
    const frameworkId = frameworkIdOf({ ...args, extraction, previous });
    if (frameworkId != null) {
      const fieldSet = registry.lookup(frameworkId);
      if (fieldSet == null) {
        // Fail closed: an unknown framework id invents no fields. Surface it (not
        // swallowed) and carry the packet forward unchanged.
        logger({ type: 'framework:unknown', frameworkId });
      } else {
        next = mergeFieldSet(base, fieldSet, frameworkId);
      }
    }

    // Stamp the version Poe assigned this turn (poe.js owns the counter).
    next.version = version;
    return next;
  };
}

// Default app instance against the default (empty) registry singleton. main.js
// injects this as Poe's `extractRQPacket`. Tests build isolated assemblers with
// createRQPacketAssembler({ registry, frameworkIdOf, ... }).
export const rqPacketAssembler = createRQPacketAssembler();
