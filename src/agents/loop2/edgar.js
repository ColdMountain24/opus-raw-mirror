// Edgar Allan, the Loop 2 (The Archive) per-subspecialization literature retriever.
//
// In Loop 2 Edgar Allan is called once per subspecialization with the query from
// Fearless Leader's plan. It queries across the full Loop 2 source list (PubMed,
// Semantic Scholar, Embase, Scopus, ClinicalTrials, arXiv, Lens.org, plus
// domain-specific sources chosen for the RQPacket domain) and returns a validated
// structured result, { papers, subspecialization_id, retrieval_count }, that the
// Grad Students read. Each paper now carries full_text_available.
//
// Two Loop 2 specifics over the Loop 1 retriever (src/loops/loop1/agents/edgar.js):
//   - the source list is the broad Loop 2 set, not the two-source Loop 1 sets;
//   - results are deduped against the GlobalKG: any paper already promoted into the
//     GlobalKG is filtered out before returning, so a subspecialization sweep only
//     surfaces papers new to the Archive. The dedup key is the DOI when present,
//     else title + year + first author (the spec's DOI-null fallback).
//
// Like Loop 1's Edgar this does NOT use the LLM dispatcher: literature retrieval is
// external, not an LLM call, so it has its own per-source transport seam. The source
// clients are injectable and default to a not-wired state (real fetch is a one-line
// fill-in per source later), so with nothing wired Edgar returns a valid empty result
// rather than throwing. A single source failing never fails the whole retrieval: the
// error is surfaced to the logger (no silent swallowing) and the other sources continue.
//
// Charter boundary. Edgar owns its output contract (the result schema, given by the
// spec) and the retrieval mechanism. It does NOT own the RQPacket schema (it reads a
// query through the `query` it is handed / the `buildQuery` seam), the domain-source
// policy (the `classifyDomain` + `domainSources` seams have documented, overridable
// defaults), nor the GlobalKG schema (it never reads the KG itself: known paper keys
// arrive through `existingPapers` / `knownKeys` / the `loadKnownKeys` seam, so the
// caller that owns the GlobalKG supplies what is already there).

// The Loop 2 core source list (spec): queried for every subspecialization regardless
// of domain.
export const CORE_SOURCES = Object.freeze([
  'pubmed',
  'semanticScholar',
  'embase',
  'scopus',
  'clinicalTrials',
  'arxiv',
  'lens',
]);

// Domain-specific extras layered on top of the core list. These are a documented,
// OVERRIDABLE default (not a FINAL policy): the architecture can replace the map. The
// names are real databases chosen as sensible defaults per domain; unknown ones simply
// surface as not-wired until a client is injected.
export const DOMAIN_SOURCES = Object.freeze({
  biomedical: Object.freeze(['cochrane']),
  computational: Object.freeze(['dblp', 'acmDigitalLibrary', 'ieeeXplore']),
  general: Object.freeze([]),
});

// A generous default per-subspecialization bound. The spec is silent on a cap; this is
// a reliability guard against an unbounded sweep flooding the GlobalKG / Observatory,
// and it is overridable per instance. Applied as a slice, so it never makes a result
// off-contract (the schema's invariant is retrieval_count === papers.length).
export const RETRIEVAL_CAP = 50;

function notWired(name) {
  return async () => {
    throw new Error(`Edgar source not wired: ${name} (real fetch pending)`);
  };
}

// Default source clients: every known source, not wired. Each is async (query, opts)
// -> paper[]. Injecting a real client for a name replaces its entry.
const DEFAULT_SOURCES = (() => {
  const map = {};
  const names = new Set([...CORE_SOURCES, ...Object.values(DOMAIN_SOURCES).flat()]);
  for (const name of names) map[name] = notWired(name);
  return Object.freeze(map);
})();

// One retrieved paper, Loop 2 shape. Strict (spec): title and source non-empty
// strings, authors an array of strings, year an integer, doi and abstract strings,
// full_text_available a boolean.
function isPaper(p) {
  return (
    p &&
    typeof p === 'object' &&
    typeof p.title === 'string' &&
    p.title.length > 0 &&
    Array.isArray(p.authors) &&
    p.authors.every((a) => typeof a === 'string') &&
    Number.isInteger(p.year) &&
    typeof p.doi === 'string' &&
    typeof p.abstract === 'string' &&
    typeof p.source === 'string' &&
    p.source.length > 0 &&
    typeof p.full_text_available === 'boolean'
  );
}

// Edgar's Loop 2 output contract, given by the spec. Strict, and retrieval_count must
// equal the number of papers returned (the count is the size of the deduped result).
export function edgarResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.subspecialization_id !== 'string') return false;
  if (!Number.isInteger(v.retrieval_count)) return false;
  if (!Array.isArray(v.papers) || !v.papers.every(isPaper)) return false;
  return v.retrieval_count === v.papers.length;
}

// Safe (empty) result, always schema-valid. The subspecialization id is carried in so
// even an empty retrieval reports which subspecialization it ran for.
function emptyResult(subspecializationId) {
  return {
    papers: [],
    subspecialization_id: typeof subspecializationId === 'string' ? subspecializationId : '',
    retrieval_count: 0,
  };
}

// Coerce a raw source record into the Loop 2 paper shape, defensively. Returns null
// when the record cannot be made into a usable paper (no title).
function normalizePaper(p, sourceName) {
  if (!p || typeof p !== 'object') return null;
  const title = typeof p.title === 'string' ? p.title.trim() : '';
  if (!title) return null;
  const authors = Array.isArray(p.authors)
    ? p.authors.filter((a) => typeof a === 'string')
    : typeof p.authors === 'string'
      ? [p.authors]
      : [];
  const yearNum = Number.isInteger(p.year) ? p.year : parseInt(p.year, 10);
  return {
    title,
    authors,
    year: Number.isInteger(yearNum) ? yearNum : 0,
    doi: typeof p.doi === 'string' ? p.doi : '',
    abstract: typeof p.abstract === 'string' ? p.abstract : '',
    source: typeof p.source === 'string' && p.source ? p.source : sourceName,
    full_text_available: Boolean(p.full_text_available),
  };
}

// The dedup key: the DOI when present, else title + year + first author (the spec's
// DOI-null fallback). Used both for in-batch dedup and for the GlobalKG filter, so the
// two paths agree on identity. Exported so the GlobalKG owner can pre-compute keys.
export function paperKey(p) {
  if (p && typeof p.doi === 'string' && p.doi) return `doi:${p.doi.toLowerCase()}`;
  const title = p && typeof p.title === 'string' ? p.title.toLowerCase() : '';
  const year = p && (Number.isInteger(p.year) || typeof p.year === 'string') ? p.year : '';
  const firstAuthor = p && Array.isArray(p.authors) && p.authors[0] ? String(p.authors[0]).toLowerCase() : '';
  return `tya:${title}|${year}|${firstAuthor}`;
}

// Default query builder: prefer the explicit per-subspecialization query (the spec's
// path), then the raw research question, then a query the RQPacket may carry.
function defaultBuildQuery({ query, researchQuestion, rqPacket } = {}) {
  if (typeof query === 'string' && query.trim()) return query.trim();
  if (typeof researchQuestion === 'string' && researchQuestion.trim()) return researchQuestion.trim();
  if (rqPacket && typeof rqPacket === 'object' && typeof rqPacket.query === 'string' && rqPacket.query.trim()) {
    return rqPacket.query.trim();
  }
  return '';
}

// Default domain classifier: an explicit domain wins; otherwise map the RQPacket
// paradigm to one of the DOMAIN_SOURCES keys. Overridable for the FINAL policy.
function defaultClassifyDomain({ domain, paradigm, rqPacket } = {}) {
  if (domain && DOMAIN_SOURCES[domain]) return domain;
  const raw =
    (typeof paradigm === 'string' && paradigm) ||
    (rqPacket && typeof rqPacket === 'object' && typeof rqPacket.ParadigmClass === 'string' && rqPacket.ParadigmClass) ||
    '';
  const p = raw.toLowerCase();
  if (p.includes('clinical') || p.includes('biomed') || p.includes('medic')) return 'biomedical';
  if (p.includes('comput') || p.includes('ml') || p.includes('machine') || p.includes('algorithm')) return 'computational';
  return 'general';
}

function summarize(result, query) {
  const n = result.retrieval_count;
  return `Retrieved ${n} new paper${n === 1 ? '' : 's'} for subspecialization ${
    result.subspecialization_id || '(none)'
  } (query: ${query || '(no query)'}).`;
}

export function createLoop2EdgarAgent(deps = {}) {
  const sources = { ...DEFAULT_SOURCES, ...(deps.sources || {}) };
  const domainSources = deps.domainSources || DOMAIN_SOURCES;
  const cap = Number.isInteger(deps.cap) && deps.cap > 0 ? deps.cap : RETRIEVAL_CAP;
  const recencyYears = Number.isInteger(deps.recencyYears) ? deps.recencyYears : 5;
  const buildQuery = deps.buildQuery || defaultBuildQuery;
  const classifyDomain = deps.classifyDomain || defaultClassifyDomain;
  // Reads the dedup keys already in the GlobalKG. Default: none (the GlobalKG is empty
  // until the Bookkeeper promotes). The PHASE_1 wiring injects a real reader later; it
  // owns the GlobalKG schema, so Edgar stays decoupled from it.
  const loadKnownKeys = typeof deps.loadKnownKeys === 'function' ? deps.loadKnownKeys : null;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Edgar Allan', ...data });
    } catch (_err) {
      // logging is best effort and must never break a retrieval
    }
  };

  // Assemble the set of dedup keys already present in the GlobalKG, from every supplied
  // path: the loadKnownKeys seam, explicit knownKeys, and existingPapers (papers).
  async function knownKeySet(ctx) {
    const known = new Set();
    if (loadKnownKeys) {
      try {
        for (const k of (await loadKnownKeys(ctx)) || []) if (typeof k === 'string') known.add(k);
      } catch (err) {
        // A failed GlobalKG read is surfaced, not swallowed; dedup degrades to in-batch
        // only rather than failing the retrieval.
        emit('edgar:known_keys_error', { message: err && err.message ? err.message : String(err) });
      }
    }
    const explicit = Array.isArray(ctx.knownKeys) ? ctx.knownKeys : [];
    for (const k of explicit) if (typeof k === 'string') known.add(k);
    const existing = Array.isArray(ctx.existingPapers) ? ctx.existingPapers : [];
    for (const raw of existing) {
      const np = normalizePaper(raw, raw && raw.source);
      if (np) known.add(paperKey(np));
    }
    return known;
  }

  // The retrieval step. Returns a packet attributed to Edgar Allan whose `result` is the
  // validated { papers, subspecialization_id, retrieval_count }. Callable directly by the
  // Grad Students, and shaped like any backstage agent's packet.
  return async function edgarRetrieve(ctx = {}) {
    const session = ctx.session || {};
    const subspecializationId = ctx.subspecializationId != null ? ctx.subspecializationId : '';
    const query = buildQuery({
      query: ctx.query,
      researchQuestion: ctx.researchQuestion != null ? ctx.researchQuestion : session.researchQuestion,
      rqPacket: ctx.rqPacket != null ? ctx.rqPacket : session.rqPacket,
    });
    const domain = classifyDomain({
      domain: ctx.domain,
      paradigm: ctx.paradigm != null ? ctx.paradigm : session.paradigm,
      rqPacket: ctx.rqPacket != null ? ctx.rqPacket : session.rqPacket,
    });
    const extras = Array.isArray(domainSources[domain]) ? domainSources[domain] : [];
    const sourceNames = [...new Set([...CORE_SOURCES, ...extras])];

    const known = await knownKeySet(ctx);

    const seen = new Set();
    const collected = [];
    for (const name of sourceNames) {
      const client = sources[name];
      if (typeof client !== 'function') {
        emit('edgar:source_missing', { source: name });
        continue;
      }
      let got;
      try {
        got = await client(query, { limit: cap, recencyYears, subspecializationId });
      } catch (err) {
        // No silent swallowing: surface the source failure; one source down does not
        // fail the retrieval.
        emit('edgar:source_error', { source: name, message: err && err.message ? err.message : String(err) });
        continue;
      }
      for (const raw of Array.isArray(got) ? got : []) {
        const p = normalizePaper(raw, name);
        if (!p) continue;
        const key = paperKey(p);
        if (seen.has(key)) continue; // in-batch dedup
        if (known.has(key)) continue; // already in the GlobalKG
        seen.add(key);
        collected.push(p);
      }
    }

    const papers = collected.slice(0, cap);
    const result = { papers, subspecialization_id: subspecializationId, retrieval_count: papers.length };
    const validated = edgarResultSchema(result) ? result : emptyResult(subspecializationId);

    return {
      agentId: 'Edgar Allan',
      content: summarize(validated, query),
      result: validated,
      control: {},
      subspecializationId,
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance. The PHASE_1 (Grad Students) wiring injects this (or a configured
// instance) and calls it once per subspecialization. Tests build isolated agents with
// createLoop2EdgarAgent({ sources, ... }) on fake source clients.
export const loop2EdgarAgent = createLoop2EdgarAgent();
