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
import { mountSidebar } from './components/sidebar.js';
import { mountIoPanel } from './components/ioPanel.js';
import { mountDashboard } from './components/dashboard.js';
import { mountSettings, loadSettings } from './components/settings.js';
import { mountMousekatool } from './components/mousekatool.js';
import { poe } from './components/poe.js';
import {
  configureDispatcher,
  probe,
  setFailoverOrder,
  setHipaaMode,
  clearCache,
} from './dispatcher/dispatcher.js';

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
  const canvasDims = document.getElementById('canvas-dims');
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
    // The loop orchestrator mounts into the canvas here in a later phase; this
    // build only switches the landing view to the (empty) conversation surface.
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
  // The dispatcher stays UI-agnostic: it emits events that we map to the agent
  // console and the debug trace footer. No live dispatch runs in this build;
  // loops drive calls in later phases. The trace patch keys (model, retries,
  // fallback, cache) line up with the debug fields, so onTrace is io.setTrace.
  function logDispatch(event) {
    // Drive the waiting game from the API-call lifecycle. dispatch:start arms the
    // threshold; any terminal event disarms and hides it. hipaa:enforced is
    // treated as terminal for the game, so it never appears during HIPAA calls.
    if (event.type === 'dispatch:start') {
      mousekatool.start();
    } else if (
      event.type === 'hipaa:enforced' ||
      event.type === 'cache:hit' ||
      event.type === 'dispatch:success' ||
      event.type === 'providers:exhausted' ||
      event.type === 'dispatch:request_error' ||
      event.type === 'validate:safe_default'
    ) {
      mousekatool.stop();
    }

    const stateByTransition = { OPEN: 'error', CLOSED: 'done', HALF_OPEN: 'pending' };
    let entry;
    switch (event.type) {
      case 'hipaa:enforced':
        entry = ['HIPAA', 'HIPAA session. routing to ollama only.', 'running'];
        break;
      case 'cache:hit':
        entry = ['CACHE', 'hit. cached output returned, no call made.', 'done'];
        break;
      case 'cache:error':
        entry = ['CACHE', `storage ${event.op} failed.`, 'error'];
        break;
      case 'circuit:transition':
        entry = [
          'CIRCUIT',
          `${event.provider}: ${event.from} to ${event.to}.`,
          stateByTransition[event.to] || 'pending',
        ];
        break;
      case 'failover:skip':
        entry = ['FAILOVER', `${event.provider} circuit open. skipping.`, 'pending'];
        break;
      case 'failover:next':
        entry = ['FAILOVER', `${event.from} unavailable. failing over.`, 'pending'];
        break;
      case 'validate:safe_default':
        entry = ['DISPATCHER', 'output failed schema twice. using safe default.', 'error'];
        break;
      case 'providers:exhausted':
        entry = ['DISPATCHER', 'all providers unavailable. returning safe default.', 'error'];
        break;
      case 'dispatch:request_error':
        entry = ['DISPATCHER', `request rejected (${event.status}). not retried.`, 'error'];
        break;
      case 'dispatch:success':
        entry = ['DISPATCHER', `completed via ${event.provider}.`, 'done'];
        break;
      default:
        return; // start/validate:fail and others are not surfaced to the console
    }
    io.console.pushEntry({ agent: entry[0], message: entry[1], state: entry[2] });
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
  // Poe owns the conversation DOM exclusively. main.js passes the mount target
  // and the agent-console API, then keeps only Poe's method API; it never holds
  // or writes a conversation node. The per-loop status copy registry is built by
  // loops in later phases; an empty registry renders the idle conversation shell.
  // No live turns run in this build.
  poe.mount(conversationRoot, {
    console: io.console,
    registry: {},
  });

  // ----- Center canvas reflow via ResizeObserver -----
  function reflowCanvas(width, height) {
    const w = Math.round(width);
    const h = Math.round(height);
    canvas.dataset.width = String(w);
    canvas.dataset.height = String(h);
    if (canvasDims) {
      canvasDims.textContent = `${w} x ${h}`;
    }
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
