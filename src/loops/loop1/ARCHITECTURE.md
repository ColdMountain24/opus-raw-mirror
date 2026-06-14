# Loop 1 (The Agora) architecture

The per-loop architecture doc CLAUDE.md refers to. It accretes one section per
build phase; it records only what has been specced, and it points at the code
rather than duplicating it. Items the architecture marks FINAL are user-owned and
must not be invented here (Autonomy Charter).

## Agents

Six agents, driven in sequence by the orchestrator (`orchestrator.js`):
Poe, CV, RQSupervisor, Novelty Checker, Edgar Allan, p53. Their status copy lives
in `registry.js`; the orchestrator's legal-adjacency state machine and the
conversation mutex live in `orchestrator.js` and `turngate.js`.

## Poe (configured)

Poe is the research collaborator and the only agent that writes the conversation
(TurnGate). Implementation: `agents/poe.js`.

- System prompt: the canonical text is `POE_SYSTEM_PROMPT` in `prompts.js` (the
  single source the agent imports; this doc points at it rather than reproducing
  it). It is the architecture's prompt and may be changed only if functionally
  inadequate, with the change logged in `Opus_DELTAS.md`.
- Provider: the conversation tier, Groq-first for streaming speed, falling back
  through the dispatcher (`CONVERSATION_TIER = ['groq','anthropic','mistral']`,
  passed as the dispatcher's per-call `failover` override). HIPAA enforcement in
  the dispatcher still overrides this absolutely.
- Job: elicitation only. One clarifying question per turn, attributed to Poe.
- Output: Poe owns its conversational `content` and validates it against its own
  `poeMessageSchema` (a non-empty message string); its `POE_SAFE_DEFAULT` is the
  unique fallback used when no provider is reachable.

### Poe's contract with the reviewers and the RQPacket (seams; shapes FINAL)

Poe re-extracts and re-versions the RQPacket after every substantive user message
before triggering CV (the orchestrator's default transition out of POE_INTAKE is
CV_CHECK). The version counter is a mechanism Poe owns; the RQPacket's domain
fields and the reviewers' verdict wire formats are FINAL and enter through two
injected seams with deferred defaults:

- `extractRQPacket({ transcript, previous, version }) -> rqPacket` (RQPacket-schema
  phase supplies the real extraction).
- `readReviewVerdict(history) -> { passed, blocking } | null` (Poe's consumption
  interface for the latest reviewer to weigh in, CV or RQSupervisor; the adapters
  live in `review.js`).

The review gate is enforced at the prompt level each turn: Poe is told to invite
confirmation only when the latest verdict passed, and otherwise told plainly not
to declare the question final. When a reviewer reports blocking items, they are
surfaced verbatim so Poe addresses a real gap rather than emitting a generic "not
ready yet" message.

## CV (configured)

CV is the completeness validator and a backstage agent. Implementation:
`agents/cv.js`.

- Input: the RQPacket Poe maintains (`session.rqPacket`). The required-field list
  is FINAL and enters via the `requiredFields` seam (default empty until the
  RQPacket-schema phase supplies it).
- Provider: the extraction tier, Anthropic-first, falling back through the
  dispatcher (`EXTRACTION_TIER = ['anthropic','groq','mistral']`, per-call
  `failover` override). HIPAA still overrides absolutely.
- Output: `{ status: 'pass' | 'fail', score: number, blocking_fields: string[] }`,
  validated against `cvResultSchema` (owned: the spec gave it) before the
  orchestrator acts on it. `CV_SAFE_DEFAULT` fails closed (an unreachable
  validator never falsely passes).
- Prompt: `CV_SYSTEM_PROMPT` in `prompts.js`, derived from the spec (no verbatim
  prompt was given) and replaceable when the architecture supplies CV's canonical
  prompt.
- Surface: backstage. CV writes its score and blocking fields to the IO panel
  (Packet Inspector + Agent Console), never the conversation. Routing: a fail
  returns to Poe (so it surfaces the blocking fields); a pass proceeds forward.
  Poe reads the verdict through `review.js` (`reviewVerdictFromHistory`).

## RQSupervisor (configured)

RQSupervisor is the question-structure reviewer and a backstage agent.
Implementation: `agents/rqsupervisor.js`.

- Input: the RQPacket Poe maintains, after it has passed CV.
- Provider: the extraction tier, Anthropic-first (shared `EXTRACTION_TIER` from
  `tiers.js`). HIPAA still overrides absolutely.
- Output: `{ approved: bool, paradigm: string, feedback: string[],
  revision_required: bool }`, validated against `rqResultSchema` (owned: the spec
  gave it) before the orchestrator acts on it. `RQSUPERVISOR_SAFE_DEFAULT` fails
  closed (an unreachable reviewer never approves; it requires revision).
- Prompt: `RQSUPERVISOR_SYSTEM_PROMPT` in `prompts.js`, derived from the spec and
  replaceable. paradigm is a free string; the ResearchParadigm set is FINAL, so
  the prompt's example paradigms (clinical, computational, synthesis,
  experimental, the ones the Poe prompt names) are illustrative, not an enum.
- Surface: backstage. Routing per spec: `revision_required` routes back to Poe
  with the feedback; otherwise the default forward edge proceeds. Poe reads the
  feedback through `review.js`.

## Edgar Allan (configured)

Edgar Allan is the literature retriever. In Loop 1 it is invoked by the Novelty
Checker (not a top-level orchestrator turn). Implementation: `agents/edgar.js`.

- Invocation: built as a capability the Novelty Checker calls; `edgarRetrieve(ctx)`
  returns a backstage-shaped packet whose `result` the caller reads. main.js
  wiring lands with the Novelty phase.
- Provider: none. Edgar does NOT use the LLM dispatcher; it has its own per-source
  transport seam (`sources: { pubmed, semanticScholar, arxiv }`, each async
  (query, opts) -> paper[]), defaulting to not-wired (real fetch later). A single
  source failing surfaces to the logger and the other continues.
- Routing: PubMed + Semantic Scholar for biomedical questions, arXiv + Semantic
  Scholar for general / computational (the `classifyDomain` seam maps the
  RQSupervisor paradigm: clinical -> biomedical, else general).
- Output: `{ papers: [{title, authors, year, doi, abstract, source}], query_used,
  retrieval_count }`, capped at 20, validated against `edgarResultSchema` (owned;
  the schema enforces the cap) before it is passed to the Novelty Checker.

## Novelty Checker (configured)

The Novelty Checker assesses novelty against retrieved literature and is a
backstage agent. Implementation: `agents/noveltychecker.js`.

- Tool: it invokes Edgar Allan (injected) to retrieve papers, passing the
  RQSupervisor paradigm (read from history) so Edgar routes its sources. Edgar's
  retrieval is attached to the Novelty packet (`retrieval`) for the IO panel.
- Provider: the extraction tier, Anthropic-first. HIPAA still overrides.
- Output: `{ novelty_signal: 'high'|'medium'|'low', rationale, overlapping_papers
  }`, validated against `noveltyResultSchema` (owned: the spec gave it).
- Non-blocking: a low signal attaches a warning (on the packet and
  `session.noveltyWarning`) and the chain still routes forward to p53; it does NOT
  go through Poe's review back-edge. The cessation card surfaces the warning
  through Poe; the researcher decides. The safe default reports low with an
  explicit "could not assess" rationale.
- Routing: because it invokes Edgar itself, it routes to P53_EVALUATE, past the
  vestigial EDGAR_RETRIEVE state (kept for the stub linear chain).

## p53 (configured)

p53 is the cessation controller and a backstage agent. Implementation:
`agents/p53.js`. Deterministic: no LLM dispatch.

- Conditions: CV passed, RQSupervisor approved, Novelty ran (all read from
  history), researcher confirmed (`session.researcherConfirmed`, set by the
  cessation/confirm flow, a later phase).
- States: CONTINUE | MAX_REACHED | CEASE (`p53ResultSchema`, owned).
  - CONTINUE: conditions not met; routes back to Poe (POE_INTAKE).
  - MAX_REACHED: the iteration cap (default 5, a seam) was hit; a non-blocking
    warning routed back through Poe. The `session.maxWarningSurfaced` gate plus
    branch order guarantee p53 never cascades straight to CEASE: a first-time max
    is always MAX_REACHED, never CEASE, even when every other condition is met.
  - CEASE: all conditions met (and any max warning already surfaced); emits the
    RQPacket (as it stands) to the `output` hook and routes to COMPLETE.
- Surface: backstage (settle + Packet Inspector), never the conversation.

## RQPacket assembler and FrameworkRegistry

The RQPacket assembler (`rqpacket.js`) is the real implementation of Poe's
`extractRQPacket` seam, and the FrameworkRegistry (`src/utils/frameworkregistry.js`)
is the client-side framework content store the assembler reads. Both are
deterministic and dispatch-free (like Edgar and p53).

- Assembler: `createRQPacketAssembler(deps)` returns `assemble({ transcript,
  previous, version, userMessage, extraction }) -> rqPacket`. It carries the prior
  packet forward (without mutating it), expands a framework id through the registry
  when Poe's extraction names one, and stamps `version` (Poe still owns the
  counter). main.js injects it as Poe's `extractRQPacket`.
- FrameworkRegistry: `register(id, definition)` + deterministic `lookup(id) ->
  frozen definition | null`, plus `has`/`ids`. Stored definitions are deep-frozen,
  so a lookup hands out an immutable, shareable field set. An absent id is `null`
  (not an error, mirroring storage); misuse (blank id, non-object definition,
  duplicate id) throws a typed `FrameworkRegistryError`.
- The framework content rule. The LLM emits only a framework id in its structured
  output; the registry maps that id to the full field set client-side, after the
  call returns. Framework content therefore never enters a prompt: the registry is
  imported only by the assembler (post-LLM, dispatch-free), and Poe's prompt is its
  system text plus the transcript, never the packet. A guard test pins this (a
  framework field set holding a sentinel never appears in any message Poe sends).
- Charter boundary. The assembler owns the assembly mechanism and the registry owns
  the lookup mechanism; the framework definitions (content) and the FINAL RQPacket
  field schema are user-owned and are NOT invented here. The registry singleton
  ships EMPTY (definitions register as data when supplied), and three seams keep the
  assembler off the FINAL shapes: `frameworkIdOf(args)` (default null, so until real
  extraction wires a framework id the assembler degrades to exactly the prior
  carry-forward, `{ ...previous, version }`), `mergeFieldSet(base, fieldSet, id)`
  (default shallow merge, overridable when the FINAL schema lands), and `registry`.
  An unknown framework id fails closed: it logs a `framework:unknown` event and
  carries the packet forward, inventing no fields.

## Output Hook (the completion seam)

The Output Hook (`outputhook.js`) is the real implementation of p53's `output`
seam: it fires when p53 emits CEASE (p53 calls `output(rqPacket, meta)`, awaited so
the effects finish while Poe holds the floor and before the machine reaches
COMPLETE). On a cessation it performs the three completion effects:

1. Persists the finalized RQPacket to the session store (`storage.session`),
   non-destructively (load, merge, save) and stamping the completed loop.
2. Unlocks the next loop in the navigator (Loop 1 done -> Loop 2 unlocks), through
   an injected `markLoopComplete`; main.js marks the loop on its presentation
   session and fans it to the sidebar navigator (which unlocks Loop N when N-1 is in
   `completedLoops`).
3. Surfaces the completion card in Poe's conversation layer. The card is a
   conversation write, so it goes through Poe (the only conversation writer): the
   hook hands Poe the finalized facts and the CTA, and the new `poe.cessationCard`
   method owns the card DOM and wires the button. The card shows the finalized
   research question, the detected paradigm, and the novelty signal (all monospace
   data, the confirmed question in active green), plus a "Proceed to Literature
   Review" CTA that calls the injected `onProceed` (main.js navigates to Loop 2).

p53 forwards the presentation facts it already read (`researchQuestion`,
`paradigm`, `noveltySignal`) as the second `meta` argument, so the hook renders the
card without re-scanning history; the RQPacket stays the first argument (the Phase 8
contract). No silent swallowing: a persistence failure is surfaced to the injected
`onError`/`logger` with `{ area, step }` context and is NON-fatal (the loop has
ceased, so the unlock and the card still happen). The persisted session shape, the
navigator update, and the CTA target are injected seams (main.js owns them), so the
hook invents neither the session schema nor the navigator. main.js wires it as
`createP53Agent({ output: createOutputHook({ poe, storage, markLoopComplete,
onProceed: () => navigateToLoop(2), onError }) })`.

## Trust layer (cessation card)

The completion card carries a trust layer over the run's results. The derivation
lives in one place, `trust.js` (mirroring `review.js`): `buildTrustModel({ history,
researchQuestion })` reads the latest CV / RQSupervisor / Novelty results and returns
a presentation model the Output Hook passes to `poe.cessationCard`. p53 forwards only
`{ researchQuestion, history }`; the Poe card is a pure renderer (plus KaTeX). The
spec-given rules are implemented verbatim and the model fails SAFE (missing results
report the lowest confidence and require review).

- Layered confidence badge (three distinct elements): a color pill keyed off the
  novelty signal via `data-level`, a natural-language label (`Well-supported` /
  `Moderate confidence` / `Needs review`), and a hover/focus tooltip carrying the raw
  Novelty rationale plus the RQSupervisor feedback. They solve different problems
  (at-a-glance, readable, inspectable) so they are not collapsed into one.
- Collapsible evaluation (`<details>` "Show evaluation"): CV completeness, the
  blocking fields that were resolved (the union of every `blocking_fields` CV reported
  across the run; none remain at the passing cessation), the paradigm and its
  rationale, and the novelty signal with its overlapping papers.
- requires_human_review: `cvScore < 0.85 || noveltySignal === 'low'` (plus the
  missing-data fail-safe). When set, the card shows a visible banner and the flag is
  persisted on the completion record (NOT the FINAL RQPacket). `REVIEW_SCORE_THRESHOLD`
  is exported from `trust.js`.
- Math: research questions and rationales render through `src/utils/mathtext.js`,
  which normalizes ChatGPT-style `\(..\)` / `\[..\]` delimiters to `$..$` / `$$..$$`
  and renders with KaTeX (`renderToString`, never wrapped in code backticks). The
  KaTeX stylesheet is imported once at the app entry (`main.js`), not in the
  component, so the test suites do not pull the vendor CSS.

Confidence pill colors. The card's confidence pill is color-coded high/medium/low via
`tokens.css` `--confidence-high` (reuses the active accent), `--confidence-medium`, and
`--confidence-low`, confined to the trust badge and the review banner. Under the
whole-app Dusty University Office theme (below) these are retuned for cream (olive /
ochre / brick red); high still reuses `--accent-active`.

## Tiers and review verdicts

Provider tiers live in `tiers.js` (`CONVERSATION_TIER` Groq-first,
`EXTRACTION_TIER` Anthropic-first), the single source the agents re-export. The
backstage reviewers' verdicts reach Poe through `review.js`
(`reviewVerdictFromHistory`), which returns the latest CV or RQSupervisor verdict
as `{ passed, blocking }`.

## Conversation vs backstage (orchestrator)

Only the conversation writer (Poe, the TurnGate owner) renders a conversation
card (`poe.receive`). Every other agent is backstage: the orchestrator settles its
Agent Console entry (`poe.settle`) and surfaces its validated packet to the Packet
Inspector (`io.packet`), with no card in the conversation feed.

## The live pipeline: schema, extraction, frameworks, confirmation

The last mile wires the FINAL shapes and the interactive path so a real question runs
end to end to a CEASE.

- RQPacket schema (`rqschema.js`). The FINAL field set: top-level investigation fields
  (KnowledgeGap, ObjectOfInquiry, InvestigationWorkflow, ValidationCriteria, Claims), a
  Scope block (universal Population/Setting/InclusionCriteria/ExclusionCriteria;
  conditional Timeframe/SpatialBoundary/DomainBoundary), classification
  (ParadigmClass, Subdomain, Design, StudyPhase), and the UnknownFields /
  IrrelevantFields markers plus the derived Frameworks. `scoreCompleteness` is the
  deterministic completeness rule: a field is populated when it has content or is in
  UnknownFields; a conditional field listed in IrrelevantFields is not counted;
  StudyPhase null never blocks; pass requires the full 1.0 threshold.
- CV is now DETERMINISTIC. It applies `scoreCompleteness` over the structured packet
  (no LLM dispatch), keeping its `{ status, score, blocking_fields }` contract and the
  fail -> Poe routing. An LLM score could not hold a 1.0 gate; the deterministic rule
  makes a clean run reach pass reliably.
- Extraction (`extraction.js`) is Poe's real `extractRQPacket` (awaited). Each turn it
  dispatches on the extraction tier to pull the structured packet from the transcript,
  then assembles the versioned packet. The study Design comes from the model as a
  label; the reporting Framework is resolved DETERMINISTICALLY from the design via
  DesignLookup (`frameworks.js` DESIGN_TO_FRAMEWORKS), never emitted by the model. Only
  the framework id labels go on the packet; the framework CONTENT lives in the registry
  and is never embedded, so it cannot leak into a downstream prompt.
- Frameworks (`frameworks.js`). DESIGN_TO_FRAMEWORKS is the FINAL design -> framework
  anchor map; FRAMEWORK_DEFINITIONS are the per-id field sets (reporting-checklist
  sections, this module's content). `seedFrameworkRegistry` registers them into the
  FrameworkRegistry at startup (main.js); the design -> framework -> content chain is
  two deterministic, client-side lookups.
- Researcher input and confirmation. The composer (`components/composer.js`) is the
  input surface, a SIBLING of Poe's feed (the TurnGate rule: only Poe writes the
  conversation). It submits to `orchestrator.submit` and exposes a Confirm affordance
  surfaced ONLY when the orchestrator reports the latest review passed
  (`canConfirm` / `composerStatus`, driven by `onComposer`). `orchestrator.confirm()`
  sets `session.researcherConfirmed` and routes straight to P53_EVALUATE, which now has
  every condition met and ceases. After cessation the composer locks (no further
  edits). The orchestrator resets its session on every mount so NEW SESSION never leaks
  a prior confirmation or packet.
- The cessation card's trust layer also surfaces p53's max-reached warning
  (`session.maxWarning`) as a non-blocking caution (a warning, not a stop), carried
  through the Output Hook onto the card.

## Theme: the Dusty University Office (whole app)

The app's visual identity is a forgotten university office: warm cream paper, sepia
ink, olive and ochre accents, square Windows-98 beveled chrome. This is a whole-app
theme (user direction 2026-06-14) and it overrides the prior deep-slate / neon-green
law; the new palette law and tokens are in `tokens.css` + `main.css` and documented in
CLAUDE.md. Loop-1 specifics:

- The shell is the desk (manila `--bg-base`); the canvas is a sheet of paper
  (`--bg-primary`, faint ruled lines). Per-loop tints still live under `[data-loop]`
  in `tokens.css` (Loop 2 ages the paper); the canvas is the only region that shifts.
- The conversation is one beveled paper page: Poe's feed above, the composer attached
  as the page footer (a sunken input well), so the input never reads as a detached box.
  Agent turns are typed memo slips; the active indicator and confirmed state are olive.
- The cessation card is a finished typed document on `--surface-document`, lifted off
  the page on a hard Win98 drop shadow, with an olive confirmed edge.

## File-cabinet drawer (the research file)

The live RQPacket is surfaced on the canvas as a manila folder with tabbed sections,
in a drawer that pops up from a handle between Poe's feed and the composer (the chosen
"drawer toggle" layout). It is a DATA VIEW, not a conversation writer and not the
composer, so the TurnGate rule is untouched.

- `components/fileCabinet.js` is generic and schema-agnostic: it renders a
  `folders = [{ id, label, fields:[{label,value,state}] }]` contract (manila tabs +
  the active section's fields) and toggles open/closed from the handle. It knows
  nothing about the RQPacket.
- `rqfolders.js` (`rqPacketFolders`) is the Loop 1 adapter that maps the FINAL packet
  into folders (Question / Method / Scope / Classification / Frameworks). Presentation
  grouping only: the field names come from `rqschema.js`, UnknownFields are marked
  "(unknown)", IrrelevantFields are omitted, framework ids are shown (content never),
  and the packet is never mutated.
- The orchestrator's optional `onPacket(rqPacket)` seam fires each turn (and clears on
  mount); `main.js` wires it to `fileCabinet.setFolders(rqPacketFolders(p))`, so the
  folder fills in live as Poe extracts.

## Live transports

The provider transports are now wired (`src/dispatcher/adapters/transports.js`,
injected by `main.js` into `configureDispatcher`). Each adapter fires a real `fetch()`
with the user's API key (pulled fresh from Settings/localStorage at call time): a keyed
provider returns a live model response, an unkeyed one fails over (and Ollama serves
HIPAA sessions from its endpoint). So a live browser run now drafts a real packet. Tests
still drive the spine through the deterministic simulator; the transports are proven by
`tests/dispatcher/transports.test.js` with an injected fetch (a real network call cannot
run under jsdom, and a browser may still hit provider CORS, documented in `Opus_DELTAS.md`).

## Deferred to later phases

Loop 1 is wired end to end: a complete question runs extraction -> CV (1.0 pass) ->
RQSupervisor -> Novelty -> p53, the researcher confirms, p53 ceases, and the Output
Hook persists the validated RQPacket, unlocks Loop 2, and renders the trust-layer
cessation card (proven by `tests/loops/loop1/pipeline.e2e.test.js`). The Phase 9
`createRQPacketAssembler` (the dormant carry-forward default) is superseded by
`extraction.js` in the live app and retained only as the documented mechanism/default.
Loop 2 (The Literature Review) itself is a future build; this phase only unlocks its
navigator entry.
