// Edgar Allan, the Loop 1 (The Agora) literature retriever.
//
// In Loop 1 Edgar Allan is invoked by the Novelty Checker to retrieve a targeted
// set of recent papers on the research question topic. It is NOT a top-level
// orchestrator turn this phase: it is built as a capability the Novelty Checker
// calls (the Novelty phase wires the invocation). It returns a validated
// structured result, { papers, query_used, retrieval_count }, capped at 20 papers
// per Loop 1 call, which the Novelty Checker reads.
//
// Edgar does NOT use the LLM dispatcher: its work is external literature
// retrieval, not an LLM call, so it has its own per-source transport seam
// (mirroring the dispatcher's transport seam). The source clients are injectable
// and default to a not-wired state (real fetch is a one-line fill-in per source
// later), so with nothing wired Edgar returns a valid empty result rather than
// throwing. A single source failing never fails the whole retrieval: the error is
// surfaced to the logger (no silent swallowing) and the other source continues.
//
// Source routing per spec: PubMed + Semantic Scholar for biomedical questions,
// arXiv + Semantic Scholar for general / computational questions.
//
// Charter boundary. Edgar owns its output contract (the result schema, given by
// the spec) and the retrieval mechanism. It does NOT own the RQPacket schema (it
// reads a query through the `buildQuery` seam) nor the domain-classification
// policy (the `classifyDomain` seam): both have documented defaults that read the
// small fields they were told about and are overridable.

// Source sets by domain (spec-defined).
export const SOURCE_SETS = Object.freeze({
  biomedical: Object.freeze(['pubmed', 'semanticScholar']),
  general: Object.freeze(['arxiv', 'semanticScholar']),
});

// Cap per Loop 1 call (spec).
export const RETRIEVAL_CAP = 20;

function notWired(name) {
  return async () => {
    throw new Error(`Edgar source not wired: ${name} (real fetch pending)`);
  };
}

// Default source clients: not wired. Each is async (query, opts) -> paper[].
const DEFAULT_SOURCES = Object.freeze({
  pubmed: notWired('pubmed'),
  semanticScholar: notWired('semanticScholar'),
  arxiv: notWired('arxiv'),
});

// One retrieved paper. Strict shape (spec): title and source non-empty strings,
// authors an array of strings, year an integer, doi and abstract strings.
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
    p.source.length > 0
  );
}

// Edgar's output contract, given by the spec. Strict, and it enforces the cap: a
// result with more than RETRIEVAL_CAP papers is off-contract.
export function edgarResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.query_used !== 'string') return false;
  if (!Number.isInteger(v.retrieval_count)) return false;
  if (!Array.isArray(v.papers) || !v.papers.every(isPaper)) return false;
  return v.papers.length <= RETRIEVAL_CAP;
}

// Safe (empty) result, always schema-valid. The query is carried in so even an
// empty retrieval reports what it searched for.
function emptyResult(query) {
  return { papers: [], query_used: typeof query === 'string' ? query : '', retrieval_count: 0 };
}

// Coerce a raw source record into the paper shape, defensively. Returns null when
// the record cannot be made into a usable paper (no title).
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
  };
}

// Dedupe by DOI when present, else by normalized title.
function dedupe(papers) {
  const seen = new Set();
  const out = [];
  for (const p of papers) {
    const key = p.doi ? `doi:${p.doi.toLowerCase()}` : `title:${p.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// Default query builder: prefer an explicit query, then the raw research question,
// then a query field the RQPacket may carry. Empty string when nothing is present.
function defaultBuildQuery({ query, researchQuestion, rqPacket } = {}) {
  if (typeof query === 'string' && query.trim()) return query.trim();
  if (typeof researchQuestion === 'string' && researchQuestion.trim()) return researchQuestion.trim();
  if (rqPacket && typeof rqPacket === 'object' && typeof rqPacket.query === 'string' && rqPacket.query.trim()) {
    return rqPacket.query.trim();
  }
  return '';
}

// Default domain classifier: an explicit 'biomedical' | 'general' wins; otherwise
// map the RQSupervisor paradigm (clinical -> biomedical, everything else,
// including computational, -> general). Overridable for the FINAL policy.
function defaultClassifyDomain({ domain, paradigm } = {}) {
  if (domain === 'biomedical' || domain === 'general') return domain;
  const p = typeof paradigm === 'string' ? paradigm.toLowerCase() : '';
  return p.includes('clinical') || p.includes('biomed') ? 'biomedical' : 'general';
}

function summarize(result) {
  const n = result.retrieval_count;
  return `Retrieved ${n} paper${n === 1 ? '' : 's'} for: ${result.query_used || '(no query)'}.`;
}

export function createEdgarAgent(deps = {}) {
  const sources = { ...DEFAULT_SOURCES, ...(deps.sources || {}) };
  const cap = Number.isInteger(deps.cap) && deps.cap > 0 ? deps.cap : RETRIEVAL_CAP;
  const recencyYears = Number.isInteger(deps.recencyYears) ? deps.recencyYears : 5;
  const buildQuery = deps.buildQuery || defaultBuildQuery;
  const classifyDomain = deps.classifyDomain || defaultClassifyDomain;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Edgar Allan', ...data });
    } catch (_err) {
      // logging is best effort and must never break a retrieval
    }
  };

  // The retrieval step. Returns a packet attributed to Edgar Allan whose `result`
  // is the validated { papers, query_used, retrieval_count }. Callable directly by
  // the Novelty Checker, and shaped like any backstage agent's packet.
  return async function edgarRetrieve(ctx = {}) {
    const session = ctx.session || {};
    const query = buildQuery({
      query: ctx.query,
      researchQuestion: ctx.researchQuestion != null ? ctx.researchQuestion : session.researchQuestion,
      rqPacket: session.rqPacket,
    });
    const domain = classifyDomain({
      domain: ctx.domain,
      paradigm: ctx.paradigm != null ? ctx.paradigm : session.paradigm,
    });
    const sourceNames = SOURCE_SETS[domain] || SOURCE_SETS.general;

    const collected = [];
    for (const name of sourceNames) {
      const client = sources[name];
      if (typeof client !== 'function') {
        emit('edgar:source_missing', { source: name });
        continue;
      }
      try {
        const got = await client(query, { limit: cap, recencyYears });
        for (const raw of Array.isArray(got) ? got : []) {
          const paper = normalizePaper(raw, name);
          if (paper) collected.push(paper);
        }
      } catch (err) {
        // No silent swallowing: surface the source failure; one source down does
        // not fail the retrieval.
        emit('edgar:source_error', { source: name, message: err && err.message ? err.message : String(err) });
      }
    }

    const papers = dedupe(collected).slice(0, cap);
    const result = { papers, query_used: query, retrieval_count: papers.length };
    const validated = edgarResultSchema(result) ? result : emptyResult(query);

    return {
      agentId: 'Edgar Allan',
      content: summarize(validated),
      result: validated,
      control: {},
      rqVersion: session.rqVersion,
    };
  };
}

// Default app instance. The Novelty Checker phase injects this (or a configured
// instance) and invokes it. Tests build isolated agents with createEdgarAgent({
// sources, ... }) on fake source clients.
export const edgarAgent = createEdgarAgent();
