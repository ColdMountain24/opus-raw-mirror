// Loop 1 (The Agora) Output Hook.
//
// This is the real implementation of p53's `output` seam: it fires when p53 emits
// CEASE (p53 calls output(completedRQPacket, meta)). On a cessation it performs the
// three completion effects:
//   1. persists the finalized RQPacket to the session store,
//   2. unlocks the next loop in the navigator (Loop 1 done -> Loop 2 unlocks),
//   3. surfaces the completion card in Poe's conversation layer (a confirmed card
//      with the finalized research question, the detected paradigm, the novelty
//      signal, and a "Proceed to Literature Review" CTA).
//
// The hook is a mechanism that orchestrates those three effects and owns the card
// PRESENTATION; it owns no schema. The conversation write goes through Poe (the
// only conversation writer): the hook hands Poe the facts and the CTA, and Poe owns
// the card DOM and wires the button. The navigator update and the persisted session
// shape enter through injected seams (main.js owns those), so the hook stays
// testable on fakes and invents neither the session schema nor the navigator.
//
// No silent swallowing: a persistence failure is surfaced to the injected
// onError/logger with context and is NON-fatal (the loop has already ceased, so the
// card and the unlock still happen); the researcher is never left without the
// completion they earned just because localStorage is full.

import { poe as defaultPoe } from '../../components/poe.js';
import { session as sessionStore } from '../../utils/storage.js';
import { buildTrustModel } from './trust.js';

const DEFAULT_CTA_LABEL = 'Proceed to Literature Review';

// Default session-state composer: a non-destructive merge that records the
// finalized RQPacket, marks the completed loop, and keeps the completion facts (and
// the trust flag) for a later session-restore. main.js can override to merge into
// its own session schema. The session shape is owned upstream (Autonomy Charter);
// this is the minimal durable record, not a schema definition. requires_human_review
// is persisted HERE (the completion record), never on the FINAL RQPacket.
function defaultComposeState(prev, rqPacket, model, extra) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const completedLoops = Array.isArray(base.completedLoops) ? base.completedLoops.slice() : [];
  if (!completedLoops.includes(extra.completedLoop)) completedLoops.push(extra.completedLoop);
  return {
    ...base,
    rqPacket,
    completedLoops,
    researchQuestion: model.researchQuestion != null ? model.researchQuestion : base.researchQuestion || null,
    paradigm: model.paradigm != null ? model.paradigm : null,
    noveltySignal: model.noveltySignal != null ? model.noveltySignal : null,
    requiresHumanReview: Boolean(model.requiresHumanReview),
    confidence: model.confidence ? model.confidence.level : null,
    maxReached: Boolean(extra.maxReached),
    completedAt: extra.completedAt,
  };
}

export function createOutputHook(deps = {}) {
  const poe = deps.poe || defaultPoe;
  const storage = deps.storage || { session: sessionStore };
  // Navigator unlock: mark the completed loop done so the next loop unlocks (the
  // navigator unlocks Loop N when Loop N-1 is in completedLoops). main.js injects it.
  const markLoopComplete = typeof deps.markLoopComplete === 'function' ? deps.markLoopComplete : null;
  // The CTA handler: proceed to the next loop. main.js injects navigateToLoop(2).
  const onProceed = typeof deps.onProceed === 'function' ? deps.onProceed : null;
  const composeState = typeof deps.composeState === 'function' ? deps.composeState : defaultComposeState;
  const ctaLabel = typeof deps.ctaLabel === 'string' ? deps.ctaLabel : DEFAULT_CTA_LABEL;
  const completedLoop = Number.isInteger(deps.completedLoop) ? deps.completedLoop : 1;
  const clock = typeof deps.clock === 'function' ? deps.clock : () => Date.now();
  const logger = typeof deps.logger === 'function' ? deps.logger : () => {};
  const onError = typeof deps.onError === 'function' ? deps.onError : null;

  function report(step, cause) {
    const message = cause && cause.message ? cause.message : String(cause);
    const detail = { area: 'loop1.outputHook', step, message, cause };
    try {
      logger({ type: 'output:error', step, message });
    } catch (_err) {
      // logging is best effort
    }
    if (onError) onError(detail);
  }

  // The output seam p53 invokes on CEASE. rqPacket is the finalized packet; meta
  // carries the run context (researchQuestion + history). The trust model (the
  // confidence, the review flag, and the evaluation breakdown) is derived from the
  // run's results here, so p53 stays a forwarder and the Poe card a pure renderer.
  return async function onCease(rqPacket, meta = {}) {
    const facts = meta && typeof meta === 'object' ? meta : {};
    const model = buildTrustModel({ history: facts.history, researchQuestion: facts.researchQuestion });
    const maxWarning = facts.maxWarning || null;

    // 1. Persist the finalized RQPacket and the completion record (with the trust
    // flag). Non-destructive and non-fatal.
    try {
      const prev = storage && storage.session && typeof storage.session.load === 'function'
        ? (await storage.session.load()) || {}
        : {};
      const state = composeState(prev, rqPacket, model, {
        completedLoop,
        completedAt: clock(),
        maxReached: Boolean(maxWarning),
      });
      if (storage && storage.session && typeof storage.session.save === 'function') {
        await storage.session.save(state);
      }
      logger({ type: 'output:persisted', version: rqPacket && rqPacket.version, requiresHumanReview: model.requiresHumanReview });
    } catch (cause) {
      report('persist', cause);
    }

    // 2. Unlock the next loop in the navigator (Loop 1 complete -> Loop 2 unlocks).
    try {
      if (markLoopComplete) markLoopComplete(completedLoop);
    } catch (cause) {
      report('unlock', cause);
    }

    // 3. Surface the completion card with its full trust layer in Poe's conversation
    // layer (the only conversation write; Poe owns the DOM and wires the CTA).
    try {
      poe.cessationCard({
        researchQuestion: model.researchQuestion,
        paradigm: model.paradigm,
        noveltySignal: model.noveltySignal,
        confidence: model.confidence,
        requiresHumanReview: model.requiresHumanReview,
        reviewReasons: model.reviewReasons,
        evaluation: model.evaluation,
        maxWarning,
        cta: {
          label: ctaLabel,
          onClick: () => {
            if (onProceed) onProceed();
          },
        },
      });
      logger({ type: 'output:completed', version: rqPacket && rqPacket.version });
    } catch (cause) {
      report('card', cause);
    }
  };
}

// Default app instance. main.js builds a configured instance (injecting the
// navigator unlock and the CTA handler); this default is wired against the Poe and
// storage singletons so importing the module never throws.
export const outputHook = createOutputHook();
