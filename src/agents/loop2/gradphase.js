// The PHASE_1 (Grad Students) coordinator: the orchestrator's 'Grad Students' step.
//
// The Loop 2 orchestrator runs ONE step per state, but PHASE_1 is a fan-out: one Grad Student
// per subspecialization, each preceded by an Edgar retrieval for that subspecialization. This
// coordinator is that fan-out. It reads Fearless Leader's plan from the run history, calls Edgar
// once per subspecialization, spawns one Grad Student per subspecialization IN PARALLEL
// (Promise.allSettled), and aggregates the per-subspecialization claim KGs into the Phase-1
// result. Each Grad Student in turn extracts its papers in parallel; both fan-out levels route
// through the dispatcher queue, which throttles them to 80% of provider rate limits (the
// documented Dynamic-Workflows decision: queue-coordinated parallel dispatch).
//
// Within PHASE_1, each subspecialization's Grad Student is followed by the Senior Grad Student,
// the per-subspecialization QUALITY REVIEWER (one call per subspecialization batch): it judges the
// batch and the coordinator applies the verdicts to the KG (a 'reject' drops the claim, a 'flag'
// keeps it with a quality flag, a 'pass' keeps it clean). The verdicts are surfaced to the IO
// panel through the render seam (review events), never to the conversation.
//
// PHASE_1 and PHASE_2 both map to 'Grad Students' in the orchestrator; the step branches on
// state. PHASE_2 (the Senior Grad Student CROSS-subspecialization synthesis -> GeneralKG, a
// distinct role from the quality reviewer here) is a later phase, so it is a pass-through.
//
// Charter boundary. This is a MECHANISM (read the plan, fan out, review, aggregate); it invents no
// claim content. The Edgar/GradStudent/SeniorGrad agents own their contracts; the render seam
// (onClaimRender) is injected by the orchestrator/main and drives presentation only.

import { loop2EdgarAgent } from './edgar.js';
import { gradStudentAgent } from './gradstudent.js';
import { seniorGradStudentAgent, applyQualityReviews } from './seniorgrad.js';

export function createGradStudentPhase(deps = {}) {
  const edgar = deps.edgar || loop2EdgarAgent;
  const gradStudent = deps.gradStudent || gradStudentAgent;
  const seniorGrad = deps.seniorGrad || seniorGradStudentAgent;
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};

  const emit = (type, data = {}) => {
    try {
      logger({ type, agentId: 'Grad Students', ...data });
    } catch (_err) {
      // best effort
    }
  };

  function readSubspecializations(history) {
    const list = Array.isArray(history) ? history : [];
    const fl = list.find((h) => h && (h.agentId === 'Fearless Leader' || (h.packet && h.packet.agentId === 'Fearless Leader')));
    const result = fl && fl.packet && fl.packet.result;
    return result && Array.isArray(result.subspecializations) ? result.subspecializations : [];
  }

  // Run Edgar, then a Grad Student, then the Senior Grad Student quality review for one
  // subspecialization. Throws on Edgar/GradStudent failure so the coordinator's Promise.allSettled
  // can surface it without failing the whole phase.
  async function runSubspecialization(subspec, ctx, onClaimRender) {
    const session = ctx.session || {};
    const edgarPacket = await edgar({
      subspecializationId: subspec.id,
      query: subspec.query,
      rqPacket: session.rqPacket,
      session,
    });
    const papers =
      edgarPacket && edgarPacket.result && Array.isArray(edgarPacket.result.papers) ? edgarPacket.result.papers : [];

    const gsPacket = await gradStudent({
      subspecialization: subspec,
      papers,
      edgarQueries: subspec.query ? [subspec.query] : [],
      onClaimRender,
      session,
    });
    const kg = gsPacket && gsPacket.result ? gsPacket.result : { subspecialization_id: subspec.id, claims: [] };
    const claims = Array.isArray(kg.claims) ? kg.claims : [];

    // Senior Grad Student quality review: one call per subspecialization batch. A reviewer failure
    // must not lose the subspecialization's claims, so it degrades to "no verdicts" (every claim
    // kept) rather than throwing.
    let reviews = [];
    try {
      const reviewPacket = await seniorGrad({ subspecialization: subspec, claims, papers, session });
      reviews = reviewPacket && reviewPacket.result && Array.isArray(reviewPacket.result.reviews) ? reviewPacket.result.reviews : [];
    } catch (cause) {
      emit('gradphase:review_error', {
        subspecialization: subspec.id,
        message: cause && cause.message ? cause.message : String(cause),
      });
    }

    const { kept, dropped, unreviewed } = applyQualityReviews(claims, reviews);
    surfaceReviews(subspec, reviews, onClaimRender);
    if (dropped.length || unreviewed) {
      // No silent swallowing: dropped claims and any unreviewed remainder are surfaced.
      emit('gradphase:reviewed', {
        subspecialization: subspec.id,
        kept: kept.length,
        dropped: dropped.length,
        unreviewed,
      });
    }

    // The KG (surviving claims) plus the round's audit counts the orchestrator's analysis trail reads:
    // papers Edgar retrieved, claims the Grad Student extracted (pre-review), and claims Senior review dropped.
    return {
      kg: { ...kg, claims: kept },
      counts: { papers: papers.length, extracted: claims.length, rejected: dropped.length },
    };
  }

  // Surface the Senior Grad Student verdicts to the IO panel through the render seam (review
  // events), so the Observatory marks flagged nodes / removes dropped ones and the claim card logs
  // the verdicts. Presentation only; never the conversation. A 'reject' carries the same shape so
  // the renderer can drop its node.
  function surfaceReviews(subspec, reviews, onClaimRender) {
    if (typeof onClaimRender !== 'function') return;
    const label = subspec.name || subspec.label || subspec.id || '';
    reviews.forEach((r) => {
      onClaimRender({
        type: 'review',
        subspecializationId: subspec.id,
        subspecializationLabel: label,
        claimId: r.claim_id,
        quality: r.quality,
        reason: r.reason,
      });
    });
  }

  // The step. Registered as the orchestrator's 'Grad Students' agent.
  return async function gradPhase(ctx = {}) {
    const state = ctx.state;
    const onClaimRender = typeof ctx.onClaimRender === 'function' ? ctx.onClaimRender : () => {};

    if (state === 'PHASE_2') {
      // Senior Grad Student synthesis (GeneralKG + CrossSubspecializationNotes) is a later phase.
      return {
        agentId: 'Grad Students',
        content: 'Phase 2 review pending (Senior Grad Student synthesis deferred).',
        result: { subspecializations: [] },
        control: {},
      };
    }

    const subspecs = readSubspecializations(ctx.history);

    // Fan out one Grad Student per subspecialization, in parallel (queue-coordinated downstream).
    const settled = await Promise.allSettled(subspecs.map((s) => runSubspecialization(s, ctx, onClaimRender)));

    const subspecializations = [];
    let papers_retrieved = 0;
    let claims_extracted = 0;
    let claims_rejected = 0;
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        subspecializations.push(r.value.kg);
        papers_retrieved += r.value.counts.papers;
        claims_extracted += r.value.counts.extracted;
        claims_rejected += r.value.counts.rejected;
      } else {
        // No silent swallowing: a subspecialization that failed (Edgar or Grad Student) is
        // surfaced; the rest stand.
        emit('gradphase:subspec_error', {
          subspecialization: subspecs[i] && subspecs[i].id,
          message: r.reason && r.reason.message ? r.reason.message : String(r.reason),
        });
      }
    });

    const totalClaims = subspecializations.reduce((acc, kg) => acc + (Array.isArray(kg.claims) ? kg.claims.length : 0), 0);

    return {
      agentId: 'Grad Students',
      content: `Phase 1: ${subspecializations.length} subspecialization KG${
        subspecializations.length === 1 ? '' : 's'
      }, ${totalClaims} claim${totalClaims === 1 ? '' : 's'} extracted.`,
      // The round's audit counts ride on the result for the orchestrator's analysis trail (papers retrieved,
      // claims extracted pre-review, claims rejected by Senior review). Surviving/promoted = subspecializations[].claims.
      result: { subspecializations, papers_retrieved, claims_extracted, claims_rejected },
      control: {},
    };
  };
}

// Default app instance. main.js injects this as the orchestrator's 'Grad Students' step (with
// the render seam threaded through ctx). Tests build isolated coordinators with
// createGradStudentPhase({ edgar, gradStudent }) on fakes.
export const gradStudentPhase = createGradStudentPhase();
