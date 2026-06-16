// Opus CC entry point.
//
// Phase 4: the shell mounts three standalone components into their regions and
// coordinates between them. The sidebar (loop nav, session status, settings)
// and the IO panel (Agent Console and Packet Inspector tabs, plus the debug
// trace footer) are components with mount functions. The canvas stays
// declarative markup; it is not a Phase 4 component.
//
// main.js owns only cross-component coordination: loop selection updates the
// shell background attribute and the canvas title; the IO collapse intent
// resizes the grid; the session lifecycle fans out to the indicator, the trace
// footer, and the two views; the canvas reflow broadcasts its size. No loop
// logic, no dispatcher, no agents yet; those arrive in later phases.

import './styles/tokens.css';
import './styles/main.css';
import './styles/shell.css';
// KaTeX vendor stylesheet for math rendered on the cessation card. Imported at the
// app entry only (not in the components) so the jsdom test suites do not pull the
// vendor CSS; KaTeX's renderToString output is asserted on directly in tests.
import 'katex/dist/katex.min.css';
import { mountSidebar } from './components/sidebar.js';
import { mountIoPanel } from './components/ioPanel.js';
import { mountDashboard } from './components/dashboard.js';
import { mountSettings, loadSettings } from './components/settings.js';
import { mountMousekatool } from './components/mousekatool.js';
import { mountComposer } from './components/composer.js';
import { mountFileCabinet } from './components/fileCabinet.js';
import { createLoopSurfaces } from './components/loopSurfaces.js';
import { poe } from './components/poe.js';
import { createLoop1Orchestrator } from './loops/loop1/orchestrator.js';
import { createPoeAgent } from './loops/loop1/agents/poe.js';
import { createCVAgent } from './loops/loop1/agents/cv.js';
import { createRQSupervisorAgent } from './loops/loop1/agents/rqsupervisor.js';
import { createEdgarAgent } from './loops/loop1/agents/edgar.js';
import { createNoveltyCheckerAgent } from './loops/loop1/agents/noveltychecker.js';
import { createP53Agent } from './loops/loop1/agents/p53.js';
import { reviewVerdictFromHistory } from './loops/loop1/review.js';
import { rqPacketFolders } from './loops/loop1/rqfolders.js';
import { createExtractor } from './loops/loop1/extraction.js';
import { seedFrameworkRegistry } from './loops/loop1/frameworks.js';
import { frameworkRegistry } from './utils/frameworkregistry.js';
import { createOutputHook } from './loops/loop1/outputhook.js';
import { createLoop2Orchestrator } from './loops/loop2/orchestrator.js';
import { fearlessLeaderAgent } from './agents/loop2/fearlessleader.js';
import { gradStudentPhase } from './agents/loop2/gradphase.js';
import { bookkeeperAgent } from './agents/loop2/bookkeeper.js';
import { salviaAgent } from './agents/loop2/salvia.js';
import { postDocAgent } from './agents/loop2/postdoc.js';
import { p53Agent as loop2P53Agent } from './agents/loop2/p53.js';
import { createPackagerAgent } from './agents/loop2/packager.js';
import { revisionCheck } from './loops/loop2/revisioncheck.js';
import { contradictionSurfacer } from './loops/loop2/contradictions.js';
import { createPoeOverlay } from './components/loop2/poeoverlay.js';
import { mountObservatory } from './components/observatory.js';
import { mountObservatoryFilters } from './components/loop2/observatoryFilters.js';
import { mountClaimCard } from './components/claimCard.js';
import { mountPaperCard } from './components/paperCard.js';
import { mountMatrixRain } from './components/matrixRain.js';
import { session as sessionStore, kg as kgStore } from './utils/storage.js';
import {
  configureDispatcher,
  probe,
  setFailoverOrder,
  setHipaaMode,
  clearCache,
} from './dispatcher/dispatcher.js';
import { createTransports } from './dispatcher/adapters/transports.js';

// ---------------------------------------------------------------------------
// Global error surface. No exception is swallowed silently: anything that
// escapes is rendered into the error boundary with enough context to find it.
// ---------------------------------------------------------------------------
const errorBoundary = document.getElementById('error-boundary');

function surfaceError(label, detail) {
  if (errorBoundary) {
    errorBoundary.hidden = false;
    errorBoundary.textContent = `[ERROR] ${label}: ${detail}`;
  }
}

window.addEventListener('error', (event) => {
  surfaceError('uncaught', event.message || String(event.error));
});

window.addEventListener('unhandledrejection', (event) => {
  surfaceError('unhandled rejection', String(event.reason));
});

function newSessionId() {
  return `S${Date.now().toString(36).toUpperCase()}`;
}

// The provider-priority setting selects which hosted provider leads the failover
// sequence; Mistral always trails. Ollama is reached only via HIPAA enforcement.
function orderFromPriority(primary) {
  return primary === 'groq'
    ? ['groq', 'anthropic', 'mistral']
    : ['anthropic', 'groq', 'mistral'];
}

// ---------------------------------------------------------------------------
// Shell wiring.
// ---------------------------------------------------------------------------
function initShell() {
  const shell = document.getElementById('app');
  const canvas = shell.querySelector('.canvas');
  const canvasTitle = document.getElementById('canvas-title');
  const dashboardRoot = document.getElementById('dashboard-root');
  const conversationRoot = document.getElementById('conversation-root');

  // ----- IO panel: collapse intent resizes the shell grid column -----
  const io = mountIoPanel(document.getElementById('io-root'), {
    onToggleCollapse(collapsed) {
      shell.dataset.ioCollapsed = String(collapsed);
      // The grid column width changes, which resizes the center canvas. The
      // ResizeObserver below picks that up and reflows the canvas content.
    },
  });

  // ----- Loop 1 orchestrator -----
  // Loop 1 owns the Poe conversation mount and the S1 status-copy registry; the
  // orchestrator mounts Poe when Loop 1 is first navigated to (so main.js no
  // longer mounts Poe itself). The RQPacket assembly, session persistence, Loop 2
  // unlock, and the cessation card land in later phases and consume onComplete.
  // Orchestrator errors surface to the global boundary rather than being swallowed.
  // Loop 1 real agents. Poe (conversation tier, Groq-first) surfaces the latest
  // upstream review verdict through the review adapter; CV (extraction tier)
  // scores completeness and routes back to Poe on a fail; RQSupervisor (extraction
  // tier) reviews structure and routes back to Poe when a revision is required;
  // the Novelty Checker (extraction tier) invokes Edgar Allan to retrieve
  // literature, then warns (non-blocking) on low novelty and routes forward to
  // p53. Edgar is wired here as the Novelty Checker's tool, not a separate turn.
  // p53 stays a stub until its phase.
  // Seed the framework registry with the FINAL framework definitions. The content
  // lives only here (looked up client-side, never placed in a prompt); the design ->
  // framework resolution is deterministic.
  seedFrameworkRegistry(frameworkRegistry);
  // Poe's real extractRQPacket: each turn it dispatches on the extraction tier to pull
  // the structured RQPacket from the conversation, resolves the framework from the
  // design (client-side), and versions the packet.
  const poeLoop1Agent = createPoeAgent({
    readReviewVerdict: reviewVerdictFromHistory,
    extractRQPacket: createExtractor(),
  });
  const cvLoop1Agent = createCVAgent();
  const rqSupervisorLoop1Agent = createRQSupervisorAgent();
  const edgarLoop1Agent = createEdgarAgent();
  const noveltyLoop1Agent = createNoveltyCheckerAgent({ edgar: edgarLoop1Agent });
  // p53 (deterministic cessation controller): CEASE emits the completed RQPacket
  // to the Output Hook, which persists it to the session store, unlocks Loop 2 in
  // the navigator, and surfaces the completion card (with the "Proceed to Literature
  // Review" CTA) through Poe. markLoopComplete and navigateToLoop are hoisted
  // function declarations below; the hook captures them and they run at CEASE time.
  const loop1OutputHook = createOutputHook({
    poe,
    storage: { session: sessionStore },
    markLoopComplete,
    onProceed: () => navigateToLoop(2),
    onError: (e) => surfaceError(`loop1 outputHook/${e.step}`, e.message),
  });
  const p53Loop1Agent = createP53Agent({ output: loop1OutputHook });
  // The researcher input surface (a sibling of Poe's feed, mounted in
  // navigateToLoop). The orchestrator drives its enable / confirm / lock state.
  let composer = null;
  // The file-cabinet drawer (the research file): a data view of the live RQPacket,
  // mounted in navigateToLoop. The orchestrator pushes the packet each turn through
  // onPacket; the drawer is not a conversation writer, so TurnGate is untouched.
  let fileCabinet = null;
  const loop1 = createLoop1Orchestrator({
    poe,
    console: io.console,
    // Backstage agents (everyone but Poe) write to the IO panel, not the
    // conversation: their validated packets surface in the Packet Inspector.
    packet: io.packet,
    agents: {
      Poe: poeLoop1Agent,
      CV: cvLoop1Agent,
      RQSupervisor: rqSupervisorLoop1Agent,
      'Novelty Checker': noveltyLoop1Agent,
      p53: p53Loop1Agent,
    },
    // Drive the composer: enable input while Poe waits, surface Confirm only once the
    // latest review passed, lock after cessation.
    onComposer: (statusPatch) => {
      if (composer) composer.setStatus(statusPatch);
    },
    // Each turn, render the latest RQPacket into the file-cabinet drawer.
    onPacket: (rqPacket) => {
      if (fileCabinet) fileCabinet.setFolders(rqPacketFolders(rqPacket));
    },
    onError: (e) => surfaceError(`loop1 ${e.state}/${e.agentId || '-'}`, e.message),
    onComplete: () => {
      // The Output Hook (p53's CEASE) owns persistence, the Loop 2 unlock, and the
      // cessation card; COMPLETE just rests the machine.
    },
  });

  // ----- Per-loop conversation surfaces -----
  // Each loop mounts into its own surface inside the conversation root; navigating
  // shows one and hides the rest, so a loop's state survives a tab away and back and
  // switching loops never leaves a prior loop's conversation on screen. Loop 1
  // registers its mounter here; Loop 2's lands in phase 1.
  function mountLoop1Surface(surface) {
    const feedEl = document.createElement('div');
    feedEl.className = 'conversation-feed';
    const fileCabinetEl = document.createElement('div');
    const composerEl = document.createElement('div');
    // Order top to bottom: Poe's feed, the file-cabinet drawer handle, the composer.
    // The drawer pops up over the feed; the composer stays anchored at the bottom.
    surface.appendChild(feedEl);
    surface.appendChild(fileCabinetEl);
    surface.appendChild(composerEl);

    // The file cabinet is a data view (not a conversation writer); mount it before the
    // orchestrator starts so the first packet update lands.
    fileCabinet = mountFileCabinet(fileCabinetEl);

    loop1.mount(feedEl);
    loop1.start();
    // Seed the drawer with the packet as it stands (placeholders on a fresh run).
    fileCabinet.setFolders(rqPacketFolders(loop1.getSession().rqPacket));

    composer = mountComposer(composerEl, {
      onSubmit: (text) => {
        Promise.resolve(loop1.submit(text)).catch((e) => surfaceError('loop1 submit', e.message));
      },
      onConfirm: () => {
        Promise.resolve(loop1.confirm()).catch((e) => surfaceError('loop1 confirm', e.message));
      },
    });
    composer.setStatus(loop1.composerStatus());
    composer.focus();
  }

  // ----- Loop 2 (The Archive) -----
  // The Loop 2 orchestrator: it inherits the finalized RQPacket from the session store,
  // warms the Loop 2 surface (data-loop=2 on the shell), and runs the nine-agent chain
  // through Poe. Agents are injected stubs in this phase; the real agent logic, the
  // Loop3Input/GlobalKG packaging, the Observatory render, and the streaming wiring land
  // in later phases. Errors surface to the global boundary rather than being swallowed.
  // The Observatory is created per surface (it owns the live cytoscape graph), so the
  // orchestrator's promote callback is a forwarder set when the Loop 2 surface mounts.
  let loop2Promote = null;
  // The Grad Students' progressive claim render seam, forwarded to the Observatory + claim card
  // (set when the Loop 2 surface mounts, like loop2Promote).
  let loop2ClaimRender = null;
  // Loop 2's Poe is a slide-up overlay (not a persistent strip): the Observatory owns the
  // center canvas, and the conversation panel rises on a decision (a contradiction, an RQ
  // revision, the intake gate) and dims the Observatory while up. It wraps the SAME Poe
  // singleton; the orchestrator's existing conversation writes raise it unchanged. The dim
  // target (the per-surface Observatory element) is bound in mountLoop2Surface via setOnToggle.
  const loop2Poe = createPoeOverlay({ poe });
  // The Output Hook (OUTPUT_HOOK): builds the Loop 2 cessation card (the definitive LRSummary + the GlobalKG
  // coverage summary + the collapsible analysis trail) and, on "Proceed to Hypothesis Scrutiny", marks Loop 2
  // complete so the navigator unlocks Loop 3. (markLoopComplete is hoisted; the CTA fires it at click time.)
  // The Loop3Input packet + a Loop 3 surface are a later phase; the GlobalKG + LRSummary + escalations persist for it.
  const loop2Packager = createPackagerAgent({ onProceed: () => markLoopComplete(2) });
  const loop2 = createLoop2Orchestrator({
    poe: loop2Poe,
    console: io.console,
    packet: io.packet,
    // kg is injected so the Bookkeeper's BOOKKEEPER_STAGE can persist SubspecializationKGs to
    // IndexedDB (the orchestrator threads `storage` into each agent step's ctx).
    storage: { session: sessionStore, kg: kgStore },
    root: shell,
    // Real Loop 2 agents wired so far: Fearless Leader plans the subspecialization sweep at
    // FEARLESS_LEADER; the Grad Students coordinator runs Edgar + a Grad Student + the Senior Grad
    // Student quality review per subspecialization at PHASE_1 (PHASE_2, the cross-subspecialization
    // GeneralKG synthesis, stays a pass-through); the Bookkeeper stages each subspecialization's
    // surviving claims into a SubspecializationKG (-> IndexedDB) and emits its node at BOOKKEEPER_STAGE,
    // then at BOOKKEEPER_PROMOTE merges the staged KGs into the GlobalKG (dedup + contradiction tags ->
    // IndexedDB) and emits the unified-view contradicts edges; Salvia surveys the staged KGs + RQPacket
    // for uncertainty at UNKNOWN_FIELD_SURFACING (its result feeds the stubbed p53). Revision Check
    // runs Skips (the cross-subspecialization analyst) at RQ_REVISION_CHECK and routes (unknown fields
    // -> a Fearless Leader re-sweep; else forward); at MATERIAL_CONTRADICTIONS Poe surfaces each of Skips'
    // contradictions (with the paper sources on both sides) for the researcher to mark resolved/unresolved/
    // escalated, pausing per decision - escalations are tagged into the GlobalKG and stashed on the session
    // for the Loop3Input packet. p53 evaluates the cessation conditions at P53_EVALUATE
    // (CEASE -> POSTDOC_FINAL; CONTINUE -> another PHASE_1 round, bounded by the iteration cap;
    // MAX_REACHED -> the reasons surface through Poe's overlay, then PAUSED until the researcher
    // acknowledges). Post-Doc runs the STANDARD synthesis pass at POSTDOC_STANDARD (drafting the LRSummary)
    // and the FINAL pass at POSTDOC_FINAL (the definitive LRSummary onto the session; its card is not raised
    // here - the cessation card is the single surface). The Packager builds the cessation card at OUTPUT_HOOK
    // (the LRSummary + the GlobalKG coverage summary + the real-time analysis trail + a Proceed CTA that marks
    // Loop 2 complete). The Loop3Input packet schema + a Loop 3 surface stay deferred.
    agents: {
      'Fearless Leader': fearlessLeaderAgent,
      'Grad Students': gradStudentPhase,
      Bookkeeper: bookkeeperAgent,
      Salvia: salviaAgent,
      'Post-Doc': postDocAgent,
      'Revision Check': revisionCheck,
      Poe: contradictionSurfacer,
      p53: loop2P53Agent,
      Packager: loop2Packager,
    },
    onError: (e) => surfaceError(`loop2 ${e.state}/${e.agentId || '-'}`, e.message),
    // Bookkeeper promotions feed the Observatory incrementally (set in mountLoop2Surface). The
    // scope ('subspecialization' | 'global') is threaded so the handler can wire claim edges.
    onPromote: (nodes, edges, meta) => {
      if (loop2Promote) loop2Promote(nodes, edges, meta);
    },
    // Grad Student claim streaming drives progressive render (set in mountLoop2Surface).
    onClaimRender: (event) => {
      if (loop2ClaimRender) loop2ClaimRender(event);
    },
    // Each unknown-field re-sweep: surface the iteration count in the IO panel (the debug-trace
    // footer). The Phase-19 analysis trail will subscribe to this same seam (one entry per
    // iteration, with the targeted fields); for now the count is the user-visible signal.
    onIteration: (info) => {
      io.setTrace({ resweep: `${info.iteration}/${info.max}` });
    },
    // The researcher chose to REVISE the RQ at RQ_REVISION_CHECK: record the revision context on the
    // app session and navigate back to Loop 1. The GlobalKG is already in IndexedDB (and rides in the
    // context), so Loop 1 can re-plan with the evidence as context; the orchestrator leaves Loop 2 paused.
    onReviseRQ: (context) => {
      if (session) {
        session.rqRevision = { reasons: (context && context.reasons) || [], at: Date.now() };
        fanSession();
      }
      navigateToLoop(1);
    },
  });


  // The Loop 2 surface: the Cytoscape Observatory fills the center canvas; the conversation
  // is the slide-up Poe overlay (loop2Poe), anchored to the surface bottom and raised on a
  // decision. Entering Loop 2 plays the green Matrix transition, then mounts the orchestrator
  // (data-loop=2 + the inherited RQPacket) and runs the chain.
  function mountLoop2Surface(surface) {
    surface.classList.add('loop2-surface');
    // The center canvas is a flex row (the stage): a left filter rail beside the Observatory. Poe stays
    // the absolute slide-up overlay anchored to the surface bottom, spanning the stage (shell.css).
    const stage = document.createElement('div');
    stage.className = 'observatory-stage';
    const filtersEl = document.createElement('div');
    const observatoryEl = document.createElement('div');
    stage.appendChild(filtersEl);
    stage.appendChild(observatoryEl);
    surface.appendChild(stage);

    // The Observatory: clicking a node shows its detail in the IO Packet inspector.
    const observatory = mountObservatory(observatoryEl, {
      onNodeClick: (node) => {
        if (!node) return;
        io.packet.setPacket(node);
        io.setActiveTab('packet');
      },
    });

    // The filter rail: the view toggle drives the Observatory's view (per-subspecialization sub-graphs
    // vs the unified GlobalKG); the facets filter the Observatory's in-memory model (no IndexedDB
    // re-fetch). Facet options accumulate from the streamed claims + the promoted GlobalKG.
    const filters = mountObservatoryFilters(filtersEl, {
      onViewChange: (view) => observatory.setView(view),
      onFilterChange: (state) => observatory.setFilter(state),
    });

    // Accumulated facet options (the union of what the graph has shown). Pushed to the panel on
    // meaningful boundaries (a claim settles, a subspecialization stages, the GlobalKG promotes).
    const facetState = { subspecs: new Map(), claimTypes: new Set(), confidences: new Set(), qualityFlags: new Set() };
    function refreshFacets() {
      filters.setFacets({
        subspecializations: [...facetState.subspecs].map(([id, label]) => ({ id, label })),
        claimTypes: [...facetState.claimTypes],
        confidences: [...facetState.confidences],
        qualityFlags: [...facetState.qualityFlags],
      });
    }
    function noteClaimFacets(d) {
      if (typeof d.subspecialization_id === 'string' && !facetState.subspecs.has(d.subspecialization_id)) {
        facetState.subspecs.set(d.subspecialization_id, d.subspecialization_id);
      }
      (Array.isArray(d.claim_type) ? d.claim_type : []).forEach((t) => facetState.claimTypes.add(t));
      facetState.confidences.add(d.confidence == null ? 'unassigned' : String(d.confidence));
      facetState.qualityFlags.add(d.quality === 'flag' || d.review === 'flag' ? 'flag' : d.quality === 'pass' ? 'pass' : 'none');
    }

    // The progressive claim card lives in the IO panel's claims tab.
    const claimCard = mountClaimCard(io.claims);
    let claimsTabShown = false;

    // The paper detail card (IO panel [PAPER] tab) + an in-memory DOI -> record index built from the
    // streamed claim events (see loop2ClaimRender). Clicking a citation chip on the Post-Doc's LRSummary
    // card resolves the DOI here and opens the paper's abstract + retrieval metadata. Session-scoped: the
    // card is reviewed in the same run; durable persistence is the OUTPUT_HOOK phase's concern.
    const paperCard = mountPaperCard(io.paper);
    const papersIndex = new Map();
    poe.setOnCitation((doi) => {
      const record = papersIndex.get(doi) || { doi, title: doi, source: 'unknown', abstract: '' };
      paperCard.open(record);
      io.setActiveTab('paper');
    });

    // Maps a (subspecialization, claim_id) to the Observatory node id(s) the Grad Students rendered
    // for it, so a later Senior-review verdict (which carries only the claim_id, not the namespaced
    // node id) can find and update the right node(s). Built from open/settled events, which carry
    // both the node id and the subspecialization + claim id.
    const claimNodeIndex = new Map();
    const indexKey = (subspecializationId, claimId) => `${subspecializationId}::${claimId}`;
    function registerNode(event) {
      const claimId = event.claim && event.claim.claim_id;
      if (!event.subspecializationId || !claimId || !event.nodeId) return;
      const key = indexKey(event.subspecializationId, claimId);
      let ids = claimNodeIndex.get(key);
      if (!ids) {
        ids = new Set();
        claimNodeIndex.set(key, ids);
      }
      ids.add(event.nodeId);
    }

    // Route Bookkeeper promotions to the Observatory (incremental render). The Bookkeeper emits the
    // subspecialization node; for a 'subspecialization'-scope promotion we wire derived-from edges
    // from that subspecialization's already-streamed claim nodes (the claimNodeIndex) to it, so the
    // staged KG reads as a connected subgraph without the agent knowing render node ids.
    loop2Promote = (nodes, edges, meta) => {
      const scope = meta && meta.scope;
      // Bookkeeper Phase 2 (BOOKKEEPER_PROMOTE, scope 'global'): the unified GlobalKG view. The agent now
      // emits the real global nodes (ids == global_claim_id / gsub::<id>) plus the derived-from and
      // contradicts edges between them, so they add directly (the contradicts endpoints are real nodes -
      // no claimNodeIndex resolution). Then populate the facets from the global claims and auto-switch to
      // the unified view (the GlobalKG "final state"); the toggle returns to the per-subspecialization view.
      if (scope === 'global') {
        observatory.addElements({ nodes: nodes || [], edges: edges || [] });
        (nodes || []).forEach((node) => {
          const d = (node && node.data) || {};
          if (d.type === 'claim') noteClaimFacets(d);
        });
        refreshFacets();
        observatory.setView('global');
        filters.setView('global');
        return;
      }
      observatory.addElements({ nodes: nodes || [], edges: edges || [] });
      if (scope !== 'subspecialization') return;
      (nodes || []).forEach((node) => {
        const subspecId = node && node.data && node.data.type === 'subspecialization' ? node.data.id : null;
        if (!subspecId) return;
        // Seed the subspecialization facet with this staged subspecialization (its label, if any).
        facetState.subspecs.set(subspecId, (node.data.label) || subspecId);
        const claimEdges = [];
        const prefix = `${subspecId}::`;
        claimNodeIndex.forEach((ids, key) => {
          if (!key.startsWith(prefix)) return;
          ids.forEach((claimNodeId) => {
            claimEdges.push({
              data: { id: `df-sub::${claimNodeId}`, source: claimNodeId, target: subspecId, type: 'derived-from' },
            });
          });
        });
        if (claimEdges.length) observatory.addElements({ nodes: [], edges: claimEdges });
      });
      refreshFacets();
    };

    // Ensure a claim's node + its source-paper node + a derived-from edge exist (idempotent;
    // addElements dedups), so a settled claim that never streamed an open still renders.
    function ensureClaimNodes(event, state) {
      const label = (event.claim && event.claim.text) || (event.claim && event.claim.claim_id) || 'claim';
      const paperNodeId = `paper::${event.paperId}`;
      // Carry the subspecialization id (+ any claim types) onto the streamed claim node so the filter
      // panel can isolate a subspecialization's sub-graph in the per-subspecialization view.
      const claimType = event.claim && Array.isArray(event.claim.claim_type) ? event.claim.claim_type : [];
      observatory.addElements({
        nodes: [
          { data: { id: event.nodeId, type: 'claim', label, state, subspecialization_id: event.subspecializationId, claim_type: claimType } },
          { data: { id: paperNodeId, type: 'paper', label: event.paperId || 'paper' } },
        ],
        edges: event.paperId
          ? [{ data: { id: `df::${event.nodeId}`, source: event.nodeId, target: paperNodeId, type: 'derived-from' } }]
          : [],
      });
    }

    // Apply a Senior Grad Student verdict to the IO panel: a reject drops the claim's node(s) (the
    // claim left the KG), a flag marks them with the amber quality ring, a pass leaves them; the
    // verdict is always logged in the claim card's SENIOR_REVIEW tally. Backstage only.
    function handleReview(event) {
      const key = indexKey(event.subspecializationId, event.claimId);
      const ids = claimNodeIndex.get(key);
      if (event.quality === 'reject') {
        if (ids) ids.forEach((id) => observatory.removeElements([id, `df::${id}`]));
        claimNodeIndex.delete(key);
      } else if (ids) {
        ids.forEach((id) => observatory.setNodeData(id, { review: event.quality }));
      }
      // Surface the quality bucket in the filter panel (flag/pass; a reject left the graph).
      if (event.quality === 'flag' || event.quality === 'pass') {
        facetState.qualityFlags.add(event.quality);
        refreshFacets();
      }
      claimCard.review({ quality: event.quality, claimId: event.claimId, reason: event.reason });
    }

    // Drive progressive render from the Grad Students' claim stream. open -> loading node + card;
    // field -> card fill (+ node label on text); settled -> node state + card lock; review ->
    // Senior-review verdict applied (drop / flag / log).
    loop2ClaimRender = (event) => {
      if (!event) return;
      // Index the source paper record (DOI -> record) for the Post-Doc final pass's clickable chips.
      if (event.paper && typeof event.paper === 'object' && event.paper.doi) {
        papersIndex.set(event.paper.doi, event.paper);
      }
      if (event.type === 'review') {
        handleReview(event);
        return;
      }
      if (!event.nodeId) return;
      const STATE_BY_STATUS = { valid: 'confirmed', flagged: 'flagged', rejected: 'rejected' };
      if (event.type === 'open') {
        registerNode(event);
        ensureClaimNodes(event, 'loading');
        if (!claimsTabShown) {
          io.setActiveTab('claims');
          claimsTabShown = true;
        }
        claimCard.open(event.claim || {});
      } else if (event.type === 'field') {
        if (event.key === 'text' && typeof event.value === 'string') {
          observatory.setNodeData(event.nodeId, { label: event.value });
        }
        claimCard.fill(event.key, event.value);
      } else if (event.type === 'settled') {
        registerNode(event);
        ensureClaimNodes(event, 'loading');
        observatory.setNodeData(event.nodeId, { state: STATE_BY_STATUS[event.status] || 'parsed' });
        claimCard.settle(event.status, { reasons: event.reasons });
        noteClaimFacets({ subspecialization_id: event.subspecializationId, claim_type: (event.claim && event.claim.claim_type) || [], confidence: null });
        refreshFacets();
      }
    };

    // Dim the Observatory to 50% while the Poe overlay is raised, restore it when the
    // researcher dismisses (cross-component coordination, owned here). The dim class +
    // its transition live with the loop surface in shell.css.
    loop2Poe.setOnToggle((open) => {
      observatoryEl.classList.toggle('observatory-dimmed', open);
    });

    // Play the Digital Rain transition over the whole surface, then remove it.
    const rain = mountMatrixRain(surface);
    Promise.resolve(rain.play(1500)).then(() => rain.destroy()).catch(() => rain.destroy());

    // The orchestrator mounts Poe (the slide-up overlay) into the surface, inherits the RQPacket,
    // and warms data-loop=2. The Observatory renders only real elements: claim/paper nodes stream
    // in during PHASE_1, subspecialization nodes (+ their claim edges) land when the Bookkeeper
    // stages at BOOKKEEPER_STAGE. The conversation panel rises on the intake gate, then lowers as
    // the autonomous sweep begins, rising again at MATERIAL_CONTRADICTIONS.
    Promise.resolve(loop2.mount(surface, { root: shell }))
      .then(() => loop2.start())
      .catch((e) => surfaceError('loop2 mount', e.message));
  }

  const loopSurfaces = conversationRoot
    ? createLoopSurfaces({
        root: conversationRoot,
        mounters: { 1: mountLoop1Surface, 2: mountLoop2Surface },
      })
    : null;

  // ----- Session + view state -----
  // main.js holds the current session in memory and injects it into the
  // dashboard and the navigator (which hold none of their own). The session here
  // carries only the presentation fields those components read; the rich session
  // schema and loop completion are owned by the orchestrator (later phases), so
  // completedLoops stays empty in this build and only Loop 1 ever unlocks. The
  // function declarations are hoisted, so the component callbacks can reference
  // them; they run only after the mounts below have assigned sidebar/dashboard.
  let session = null;

  function fanSession() {
    dashboard.setSession(session);
    sidebar.setSession(session);
  }

  function showLanding() {
    if (canvasTitle) canvasTitle.hidden = true;
    if (dashboardRoot) dashboardRoot.hidden = false;
    if (conversationRoot) conversationRoot.hidden = true;
  }

  // Mark a loop complete so the navigator unlocks the next one (a loop unlocks when
  // its predecessor is in completedLoops). The Output Hook calls this at CEASE; the
  // change fans out to the sidebar navigator and the dashboard.
  function markLoopComplete(n) {
    if (!session) return;
    const loop = Number(n);
    if (!Array.isArray(session.completedLoops)) session.completedLoops = [];
    if (!session.completedLoops.includes(loop)) session.completedLoops.push(loop);
    session.lastActiveAt = Date.now();
    fanSession();
  }

  function navigateToLoop(loop) {
    const n = Number(loop);
    if (session) {
      session.currentLoop = n;
      session.lastActiveAt = Date.now();
      fanSession();
    }
    sidebar.setActiveLoop(n);
    shell.dataset.loop = String(n);
    if (canvasTitle) {
      canvasTitle.hidden = false;
      canvasTitle.textContent = `LOOP ${n}`;
    }
    if (dashboardRoot) dashboardRoot.hidden = true;
    if (conversationRoot) conversationRoot.hidden = false;
    // Reveal the target loop's surface (mounting it the first time), hiding the others.
    // Loop 1 mounts its orchestrator (Poe's feed + the composer + the file-cabinet
    // drawer); a loop with no registered mounter shows an empty surface until its phase
    // wires one. This is the only loop-switch teardown point: no prior loop's
    // conversation is ever left on screen.
    if (loopSurfaces) loopSurfaces.show(n);
  }

  function startNewSession() {
    const id = newSessionId();
    // Minimal placeholder session: only the presentation fields the dashboard
    // and navigator read. The orchestrator owns and extends the real schema.
    session = {
      id,
      researchQuestion: null,
      currentLoop: null,
      completedLoops: [],
      lastActiveAt: Date.now(),
    };
    fanSession();
    sidebar.setSessionId(id);
    sidebar.setSessionStatus('idle');
    io.setTrace({ session: id, retries: 0, fallback: 'none', cache: 'cold' });
    io.console.clear();
    io.packet.clear();
    if (loopSurfaces) loopSurfaces.teardown(); // a fresh session re-mounts loops on next nav
    showLanding();
  }

  function clearSession() {
    session = null;
    fanSession();
    sidebar.setSessionId('S?');
    sidebar.setSessionStatus('idle');
    io.setTrace({ session: 'S?', retries: 0, fallback: 'none', cache: 'cold' });
    io.console.clear();
    io.packet.clear();
    if (loopSurfaces) loopSurfaces.teardown(); // a cleared session re-mounts loops on next nav
    showLanding();
  }

  // ----- Sidebar: brand, delegated loop nav, session lifecycle, settings -----
  const sidebar = mountSidebar(document.getElementById('sidebar-root'), {
    activeLoop: 1,
    onSelectLoop: navigateToLoop,
    onNewSession: startNewSession,
    onClearSession: clearSession,
    onSettings() {
      settings.open();
    },
  });

  // ----- Dashboard: the landing view (Begin launches Loop 1) -----
  const dashboard = mountDashboard(dashboardRoot, {
    onBegin() {
      navigateToLoop(1);
    },
  });

  // Initial paint: no session yet, landing visible, only Loop 1 unlocked.
  fanSession();
  showLanding();

  // ----- Dispatcher event wiring -----
  // The dispatcher stays UI-agnostic. Its events drive two things: the waiting-game
  // lifecycle, and a DEV log. They do NOT go to the agent console: the IO panel's
  // Agent Console surfaces agent-level activity only (CV pass/fail, RQSupervisor
  // verdict, p53 state), driven by the orchestrator through Poe's setStatus/settle.
  // Dispatcher/transport detail (failover, cache, provider rejections) belongs in a
  // dev log, so it goes to console.debug. The compact dispatcher status (model,
  // retries, fallback, cache) still shows in the debug-trace footer via onTrace.
  function logDispatch(event) {
    // Drive the waiting game from the API-call lifecycle. dispatch:start arms the
    // threshold; any terminal event disarms and hides it. hipaa:enforced is treated
    // as terminal for the game, so it never appears during HIPAA calls. A 4xx
    // (dispatch:request_error) is NOT terminal: it fails over to the next provider.
    if (event.type === 'dispatch:start') {
      mousekatool.start();
    } else if (
      event.type === 'hipaa:enforced' ||
      event.type === 'cache:hit' ||
      event.type === 'dispatch:success' ||
      event.type === 'providers:exhausted' ||
      event.type === 'validate:safe_default'
    ) {
      mousekatool.stop();
    }

    // Feed the reliability spine's fallback events into Loop 2's analysis trail while Loop 2 is the active
    // loop (the dispatcher logger is app-wide; the active-loop gate keeps Loop 1's dispatches out of the
    // Loop 2 trail). noteFallback filters to the fallback event types and ignores the rest.
    if (session && session.currentLoop === 2 && typeof loop2.noteFallback === 'function') {
      loop2.noteFallback(event);
    }

    // Dev log only (browser console), never the user-facing agent console.
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug('[dispatch]', event.type, event);
    }
  }

  // Apply persisted settings (provider priority + global HIPAA mode) when the
  // dispatcher is configured. Keys and the Ollama endpoint are persisted by the
  // settings modal and consumed once real fetch is wired per adapter.
  const persisted = loadSettings();

  // ----- Mousekatool: the waiting game for long API calls -----
  // Driven by the dispatch lifecycle in logDispatch. Disabled under global HIPAA
  // mode (Ollama calls are local and fast); the per-call hipaa:enforced event
  // also stops it. The threshold is configurable in settings.
  const mousekatool = mountMousekatool(document.getElementById('mousekatool-root'), {
    threshold: (persisted.mousekatoolThreshold ?? 4) * 1000,
  });
  mousekatool.setEnabled(!persisted.hipaa);

  configureDispatcher({
    logger: logDispatch,
    onTrace: (patch) => io.setTrace(patch),
    failoverSequence: orderFromPriority(persisted.priority),
    hipaaMode: persisted.hipaa,
    // Real fetch() transports per provider. Each pulls its API key (or the Ollama
    // endpoint) from settings/localStorage at call time and fires the live request,
    // so an unkeyed provider fails over and a keyed one gets a real model response
    // instead of the safe-default string.
    transports: createTransports(),
  });

  // ----- Settings modal: opens from the sidebar settings button -----
  // The modal reports dispatcher-affecting intent; main.js applies it through the
  // dispatcher's live config and diagnostics (probe, order, HIPAA, cache clear)
  // and the Mousekatool threshold and HIPAA suppression.
  const settings = mountSettings(document.getElementById('settings-root'), {
    onTestConnection: (provider) => probe(provider),
    onPriorityChange: (primary) => setFailoverOrder(orderFromPriority(primary)),
    onHipaaChange: (on) => {
      setHipaaMode(on);
      mousekatool.setEnabled(!on);
    },
    onClearCache: () => clearCache(),
    onThresholdChange: (seconds) => mousekatool.setThreshold(seconds * 1000),
  });

  // ----- Poe: the conversation layer (TurnGate owner) -----
  // Poe owns the conversation DOM exclusively and is now mounted by the Loop 1
  // orchestrator with the loop's own status-copy registry (see navigateToLoop),
  // not here: main.js never holds or writes a conversation node. The orchestrator
  // keeps only Poe's method API.

  // ----- Center canvas reflow via ResizeObserver -----
  function reflowCanvas(width, height) {
    const w = Math.round(width);
    const h = Math.round(height);
    canvas.dataset.width = String(w);
    canvas.dataset.height = String(h);
    // The size readout lives in the IO debug footer (telemetry), not on the canvas.
    io.setTrace({ canvas: `${w} x ${h}` });
    // Broadcast the new size so loop content (added later) can re-layout when
    // the IO panel collapses or expands.
    canvas.dispatchEvent(
      new CustomEvent('canvas:resize', {
        bubbles: true,
        detail: { width: w, height: h },
      }),
    );
  }

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.contentRect;
        reflowCanvas(box.width, box.height);
      }
    });
    observer.observe(canvas);
  } else {
    // Non-browser environments (jsdom in tests) lack ResizeObserver. Measure
    // once so the readout is not stale, and warn rather than swallow.
    const rect = canvas.getBoundingClientRect();
    reflowCanvas(rect.width, rect.height);
    console.warn('[shell] ResizeObserver unavailable; canvas reflow is static.');
  }
}

try {
  initShell();
} catch (err) {
  surfaceError('shell init failed', err && err.message ? err.message : String(err));
  throw err; // never swallow
}
