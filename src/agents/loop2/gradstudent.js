// Grad Student, the Loop 2 (The Archive) claim extractor.
//
// One Grad Student per subspecialization (the architecture's "one instance per
// subspecialization"). It reads the papers Edgar retrieved for its subspecialization and
// extracts structured claims from each, then assembles the claims-scoped SubspecializationKG.
//
// Streaming is the point. Each paper's claims are produced by a STREAMED dispatch: the
// provider's tokens are fed to the incremental claim-stream parser (claimstream.js) as they
// arrive, so a claim node appears in the Observatory and a card in the IO panel the moment its
// claim_id parses (loading) and its fields fill in progressively (parsed) - long before the
// full extraction completes. The parser drives PRESENTATION ONLY. The authoritative claims
// come from the dispatcher's FULL validated body (the hard constraint: never feed a partial
// parse downstream); each authoritative claim is then run through the validation seam (Salvia)
// and the node settles to confirmed / flagged / rejected.
//
// Papers are extracted in parallel through the dispatcher queue (Promise.allSettled), and the
// queue throttles concurrent calls to 80% of provider rate limits, so nothing fires unthrottled
// (see Opus_DELTAS: the Dynamic-Workflows decision is "queue-coordinated parallel dispatch").
//
// Charter boundary. The Grad Student owns its output contract (the claim schema is the
// architecture's SubspecializationKG Claim) and its safe default. confidence and
// citation_boost_count are NULL here (assigned by Post-Doc, a later phase); salvia_status is set
// by the validation seam (real Salvia logic is its own later phase; the default is a
// deterministic pass). The render NODE id is namespaced by subspecialization + paper so claims
// from different papers never collide on screen; the stored claim_id is the model's.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { GRAD_STUDENT_SYSTEM_PROMPT } from './prompts.js';
import { createClaimStreamParser } from './claimstream.js';
import { paperKey } from './edgar.js';
// Tiers live under loop1/ (historical home). FUTURE: move to a shared path.
import { EXTRACTION_TIER } from '../../loops/loop1/tiers.js';

export { EXTRACTION_TIER };

const SALVIA_STATUSES = ['valid', 'flagged', 'rejected'];

function isStringArray(a) {
  return Array.isArray(a) && a.every((s) => typeof s === 'string');
}

// The MODEL output contract validated by the dispatcher (what the LLM returns). Lenient on the
// array fields (the array fields may be omitted and are filled at normalize), strict on the
// claim's identity (claim_id + text): a claim with no id or no text is not a claim.
function isModelClaim(c) {
  return (
    c &&
    typeof c === 'object' &&
    typeof c.claim_id === 'string' &&
    c.claim_id.length > 0 &&
    typeof c.text === 'string' &&
    c.text.length > 0 &&
    (c.claim_type === undefined || isStringArray(c.claim_type)) &&
    (c.entity_references === undefined || isStringArray(c.entity_references)) &&
    (c.supporting_paper_dois === undefined || isStringArray(c.supporting_paper_dois))
  );
}

export function claimsResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!Array.isArray(v.claims)) return false;
  return v.claims.every(isModelClaim);
}

// The dispatcher safe default when no provider is reachable: no claims (the paper yields nothing
// rather than the pipeline stalling). Schema-valid by construction.
export const GRAD_STUDENT_SAFE_DEFAULT = Object.freeze({ claims: [] });

// One assembled claim (architecture SubspecializationKG Claim), for the result-level schema.
function isClaim(c) {
  return (
    c &&
    typeof c === 'object' &&
    typeof c.claim_id === 'string' &&
    typeof c.text === 'string' &&
    isStringArray(c.claim_type) &&
    isStringArray(c.entity_references) &&
    isStringArray(c.supporting_paper_dois) &&
    (c.confidence === null || typeof c.confidence === 'number') &&
    (c.salvia_status === null || SALVIA_STATUSES.includes(c.salvia_status)) &&
    (c.citation_boost_count === null || Number.isInteger(c.citation_boost_count))
  );
}

// The Grad Student's assembled output: the claims-scoped SubspecializationKG.
export function gradStudentResultSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.subspecialization_id !== 'string') return false;
  if (typeof v.subspecialization_label !== 'string') return false;
  if (typeof v.grad_student_id !== 'string') return false;
  if (!isStringArray(v.edgar_queries)) return false;
  if (!v.metadata || typeof v.metadata.retrieval_density !== 'number') return false;
  if (!Array.isArray(v.claims) || !v.claims.every(isClaim)) return false;
  return true;
}

// Default Salvia seam: a deterministic grounding pass. A claim with no text is rejected (not a
// claim); a claim that cites no supporting paper is flagged (present but ungrounded); otherwise
// valid. The real Salvia (CitationExistence / AbstractGrounding / EntityConsistency) is its own
// later phase and replaces this via the `validate` dep.
export function defaultValidate(claim) {
  if (!claim || typeof claim.text !== 'string' || !claim.text.trim()) {
    return { status: 'rejected', reasons: ['claim has no text'] };
  }
  if (!Array.isArray(claim.supporting_paper_dois) || claim.supporting_paper_dois.length === 0) {
    return { status: 'flagged', reasons: ['claim cites no supporting papers'] };
  }
  return { status: 'valid', reasons: [] };
}

// Render node id: namespaced by subspecialization + paper so two papers' claims never collide on
// screen even if a model reuses a claim_id. The same id is used by the loading node (from the
// parser) and the settle transition (from the authoritative body), so they address one node.
function claimNodeId(subspecId, paperId, claimId) {
  return `${subspecId}::${paperId}::${claimId}`;
}

function normalizeClaim(mc) {
  return {
    claim_id: mc.claim_id,
    text: mc.text,
    claim_type: isStringArray(mc.claim_type) ? mc.claim_type : [],
    entity_references: isStringArray(mc.entity_references) ? mc.entity_references : [],
    supporting_paper_dois: isStringArray(mc.supporting_paper_dois) ? mc.supporting_paper_dois : [],
    confidence: null, // assigned by Post-Doc
    salvia_status: null, // set by the validation seam below
    citation_boost_count: null, // assigned by Post-Doc
  };
}

function summarize(result) {
  const n = result.claims.length;
  const valid = result.claims.filter((c) => c.salvia_status === 'valid').length;
  return `Extracted ${n} claim${n === 1 ? '' : 's'} for ${
    result.subspecialization_label || result.subspecialization_id || '(subspecialization)'
  } (${valid} valid, retrieval density ${result.metadata.retrieval_density.toFixed(2)}).`;
}

export function createGradStudentAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || GRAD_STUDENT_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 1024;
  const validate = typeof deps.validate === 'function' ? deps.validate : defaultValidate;
  const makeParser = deps.makeParser || createClaimStreamParser;
  // PapersBudget default 40 (architecture: configurable in Settings).
  const defaultBudget = Number.isInteger(deps.papersBudget) && deps.papersBudget > 0 ? deps.papersBudget : 40;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Grad Students', ...data });
    } catch (_err) {
      // logging is best effort and must never break an extraction
    }
  };

  function buildMessages(p, subspec) {
    return [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          `Subspecialization: ${subspec.label || subspec.id || '(unnamed)'} (id ${subspec.id || 'unknown'})\n` +
          `Search focus: ${subspec.query || ''}\n\n` +
          `Paper:\n` +
          `Title: ${p.title || '(untitled)'}\n` +
          `Authors: ${(Array.isArray(p.authors) ? p.authors : []).join(', ')}\n` +
          `Year: ${p.year == null ? '(unknown)' : p.year}\n` +
          `DOI: ${p.doi || '(none)'}\n` +
          `Abstract: ${p.abstract || ''}\n\n` +
          `Extract the claims this paper makes that are relevant to the subspecialization.`,
      },
    ];
  }

  // Extract claims from ONE paper: a streamed dispatch driving progressive render, then the
  // authoritative validated body settling each claim through the Salvia seam.
  async function extractFromPaper(p, subspec, onClaimRender, loopContext) {
    const paperId = paperKey(p);
    const opened = new Set(); // stream claim_ids already opened, so a repeat does not re-open

    const parser = makeParser({
      onClaimOpen: (_i, partial) => {
        const cid = partial.claim_id;
        if (!cid || opened.has(cid)) return;
        opened.add(cid);
        onClaimRender({
          type: 'open',
          nodeId: claimNodeId(subspec.id, paperId, cid),
          paperId,
          // The full source paper record rides along so the app can index it (DOI -> record) for the
          // Post-Doc final pass's clickable citation chips (the paper detail card in the IO panel).
          paper: p,
          subspecializationId: subspec.id,
          claim: { ...partial },
        });
      },
      onClaimField: (_i, key, value, partial) => {
        if (!partial.claim_id) return; // not renderable until it has an id
        onClaimRender({
          type: 'field',
          nodeId: claimNodeId(subspec.id, paperId, partial.claim_id),
          key,
          value,
          claim: { ...partial },
        });
      },
      onClaimClose: () => {},
    });

    const raw = await dispatch({
      agentId: 'Grad Students',
      tier: 'extraction',
      failover,
      messages: buildMessages(p, subspec),
      schema: claimsResultSchema,
      safeDefault: GRAD_STUDENT_SAFE_DEFAULT,
      maxTokens,
      onToken: (delta) => parser.push(delta),
      loopContext,
    });
    parser.end();

    // The authority is the full validated body, never the streamed partial.
    const modelClaims = claimsResultSchema(raw) ? raw.claims : [];
    const out = [];
    for (const mc of modelClaims) {
      const claim = normalizeClaim(mc);
      const verdict = validate(claim, { paper: p, subspecialization: subspec }) || { status: 'valid', reasons: [] };
      claim.salvia_status = SALVIA_STATUSES.includes(verdict.status) ? verdict.status : 'valid';
      onClaimRender({
        type: 'settled',
        nodeId: claimNodeId(subspec.id, paperId, mc.claim_id),
        status: claim.salvia_status,
        reasons: Array.isArray(verdict.reasons) ? verdict.reasons : [],
        paperId,
        paper: p,
        subspecializationId: subspec.id,
        claim: { ...claim },
      });
      out.push(claim);
    }
    return out;
  }

  // The per-subspecialization step. ctx carries the subspecialization assignment + the papers
  // Edgar retrieved for it + the render seam. Returns the claims-scoped SubspecializationKG.
  return async function gradStudent(ctx = {}) {
    const subspec = ctx.subspecialization || {};
    const papers = Array.isArray(ctx.papers) ? ctx.papers : [];
    const onClaimRender = typeof ctx.onClaimRender === 'function' ? ctx.onClaimRender : () => {};
    const loopContext = ctx.loopContext || (ctx.session && ctx.session.loopContext) || undefined;
    const budget = Number.isInteger(ctx.papersBudget) && ctx.papersBudget > 0 ? ctx.papersBudget : defaultBudget;
    const retrieval_density = budget > 0 ? Math.min(papers.length / budget, 1) : 0;
    const gradStudentId = `gs_${subspec.id || 'unknown'}`;

    // Papers extracted in parallel through the dispatcher queue (queue-coordinated fan-out).
    const settled = await Promise.allSettled(papers.map((p) => extractFromPaper(p, subspec, onClaimRender, loopContext)));
    const claims = [];
    settled.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        claims.push(...r.value);
      } else {
        // No silent swallowing: a paper that failed extraction is surfaced; the rest stand.
        emit('gradstudent:paper_error', {
          paper: paperKey(papers[idx] || {}),
          message: r.reason && r.reason.message ? r.reason.message : String(r.reason),
        });
      }
    });

    const result = {
      subspecialization_id: subspec.id || '',
      subspecialization_label: subspec.label || '',
      grad_student_id: gradStudentId,
      claims,
      edgar_queries: isStringArray(ctx.edgarQueries) ? ctx.edgarQueries : subspec.query ? [subspec.query] : [],
      metadata: { retrieval_density },
    };

    return {
      agentId: 'Grad Students',
      content: summarize(result),
      result,
      subspecializationId: subspec.id || '',
      control: {},
    };
  };
}

// Default app instance. The PHASE_1 coordinator (gradphase.js) injects this (or a configured
// instance) and runs one per subspecialization. Tests build isolated agents with
// createGradStudentAgent({ dispatch, ... }) on a fake streaming dispatch.
export const gradStudentAgent = createGradStudentAgent();
