// Loop 1 (The Agora) RQPacket extraction.
//
// The real implementation of Poe's `extractRQPacket` seam. Each user turn it
// dispatches on the extraction tier to pull the structured RQPacket fields from the
// conversation, then assembles the versioned packet. The study DESIGN comes from the
// model as a label; the reporting FRAMEWORK is resolved DETERMINISTICALLY from that
// design via DesignLookup (frameworksForDesign), never emitted by the model, and the
// framework CONTENT stays in the registry (it is never embedded in the packet, so it
// cannot leak into a downstream prompt). Only the framework ID labels go on the
// packet.
//
// Charter boundary. The field schema and the design->framework mapping are FINAL
// (rqschema.js, frameworks.js); this module is the extraction MECHANISM. It invents
// no field values (a down provider yields the empty extraction, which carries the
// prior packet forward) and no framework content.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { EXTRACTION_TIER } from './tiers.js';
import { EXTRACTION_SYSTEM_PROMPT } from './prompts.js';
import { frameworksForDesign } from './frameworks.js';
import {
  emptyRQPacket,
  TOP_LEVEL_REQUIRED,
  SCOPE_UNIVERSAL,
  SCOPE_CONDITIONAL,
  CLASSIFICATION_FIELDS,
} from './rqschema.js';

// The extraction output is a JSON object (fields may be omitted/null; we normalize
// after). Loose by design: a strict per-field schema would reject a partial draft.
export function extractionSchema(v) {
  return Boolean(v && typeof v === 'object' && !Array.isArray(v));
}

// Safe default when no provider is reachable: an empty extraction, which assembles to
// the prior packet carried forward with the bumped version (no invented fields).
export const EXTRACTION_SAFE_DEFAULT = Object.freeze({});

const STRING_LIST = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string') : []);

// A value "has content" when it is a non-empty string, a non-empty array, or any
// other non-null primitive/object. Mirrors rqschema's notion of populated.
function hasContent(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

// Assemble the versioned RQPacket from an extraction object plus the prior packet.
// Pure and deterministic given the extraction; the framework comes from the design.
export function assembleRQPacket(extraction, previous, version) {
  const ex = extraction && typeof extraction === 'object' ? extraction : {};
  // Normalize to the full shape: empty template overlaid with the carried-forward
  // previous packet, then the new extraction's provided fields.
  const packet = { ...emptyRQPacket() };
  if (previous && typeof previous === 'object') {
    for (const f of [...TOP_LEVEL_REQUIRED, ...CLASSIFICATION_FIELDS]) {
      if (previous[f] !== undefined) packet[f] = previous[f];
    }
    if (previous.Scope && typeof previous.Scope === 'object') {
      packet.Scope = { ...packet.Scope, ...previous.Scope };
    }
    if (Array.isArray(previous.UnknownFields)) packet.UnknownFields = previous.UnknownFields.slice();
    if (Array.isArray(previous.IrrelevantFields)) packet.IrrelevantFields = previous.IrrelevantFields.slice();
  }

  // Accumulating overlay: a new value overwrites only when it has content, or when the
  // carried-forward value was empty. A later extraction that returns null for a field
  // (because it was not in the latest read) must NOT wipe a value an earlier turn
  // established; the extraction prompt emits every key each turn, so without this the
  // packet would never accumulate and a complete question could never pass CV.
  for (const f of [...TOP_LEVEL_REQUIRED, ...CLASSIFICATION_FIELDS]) {
    if (ex[f] !== undefined && (hasContent(ex[f]) || !hasContent(packet[f]))) packet[f] = ex[f];
  }
  if (ex.Scope && typeof ex.Scope === 'object') {
    for (const f of [...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL]) {
      const v = ex.Scope[f];
      if (v !== undefined && (hasContent(v) || !hasContent(packet.Scope[f]))) packet.Scope[f] = v;
    }
  }
  if (ex.UnknownFields !== undefined) packet.UnknownFields = STRING_LIST(ex.UnknownFields);
  if (ex.IrrelevantFields !== undefined) packet.IrrelevantFields = STRING_LIST(ex.IrrelevantFields);

  // Framework id labels are deterministic from the design (never from the model).
  packet.Frameworks = frameworksForDesign(packet.Design);
  packet.version = version;
  return packet;
}

export function createExtractor(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const failover = deps.failover || EXTRACTION_TIER;
  const systemPrompt = deps.systemPrompt || EXTRACTION_SYSTEM_PROMPT;
  const maxTokens = deps.maxTokens || 1024;

  // Poe's extractRQPacket seam (async): dispatch the extraction, then assemble.
  return async function extract({ transcript = [], previous = null, version, loopContext } = {}) {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(Array.isArray(transcript) ? transcript : []),
      { role: 'system', content: 'Return only the JSON object for the conversation so far.' },
    ];

    const raw = await dispatch({
      agentId: 'Poe-extract',
      tier: 'extraction',
      failover,
      messages,
      schema: extractionSchema,
      safeDefault: EXTRACTION_SAFE_DEFAULT,
      maxTokens,
      loopContext,
    });

    return assembleRQPacket(raw && typeof raw === 'object' ? raw : {}, previous, version);
  };
}

// Default app instance against the real dispatch singleton. main.js injects this as
// Poe's extractRQPacket. Tests build isolated extractors with createExtractor({ dispatch }).
export const extractor = createExtractor();
