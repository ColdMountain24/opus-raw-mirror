// Loop 1 (The Agora) RQPacket schema and the completeness scorer.
//
// The FINAL RQPacket field set (user-supplied) and the deterministic completeness
// rule CV applies. The packet is structured: top-level investigation fields, a Scope
// block (universal fields plus conditional fields that some paradigms make
// irrelevant), and classification fields (ParadigmClass, Subdomain, Design,
// StudyPhase) plus UnknownFields / IrrelevantFields markers and the derived
// Frameworks. The scorer is deterministic (no LLM): a populated field has content or
// is explicitly marked unknown; a conditional field the paradigm makes irrelevant is
// not counted; StudyPhase null is always valid; the pass threshold is 1.0.

// Required investigation fields at the packet top level.
export const TOP_LEVEL_REQUIRED = Object.freeze([
  'KnowledgeGap',
  'ObjectOfInquiry',
  'InvestigationWorkflow',
  'ValidationCriteria',
  'Claims',
]);

// Scope fields every paradigm requires.
export const SCOPE_UNIVERSAL = Object.freeze(['Population', 'Setting', 'InclusionCriteria', 'ExclusionCriteria']);

// Scope fields a paradigm may render irrelevant (skipped when listed in
// IrrelevantFields). Otherwise required.
export const SCOPE_CONDITIONAL = Object.freeze(['Timeframe', 'SpatialBoundary', 'DomainBoundary']);

// Classification fields. Design drives the framework lookup; StudyPhase null is
// always valid (it is never a required completeness field).
export const CLASSIFICATION_FIELDS = Object.freeze(['ParadigmClass', 'Subdomain', 'Design', 'StudyPhase']);

const SCOPE_FIELDS = new Set([...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL]);

// The pass threshold: every applicable required field must be populated.
export const PASS_THRESHOLD = 1.0;

// A fresh, empty packet (all fields null, marker arrays empty). The extraction fills
// it; this documents the shape in one place.
export function emptyRQPacket() {
  const scope = {};
  for (const f of [...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL]) scope[f] = null;
  const packet = { version: 0, Scope: scope, UnknownFields: [], IrrelevantFields: [], Frameworks: [] };
  for (const f of TOP_LEVEL_REQUIRED) packet[f] = null;
  for (const f of CLASSIFICATION_FIELDS) packet[f] = null;
  return packet;
}

// Read a field's value from wherever it lives (Scope fields under Scope, the rest at
// the top level).
function fieldValue(packet, name) {
  if (SCOPE_FIELDS.has(name)) {
    const scope = packet && packet.Scope && typeof packet.Scope === 'object' ? packet.Scope : {};
    return scope[name];
  }
  return packet ? packet[name] : undefined;
}

// A value "has content" when it is a non-empty string, a non-empty array, or any
// other non-null primitive/object.
function hasContent(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

// A field is populated when it has content OR the researcher explicitly marked it
// unknown (UnknownFields). An explicit "I do not know" counts as answered.
function isPopulated(packet, name) {
  const unknown = packet && Array.isArray(packet.UnknownFields) ? packet.UnknownFields : [];
  if (unknown.includes(name)) return true;
  return hasContent(fieldValue(packet, name));
}

// The required fields that actually apply to this packet: top-level + universal
// scope always; conditional scope only when the paradigm has not marked it
// irrelevant (IrrelevantFields).
export function applicableFields(packet) {
  const irrelevant = packet && Array.isArray(packet.IrrelevantFields) ? packet.IrrelevantFields : [];
  const conditional = SCOPE_CONDITIONAL.filter((f) => !irrelevant.includes(f));
  return [...TOP_LEVEL_REQUIRED, ...SCOPE_UNIVERSAL, ...conditional];
}

// Deterministic completeness scoring: score is the populated fraction of the
// applicable required fields; blocking_fields are the applicable fields not yet
// populated; status passes only at the 1.0 threshold (every applicable field
// populated). StudyPhase is never required, so its null never blocks.
export function scoreCompleteness(packet) {
  const fields = applicableFields(packet);
  const blocking_fields = fields.filter((name) => !isPopulated(packet, name));
  const populated = fields.length - blocking_fields.length;
  const score = fields.length === 0 ? 1 : populated / fields.length;
  const status = blocking_fields.length === 0 && score >= PASS_THRESHOLD ? 'pass' : 'fail';
  return { status, score, blocking_fields };
}
