import './poeoverlay.css';
import { poe as defaultPoe } from '../poe.js';

// Loop 2 Poe overlay panel.
//
// In Loop 2 the Observatory owns the center canvas, so Poe does NOT sit in a
// persistent conversation strip. The conversation surface is instead a panel that
// slides up from the bottom of the surface ON DEMAND: when the orchestrator needs
// the researcher to make a decision (review a contradiction Skips surfaced), when
// an RQ revision is required, or when the researcher initiates a conversation.
// While the panel is up the Observatory dims to 50% opacity; the researcher can
// dismiss the panel to return to the full graph.
//
// This is NOT a second conversation writer (the TurnGate rule). It mounts the SAME
// S0 Poe component (createPoe() / the singleton) into the panel feed - "the same
// Poe in a different mount configuration". Every conversation write still goes
// through that one Poe; the overlay only wraps it in the slide-up chrome and
// forwards the Poe method API. A conversation WRITE (receive / milestoneCard /
// userTurn / cessationCard) raises the panel - this is the orchestrator's documented
// `poe.showOverlay(packet)` trigger, reached through the same render path - while a
// backstage/streaming signal (setStatus / settle / stream / showThinking) passes
// through WITHOUT raising it, so an autonomous agent turn leaves the Observatory in
// full view.
//
// The Observatory dim is decoupled (main.js owns cross-component coordination): the
// overlay fires an injected onToggle(open) on every open/close edge and main.js dims
// the Observatory element. The overlay owns no loop logic and no schema (the
// Autonomy Charter): it reads only `packet.agentId` to route a render to Poe.

const DISMISS_LABEL = 'Dismiss';
const PANEL_TITLE = 'Conversation';

export function createPoeOverlay({ poe = defaultPoe } = {}) {
  let host = null;
  let panel = null;
  let feedEl = null;
  let dismissBtn = null;
  let open = false;
  let onToggle = () => {};

  function ensureMounted(method) {
    if (!panel) throw new Error(`poeOverlay.${method}: call mount(target) first`);
  }

  // Reflect the open/closed state onto the panel DOM (drives the CSS slide) and fire
  // onToggle on a REAL edge only, so an idempotent showOverlay()/hideOverlay() never
  // re-dims (the Observatory dim toggle stays in sync with one transition per edge).
  function setOpen(next) {
    if (!panel || open === next) return;
    open = next;
    panel.dataset.state = open ? 'open' : 'closed';
    panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    try {
      onToggle(open);
    } catch (_err) {
      // The dim is best-effort presentation; never break the conversation on it.
    }
  }

  // Raise the panel, optionally rendering a packet first (the orchestrator's
  // documented trigger: poe.showOverlay(packet)). A packet without an agentId is
  // treated as a bare "raise" with no render (Poe owns attribution).
  function showOverlay(packet) {
    ensureMounted('showOverlay');
    if (packet && typeof packet === 'object' && packet.agentId) {
      poe.receive(packet);
    }
    setOpen(true);
    return api;
  }

  function hideOverlay() {
    ensureMounted('hideOverlay');
    setOpen(false);
    return api;
  }

  function setOnToggle(fn) {
    onToggle = typeof fn === 'function' ? fn : () => {};
    return api;
  }

  // ----- Poe method delegation -----
  // A conversation WRITE raises the panel (the moment the researcher's attention is
  // wanted); a backstage/streaming signal passes through silently.
  function writeThenRaise(method) {
    return (...args) => {
      const out = poe[method](...args);
      setOpen(true);
      return out;
    };
  }
  function passthrough(method) {
    return (...args) => poe[method](...args);
  }

  function mount(target, opts = {}) {
    if (!target) throw new Error('poeOverlay.mount: target is required');
    host = target;
    open = false;
    if (typeof opts.onToggle === 'function') onToggle = opts.onToggle;

    host.classList.add('poe-overlay-host');

    panel = document.createElement('div');
    panel.className = 'poe-overlay';
    panel.dataset.state = 'closed';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Researcher conversation');
    panel.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'poe-overlay-header';
    const title = document.createElement('span');
    title.className = 'poe-overlay-title';
    title.textContent = PANEL_TITLE;
    dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'poe-overlay-dismiss';
    dismissBtn.textContent = DISMISS_LABEL;
    dismissBtn.setAttribute('aria-label', 'Dismiss conversation');
    dismissBtn.addEventListener('click', () => hideOverlay());
    header.appendChild(title);
    header.appendChild(dismissBtn);

    feedEl = document.createElement('div');
    feedEl.className = 'poe-overlay-feed';

    panel.appendChild(header);
    panel.appendChild(feedEl);
    host.appendChild(panel);

    // Escape dismisses the panel (keyboard parity with the dismiss button).
    panel.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        hideOverlay();
      }
    });

    // Mount the S0 Poe into the panel feed: the one conversation writer, in a
    // different mount configuration. The loop registry, the agent console, and the
    // (test) measure injection flow through unchanged.
    poe.mount(feedEl, { registry: opts.registry, console: opts.console, measure: opts.measure });

    return api;
  }

  const api = {
    mount,
    // ----- overlay controls -----
    showOverlay,
    hideOverlay,
    dismiss: hideOverlay,
    isOpen: () => open,
    setOnToggle,
    // ----- Poe conversation writes raise the panel -----
    receive: writeThenRaise('receive'),
    milestoneCard: writeThenRaise('milestoneCard'),
    cessationCard: writeThenRaise('cessationCard'),
    userTurn: writeThenRaise('userTurn'),
    // ----- backstage / streaming signals pass through (no raise) -----
    setStatus: passthrough('setStatus'),
    settle: passthrough('settle'),
    stream: passthrough('stream'),
    showThinking: passthrough('showThinking'),
  };
  return api;
}

// Default app singleton: wraps the Poe singleton. main.js wires setOnToggle to the
// Observatory dim and hands this to the Loop 2 orchestrator as its `poe`, so the
// orchestrator's existing conversation writes raise the slide-up panel unchanged.
export const poeOverlay = createPoeOverlay();
