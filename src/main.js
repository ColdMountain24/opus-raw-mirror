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
import { session as sessionStore } from './utils/storage.js';
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
  let loop1Mounted = false;

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
    // Loop 1 has an orchestrator: mount it into the conversation surface and run the
    // intake turn the first time the loop is shown. Poe owns the feed; the composer
    // (the researcher input) is a sibling surface below it, per the TurnGate rule.
    // Other loops have no orchestrator yet, so they reveal the conversation only.
    if (n === 1 && !loop1Mounted && conversationRoot) {
      conversationRoot.innerHTML = '';
      const feedEl = document.createElement('div');
      feedEl.className = 'conversation-feed';
      const fileCabinetEl = document.createElement('div');
      const composerEl = document.createElement('div');
      // Order top to bottom: Poe's feed, the file-cabinet drawer handle, the composer.
      // The drawer pops up over the feed; the composer stays anchored at the bottom.
      conversationRoot.appendChild(feedEl);
      conversationRoot.appendChild(fileCabinetEl);
      conversationRoot.appendChild(composerEl);

      // The file cabinet is a data view (not a conversation writer); mount it before
      // the orchestrator starts so the first packet update lands.
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
      loop1Mounted = true;
    }
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
    loop1Mounted = false; // a fresh/cleared session re-mounts Loop 1 on next nav
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
    loop1Mounted = false; // a fresh/cleared session re-mounts Loop 1 on next nav
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
