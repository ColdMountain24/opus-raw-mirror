# CLAUDE.md

Guidance for Claude Code working in this repository. Read this first. This is a
living document: update it at the end of every session.

## What this is

Opus CC RAW mirror: a multi-loop agent console web app built on a
reliability-first provider dispatcher. Every LLM call routes through one
dispatcher that handles retries, failover, rate limiting, circuit breaking,
HIPAA routing, schema validation, and caching, so loop and agent code never touch
a provider directly.

"Opus" is the executing agent (the assistant). The product and repo are named
Opus CC; do not rename them.

S0 ships the app shell, the reliability spine, and the eval baseline. S1 builds
Loop 1 (The Agora) end to end on it: six agents through the orchestrator, the FINAL
RQPacket schema + deterministic extraction/CV + the framework registry, the
researcher composer + confirmation, the file-cabinet RQPacket drawer, and the
cessation card with its full trust layer (see `src/loops/loop1/ARCHITECTURE.md`). The
provider transports are now wired (`src/dispatcher/adapters/transports.js`): each
adapter fires a real `fetch()` with the user's API key (from Settings/localStorage),
so a keyed provider returns a live model response and an unkeyed one fails over. Tests
still drive the spine through the deterministic simulator on virtual time.

S2 builds Loop 2 (The Archive): nine agents, the Cytoscape Observatory, progressive
streaming, the Post-Doc trust layer, and a cessation card producing a validated
Loop3Input packet (GlobalKG -> IndexedDB, Loop 3 unlocked). The S2 pre-flight has
landed the FINAL-independent infrastructure: the real SSE streaming seam (`onToken`),
the generalized `poe.milestoneCard` seam (citation chips + confidence badges), the
per-loop surface manager (`components/loopSurfaces.js`, loop-switch teardown), and the
jsdom-safe Cytoscape Observatory harness.

Loop 2 phase 1 (the orchestrator) is built: `createLoop2Orchestrator` is the FINAL-routing
state machine (`ENTRY -> POE_INTAKE -> FEARLESS_LEADER -> PHASE_1/PHASE_2 (Grad Students)
-> BOOKKEEPER_STAGE -> POSTDOC_STANDARD -> RQ_REVISION_CHECK -> MATERIAL_CONTRADICTIONS
(Poe) -> BOOKKEEPER_PROMOTE -> UNKNOWN_FIELD_SURFACING -> P53_EVALUATE -> POSTDOC_FINAL ->
OUTPUT_HOOK -> COMPLETE`), modeled on the Loop 1 mechanism, with injected stub agents. It
inherits the RQPacket from the session store on mount, warms `data-loop="2"`, and runs an
autonomous chain after a brief "add more papers?" gate; entering Loop 2 plays the green
Matrix transition. The Observatory render is built (`components/observatory.js`): a Cytoscape.js
(cose-bilkent) graph that renders subspecialization/claim/paper nodes + supports/contradicts/
derived-from edges, updates incrementally via the orchestrator's `onPromote` seam (Bookkeeper
promotions -> `observatory.addElements`), with pan/zoom, a custom minimap, and node-click ->
the IO Packet inspector; a placeholder graph is seeded until the real Bookkeeper emits the KG.
The Grad Students stream claims (the streaming/progressive phase): `src/agents/loop2/claimstream.js`
is a char-fed O(n) incremental partial-JSON parser; `gradstudent.js` is one Grad Student per
subspecialization that runs a per-paper streamed dispatch whose tokens drive progressive render
(claim nodes appear loading the moment claim_id parses, settle to a confidence-NEUTRAL confirmed/
flagged/rejected state via the Salvia validation seam - confidence is null until Post-Doc); the FULL
validated body stays the authority. `gradphase.js` is the orchestrator's `Grad Students` step: it
runs Edgar + one Grad Student per subspecialization in parallel (Promise.allSettled, queue-coordinated
- the documented Dynamic-Workflows decision). The Observatory gained `updateElements`/`setNodeData`
(+ loading/parsed/confirmed/flagged/rejected styles); `components/claimCard.js` is the progressive
IO-panel claim card in a new `[CLAIMS]` tab; the orchestrator's `onClaimRender` seam (threaded into
the Grad Students ctx) forwards to both. Claims-only this phase.
Two real Loop 2 agents are built (`src/agents/loop2/`). Fearless Leader (`fearlessleader.js`,
prompt in `prompts.js`), the sweep planner at FEARLESS_LEADER, reads the inherited RQPacket and
returns a schema-validated `{subspecializations: [{id, name, query, grad_student_count}], rationale}`
on the extraction tier; backstage (its plan renders in the IO panel via the orchestrator, never the
conversation). main.js injects it into the orchestrator's `agents` map. Edgar Allan (`edgar.js`),
the per-subspecialization retriever, is called once per subspecialization with Fearless Leader's
query; it does NOT use the dispatcher (external retrieval, injectable source clients) and returns
`{papers: [{title, authors, year, doi, abstract, source, full_text_available}], subspecialization_id,
retrieval_count}` across the broad Loop 2 source list (CORE_SOURCES + overridable DOMAIN_SOURCES),
deduped against the GlobalKG (DOI, else title+year+first-author). Like the Loop 1 Edgar it is an
internal tool (no orchestrator state): built as the `loop2EdgarAgent` capability, now wired by the
Grad Students coordinator (gradphase). The remaining orchestrator states (POSTDOC, p53,
OUTPUT_HOOK) stay stubbed.
The Senior Grad Student is built (`seniorgrad.js`, prompt in `prompts.js`) as the per-subspecialization
QUALITY REVIEWER: one extraction-tier dispatch per subspecialization batch returning `{reviews: [{claim_id,
quality: 'pass'|'flag'|'reject', reason}]}` (claim plausibility / supporting-evidence sufficiency /
extraction accuracy vs the abstracts). It is an internal tool wired inside PHASE_1 (`gradphase.js`
`runSubspecialization`: Edgar -> Grad Student -> Senior review). `applyQualityReviews` enforces the spec's
KG mutation: a 'reject' DROPS the claim, a 'flag' KEEPS it with a `quality_review` flag, a 'pass' keeps it
clean; an unreviewed claim (no verdict / reviewer outage) is KEPT, never silently dropped. Verdicts surface
backstage to the IO panel via the `onClaimRender` `review` event: the Observatory drops rejected nodes
(`removeElements`) and amber-rings flagged ones (`node[review="flag"]`, a dimension separate from the Salvia
`state`); the claim card carries a persistent `[SENIOR_REVIEW]` tally. NOTE: this is the build-prompt's
quality-reviewer role; the architecture doc's PHASE_2 Senior-Grad-Student GeneralKG/CrossSubspecializationNotes
SYNTHESIZER is a distinct, still-deferred concern (PHASE_2 stays a pass-through).
The Bookkeeper's Phase 1 operation is built (`bookkeeper.js`) as a CLIENT-SIDE (no LLM) agent at
BOOKKEEPER_STAGE: it reads the PHASE_1 per-subspecialization claims-KGs from history, builds a structured
`SubspecializationKG` per subspecialization (claims-scoped; the architecture's other named sections
scaffolded empty), PERSISTS each to IndexedDB via `storage.kg.save('loop-2-subspec', subspec_id, kg)` (the
first Loop 2 IndexedDB write), and emits the subspecialization node to the Observatory (`onPromote`, scope
'subspecialization'; main.js wires the derived-from edges from the streamed claim nodes to it via the
`claimNodeIndex`). It promotes every claim that survived Senior review (rejects already dropped; unreviewed
kept). The seeded PLACEHOLDER_GRAPH is gone (real nodes now). The Bookkeeper's Phase 2 (BOOKKEEPER_PROMOTE) is
also built: it merges the staged SubspecializationKGs into the GlobalKG and writes it to IndexedDB
(`kg.save('loop-2','global', gkg)`) - the end-state's "GlobalKG to IndexedDB". DEDUP by `subspec_id::claim_id`
(re-promotions merge - union evidence, `promotion_count`++ - never duplicate; the GlobalKG accumulates across
refinement rounds via load+merge). CONTRADICTION TAGGING: each GlobalKG claim gets `contradiction_partners` from
the latest Skips scan (Revision Check packet). The unified-view Observatory update = contradicts edges keyed by
global_claim_id; main.js's `loop2Promote` scope-'global' branch resolves the endpoints to render nodes via
`claimNodeIndex` and draws them. Exports: `GLOBAL_KG_LOOP_ID`/`GLOBAL_KG_VERSION`/`globalClaimId`/`mergeIntoGlobalKG`/
`globalKgSchema`/`readStagedSubspecializationKGs`/`readContradictions`.
Salvia is built (`salvia.js`, prompt in `prompts.js`) as the UNCERTAINTY SURVEYOR at UNKNOWN_FIELD_SURFACING
(an extraction-tier agent, immediately before P53_EVALUATE): it reads the latest staged SubspecializationKGs +
the RQPacket and returns `{uncertain_claims, unaddressed_rq_fields, uncertainty_level: 'low'|'medium'|'high'}`
for p53. The deterministic `scanForUncertainty` (flagged claims via quality_review/salvia_status; level from
the flagged proportion) is the safe default AND a floor unioned into the model result, filtered to real
claim_ids. NOTE: this surveyor is DISTINCT from the per-claim salvia_status grounding seam inside the Grad
Student (which SETS valid/flagged/rejected); Salvia here READS those flags. main.js registers it.
Skips is built (`skips.js`, prompt in `prompts.js`) as the CROSS-SUBSPECIALIZATION ANALYST: an INTERNAL TOOL
(no dedicated state) invoked inside the Revision Check control point. It reads all SubspecializationKGs +
the RQPacket and returns `{contradictions: [{claim_a_id, claim_b_id, nature}], unknown_fields: string[]}`
(extraction tier; empty safe default; contradictions filtered to real claim_id pairs). Wiring: `revisioncheck.js`
(RQ_REVISION_CHECK invokes Skips and FORWARDS, carrying `{contradictions, unknown_fields}` for downstream;
control always {}) and `contradictions.js` (the MATERIAL_CONTRADICTIONS 'Poe' step). main.js registers both steps.
Material contradictions surfacing is built (ORCHESTRATOR-OWNED, at MATERIAL_CONTRADICTIONS, before BOOKKEEPER_PROMOTE;
mirrors the RQ-revision check). `contradictions.js` now also exports pure helpers: `contradictionKey` (`claim_a::claim_b`,
directed as Skips emits, so the orchestrator's resolution-map key and the Bookkeeper's GlobalKG-tag lookup agree),
`enrichContradictions({contradictions, stagedKGs})` (resolves each side's claim text + supporting-paper DOIs + subspecialization
from the staged KGs; fallback to the claim id with no sources), `pendingContradictions`, `escalatedFrom`. The 'Poe' surfacer
step `receive`s a brief lead-in + carries the raw contradictions; the orchestrator's `planMaterialContradictions(packet)`
ENRICHES (via `readStagedSubspecializationKGs(history)`) and surfaces each UNDECIDED contradiction ONE AT A TIME through Poe's
overlay (a `milestoneCard` with `[SIDE_A]`/`[SIDE_B]` fields whose clickable citation chips reuse the Post-Doc `setOnCitation`/
papersIndex seam -> the `[PAPER]` tab, a `[SUBSPECS]` field, a `[CROSS_SUBSPEC]` warning banner = the nature, and four CTAs:
resolve A-stronger / resolve B-stronger / unresolved / escalate), PAUSING per decision; `recordContradictionDecision` records
`session.contradictionResolutions[key]={status,stronger_claim_id,at}` (once per key) and re-surfaces the next or, when all are
decided, stashes `session.escalatedContradictions` and resumes to BOOKKEEPER_PROMOTE. The Bookkeeper Phase 2's
`mergeIntoGlobalKG(...,resolutions)` (reads `ctx.session.contradictionResolutions`) now STAMPS each tagged contradiction +
per-claim `contradiction_partners` entry with its `resolution` (default `'open'` when MATERIAL_CONTRADICTIONS did not run) +
`stronger_claim_id`, and the GlobalKG gains `escalated_contradiction_count` (escalations TAGGED in the persisted GlobalKG). The
actual Loop3Input PACKAGING of the escalations stays the deferred OUTPUT_HOOK phase; this phase produces + persists the data it reads.
The unknown-field surfacing loop is built (ORCHESTRATOR-OWNED): at UNKNOWN_FIELD_SURFACING (Salvia still runs
there), the orchestrator unions Salvia's `unaddressed_rq_fields` with Skips' `unknown_fields` and, when fields
remain under the iteration cap, re-sweeps via a NEW Fearless Leader plan TARGETING them (UNKNOWN_FIELD_SURFACING
-> FEARLESS_LEADER, off index 0; default stays P53_EVALUATE), else falls through to p53. `unknownFieldIterations`
is tracked in orchestrator state (`getUnknownFieldIterations()`, reset on mount), capped by `maxUnknownFieldIterations`
(placeholder for the architecture max), and each re-sweep fires the `onIteration` seam (main.js -> IO trace
`resweep` count; the Phase-19 analysis trail subscribes to the same `onIteration`/`unknownfield:resweep` event).
Fearless Leader reads `session.unknownFields` (staged by the orchestrator) into its prompt and clears it
(consume-once). This SUPERSEDED the Skips-phase provisional RQ_REVISION_CHECK -> FEARLESS_LEADER re-sweep edge
(removed, along with revisioncheck's sweep cap).
The Loop 2 Poe overlay is built (`components/loop2/poeoverlay.js` + `.css`): in Loop 2 the Observatory owns the
center canvas, so Poe is a slide-up panel anchored to the surface bottom, raised on a decision (a contradiction,
an RQ revision, the intake gate) and lowered on dismissal (button + Escape); while up, the Observatory dims to
50%. `createPoeOverlay({poe})` WRAPS the SAME S0 Poe (the singleton) in a different mount configuration (mounts it
into the panel feed) and forwards the Poe method API: a conversation WRITE (receive/milestoneCard/cessationCard/
userTurn) raises the panel, a backstage signal (setStatus/settle/stream/showThinking) passes through without
raising it. Public overlay controls: `showOverlay(packet)` (the orchestrator's documented trigger), `hideOverlay`/
`dismiss`, `isOpen`, `setOnToggle`. main.js constructs `loop2Poe` and hands it to the orchestrator as its `poe`
(so existing conversation writes raise it unchanged), drops the persistent conversation strip, mounts the
orchestrator into the SURFACE (the overlay host), and `setOnToggle`s the Observatory dim (`.observatory-dimmed`);
the orchestrator's `proceed()` calls a guarded `poe.hideOverlay()` to lower the panel as the researcher leaves the
intake gate (so the autonomous sweep runs against the undimmed graph). It is NOT a second conversation writer (the
TurnGate holds: one Poe).
p53 is built (`agents/loop2/p53.js`, the eighth real agent) as the orchestrator's P53_EVALUATE cessation
controller: DETERMINISTIC (no dispatcher), it reads history + session flags and evaluates the four FINAL cessation
conditions (all planned subspecializations staged; Salvia uncertainty low, or medium with `session.researcherAcknowledged`;
no unresolved Skips contradictions; GlobalKG coverage >= threshold) -> `{state: CONTINUE|MAX_REACHED|CEASE,
conditions, coverage, iteration, max_iterations, reasons}`. Routing: CEASE -> POSTDOC_FINAL (Post-Doc final pass,
then the Output Hook); CONTINUE -> PHASE_1 (another round, bounded by the iteration cap); MAX_REACHED -> the reasons
surface through Poe's overlay (`packet.overlay`) and the chain PAUSES until the researcher acknowledges. The
coverage METRIC + THRESHOLD are injectable seams with PLACEHOLDER defaults (the FINAL values live in the external
architecture doc, not in the repo). A new GENERAL orchestrator seam carries this: a backstage `packet.overlay`
(a declarative milestone) is forwarded to `poe.milestoneCard` (raising the overlay), and a paused-with-overlay
agent gets an injected "Acknowledge and continue" CTA that resumes toward cessation. main.js registers `p53: loop2P53Agent`.
The Observatory now renders the UNIFIED GlobalKG view with a view toggle + a filter panel. The Observatory keeps an
in-memory `elements` model (renderer-independent) that `setView('subspec'|'global')` and `setFilter(state)` recompute
visibility from (cytoscape display per element, asserted via `visibleIds()`/`isVisible()`) - so filters apply to the
in-memory graph with NO IndexedDB re-fetch. Each node may carry `data.view` (absent = 'subspec', streamed nodes
unchanged). Bookkeeper Phase 2's scope-'global' `promoted` now carries the REAL global nodes (`buildGlobalViewElements`:
one deduped claim node id==global_claim_id with the filterable facets + supportCount + a contradiction flag, one
`gsub::<id>` subspec node sized by claim count, derived-from edges) plus the contradicts edges between those real nodes,
so main.js adds them DIRECTLY (the prior claimNodeIndex cartesian resolution for scope global is gone). In the global view,
edges are colored by type (the supports/contradicts/derived-from selectors already in STYLE), claim nodes are sized by
supporting-paper count and subspec nodes by claim count (the renderer owns the clamped pixel mapping `sizeForGlobalNode`
via `node[view="global"]{width/height:data(size)}`; the agent supplies only the count), and a claim in a contradiction
wears a red underlay halo (`node[contradiction=1]`). main.js auto-switches both the Observatory and the panel to the
global view on promotion (the "final state"); the toggle returns to the per-subspecialization sub-graphs.
`components/loop2/observatoryFilters.js` is the presentation-only left rail (view toggle + four checkbox facet groups -
subspecialization, claim type, confidence, quality flag - + clear); main.js accumulates facet options from the streamed
claims (the subspec view is filterable too) and the promoted GlobalKG and pushes them via `setFacets`. The CONFIDENCE
facet ships with only an "unassigned" bucket until the deferred Post-Doc FINAL pass assigns confidence.
The Post-Doc STANDARD pass is built (`agents/loop2/postdoc.js`, the NINTH real agent) as the orchestrator's
POSTDOC_STANDARD agent: a dispatcher agent (extraction tier, like Salvia/Skips) that synthesizes the knowledge graph
into a DRAFT LRSummary `{key_findings, evidence_strength, gaps, contradictions_summary}` (`lrSummaryDraftSchema`).
`readKnowledgeGraph` prefers the written GlobalKG (`kg.load('loop-2','global')`) and FALLS BACK to the staged
SubspecializationKGs (+ latest Skips contradictions) - POSTDOC_STANDARD sits before the round's BOOKKEEPER_PROMOTE, so
round 1 has no GlobalKG yet; a kg.load failure is surfaced (`postdoc:kg_load_error`) and degrades, never thrown. The
safe default `deterministicDraft` is a structural floor (leading claim texts, a coarse avg-support strength label, a
contradiction-count sentence) so an outage still yields an on-contract draft. It STORES the draft on the session
(`session.lrSummary` + `session.lrSummaryPass='standard'`) for the later passes and settles BACKSTAGE to the IO panel
(`ioPacket.setPacket`; never a conversation write). The step BRANCHES on state (like the Bookkeeper). main.js
registers `'Post-Doc': postDocAgent`.
The Post-Doc FINAL pass + the full TRUST STACK is built (the POSTDOC_FINAL branch): after a p53 CEASE it produces the
DEFINITIVE LRSummary (Loop 2's output). The model returns `key_findings:[{text, claim_ids, rationale}]` + evidence/
gaps/contradictions; the Post-Doc ENRICHES each finding DETERMINISTICALLY from the GlobalKG (resolve claim_ids ->
claims -> union supporting papers + detect contradiction tags) and ASSIGNS the confidence (the build prompt's three
labels map exactly: contradiction -> low/red "Conflicting evidence"; >= 2 papers -> high/green "Well-supported by
multiple papers"; else medium/yellow "Single-source, moderate confidence") - confidence is NEVER model-assigned (this
is the FINAL pass where "confidence is null until Post-Doc" is resolved). `requires_human_review = any finding (< 2
papers OR cites a contradiction)`. Math is normalized in the agent (`normalizeMathDelimiters` + a backtick-math strip)
and rendered via `math:true` (KaTeX). The card is the existing `poe.milestoneCard` (three-layer confidence badge,
`[REVIEW]` banner, math fields), emitted as `packet.overlay` (raises the Loop 2 overlay); the only poe.js additions are
CLICKABLE citation chips (a chip with a `citation` is a `<button>` firing `poe.setOnCitation`) and milestoneField
rendering a value AND chips together. The clickable chip opens the source paper's abstract + retrieval metadata in a new
`[PAPER]` IO tab (`components/paperCard.js`), resolved from an in-memory `papersIndex` (DOI -> record) main.js builds
from the streamed claim events (the Grad Student now rides the full `paper` record on its open/settled `onClaimRender`
events). The enriched LRSummary is stored on the session (`session.lrSummary`, `lrSummaryPass='final'`).
The RQ revision check is built (ORCHESTRATOR-OWNED, at RQ_REVISION_CHECK, after the Post-Doc standard pass; policy in
`src/loops/loop2/rqrevision.js`). After the Revision Check (Skips) packet, the orchestrator evaluates whether the review
revealed the RQ needs revising on two signals: (1) more than 30% of the evidence is flagged for review, (2) a core RQ
assumption is contradicted by high-confidence claims. RECONCILIATION (the spec references data not available at this
state - the standard draft's findings are free strings, confidence is null pre-FINAL-pass, the RQPacket assumption schema
is FINAL): it is DETERMINISTIC ("the orchestrator checks"; Charter: no invented agent) - condition 1 is computed over the
underlying CLAIMS (`isClaimFlagged`: review-flagged / < 2 papers / contradiction-tagged) against the spec's 30% threshold;
condition 2 is an INJECTABLE predicate (`isAssumptionContradicted`) defaulting to a Skips contradiction between two
well-supported (>= 2-paper) claims (the FINAL assumption-aware predicate is the external seam, like p53's coverage). When
either holds, the orchestrator surfaces a TWO-CHOICE decision through Poe's overlay (a new `milestoneCard` `ctas:[...]`
row) and PAUSES: "Revise the research question" records `session.rqRevisionChoice='revise'` + fires the injected
`onReviseRQ({globalKg, stagedKGs, lrSummary, reasons})` (main.js navigates back to Loop 1 with the GlobalKG as context),
leaving Loop 2 paused; "Proceed with an acknowledged caveat" records `session.rqRevisionChoice='proceed'` +
`session.rqRevisionCaveat` and resumes (the normal MATERIAL_CONTRADICTIONS forward edge). The choice is recorded once per
run (no re-surfacing). No new state/edge: this layers on after the existing POSTDOC_STANDARD -> RQ_REVISION_CHECK packet,
exactly as the unknown-field re-sweep layers on after Salvia.
The cessation card + the analysis trail are built (the OUTPUT_HOOK Packager). `src/agents/loop2/packager.js`
(`createPackagerAgent`) is the OUTPUT_HOOK agent, CLIENT-SIDE (no dispatch, like the Bookkeeper): it reads
`session.lrSummary` (the definitive LRSummary), the GlobalKG (`kg.load('loop-2','global')` -> the coverage
counts), `ctx.trailLog`, and the PHASE_1 packets (papers-retrieved/claims-extracted), and builds the cessation
card via `buildCessationCard` - it REUSES the Post-Doc's `buildFinalCardSpec(session.lrSummary)` (findings + head
badge + review banner + clickable chips) and AUGMENTS it with a `[COVERAGE]` field group (subspecializations /
papers retrieved / claims extracted / claims promoted / escalated), a collapsible `Show analysis trail` section
(`formatTrail`), `tag:'[ARCHIVE_COMPLETE]'`, and a `Proceed to Hypothesis Scrutiny` CTA. It is returned as
`packet.overlay` (the existing seam -> poe.milestoneCard raises the Loop 2 overlay + wires the CTA; backstage
settle to IO). The ORCHESTRATOR now keeps a REAL-TIME `trailLog` (reset on mount, `getTrailLog()`, threaded into
each step ctx): `appendTrail` is called at FEARLESS_LEADER (`sweep`, + the unknown fields a re-sweep targeted via
a consume-once `pendingResweepFields`), PHASE_1 (`claims_round`, from gradphase's new ADDITIVE result counts
`papers_retrieved`/`claims_extracted`/`claims_rejected`), P53_EVALUATE (`coverage`), the unknown-field re-sweep
(`unknown_field_sweep`), and the escalate branch (`contradiction_escalated`); plus a public `noteFallback(event)`
that maps DISPATCHER events (failover / cache hit / corrective retry / safe default / circuit open) into the trail
(main.js feeds it from `logDispatch` gated by `session.currentLoop===2`). The Post-Doc FINAL pass no longer raises
its own overlay (still stores `session.lrSummary`): the cessation card is the SINGLE LRSummary surface. The CTA
marks Loop 2 complete (`markLoopComplete(2)`, unlocking Loop 3 in the navigator). poe.js is UNCHANGED.
STILL FINAL/deferred: the rest of the SubspecializationKG (entities/methods/datasets/design-recs/
intra-contradictions/unknowns/sparse handling), the real per-claim Salvia VALIDATION seam (the grounding
seam inside the Grad Student is still the default deterministic pass; the uncertainty SURVEYOR is built),
the Senior Grad Student GeneralKG + CrossSubspecializationNotes synthesis (PHASE_2),
the canonical/temporal trust dimensions + durable paper-record persistence (the in-memory papersIndex is
session-scoped), the FINAL GlobalKG coverage metric + threshold (p53's are placeholder seams; the GlobalKG itself
is now written), and the Loop3Input PACKET schema + a real Loop 3 surface (the only remaining end-state piece; the
OUTPUT_HOOK cessation card + the Loop 2 unlock are now built, and the GlobalKG / definitive LRSummary /
`session.escalatedContradictions` are all persisted for the Loop3Input packaging to read).

## Stack and commands

- Vite 8, vanilla JS, no UI framework. App root is `src/`, build output `dist/`.
- Vitest 4 + jsdom for tests; `fake-indexeddb` for the storage suite (dev only).

```
npm run dev      # Vite dev server on :5173
npm run build    # production build to dist/
npm test         # full vitest suite (run once)
npm run eval     # the 5 workflow evals (CI-style PASS/FAIL, non-zero on fail)
```

Always run `npm test` before ending a session.

## Layout

```
src/
  dispatcher/      the reliability spine; single dispatch() entry point
    dispatcher.js  exports dispatch, createDispatcher, configureDispatcher
    adapters/      per-provider template + 429 parser + send() seam;
                   streamparse.js (SSE/NDJSON delta reader) for real token streaming
    simulator.js   deterministic transport; circuitBreaker/queue/backoff/failover;
                   streamSuccess() for deterministic streaming on virtual time
    hipaa.js cache.js validate.js errors.js tokens.js RATE_LIMITS.js
  components/      sidebar, ioPanel, agentConsole, packetInspector, poe,
                   dashboard, settings, mousekatool, loopSurfaces (per-loop mount/teardown),
                   matrixRain (Loop 2 entry transition),
                   observatory (Cytoscape.js KG canvas: incremental render, minimap, click),
                   loop2/poeoverlay (Loop 2 slide-up Poe panel, wraps the S0 Poe; dims the Observatory)
  loops/loop2/     orchestrator.js (the FINAL-routing state machine, stub agents),
                   registry.js (nine-agent status copy)
  utils/storage.js IndexedDB (GlobalKG), localStorage (session), File System export
  styles/          tokens.css (single source of truth), shell.css, main.css
  main.js          shell coordination only (no loop logic, no agents)
tests/             vitest suites mirror src/ (incl. evals/: 5 workflows + gate + rubric)
Opus_DELTAS.md     deviation + decision log (see below)
```

## The dispatcher (the spine)

`dispatch({ tier, messages, schema, loopContext, agentId, safeDefault, priority,
maxTokens, onToken }) -> validatedResponse`. `onToken` (optional) streams prose
deltas for perceived speed: the FIRST provider attempt streams (SSE/NDJSON via the
transports), the corrective retry is silent, and schema validation always runs on the
FULL accumulated body, never a partial. Composition order inside `dispatch()`:

1. HIPAA: `loopContext.hipaa` forces `['ollama']` only, resolved first and
   absolute (no hosted fallback).
2. Cache: key = hash(agentId + tier + messages); a hit skips the call.
3. Failover over `['anthropic','groq','mistral']`: breaker gate, queue admission
   (80% of limits), provider template, retry/send with 429 parsing.
4. Validate against the caller schema: one corrective retry (+0.1 temp), then the
   caller `safeDefault`.

The dispatcher is UI-agnostic: it emits typed events to an injected logger and
trace sink. The caller owns `schema` and `safeDefault`; the dispatcher never
invents agent values.

## Hard constraints (PLAYBOOK, always in effect)

Reliability:
- All LLM calls go through the dispatcher. No direct provider calls outside `adapters/`.
- Per-provider prompt templates: Claude, Llama-on-Groq, and Mistral do NOT get identical prompts.
- Backoff 1/2/4/8s + jitter; honor retry-after; retry only 429/5xx/timeout, never 4xx.
- Circuit breaker: 3 consecutive fails -> OPEN, 60s cooldown -> HALF-OPEN, success -> CLOSED.
- Schema validation + corrective retry (+0.1 temp) + safe-default fallback.
- Queue at 80% of rate limits.
- HIPAA flag -> Ollama only, enforced before provider selection.
- localStorage packet cache; a pre-warmed cache makes a repeat run cost zero quota.
- No silent error swallowing: every exception reaches the error boundary with reproducible context.

Visual and copy (the "Dusty University Office" theme; whole-app, by user direction 2026-06-14, superseding the prior deep-slate / neon-green law):
- No em dashes anywhere (text, code, labels, comments, status copy). Use hyphens, colons, or parentheses.
- No border-radius anywhere (structural). This also keeps the Windows-98 bevels square.
- Monospace for IO, console, packets, any data, and the typed-document cessation card; the Win98 sans (`--font-ui`) for non-data UI chrome.
- Warm cream paper for surfaces: `--bg-base` (manila chrome) and the loop-aware `--bg-primary` (the canvas page; per-loop tints live in `tokens.css` under `[data-loop]`, defined in that loop's architecture doc).
- Sepia/brown ink for text (`--fg-default` / `--fg-dim`).
- Deep olive-green for active/live/confirmed only (`--accent-active`). Never idle or decorative.
- Ochre/sienna for bracket notation only (`--accent-bracket`, via `.bracket`): `[AGENT]`, `[FIELD]`.
- Windows-98 chrome: raised/sunken two-tone bevels via `--bevel-light` / `--bevel-dark` (or the `.bevel-raised` / `.bevel-sunken` utilities in `main.css`); raised faces `--surface-raised`, sunken wells `--surface-sunken`, the typed document `--surface-document`. Brick red `--accent-error` for failures.
- A single global progress indicator (owned by Poe, at the top of the conversation).
- Unique status copy; never a generic "Loading...".

Code hygiene and process:
- Components export `mountX(target, opts)`, return a method API, own their DOM and CSS (`import './x.css'`).
- Dependency injection for testability: clock, sleep, random, storage, measure, and transports are injectable; tests run on virtual time and in-memory stubs.
- Typed errors carry classification fields (`retryable`, `failover`, `countsAsFailure`, `retryAfterMs`); decisions read fields, not error strings.
- Factory + default singleton for app-wide services (`createDispatcher`/`dispatch`, `createStorage`/`kg|session|file`, `createPoe`/`poe`).
- Before any bug fix, write a failing regression test named after what broke.
- Run the full test suite before ending any session.

## TurnGate

Poe (`src/components/poe.js`) is the only module that may write to the
conversation layer, enforced structurally: the conversation DOM lives only inside
`poe.js`'s closure, its API exposes methods only, and Poe owns its own progress
indicator (no shell DOM reference). Do not add a second conversation writer, and
do not give any other module a conversation node.

## Autonomy Charter (what Opus does NOT own)

Opus implements infrastructure and enforcement mechanisms. Opus does not own, and
must not invent: agent logic, packet schemas, inter-agent routing rules, the HIPAA
routing policy (FINAL; Opus only implements the enforcement mechanism), or any
item marked `(FINAL)`. Components and the dispatcher stay schema-agnostic: they
render or validate what they are handed, reading a small documented set of
presentation fields, never defining the shapes.

## Opus_DELTAS.md

The audit trail of every deviation from the literal spec, every silently
documented decision, and every reusable pattern, with the reason. Append a row
whenever you deviate, make a judgment call the spec did not dictate, or establish
a pattern. It records deviations and decisions, never constraints (constraints
live in this file).

## Testing and evals

- Unit suites under `tests/` mirror `src/` (the dispatcher has one suite per
  reliability sub-step under `tests/dispatcher/`).
- The 5 workflow evals (`tests/evals/`) drive the whole spine through the
  simulator on virtual time (happy path per provider, breaker-OPEN failover,
  corrective-retry success, HIPAA ollama-only, cache hit). They run as `npm run
  eval`, as `tests/evals.test.js`, and via a `Stop` hook
  (`.claude/settings.json` -> `tests/evals/gate.js`) that blocks a clean stop on
  any FAIL; `tests/evals/rubric.md` is the LLM-judge rubric.
