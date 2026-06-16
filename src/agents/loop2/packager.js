// The Packager, the Loop 2 (The Archive) Output Hook. It runs at the orchestrator's OUTPUT_HOOK state
// (the last state before COMPLETE) and produces the CESSATION CARD - Loop 2's completion artifact and the
// single most important credibility element for a research audience.
//
// CLIENT-SIDE: no LLM, no dispatcher (like the Bookkeeper / Edgar). It reads three things and renders one card:
//   1. session.lrSummary  - the definitive LRSummary the Post-Doc FINAL pass stored (the trust stack:
//                           key findings with confidence badges + clickable citation chips).
//   2. the GlobalKG        - kg.load('loop-2','global'), for the coverage summary (subspecializations,
//                           claims promoted, escalated contradictions).
//   3. ctx.trailLog        - the orchestrator's REAL-TIME analysis trail (sweeps, per-round claim ratios,
//                           coverage per iteration, unknown-field sweeps, fallback events, escalations).
//
// The cessation card reuses the Post-Doc's buildFinalCardSpec (so the LRSummary renders identically, once)
// and AUGMENTS it with the coverage fields, a collapsible "Show analysis trail" section, and a "Proceed to
// Hypothesis Scrutiny" CTA. It is returned as packet.overlay; the orchestrator forwards it to
// poe.milestoneCard (raising the Loop 2 overlay and wiring the CTA). The Packager is backstage (settles to
// the IO panel), so it is NOT the conversation writer - only Poe writes the conversation (TurnGate holds).
//
// Charter boundary. The Packager owns the card PRESENTATION (Opus owns presentation) and the trail
// formatting; it owns no schema. The Loop3Input PACKET (FINAL/unowned) is NOT built here: the CTA hands off
// through the injected onProceed seam (main.js marks Loop 2 complete -> Loop 3 unlocks in the navigator); the
// GlobalKG, the definitive LRSummary, and the escalated contradictions are already persisted for the later
// Loop3Input phase. A missing lrSummary / GlobalKG degrades to a minimal valid card (never a dead end).

import { kg as kgSingleton } from '../../utils/storage.js';
import { buildFinalCardSpec } from './postdoc.js';
import { GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION } from './bookkeeper.js';

// Sum the per-round audit counts the Grad Students phase recorded on each PHASE_1 packet (papers Edgar
// retrieved, claims extracted pre-review). The GlobalKG carries the promoted total; these two are not in it.
function sumPhase1(history) {
  let papers = 0;
  let extracted = 0;
  for (const h of Array.isArray(history) ? history : []) {
    if (h && h.state === 'PHASE_1' && h.packet && h.packet.result) {
      const r = h.packet.result;
      if (Number.isFinite(r.papers_retrieved)) papers += r.papers_retrieved;
      if (Number.isFinite(r.claims_extracted)) extracted += r.claims_extracted;
    }
  }
  return { papers, extracted };
}

// Format the real-time analysis trail into milestone fields for the collapsible "Show analysis trail"
// section. Presentation only: it reads the documented trail entry shapes and invents nothing.
export function formatTrail(trailLog) {
  const log = Array.isArray(trailLog) ? trailLog : [];
  const sweeps = log.filter((e) => e.type === 'sweep');
  const claimRounds = log.filter((e) => e.type === 'claims_round');
  const coverage = log.filter((e) => e.type === 'coverage');
  const unknownSweeps = log.filter((e) => e.type === 'unknown_field_sweep');
  const fallbacks = log.filter((e) => e.type === 'fallback');
  const escalated = log.filter((e) => e.type === 'contradiction_escalated');

  const fields = [];
  fields.push({ label: 'FEARLESS_LEADER_ROUNDS', value: String(sweeps.length || (claimRounds.length ? 1 : 0)) });

  claimRounds.forEach((r) => {
    fields.push({
      label: `ROUND_${r.round}_CLAIMS`,
      value: `extracted ${r.extracted}, promoted ${r.promoted}, rejected ${r.rejected}`,
    });
  });

  if (coverage.length) {
    fields.push({
      label: 'COVERAGE_BY_ITERATION',
      value: coverage.map((c) => `iter ${c.iteration}: ${typeof c.coverage === 'number' ? c.coverage.toFixed(2) : 'n/a'}`),
    });
  }

  unknownSweeps.forEach((u) => {
    fields.push({
      label: `UNKNOWN_FIELD_SWEEP_${u.iteration}`,
      value: `targeted: ${(Array.isArray(u.fields) ? u.fields : []).join(', ') || 'none'}`,
    });
  });

  // Fallback events, summarized as counts (the reliability spine's failovers / corrective retries / etc.).
  const counts = fallbacks.reduce((acc, f) => {
    acc[f.kind] = (acc[f.kind] || 0) + 1;
    return acc;
  }, {});
  const fbParts = [];
  if (counts.failover) fbParts.push(`${counts.failover} provider failover${counts.failover === 1 ? '' : 's'}`);
  if (counts.corrective_retry) fbParts.push(`${counts.corrective_retry} corrective retr${counts.corrective_retry === 1 ? 'y' : 'ies'}`);
  if (counts.cache_hit) fbParts.push(`${counts.cache_hit} cache hit${counts.cache_hit === 1 ? '' : 's'}`);
  if (counts.safe_default) fbParts.push(`${counts.safe_default} safe-default fallback${counts.safe_default === 1 ? '' : 's'}`);
  if (counts.circuit_open) fbParts.push(`${counts.circuit_open} circuit open${counts.circuit_open === 1 ? '' : 's'}`);
  fields.push({ label: 'FALLBACK_EVENTS', value: fbParts.length ? fbParts.join(', ') : '', emptyText: 'none' });

  if (escalated.length) {
    fields.push({
      label: 'ESCALATED_CONTRADICTIONS',
      value: escalated.map((e) => `${e.claim_a_id || '?'} vs ${e.claim_b_id || '?'}`),
    });
  }

  return fields;
}

// Build the cessation card spec: the LRSummary (reused from the Post-Doc) + the coverage summary + the
// collapsible analysis trail + the Proceed CTA. A null lrSummary degrades to a coverage+trail-only card.
export function buildCessationCard(lrSummary, coverage, trailLog, onProceed) {
  const base = lrSummary ? buildFinalCardSpec(lrSummary) : { fields: [], banners: [], badge: null };

  const coverageFields = [
    { label: 'SUBSPECIALIZATIONS', value: String(coverage.subspecializations) },
    { label: 'PAPERS_RETRIEVED', value: String(coverage.papers_retrieved) },
    { label: 'CLAIMS_EXTRACTED', value: String(coverage.claims_extracted) },
    { label: 'CLAIMS_PROMOTED', value: String(coverage.claims_promoted), confirmed: true },
  ];
  if (coverage.escalated_contradictions) {
    coverageFields.push({ label: 'ESCALATED_CONTRADICTIONS', value: String(coverage.escalated_contradictions) });
  }

  return {
    variant: 'cessation',
    tag: '[ARCHIVE_COMPLETE]',
    title: 'Literature review complete.',
    badge: base.badge || undefined,
    banners: base.banners || [],
    fields: [...coverageFields, ...(base.fields || [])],
    sections: [{ summary: 'Show analysis trail', fields: formatTrail(trailLog) }],
    cta: {
      label: 'Proceed to Hypothesis Scrutiny',
      onClick: () => {
        if (typeof onProceed === 'function') onProceed();
      },
    },
  };
}

export function createPackagerAgent(deps = {}) {
  const defaultKg = deps.kg || kgSingleton;
  const onProceed = typeof deps.onProceed === 'function' ? deps.onProceed : null;
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Packager', ...data });
    } catch (_err) {
      // logging is best effort and must never break the cessation
    }
  };

  // The OUTPUT_HOOK step the orchestrator runs after the Post-Doc final pass.
  return async function packager(ctx = {}) {
    const session = ctx.session || {};
    const kgStore = (ctx.storage && ctx.storage.kg) || defaultKg;
    const trailLog = Array.isArray(ctx.trailLog) ? ctx.trailLog : [];

    let globalKg = null;
    try {
      globalKg = await kgStore.load(GLOBAL_KG_LOOP_ID, GLOBAL_KG_VERSION);
    } catch (cause) {
      // A failed read is surfaced (not swallowed); the card still renders from the LRSummary + trail.
      emit('packager:kg_load_error', { message: cause && cause.message ? cause.message : String(cause) });
    }

    const lrSummary = session.lrSummary && typeof session.lrSummary === 'object' ? session.lrSummary : null;
    const { papers, extracted } = sumPhase1(ctx.history);
    const coverage = {
      subspecializations: globalKg && Array.isArray(globalKg.subspecialization_ids) ? globalKg.subspecialization_ids.length : 0,
      papers_retrieved: papers,
      claims_extracted: extracted,
      claims_promoted: globalKg && Number.isInteger(globalKg.claim_count) ? globalKg.claim_count : 0,
      escalated_contradictions: globalKg && Number.isInteger(globalKg.escalated_contradiction_count) ? globalKg.escalated_contradiction_count : 0,
    };

    const overlay = buildCessationCard(lrSummary, coverage, trailLog, onProceed);
    emit('packager:complete', {
      findings: lrSummary && Array.isArray(lrSummary.key_findings) ? lrSummary.key_findings.length : 0,
      ...coverage,
      trail_length: trailLog.length,
      at: clock(),
    });

    return {
      agentId: 'Packager',
      content: `Loop 2 complete: ${coverage.claims_promoted} claim${coverage.claims_promoted === 1 ? '' : 's'} promoted across ${coverage.subspecializations} subspecialization${coverage.subspecializations === 1 ? '' : 's'}.`,
      result: { coverage, trail_length: trailLog.length },
      overlay,
      control: {},
    };
  };
}

// Default app instance. main.js builds a configured instance (injecting onProceed = mark Loop 2 complete);
// this default is wired against the kg singleton so importing the module never throws.
export const packagerAgent = createPackagerAgent();
