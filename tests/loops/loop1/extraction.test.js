import { describe, expect, it, vi } from 'vitest';
import {
  createExtractor,
  assembleRQPacket,
  extractionSchema,
  EXTRACTION_SAFE_DEFAULT,
} from '../../../src/loops/loop1/extraction.js';
import { EXTRACTION_TIER } from '../../../src/loops/loop1/tiers.js';
import { scoreCompleteness } from '../../../src/loops/loop1/rqschema.js';

const completeExtraction = () => ({
  KnowledgeGap: 'unclear whether fasting aids memory',
  ObjectOfInquiry: 'intermittent fasting and working memory',
  InvestigationWorkflow: 'a 12 week parallel trial',
  ValidationCriteria: 'change in n-back score',
  Claims: 'fasting improves working memory',
  Scope: {
    Population: 'adults 50 to 70',
    Setting: 'outpatient clinic',
    InclusionCriteria: 'healthy adults',
    ExclusionCriteria: 'diabetes',
    Timeframe: '12 weeks',
    SpatialBoundary: 'single site',
    DomainBoundary: 'cognitive aging',
  },
  ParadigmClass: 'clinical',
  Subdomain: 'cognitive aging',
  Design: 'randomized_controlled_trial',
  StudyPhase: null,
  UnknownFields: [],
  IrrelevantFields: [],
});

describe('assembleRQPacket', () => {
  it('builds the full packet, derives the framework from the design, and stamps the version', () => {
    const packet = assembleRQPacket(completeExtraction(), null, 3);
    expect(packet.version).toBe(3);
    expect(packet.KnowledgeGap).toBe('unclear whether fasting aids memory');
    expect(packet.Scope.Population).toBe('adults 50 to 70');
    // Framework id label is derived deterministically from the design.
    expect(packet.Frameworks).toEqual(['CONSORT']);
    // A complete extraction scores as a passing packet.
    expect(scoreCompleteness(packet).status).toBe('pass');
  });

  it('does not embed framework content, only the id labels', () => {
    const packet = assembleRQPacket({ ...completeExtraction(), Design: 'systematic_review_with_meta' }, null, 1);
    expect(packet.Frameworks).toEqual(['PRISMA', 'PRISMA-MA']);
    // No checklist sections leaked onto the packet.
    expect(JSON.stringify(packet)).not.toContain('sections');
  });

  it('carries the prior packet forward when the new extraction is empty', () => {
    const prev = assembleRQPacket(completeExtraction(), null, 1);
    const next = assembleRQPacket({}, prev, 2);
    expect(next.version).toBe(2);
    expect(next.KnowledgeGap).toBe(prev.KnowledgeGap); // carried forward
    expect(next.Frameworks).toEqual(['CONSORT']);
  });

  it('overlays the new extraction over the previous packet', () => {
    const prev = assembleRQPacket(completeExtraction(), null, 1);
    const next = assembleRQPacket({ KnowledgeGap: 'a sharper gap' }, prev, 2);
    expect(next.KnowledgeGap).toBe('a sharper gap'); // overwritten
    expect(next.Claims).toBe(prev.Claims); // untouched fields preserved
  });

  it('accumulates: a later extraction that nulls a filled field does not wipe it', () => {
    // The extraction prompt emits every key each turn (null for anything not in the
    // latest read), so a later null must preserve an earlier value or the packet never
    // accumulates and a complete question could never pass CV.
    const prev = assembleRQPacket(completeExtraction(), null, 1);
    const next = assembleRQPacket(
      { ...completeExtraction(), KnowledgeGap: null, Scope: { ...completeExtraction().Scope, Population: null } },
      prev,
      2,
    );
    expect(next.KnowledgeGap).toBe(prev.KnowledgeGap); // null did not wipe it
    expect(next.Scope.Population).toBe(prev.Scope.Population); // nor the scope field
    // A genuinely new value still overwrites.
    const updated = assembleRQPacket({ KnowledgeGap: 'a revised gap' }, prev, 3);
    expect(updated.KnowledgeGap).toBe('a revised gap');
  });

  it('normalizes UnknownFields / IrrelevantFields to string arrays and an unknown design to no framework', () => {
    const packet = assembleRQPacket(
      { Design: 'not_a_design', UnknownFields: ['Setting', 7], IrrelevantFields: ['Timeframe'] },
      null,
      1,
    );
    expect(packet.Frameworks).toEqual([]);
    expect(packet.UnknownFields).toEqual(['Setting']);
    expect(packet.IrrelevantFields).toEqual(['Timeframe']);
  });
});

describe('createExtractor', () => {
  it('dispatches on the extraction tier (Anthropic-first) with the transcript and returns the assembled packet', async () => {
    const dispatch = vi.fn(async () => completeExtraction());
    const extract = createExtractor({ dispatch });
    const transcript = [
      { role: 'user', content: 'I want to study fasting and memory.' },
      { role: 'assistant', content: 'Which population?' },
    ];

    const packet = await extract({ transcript, previous: null, version: 1 });

    expect(packet.version).toBe(1);
    expect(packet.Frameworks).toEqual(['CONSORT']);

    const spec = dispatch.mock.calls[0][0];
    expect(spec.agentId).toBe('Poe-extract');
    expect(spec.tier).toBe('extraction');
    expect(spec.failover).toEqual(EXTRACTION_TIER);
    expect(spec.failover[0]).toBe('anthropic');
    expect(spec.schema).toBe(extractionSchema);
    expect(spec.safeDefault).toBe(EXTRACTION_SAFE_DEFAULT);
    // The transcript is included in the extraction prompt.
    expect(spec.messages).toContainEqual({ role: 'user', content: 'I want to study fasting and memory.' });
  });

  it('falls back to the prior packet when no provider is reachable (safe default is empty)', async () => {
    const dispatch = vi.fn(async (spec) => spec.safeDefault); // empty extraction
    const extract = createExtractor({ dispatch });
    const prev = assembleRQPacket(completeExtraction(), null, 1);
    const packet = await extract({ transcript: [], previous: prev, version: 2 });
    expect(packet.version).toBe(2);
    expect(packet.KnowledgeGap).toBe(prev.KnowledgeGap); // carried forward, nothing invented
  });

  it('extractionSchema accepts an object and rejects non-objects', () => {
    expect(extractionSchema({})).toBe(true);
    expect(extractionSchema({ KnowledgeGap: 'x' })).toBe(true);
    expect(extractionSchema(null)).toBe(false);
    expect(extractionSchema([])).toBe(false);
    expect(extractionSchema('x')).toBe(false);
  });
});
