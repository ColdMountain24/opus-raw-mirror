import { describe, expect, it, vi } from 'vitest';
import {
  createLoop2EdgarAgent,
  edgarResultSchema,
  CORE_SOURCES,
  DOMAIN_SOURCES,
  paperKey,
} from '../../../src/agents/loop2/edgar.js';

// Edgar Allan configured as the Loop 2 (The Archive) per-subspecialization retriever.
// Like Loop 1's Edgar it never touches the network directly: tests inject fake source
// clients (mirroring how the dispatcher tests inject transports). The Loop 2 contract
// adds full_text_available per paper, a subspecialization_id, and a GlobalKG filter.

const paper = (over = {}) => ({
  title: 'A paper',
  authors: ['Poe, E.'],
  year: 2023,
  doi: '',
  abstract: 'An abstract.',
  source: 'test',
  full_text_available: false,
  ...over,
});

// A source client that records its calls and returns a fixed list.
function source(papers = []) {
  const fn = vi.fn(async (query, opts) => {
    fn.queries.push({ query, opts });
    return papers;
  });
  fn.queries = [];
  return fn;
}

// Build a sources map of empty fakes for every core source, overlaying any given.
function coreSources(overrides = {}) {
  const map = {};
  for (const name of CORE_SOURCES) map[name] = source([]);
  return { ...map, ...overrides };
}

describe('Edgar Allan Loop 2 per-subspecialization retriever', () => {
  it('queries across the full core source list with the subspecialization query', async () => {
    const sources = coreSources();
    const edgar = createLoop2EdgarAgent({ sources });
    await edgar({ subspecializationId: 'subspec-1', query: 'fasting and memory' });

    for (const name of CORE_SOURCES) {
      expect(sources[name]).toHaveBeenCalledTimes(1);
      expect(sources[name].queries[0].query).toBe('fasting and memory');
    }
  });

  it('returns the Loop 2 contract: papers with full_text_available, a subspecialization_id, a count', async () => {
    const sources = coreSources({
      pubmed: source([paper({ title: 'P', source: 'pubmed', doi: '10.1/p', full_text_available: true })]),
    });
    const edgar = createLoop2EdgarAgent({ sources });
    const packet = await edgar({ subspecializationId: 'subspec-7', query: 'q' });

    expect(packet.agentId).toBe('Edgar Allan');
    expect(packet.result.subspecialization_id).toBe('subspec-7');
    expect(packet.result.retrieval_count).toBe(1);
    expect(packet.result.papers[0]).toEqual({
      title: 'P',
      authors: ['Poe, E.'],
      year: 2023,
      doi: '10.1/p',
      abstract: 'An abstract.',
      source: 'pubmed',
      full_text_available: true,
    });
    expect(edgarResultSchema(packet.result)).toBe(true);
  });

  it('normalizes full_text_available to a boolean and defaults it to false', async () => {
    const sources = coreSources({
      pubmed: source([{ title: 'A', authors: ['x'], year: 2020, source: 'pubmed', doi: '10/a', full_text_available: 'yes' }]),
      arxiv: source([{ title: 'B', authors: ['y'], year: 2021, source: 'arxiv', doi: '10/b' }]), // missing -> false
    });
    const edgar = createLoop2EdgarAgent({ sources });
    const packet = await edgar({ subspecializationId: 's', query: 'q' });
    const byTitle = Object.fromEntries(packet.result.papers.map((p) => [p.title, p.full_text_available]));
    expect(byTitle.A).toBe(true);
    expect(byTitle.B).toBe(false);
  });

  it('dedupes within the batch by DOI, then by title + year + first author', async () => {
    const sources = coreSources({
      pubmed: source([paper({ title: 'Shared', doi: '10.1/x', source: 'pubmed' })]),
      semanticScholar: source([
        paper({ title: 'Shared (preprint)', doi: '10.1/x', source: 'semanticScholar' }), // same DOI -> dup
        paper({ title: 'Unique', doi: '', year: 2022, authors: ['Lee, A.'], source: 'semanticScholar' }),
        paper({ title: 'Unique', doi: '', year: 2022, authors: ['Lee, A.'], source: 'embase' }), // same t+y+author -> dup
        paper({ title: 'Unique', doi: '', year: 2022, authors: ['Kim, B.'], source: 'scopus' }), // different author -> kept
      ]),
    });
    const edgar = createLoop2EdgarAgent({ sources });
    const packet = await edgar({ subspecializationId: 's', query: 'q' });
    // one shared-DOI + Unique/Lee + Unique/Kim = 3
    expect(packet.result.retrieval_count).toBe(3);
  });

  it('filters out papers already in the GlobalKG (existingPapers)', async () => {
    const known = paper({ title: 'Already known', doi: '10.1/known', source: 'pubmed' });
    const sources = coreSources({
      pubmed: source([known, paper({ title: 'Fresh', doi: '10.1/fresh', source: 'pubmed' })]),
    });
    const edgar = createLoop2EdgarAgent({ sources });
    const packet = await edgar({ subspecializationId: 's', query: 'q', existingPapers: [known] });
    expect(packet.result.retrieval_count).toBe(1);
    expect(packet.result.papers[0].title).toBe('Fresh');
  });

  it('filters against GlobalKG keys read through the loadKnownKeys seam', async () => {
    const dup = paper({ title: 'In KG', doi: '', year: 2019, authors: ['Doe, J.'], source: 'arxiv' });
    const sources = coreSources({ arxiv: source([dup, paper({ title: 'New', doi: '10/new', source: 'arxiv' })]) });
    const loadKnownKeys = vi.fn(async () => [paperKey(dup)]);
    const edgar = createLoop2EdgarAgent({ sources, loadKnownKeys });
    const packet = await edgar({ subspecializationId: 's', query: 'q' });
    expect(loadKnownKeys).toHaveBeenCalledTimes(1);
    expect(packet.result.papers.map((p) => p.title)).toEqual(['New']);
  });

  it('adds domain-specific sources for the RQPacket domain', async () => {
    const dblp = source([paper({ title: 'D', doi: '10/d', source: 'dblp' })]);
    const sources = coreSources({ dblp });
    const edgar = createLoop2EdgarAgent({ sources });
    await edgar({ subspecializationId: 's', query: 'q', paradigm: 'computational' });
    expect(dblp).toHaveBeenCalledTimes(1);
  });

  it('survives a source failure: surfaces it to the logger and keeps the others', async () => {
    const events = [];
    const sources = coreSources({
      pubmed: vi.fn(async () => {
        throw new Error('pubmed 503');
      }),
      arxiv: source([paper({ title: 'S', doi: '10.1/s', source: 'arxiv' })]),
    });
    const edgar = createLoop2EdgarAgent({ sources, logger: (e) => events.push(e) });
    const packet = await edgar({ subspecializationId: 's', query: 'q' });

    expect(packet.result.retrieval_count).toBe(1);
    const err = events.find((e) => e.type === 'edgar:source_error');
    expect(err).toMatchObject({ source: 'pubmed' });
    expect(err.message).toMatch(/pubmed 503/);
  });

  it('caps retrieval at the configured cap', async () => {
    const many = Array.from({ length: 8 }, (_, i) => paper({ title: `T${i}`, doi: `10.1/${i}`, source: 'arxiv' }));
    const sources = coreSources({ arxiv: source(many) });
    const edgar = createLoop2EdgarAgent({ sources, cap: 3 });
    const packet = await edgar({ subspecializationId: 's', query: 'q' });
    expect(packet.result.papers.length).toBe(3);
    expect(packet.result.retrieval_count).toBe(3);
  });

  it('returns a valid empty result when no source is wired (default sources)', async () => {
    const events = [];
    const edgar = createLoop2EdgarAgent({ logger: (e) => events.push(e) });
    const packet = await edgar({ subspecializationId: 'subspec-9', query: 'fasting' });
    expect(packet.result).toEqual({ papers: [], subspecialization_id: 'subspec-9', retrieval_count: 0 });
    expect(edgarResultSchema(packet.result)).toBe(true);
    // Not-wired sources surface as errors, never swallowed silently.
    expect(events.some((e) => e.type === 'edgar:source_error')).toBe(true);
  });

  it('paperKey uses the DOI, falling back to title + year + first author', () => {
    expect(paperKey(paper({ doi: '10.1/A' }))).toBe('doi:10.1/a');
    const noDoi = paper({ doi: '', title: 'Fasting', year: 2020, authors: ['Lee, A.', 'Kim, B.'] });
    expect(paperKey(noDoi)).toBe('tya:fasting|2020|lee, a.');
  });

  it('edgarResultSchema accepts the contract and rejects off-contract values', () => {
    const ok = { papers: [paper({ doi: '10/a' })], subspecialization_id: 's', retrieval_count: 1 };
    expect(edgarResultSchema(ok)).toBe(true);
    expect(edgarResultSchema({ papers: [], subspecialization_id: '', retrieval_count: 0 })).toBe(true);
    // subspecialization_id must be a string
    expect(edgarResultSchema({ papers: [], subspecialization_id: 1, retrieval_count: 0 })).toBe(false);
    // retrieval_count must equal papers.length
    expect(edgarResultSchema({ papers: [paper({ doi: '10/a' })], subspecialization_id: 's', retrieval_count: 0 })).toBe(false);
    // a paper missing full_text_available is off-contract
    const noFta = { title: 't', authors: ['a'], year: 2020, doi: '', abstract: '', source: 'x' };
    expect(edgarResultSchema({ papers: [noFta], subspecialization_id: 's', retrieval_count: 1 })).toBe(false);
    // full_text_available must be a boolean
    expect(edgarResultSchema({ papers: [paper({ doi: '10/a', full_text_available: 'yes' })], subspecialization_id: 's', retrieval_count: 1 })).toBe(false);
    // year must be an integer
    expect(edgarResultSchema({ papers: [paper({ doi: '10/a', year: '2020' })], subspecialization_id: 's', retrieval_count: 1 })).toBe(false);
    expect(edgarResultSchema(null)).toBe(false);
    expect(DOMAIN_SOURCES.computational).toContain('dblp');
  });
});
