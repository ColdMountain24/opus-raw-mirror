import { describe, expect, it } from 'vitest';
import {
  DESIGN_TO_FRAMEWORKS,
  FRAMEWORK_DEFINITIONS,
  frameworksForDesign,
  seedFrameworkRegistry,
  DESIGN_IDS,
} from '../../../src/loops/loop1/frameworks.js';
import { createFrameworkRegistry } from '../../../src/utils/frameworkregistry.js';

// The design -> framework anchors are FINAL; the registry contents are this module's
// and are looked up client-side (never in a prompt).

describe('DesignLookup (DESIGN_TO_FRAMEWORKS)', () => {
  it('resolves the canonical anchors deterministically', () => {
    expect(frameworksForDesign('case_control')).toEqual(['STROBE']);
    expect(frameworksForDesign('randomized_controlled_trial')).toEqual(['CONSORT']);
    expect(frameworksForDesign('systematic_review_with_meta')).toEqual(['PRISMA', 'PRISMA-MA']);
    expect(frameworksForDesign('scoping_review')).toEqual(['PRISMA-ScR']);
    expect(frameworksForDesign('ml_classification')).toEqual(['TRIPOD']);
    expect(frameworksForDesign('simulation')).toEqual(['TRACE']);
    expect(frameworksForDesign('constructive')).toEqual(['RAW_CONSTRUCTIVE']);
    expect(frameworksForDesign('theoretical')).toEqual(['RAW_THEORETICAL']);
    expect(frameworksForDesign('experimental_lab')).toEqual(['ARRIVE_2']);
  });

  it('returns no framework for an unknown or absent design', () => {
    expect(frameworksForDesign('not_a_design')).toEqual([]);
    expect(frameworksForDesign(null)).toEqual([]);
    expect(frameworksForDesign(undefined)).toEqual([]);
  });

  it('returns a copy so the anchors cannot be mutated through it', () => {
    const a = frameworksForDesign('case_control');
    a.push('X');
    expect(frameworksForDesign('case_control')).toEqual(['STROBE']);
  });

  it('every framework a design references has a registered definition', () => {
    const referenced = new Set(Object.values(DESIGN_TO_FRAMEWORKS).flat());
    for (const id of referenced) {
      expect(FRAMEWORK_DEFINITIONS[id], `missing definition for ${id}`).toBeTruthy();
    }
    expect(DESIGN_IDS).toContain('cross_sectional');
  });
});

describe('seedFrameworkRegistry', () => {
  it('registers every framework definition, retrievable by id, and is idempotent', () => {
    const reg = createFrameworkRegistry();
    seedFrameworkRegistry(reg);
    seedFrameworkRegistry(reg); // idempotent: no duplicate-registration throw

    expect(reg.has('STROBE')).toBe(true);
    expect(reg.lookup('CONSORT').name).toBe('CONSORT');
    expect(Array.isArray(reg.lookup('PRISMA').sections)).toBe(true);
    expect(reg.ids().sort()).toEqual(Object.keys(FRAMEWORK_DEFINITIONS).sort());
  });
});
