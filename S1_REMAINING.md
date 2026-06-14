# S1 status: Loop 1 wired end to end

The S1 goal (a real research question produces a validated RQPacket in the session
store, Loop 2 unlocked, the cessation card with the full trust layer) is now wired
end to end. The capstone test `tests/loops/loop1/pipeline.e2e.test.js` drives the whole
pipeline with the real agents and asserts the validated packet is persisted, Loop 2 is
unlocked, and the trust-layer card renders.

## Built (final phase)

1. RQPacket schema + deterministic completeness (`src/loops/loop1/rqschema.js`):
   the FINAL field set and `scoreCompleteness` (populated = content or in UnknownFields;
   conditional fields skipped when in IrrelevantFields; StudyPhase null always valid;
   pass threshold 1.0).
2. CV is now deterministic over that scorer (no LLM), holding the 1.0 gate reliably.
3. Real extraction (`src/loops/loop1/extraction.js`), Poe's awaited `extractRQPacket`:
   dispatches the extraction tier to pull the packet from the transcript; the study
   Design is model-emitted, the Framework is resolved deterministically from the design
   via DesignLookup (never the model); only framework id labels go on the packet.
4. Frameworks (`src/loops/loop1/frameworks.js`): the DESIGN_TO_FRAMEWORKS anchors,
   the per-id field-set contents, and `seedFrameworkRegistry` (seeds the registry at
   startup). Framework content never enters a prompt.
5. Composer + confirmation: `src/components/composer.js` (a sibling of Poe's feed) plus
   `orchestrator.confirm()` / `canConfirm()` / `composerStatus()` / `onComposer`.
   Confirm is surfaced only when the latest review passed; confirming sets
   `session.researcherConfirmed` and routes to p53, which ceases; the composer locks
   post-cessation; the orchestrator resets its session on mount.
6. p53's max-reached warning is carried onto the cessation card as a non-blocking note.

328 tests, 5/5 evals, clean build.

## What remains (not Loop 1 logic)

- The S0 transport fill-in: the provider adapters ship with empty transports, so the
  dispatcher and the extraction fall to safe defaults. A live browser run needs real
  `fetch()` wired per adapter (the documented one-line S0 seam) before the model
  actually drafts a packet. This needs provider keys / network and is intentionally
  outside the deterministic build.
- Loop 2 (The Literature Review) itself is a future build; this phase only unlocks its
  navigator entry and renders the "Proceed to Literature Review" CTA.
