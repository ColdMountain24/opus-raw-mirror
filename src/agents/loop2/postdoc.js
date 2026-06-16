// Post-Doc, the Loop 2 (The Archive) synthesis lead. The Post-Doc reads the knowledge graph the review
// has built and synthesizes it into a structured LRSummary (literature-review summary) the researcher
// reviews and the later cessation/packaging stages consume.
//
// This phase builds the STANDARD pass (the orchestrator's POSTDOC_STANDARD state), which runs once per
// refinement round (after each BOOKKEEPER_STAGE; the loop re-enters it after a p53 CONTINUE) and
// produces a DRAFT LRSummary: { key_findings, evidence_strength, gaps, contradictions_summary }. It
// runs on the EXTRACTION TIER (a generative synthesis, so it dispatches through the spine like Salvia /
// Skips), STORES the draft on the session for the later passes to read, and settles BACKSTAGE to the IO
// panel for researcher review (never a conversation write - the TurnGate holds: one Poe).
//
// The FINAL pass (POSTDOC_FINAL, after a p53 CEASE) - the confidence / citation-chip / confidence-badge
// trust layer + the cessation card - is Phase 16, still deferred; this step returns a minimal valid
// placeholder for POSTDOC_FINAL so the cessation chain (CEASE -> POSTDOC_FINAL -> OUTPUT_HOOK) still moves.
//
// Charter boundary. The Post-Doc owns its output contract (the LRSummary draft schema, given verbatim by
// the spec) and its safe default. It does NOT own the GlobalKG / claim / RQPacket schemas (FINAL): it
// reasons over the KG + packet it is handed and invents no claims, papers, or findings.

import { dispatch as defaultDispatch } from '../../dispatcher/dispatcher.js';
import { POSTDOC_STANDARD_SYSTEM_PROMPT, POSTDOC_FINAL_SYSTEM_PROMPT } from './prompts.js';
// Tiers live under loop1/ (historical home). FUTURE: move to a shared path.
import { EXTRACTION_TIER } from '../../loops/loop1/tiers.js';
import { GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION, readContradictions } from './bookkeeper.js';
import { readSubspecializationKGs } from './salvia.js';
import { normalizeMathDelimiters } from '../../utils/mathtext.js';

export { EXTRACTION_TIER };

function isStringArray(a) {
  return Array.isArray(a) && a.every((s) => typeof s === 'string');
}

// The LRSummary draft contract, given verbatim by the spec. Strict: the session draft + the IO-panel
// display read this exact shape, so the dispatcher runs the corrective retry on a miss, then the safe
// default.
export function lrSummaryDraftSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!isStringArray(v.key_findings)) return false;
  if (typeof v.evidence_strength !== 'string') return false;
  if (!isStringArray(v.gaps)) return false;
  if (typeof v.contradictions_summary !== 'string') return false;
  return true;
}

function normalizeClaim(c, subspecId, idFallback) {
  return {
    id: typeof c[idFallback] === 'string' ? c[idFallback] : c.claim_id,
    raw_claim_id: typeof c.claim_id === 'string' ? c.claim_id : null,
    text: typeof c.text === 'string' ? c.text : '',
    claim_type: isStringArray(c.claim_type) ? c.claim_type : [],
    supporting_paper_dois: isStringArray(c.supporting_paper_dois) ? c.supporting_paper_dois : [],
    subspecialization_id: subspecId,
    // The Bookkeeper tags a contradicting GlobalKG claim with its partner(s); the final pass reads this
    // to compute a finding's confidence + the human-review flag (the staged fallback has no partners).
    contradiction: Array.isArray(c.contradiction_partners) && c.contradiction_partners.length > 0,
  };
}

// The knowledge graph the Post-Doc synthesizes, normalized to { source, claims, contradictions,
// subspecialization_ids }: the WRITTEN GlobalKG when present (the unified, deduped claim graph), else -
// on the first round, before the first BOOKKEEPER_PROMOTE - the staged SubspecializationKGs from
// history (+ the latest Skips contradictions). `emit` (optional) surfaces a kg.load failure; the
// synthesis never throws on a read error (it degrades to the staged KGs).
export async function readKnowledgeGraph(ctx = {}, emit) {
  const kgStore = (ctx.storage && ctx.storage.kg) || null;
  let global = null;
  if (kgStore && typeof kgStore.load === 'function') {
    try {
      global = await kgStore.load(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION);
    } catch (cause) {
      global = null;
      if (typeof emit === 'function') emit('postdoc:kg_load_error', { message: cause && cause.message ? cause.message : String(cause) });
    }
  }
  if (global && Array.isArray(global.claims) && global.claims.length) {
    return {
      source: 'global',
      subspecialization_ids: isStringArray(global.subspecialization_ids) ? global.subspecialization_ids : [],
      claims: global.claims.map((c) => normalizeClaim(c, c.subspecialization_id, 'global_claim_id')),
      contradictions: Array.isArray(global.contradictions) ? global.contradictions : [],
    };
  }
  // Round 1 fallback: the staged SubspecializationKGs (+ the latest cross-subspecialization contradictions).
  const staged = readSubspecializationKGs(ctx.history);
  const claims = [];
  const subspecIds = [];
  for (const kg of staged) {
    const subId = kg && typeof kg.subspecialization_id === 'string' ? kg.subspecialization_id : null;
    if (subId) subspecIds.push(subId);
    for (const c of Array.isArray(kg.claims) ? kg.claims : []) {
      if (c && typeof c.claim_id === 'string') claims.push(normalizeClaim(c, subId, 'claim_id'));
    }
  }
  return { source: 'staged', subspecialization_ids: subspecIds, claims, contradictions: readContradictions(ctx.history) };
}

// A coarse, deterministic evidence-strength label from the average supporting-paper count. Used only in
// the safe default (the model's evidence_strength is a free string); a structural floor, not a verdict.
function evidenceStrengthLabel(claims) {
  if (!claims.length) return 'insufficient';
  const totalSupport = claims.reduce((n, c) => n + (Array.isArray(c.supporting_paper_dois) ? c.supporting_paper_dois.length : 0), 0);
  const avg = totalSupport / claims.length;
  if (avg >= 3) return 'strong';
  if (avg >= 1.5) return 'moderate';
  return 'limited';
}

// A deterministic LRSummary draft from the KG structure: the dispatcher SAFE DEFAULT, so a provider
// outage still yields a usable, on-contract, non-empty draft. The synthesis prose is the model's job;
// this floor is structural (the leading claim texts, a coarse strength label, a contradiction count).
export function deterministicDraft(kg) {
  const claims = Array.isArray(kg.claims) ? kg.claims : [];
  const contradictions = Array.isArray(kg.contradictions) ? kg.contradictions : [];
  const n = contradictions.length;
  return {
    key_findings: claims.slice(0, 5).map((c) => c.text).filter((t) => typeof t === 'string' && t.trim()),
    evidence_strength: evidenceStrengthLabel(claims),
    gaps: [],
    contradictions_summary: n
      ? `${n} contradiction${n === 1 ? '' : 's'} flagged across the knowledge graph.`
      : 'No material contradictions flagged.',
  };
}

function summarize(result, kg) {
  const k = result.key_findings.length;
  const g = result.gaps.length;
  return (
    `Draft LRSummary from ${kg.claims.length} claim${kg.claims.length === 1 ? '' : 's'} (${kg.source}): ` +
    `${k} key finding${k === 1 ? '' : 's'}, evidence ${result.evidence_strength}, ${g} gap${g === 1 ? '' : 's'}.`
  );
}

// --------------------------------------------------------------------------------------------------
// The FINAL pass: the definitive LRSummary (Loop 2's output) + the trust stack.
// --------------------------------------------------------------------------------------------------

const CONFIDENCE_LEVELS = Object.freeze(['high', 'medium', 'low']);

function isFinalModelFinding(f) {
  return f && typeof f === 'object' && typeof f.text === 'string' && isStringArray(f.claim_ids) && typeof f.rationale === 'string';
}

// The model's final-pass output: each finding names the claim_ids it synthesized from (the trust layer
// resolves the rest). Strict, so the dispatcher runs the corrective retry then the safe default.
export function finalModelSchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!Array.isArray(v.key_findings) || !v.key_findings.every(isFinalModelFinding)) return false;
  if (typeof v.evidence_strength !== 'string') return false;
  if (!isStringArray(v.gaps)) return false;
  if (typeof v.contradictions_summary !== 'string') return false;
  return true;
}

function isFinalFinding(f) {
  return (
    f && typeof f === 'object' &&
    typeof f.text === 'string' && isStringArray(f.claim_ids) && typeof f.rationale === 'string' &&
    isStringArray(f.supporting_paper_dois) && Number.isInteger(f.paper_count) &&
    typeof f.cites_contradiction === 'boolean' &&
    CONFIDENCE_LEVELS.includes(f.confidence) && typeof f.confidence_label === 'string'
  );
}

// The enriched, stored LRSummary contract (Loop 2's output): per-finding confidence + supporting papers +
// the contradiction flag, plus the summary-level requires_human_review flag.
export function finalLRSummarySchema(v) {
  if (!v || typeof v !== 'object') return false;
  if (!Array.isArray(v.key_findings) || !v.key_findings.every(isFinalFinding)) return false;
  if (typeof v.evidence_strength !== 'string') return false;
  if (!isStringArray(v.gaps)) return false;
  if (typeof v.contradictions_summary !== 'string') return false;
  if (typeof v.requires_human_review !== 'boolean') return false;
  return true;
}

// Strip code backticks that wrap a math span (math is notation, not a code literal), then normalize the
// \(...\) / \[...\] delimiters to $ / $$ so the card renders it through KaTeX.
function cleanMath(text) {
  if (typeof text !== 'string') return '';
  const unbackticked = text
    .replace(/`(\${1,2}[\s\S]*?\${1,2})`/g, '$1')
    .replace(/`(\\\([\s\S]*?\\\))`/g, '$1')
    .replace(/`(\\\[[\s\S]*?\\\])`/g, '$1');
  return normalizeMathDelimiters(unbackticked);
}

// The deterministic confidence assignment (the build prompt's three labels map exactly to the paper count
// + contradiction tags; the model does NOT assign confidence - this is what makes the badge trustworthy).
export function confidenceFor(paperCount, citesContradiction) {
  if (citesContradiction) return { confidence: 'low', confidence_label: 'Conflicting evidence' };
  if (paperCount >= 2) return { confidence: 'high', confidence_label: 'Well-supported by multiple papers' };
  return { confidence: 'medium', confidence_label: 'Single-source, moderate confidence' };
}

// Enrich each model finding from the knowledge graph: resolve its claim_ids to claims, union their
// supporting papers (the count), detect whether any cited claim is contradiction-tagged, and assign the
// confidence + label deterministically. Hallucinated claim_ids that match no claim contribute nothing.
function enrichFindings(modelFindings, kg) {
  const claims = Array.isArray(kg.claims) ? kg.claims : [];
  const byId = new Map(claims.map((c) => [c.id, c]));
  const contradictionRawIds = new Set();
  for (const con of Array.isArray(kg.contradictions) ? kg.contradictions : []) {
    if (con && typeof con.claim_a_id === 'string') contradictionRawIds.add(con.claim_a_id);
    if (con && typeof con.claim_b_id === 'string') contradictionRawIds.add(con.claim_b_id);
  }
  return (Array.isArray(modelFindings) ? modelFindings : []).map((f) => {
    const claim_ids = isStringArray(f.claim_ids) ? f.claim_ids : [];
    const dois = new Set();
    let cites = false;
    for (const cid of claim_ids) {
      const claim = byId.get(cid);
      if (!claim) continue;
      (Array.isArray(claim.supporting_paper_dois) ? claim.supporting_paper_dois : []).forEach((d) => dois.add(d));
      if (claim.contradiction || (claim.raw_claim_id && contradictionRawIds.has(claim.raw_claim_id))) cites = true;
    }
    const supporting_paper_dois = [...dois];
    const paper_count = supporting_paper_dois.length;
    const { confidence, confidence_label } = confidenceFor(paper_count, cites);
    return {
      text: cleanMath(f.text),
      claim_ids,
      rationale: cleanMath(f.rationale),
      supporting_paper_dois,
      paper_count,
      cites_contradiction: cites,
      confidence,
      confidence_label,
    };
  });
}

// Finalize a model result into the enriched LRSummary: enrich every finding, then set the human-review
// flag (any finding with fewer than 2 supporting papers, or citing a contradiction-tagged claim).
export function finalizeLRSummary(model, kg) {
  const key_findings = enrichFindings(model && model.key_findings, kg);
  const requires_human_review = key_findings.some((f) => f.paper_count < 2 || f.cites_contradiction);
  return {
    key_findings,
    evidence_strength: model && typeof model.evidence_strength === 'string' ? model.evidence_strength : evidenceStrengthLabel(kg.claims || []),
    gaps: model && isStringArray(model.gaps) ? model.gaps : [],
    contradictions_summary: cleanMath(model && model.contradictions_summary),
    requires_human_review,
  };
}

// The dispatcher safe default (model-shaped): one finding per leading claim, so a provider outage still
// yields an on-contract definitive summary that finalizes into a usable card.
function deterministicFinalModel(kg) {
  const claims = Array.isArray(kg.claims) ? kg.claims : [];
  const contradictions = Array.isArray(kg.contradictions) ? kg.contradictions : [];
  return {
    key_findings: claims.slice(0, 5).map((c) => ({
      text: c.text || c.id,
      claim_ids: [c.id],
      rationale: 'Carried directly from the claim (model synthesis unavailable).',
    })),
    evidence_strength: evidenceStrengthLabel(claims),
    gaps: [],
    contradictions_summary: contradictions.length ? `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} flagged.` : '',
  };
}

// The overall (head) confidence is the weakest finding's level (low dominates), so the card head never
// over-states a synthesis that contains a low-confidence finding.
function weakestLevel(findings) {
  const order = { low: 0, medium: 1, high: 2 };
  let worst = 'high';
  for (const f of findings) if (order[f.confidence] < order[worst]) worst = f.confidence;
  return findings.length ? worst : 'medium';
}

// Build the LRSummary cessation card spec (poe.milestoneCard): a head badge, the review banner when
// flagged, one field per finding (text + confidence badge + clickable citation chips), then the
// evidence / gaps / contradictions fields. The orchestrator forwards this as packet.overlay.
export function buildFinalCardSpec(summary) {
  const findings = Array.isArray(summary.key_findings) ? summary.key_findings : [];
  const under = findings.filter((f) => f.paper_count < 2).length;
  const conflict = findings.filter((f) => f.cites_contradiction).length;
  const reasons = [];
  if (under) reasons.push(`${under} finding${under === 1 ? '' : 's'} under-sourced (fewer than 2 papers)`);
  if (conflict) reasons.push(`${conflict} finding${conflict === 1 ? '' : 's'} cite a flagged contradiction`);

  const fields = [];
  findings.forEach((f, i) => {
    fields.push({
      label: `FINDING ${i + 1}`,
      value: f.text,
      math: true,
      badge: {
        level: f.confidence,
        label: f.confidence_label,
        tooltip: `${f.paper_count} supporting paper${f.paper_count === 1 ? '' : 's'}; claims ${f.claim_ids.join(', ') || '(none)'}; ${f.rationale}`,
      },
      chips: f.supporting_paper_dois.map((doi) => ({ label: doi, title: doi, citation: doi })),
    });
  });
  fields.push({ label: 'EVIDENCE', value: summary.evidence_strength, emptyText: 'not assessed' });
  fields.push({ label: 'GAPS', value: summary.gaps, emptyText: 'none identified' });
  fields.push({ label: 'CONTRADICTIONS', value: summary.contradictions_summary, math: true, emptyText: 'none' });

  return {
    variant: 'archive',
    tag: '[ARCHIVE]',
    title: 'Literature review synthesized.',
    badge: {
      level: weakestLevel(findings),
      label: summary.requires_human_review ? 'Human review recommended' : 'Synthesis complete',
      tooltip: `${findings.length} key finding${findings.length === 1 ? '' : 's'}; evidence ${summary.evidence_strength}`,
    },
    banners: summary.requires_human_review ? [{ kind: 'review', tag: '[REVIEW]', text: 'Human review recommended', reasons }] : [],
    fields,
  };
}

export function createPostDocAgent(deps = {}) {
  const dispatch = deps.dispatch || defaultDispatch;
  const systemPrompt = deps.systemPrompt || POSTDOC_STANDARD_SYSTEM_PROMPT;
  const finalSystemPrompt = deps.finalSystemPrompt || POSTDOC_FINAL_SYSTEM_PROMPT;
  const failover = deps.failover || EXTRACTION_TIER;
  const maxTokens = deps.maxTokens || 1024;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Post-Doc', ...data });
    } catch (_err) {
      // logging is best effort and must never break a synthesis
    }
  };

  function claimLine(c) {
    const dois = Array.isArray(c.supporting_paper_dois) ? c.supporting_paper_dois.join(', ') : '';
    const types = Array.isArray(c.claim_type) && c.claim_type.length ? ` {${c.claim_type.join(', ')}}` : '';
    return `  - [${c.id}] ${c.text || ''}${types} | supporting: ${dois || '(none)'}`;
  }

  function contradictionLine(con) {
    return `  - ${con.claim_a_id} vs ${con.claim_b_id}: ${con.nature || ''}`;
  }

  function buildSynthesisText(kg, rqPacket) {
    const claims = Array.isArray(kg.claims) ? kg.claims : [];
    const contradictions = Array.isArray(kg.contradictions) ? kg.contradictions : [];
    return (
      `Research question packet:\n${JSON.stringify(rqPacket, null, 2)}\n\n` +
      `Knowledge graph source: ${kg.source}. Subspecializations: ${kg.subspecialization_ids.join(', ') || '(none)'}\n\n` +
      `Claims (${claims.length}):\n${claims.map(claimLine).join('\n') || '  (none)'}\n\n` +
      `Contradictions (${contradictions.length}):\n${contradictions.map(contradictionLine).join('\n') || '  (none)'}\n\n` +
      `Synthesize the draft literature-review summary and return the JSON object.`
    );
  }

  function buildFinalText(kg, rqPacket) {
    const claims = Array.isArray(kg.claims) ? kg.claims : [];
    const contradictions = Array.isArray(kg.contradictions) ? kg.contradictions : [];
    return (
      `Research question packet:\n${JSON.stringify(rqPacket, null, 2)}\n\n` +
      `Knowledge graph source: ${kg.source}. Subspecializations: ${kg.subspecialization_ids.join(', ') || '(none)'}\n\n` +
      `Claims (${claims.length}):\n${claims.map(claimLine).join('\n') || '  (none)'}\n\n` +
      `Contradictions (${contradictions.length}):\n${contradictions.map(contradictionLine).join('\n') || '  (none)'}\n\n` +
      `Write the DEFINITIVE literature-review summary. For each finding, name the claim ids (shown in [brackets] above) it draws on. Return the JSON object.`
    );
  }

  function finalSummaryLine(summary, kg) {
    const k = summary.key_findings.length;
    return (
      `Definitive LRSummary from ${kg.claims.length} claim${kg.claims.length === 1 ? '' : 's'} (${kg.source}): ` +
      `${k} key finding${k === 1 ? '' : 's'}, evidence ${summary.evidence_strength}` +
      `${summary.requires_human_review ? ', human review recommended' : ''}.`
    );
  }

  // The Post-Doc step the orchestrator runs at POSTDOC_STANDARD / POSTDOC_FINAL (branches on state, like
  // the Bookkeeper). Backstage (settles to the IO panel; no conversation write). No control transition,
  // so the default forward edge proceeds (STANDARD -> RQ_REVISION_CHECK; FINAL -> OUTPUT_HOOK).
  return async function postDoc(ctx = {}) {
    if (ctx.state === 'POSTDOC_FINAL') {
      // The DEFINITIVE pass (Loop 2's output + the full trust stack). Synthesize, enrich each finding
      // from the KG (confidence/papers/contradiction), and store the result on the session. The findings
      // are NOT surfaced here: the OUTPUT_HOOK cessation card (the Packager) is the single LRSummary
      // surface - it reuses buildFinalCardSpec(session.lrSummary) and adds the coverage summary + the
      // analysis trail + the Proceed CTA - so the findings render once, not twice back-to-back.
      const session = ctx.session || {};
      const rqPacket =
        ctx.rqPacket != null && typeof ctx.rqPacket === 'object'
          ? ctx.rqPacket
          : session.rqPacket && typeof session.rqPacket === 'object'
            ? session.rqPacket
            : {};
      const kg = await readKnowledgeGraph(ctx, emit);
      const safeDefault = deterministicFinalModel(kg);

      const raw = await dispatch({
        agentId: 'Post-Doc',
        tier: 'extraction',
        failover,
        messages: [
          { role: 'system', content: finalSystemPrompt },
          { role: 'user', content: buildFinalText(kg, rqPacket) },
        ],
        schema: finalModelSchema,
        safeDefault,
        maxTokens,
        loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
      });

      const model = finalModelSchema(raw) ? raw : safeDefault;
      const summary = finalizeLRSummary(model, kg);

      // The definitive LRSummary is Loop 2's output: store it on the session (OUTPUT_HOOK packages it).
      session.lrSummary = summary;
      session.lrSummaryPass = 'final';
      emit('postdoc:final', { findings: summary.key_findings.length, requires_human_review: summary.requires_human_review, source: kg.source });

      return {
        agentId: 'Post-Doc',
        content: finalSummaryLine(summary, kg),
        result: summary,
        control: {},
      };
    }

    const session = ctx.session || {};
    const rqPacket =
      ctx.rqPacket != null && typeof ctx.rqPacket === 'object'
        ? ctx.rqPacket
        : session.rqPacket && typeof session.rqPacket === 'object'
          ? session.rqPacket
          : {};

    const kg = await readKnowledgeGraph(ctx, emit);
    const safeDefault = deterministicDraft(kg);

    const raw = await dispatch({
      agentId: 'Post-Doc',
      tier: 'extraction',
      failover,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildSynthesisText(kg, rqPacket) },
      ],
      schema: lrSummaryDraftSchema,
      safeDefault,
      maxTokens,
      loopContext: ctx.loopContext || (session && session.loopContext) || undefined,
    });

    const result = lrSummaryDraftSchema(raw) ? raw : safeDefault;

    // Store the draft on the session: the final pass (Phase 16) and the Output Hook read it. `lrSummary`
    // holds the schema-shaped draft; `lrSummaryPass` marks it as the standard (vs final) pass.
    session.lrSummary = result;
    session.lrSummaryPass = 'standard';
    emit('postdoc:draft', { findings: result.key_findings.length, source: kg.source });

    return { agentId: 'Post-Doc', content: summarize(result, kg), result, control: {} };
  };
}

// Default app instance, built against the real dispatch singleton. main.js injects this as the
// orchestrator's `Post-Doc` step. Tests build isolated agents with createPostDocAgent({ dispatch, ... }).
export const postDocAgent = createPostDocAgent();
