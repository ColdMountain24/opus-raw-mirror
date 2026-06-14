// Loop 1 (The Agora) RQPacket -> file-cabinet folders.
//
// The schema-aware adapter between the FINAL RQPacket (rqschema.js) and the generic,
// schema-agnostic file-cabinet component. The component renders whatever folders it
// is handed; this module owns the mapping. The GROUPING is presentation only (Opus
// owns component decomposition): it invents no schema, the field names come straight
// from rqschema.js, and the packet shape is never mutated.
//
// Each field becomes { label, value, state }:
//   state 'filled'  -> the value has content; value is the rendered content.
//   state 'unknown' -> the field is in UnknownFields (the researcher said so).
//   state 'empty'   -> not yet specified.
// Fields the paradigm marked irrelevant (IrrelevantFields) are omitted entirely.

import {
  SCOPE_UNIVERSAL,
  SCOPE_CONDITIONAL,
} from './rqschema.js';

const SCOPE_FIELDS = new Set([...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL]);

// Presentation grouping of the FINAL fields into manila folders.
const GROUPS = [
  { id: 'question', label: 'Question', fields: ['KnowledgeGap', 'ObjectOfInquiry', 'Claims'] },
  { id: 'method', label: 'Method', fields: ['InvestigationWorkflow', 'ValidationCriteria', 'Design', 'StudyPhase'] },
  { id: 'scope', label: 'Scope', fields: [...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL] },
  { id: 'classification', label: 'Classification', fields: ['ParadigmClass', 'Subdomain'] },
];

const PLACEHOLDER_EMPTY = '(not yet specified)';
const PLACEHOLDER_UNKNOWN = '(unknown)';
const PLACEHOLDER_FRAMEWORKS = '(resolved from the study design)';

function hasContent(value) {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

// Read a field from wherever it lives (Scope fields under Scope, the rest top level).
function readValue(packet, name) {
  if (SCOPE_FIELDS.has(name)) {
    const scope = packet && packet.Scope && typeof packet.Scope === 'object' ? packet.Scope : {};
    return scope[name];
  }
  return packet ? packet[name] : undefined;
}

function display(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function fieldEntry(packet, name) {
  const unknown = packet && Array.isArray(packet.UnknownFields) ? packet.UnknownFields : [];
  if (unknown.includes(name)) return { label: name, value: PLACEHOLDER_UNKNOWN, state: 'unknown' };
  const raw = readValue(packet, name);
  if (hasContent(raw)) return { label: name, value: display(raw), state: 'filled' };
  return { label: name, value: PLACEHOLDER_EMPTY, state: 'empty' };
}

// Map an RQPacket (or null) to the folders the file cabinet renders. Tolerant of a
// missing/partial packet: every field falls back to its placeholder.
export function rqPacketFolders(packet) {
  const pkt = packet && typeof packet === 'object' ? packet : {};
  const irrelevant = Array.isArray(pkt.IrrelevantFields) ? pkt.IrrelevantFields : [];

  const folders = GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    fields: group.fields
      .filter((name) => !irrelevant.includes(name))
      .map((name) => fieldEntry(pkt, name)),
  }));

  // Frameworks: the deterministic id labels derived from the design (display only;
  // the framework CONTENT never appears, only the ids).
  const frameworks = Array.isArray(pkt.Frameworks) ? pkt.Frameworks : [];
  folders.push({
    id: 'frameworks',
    label: 'Frameworks',
    fields: [
      frameworks.length
        ? { label: 'Frameworks', value: frameworks.join(', '), state: 'filled' }
        : { label: 'Frameworks', value: PLACEHOLDER_FRAMEWORKS, state: 'empty' },
    ],
  });

  return folders;
}
