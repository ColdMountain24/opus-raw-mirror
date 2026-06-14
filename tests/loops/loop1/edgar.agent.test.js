import { describe, expect, it, vi } from 'vitest';
import {
  createEdgarAgent,
  edgarResultSchema,
  SOURCE_SETS,
  RETRIEVAL_CAP,
} from '../../../src/loops/loop1/agents/edgar.js';

// Edgar Allan configured as the Loop 1 literature retriever. Tests inject fake
// source clients (Edgar never touches the network directly), mirroring how the
// dispatcher tests inject transports.

const paper = (over = {}) => ({
  title: 'A paper',
  authors: ['Poe, E.'],
  year: 2023,
  doi: '',
  abstract: 'An abstract.',
  source: 'test',
  ...over,
});

// A source client that records its calls and returns a fixed list.
function source(name, papers = []) {
  const fn = vi.fn(async (query, opts) => {
    fn.queries.push({ query, opts });
    return papers;
  });
  fn.queries = [];
  return fn;
}

describe('Edgar Allan Loop 1 literature retriever', () => {
  it('routes biomedical questions to PubMed + Semantic Scholar', async () => {
    const pubmed = source('pubmed', [paper({ title: 'P', source: 'pubmed', doi: '10.1/p' })]);
    const semanticScholar = source('semanticScholar', [paper({ title: 'S', source: 'semanticScholar', doi: '10.1/s' })]);
    const arxiv = source('arxiv', [paper({ title: 'A', source: 'arxiv' })]);
    const edgar = createEdgarAgent({ sources: { pubmed, semanticScholar, arxiv } });

    const packet = await edgar({ domain: 'biomedical', query: 'fasting and memory' });

    expect(pubmed).toHaveBeenCalledTimes(1);
    expect(semanticScholar).toHaveBeenCalledTimes(1);
    expect(arxiv).not.toHaveBeenCalled();
    expect(packet.result.papers.map((p) => p.source).sort()).toEqual(['pubmed', 'semanticScholar']);
    expect(packet.agentId).toBe('Edgar Allan');
    expect(packet.result.query_used).toBe('fasting and memory');
  });

  it('routes general / computational questions to arXiv + Semantic Scholar', async () => {
    const pubmed = source('pubmed', [paper()]);
    const semanticScholar = source('semanticScholar', [paper({ title: 'S', source: 'semanticScholar', doi: '10.1/s' })]);
    const arxiv = source('arxiv', [paper({ title: 'A', source: 'arxiv', doi: '10.1/a' })]);
    const edgar = createEdgarAgent({ sources: { pubmed, semanticScholar, arxiv } });

    // A computational paradigm classifies to general.
    const packet = await edgar({ paradigm: 'computational', query: 'graph transformers' });

    expect(arxiv).toHaveBeenCalledTimes(1);
    expect(semanticScholar).toHaveBeenCalledTimes(1);
    expect(pubmed).not.toHaveBeenCalled();
    expect(packet.result.papers.map((p) => p.source).sort()).toEqual(['arxiv', 'semanticScholar']);
  });

  it('maps the clinical paradigm to biomedical sources', async () => {
    const pubmed = source('pubmed', []);
    const arxiv = source('arxiv', []);
    const semanticScholar = source('semanticScholar', []);
    const edgar = createEdgarAgent({ sources: { pubmed, arxiv, semanticScholar } });
    await edgar({ paradigm: 'clinical', query: 'q' });
    expect(pubmed).toHaveBeenCalledTimes(1);
    expect(arxiv).not.toHaveBeenCalled();
  });

  it('caps retrieval at 20 papers', async () => {
    const many = Array.from({ length: 25 }, (_, i) => paper({ title: `T${i}`, doi: `10.1/${i}`, source: 'arxiv' }));
    const arxiv = source('arxiv', many);
    const semanticScholar = source('semanticScholar', []);
    const edgar = createEdgarAgent({ sources: { arxiv, semanticScholar } });
    const packet = await edgar({ domain: 'general', query: 'q' });
    expect(packet.result.papers.length).toBe(RETRIEVAL_CAP);
    expect(packet.result.retrieval_count).toBe(RETRIEVAL_CAP);
  });

  it('dedupes across sources by DOI, then by title', async () => {
    const arxiv = source('arxiv', [paper({ title: 'Shared', doi: '10.1/x', source: 'arxiv' })]);
    const semanticScholar = source('semanticScholar', [
      paper({ title: 'Shared (preprint)', doi: '10.1/x', source: 'semanticScholar' }), // same DOI
      paper({ title: 'Unique', doi: '', source: 'semanticScholar' }),
      paper({ title: 'Unique', doi: '', source: 'semanticScholar' }), // same title, dup
    ]);
    const edgar = createEdgarAgent({ sources: { arxiv, semanticScholar } });
    const packet = await edgar({ domain: 'general', query: 'q' });
    expect(packet.result.retrieval_count).toBe(2); // one shared-DOI + one Unique
  });

  it('survives a source failure: surfaces it to the logger and keeps the other source', async () => {
    const events = [];
    const arxiv = vi.fn(async () => {
      throw new Error('arxiv 503');
    });
    const semanticScholar = source('semanticScholar', [paper({ title: 'S', doi: '10.1/s', source: 'semanticScholar' })]);
    const edgar = createEdgarAgent({ sources: { arxiv, semanticScholar }, logger: (e) => events.push(e) });
    const packet = await edgar({ domain: 'general', query: 'q' });

    expect(packet.result.retrieval_count).toBe(1);
    expect(packet.result.papers[0].source).toBe('semanticScholar');
    const err = events.find((e) => e.type === 'edgar:source_error');
    expect(err).toMatchObject({ source: 'arxiv' });
    expect(err.message).toMatch(/arxiv 503/);
  });

  it('normalizes ragged source records and drops untitled ones', async () => {
    const arxiv = source('arxiv', [
      { title: '  Trimmed  ', authors: 'Solo Author', year: '2021', source: 'arxiv' }, // string author, string year, no doi/abstract
      { authors: ['x'], year: 2020 }, // no title -> dropped
    ]);
    const semanticScholar = source('semanticScholar', []);
    const edgar = createEdgarAgent({ sources: { arxiv, semanticScholar } });
    const packet = await edgar({ domain: 'general', query: 'q' });
    expect(packet.result.papers.length).toBe(1);
    expect(packet.result.papers[0]).toEqual({
      title: 'Trimmed',
      authors: ['Solo Author'],
      year: 2021,
      doi: '',
      abstract: '',
      source: 'arxiv',
    });
    expect(edgarResultSchema(packet.result)).toBe(true);
  });

  it('returns a valid empty result when no source is wired (default sources)', async () => {
    const events = [];
    const edgar = createEdgarAgent({ logger: (e) => events.push(e) });
    const packet = await edgar({ domain: 'biomedical', query: 'fasting' });
    expect(packet.result).toEqual({ papers: [], query_used: 'fasting', retrieval_count: 0 });
    expect(edgarResultSchema(packet.result)).toBe(true);
    // Not-wired sources surface as errors, never swallowed silently.
    expect(events.filter((e) => e.type === 'edgar:source_error').length).toBe(2);
  });

  it('builds the query from the research question when none is given explicitly', async () => {
    const arxiv = source('arxiv', []);
    const semanticScholar = source('semanticScholar', []);
    const edgar = createEdgarAgent({ sources: { arxiv, semanticScholar } });
    const packet = await edgar({ domain: 'general', session: { researchQuestion: 'Does sleep aid memory?' } });
    expect(packet.result.query_used).toBe('Does sleep aid memory?');
    expect(arxiv.queries[0].query).toBe('Does sleep aid memory?');
  });

  it('edgarResultSchema accepts the contract and rejects off-contract values', () => {
    const ok = { papers: [paper({ doi: '10.1/a' })], query_used: 'q', retrieval_count: 1 };
    expect(edgarResultSchema(ok)).toBe(true);
    expect(edgarResultSchema({ papers: [], query_used: 'q', retrieval_count: 0 })).toBe(true);
    expect(edgarResultSchema({ papers: [], query_used: 1, retrieval_count: 0 })).toBe(false);
    expect(edgarResultSchema({ papers: [], query_used: 'q', retrieval_count: '0' })).toBe(false);
    expect(edgarResultSchema({ papers: [paper({ year: '2020' })], query_used: 'q', retrieval_count: 1 })).toBe(false);
    expect(edgarResultSchema({ papers: [{ title: 'x' }], query_used: 'q', retrieval_count: 1 })).toBe(false);
    // Over the cap is off-contract.
    const over = {
      papers: Array.from({ length: 21 }, (_, i) => paper({ title: `T${i}`, doi: `10.1/${i}` })),
      query_used: 'q',
      retrieval_count: 21,
    };
    expect(edgarResultSchema(over)).toBe(false);
    expect(SOURCE_SETS.biomedical).toEqual(['pubmed', 'semanticScholar']);
    expect(SOURCE_SETS.general).toEqual(['arxiv', 'semanticScholar']);
  });
});
