import { describe, expect, it } from 'vitest';
import { rqPacketFolders } from '../../../src/loops/loop1/rqfolders.js';
import { emptyRQPacket } from '../../../src/loops/loop1/rqschema.js';

// rqfolders maps the FINAL RQPacket into file-cabinet folders. Presentation only:
// it groups the schema's field names, marks each field's state, omits irrelevant
// fields, and shows the deterministic framework ids. It never mutates the packet.

function folderById(folders, id) {
  return folders.find((f) => f.id === id);
}
function field(folder, label) {
  return folder.fields.find((f) => f.label === label);
}

describe('rqPacketFolders', () => {
  it('returns the five sections even for an empty packet, all placeholders', () => {
    const folders = rqPacketFolders(emptyRQPacket());
    expect(folders.map((f) => f.id)).toEqual([
      'question',
      'method',
      'scope',
      'classification',
      'frameworks',
    ]);
    // Every field in the question folder is an empty placeholder.
    const question = folderById(folders, 'question');
    expect(question.fields.every((f) => f.state === 'empty')).toBe(true);
    expect(field(question, 'KnowledgeGap').value).toBe('(not yet specified)');
    // Frameworks default to the derived placeholder.
    expect(field(folderById(folders, 'frameworks'), 'Frameworks').state).toBe('empty');
  });

  it('tolerates a null packet', () => {
    const folders = rqPacketFolders(null);
    expect(folders).toHaveLength(5);
    expect(folderById(folders, 'question').fields.length).toBeGreaterThan(0);
  });

  it('renders filled top-level and scope fields with their content', () => {
    const packet = {
      ...emptyRQPacket(),
      KnowledgeGap: 'whether fasting aids memory',
      Design: 'randomized_controlled_trial',
      Scope: { ...emptyRQPacket().Scope, Population: 'adults 50 to 70' },
      Frameworks: ['CONSORT'],
    };
    const folders = rqPacketFolders(packet);

    const kg = field(folderById(folders, 'question'), 'KnowledgeGap');
    expect(kg).toEqual({ label: 'KnowledgeGap', value: 'whether fasting aids memory', state: 'filled' });

    const design = field(folderById(folders, 'method'), 'Design');
    expect(design.state).toBe('filled');
    expect(design.value).toBe('randomized_controlled_trial');

    const pop = field(folderById(folders, 'scope'), 'Population');
    expect(pop.state).toBe('filled');
    expect(pop.value).toBe('adults 50 to 70');

    const fw = field(folderById(folders, 'frameworks'), 'Frameworks');
    expect(fw).toEqual({ label: 'Frameworks', value: 'CONSORT', state: 'filled' });
  });

  it('marks fields the researcher flagged as unknown', () => {
    const packet = { ...emptyRQPacket(), UnknownFields: ['ValidationCriteria'] };
    const vc = field(folderById(rqPacketFolders(packet), 'method'), 'ValidationCriteria');
    expect(vc).toEqual({ label: 'ValidationCriteria', value: '(unknown)', state: 'unknown' });
  });

  it('omits scope fields the paradigm marked irrelevant', () => {
    const packet = { ...emptyRQPacket(), IrrelevantFields: ['Timeframe', 'SpatialBoundary'] };
    const scope = folderById(rqPacketFolders(packet), 'scope');
    const labels = scope.fields.map((f) => f.label);
    expect(labels).not.toContain('Timeframe');
    expect(labels).not.toContain('SpatialBoundary');
    expect(labels).toContain('DomainBoundary'); // not marked irrelevant
    expect(labels).toContain('Population'); // universal, always present
  });

  it('joins multiple framework ids', () => {
    const packet = { ...emptyRQPacket(), Frameworks: ['PRISMA', 'PRISMA-MA'] };
    const fw = field(folderById(rqPacketFolders(packet), 'frameworks'), 'Frameworks');
    expect(fw.value).toBe('PRISMA, PRISMA-MA');
  });
});
