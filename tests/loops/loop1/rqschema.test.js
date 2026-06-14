import { describe, expect, it } from 'vitest';
import {
  scoreCompleteness,
  applicableFields,
  emptyRQPacket,
  TOP_LEVEL_REQUIRED,
  SCOPE_UNIVERSAL,
  SCOPE_CONDITIONAL,
  PASS_THRESHOLD,
} from '../../../src/loops/loop1/rqschema.js';

// Build a fully populated packet, then knock fields out per test.
function fullPacket() {
  const p = emptyRQPacket();
  for (const f of TOP_LEVEL_REQUIRED) p[f] = `${f} content`;
  for (const f of [...SCOPE_UNIVERSAL, ...SCOPE_CONDITIONAL]) p.Scope[f] = `${f} content`;
  p.ParadigmClass = 'clinical';
  p.Design = 'case_control';
  p.StudyPhase = null; // always valid
  return p;
}

describe('RQPacket completeness scorer', () => {
  it('passes at the 1.0 threshold when every applicable field is populated', () => {
    expect(PASS_THRESHOLD).toBe(1.0);
    const result = scoreCompleteness(fullPacket());
    expect(result.status).toBe('pass');
    expect(result.score).toBe(1);
    expect(result.blocking_fields).toEqual([]);
  });

  it('fails below 1.0 and names every unpopulated applicable field', () => {
    const p = fullPacket();
    p.KnowledgeGap = null;
    p.Scope.Population = '   '; // whitespace is not content
    const result = scoreCompleteness(p);
    expect(result.status).toBe('fail');
    expect(result.score).toBeLessThan(1);
    expect(result.blocking_fields).toContain('KnowledgeGap');
    expect(result.blocking_fields).toContain('Population');
  });

  it('counts a field listed in UnknownFields as populated (an explicit "unknown" is answered)', () => {
    const p = fullPacket();
    p.ObjectOfInquiry = null;
    p.UnknownFields = ['ObjectOfInquiry'];
    const result = scoreCompleteness(p);
    expect(result.status).toBe('pass');
    expect(result.blocking_fields).not.toContain('ObjectOfInquiry');
  });

  it('skips a conditional field the paradigm marks irrelevant (not counted, not blocking)', () => {
    const p = fullPacket();
    p.Scope.SpatialBoundary = null;
    p.Scope.Timeframe = null;
    p.IrrelevantFields = ['SpatialBoundary', 'Timeframe'];
    expect(applicableFields(p)).not.toContain('SpatialBoundary');
    expect(applicableFields(p)).not.toContain('Timeframe');
    const result = scoreCompleteness(p);
    expect(result.status).toBe('pass'); // the irrelevant conditionals do not block
    expect(result.blocking_fields).toEqual([]);
  });

  it('a conditional field NOT marked irrelevant still blocks when empty', () => {
    const p = fullPacket();
    p.Scope.DomainBoundary = null; // relevant and empty
    const result = scoreCompleteness(p);
    expect(result.status).toBe('fail');
    expect(result.blocking_fields).toContain('DomainBoundary');
  });

  it('StudyPhase null never blocks (it is not a required field)', () => {
    const p = fullPacket();
    p.StudyPhase = null;
    expect(scoreCompleteness(p).status).toBe('pass');
    expect(scoreCompleteness(p).blocking_fields).not.toContain('StudyPhase');
  });

  it('an empty packet blocks on all applicable required fields', () => {
    const result = scoreCompleteness(emptyRQPacket());
    expect(result.status).toBe('fail');
    expect(result.score).toBe(0);
    expect(result.blocking_fields).toEqual(applicableFields(emptyRQPacket()));
    expect(result.blocking_fields).toContain('KnowledgeGap');
    expect(result.blocking_fields).toContain('ExclusionCriteria');
  });
});
