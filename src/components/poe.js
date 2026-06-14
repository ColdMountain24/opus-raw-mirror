import './poe.css';
import { mathToFragment } from '../utils/mathtext.js';

// Poe: the conversation component. Poe is the only agent that writes to the
// conversation layer (the TurnGate rule). This is enforced structurally, not by
// convention: the conversation DOM is created and held entirely inside this
// closure, the returned API exposes methods only (never a node), and Poe renders
// its own progress indicator rather than reaching into any shell DOM. No other
// module has a reference to the conversation.
//
// Streaming and validation are decoupled. While an agent runs, the orchestrator
// streams raw prose to Poe through stream() for perceived speed; it advances only
// once it holds a full, validated packet, which it hands to receive(). Poe never
// sees a partial parse: stream() carries unvalidated text, receive() carries the
// final validated render that replaces it.
//
// Poe owns no packet schema and no status copy (Autonomy Charter). It reads a
// small, documented set of presentation fields defensively and resolves status
// text from the per-loop registry injected at mount.
//
// The instance is built by createPoe(); a default singleton `poe` is exported for
// the app. Each loop calls mount(target, { registry }) with its own registry.

const DEFAULT_EMPTY = 'conversation idle. No turn in progress.';
const THINKING_LABEL = 'Show reasoning';

function defaultMeasure(el) {
  // Real layout in the browser; tests inject a measure() because jsdom has no
  // layout (the same dependency-injection rationale as the dispatcher clock).
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
}

export function createPoe() {
  // ----- conversation DOM, owned here and never exposed -----
  let root = null;
  let indicator = null;
  let indicatorLabel = null;
  let feed = null;
  let emptyEl = null;

  // ----- injected per-loop collaborators -----
  let registry = {};
  let consoleApi = null;
  let measure = defaultMeasure;

  // ----- per-agent turn state -----
  const dimsByAgent = new Map(); // agentId -> { width, height } measured from a finished card
  const openTurnByAgent = new Map(); // agentId -> the turn element still awaiting receive()
  const pendingCardByAgent = new Map(); // agentId -> the card awaiting finalization (skeleton/streaming)
  const thinkingByAgent = new Map(); // agentId -> the current turn's reasoning accordion
  const consoleEntryByAgent = new Map(); // agentId -> agent-console entry id
  let activeAgent = null;

  function resetState() {
    dimsByAgent.clear();
    openTurnByAgent.clear();
    pendingCardByAgent.clear();
    thinkingByAgent.clear();
    consoleEntryByAgent.clear();
    activeAgent = null;
  }

  function ensureMounted(method) {
    if (!root) throw new Error(`poe.${method}: call mount(target) first`);
  }

  // ----- small DOM helpers -----
  function bracket(text) {
    const span = document.createElement('span');
    span.className = 'bracket';
    span.textContent = text;
    return span;
  }

  function syncEmpty() {
    if (!emptyEl) return;
    // The placeholder hides once any conversation content exists: an agent turn or
    // the milestone cessation card (which is a feed-level card, not a turn).
    emptyEl.style.display = feed.querySelector('.poe-turn, .poe-cessation') ? 'none' : '';
  }

  function scrollFeed() {
    feed.scrollTop = feed.scrollHeight;
  }

  // ----- mount -----
  function mount(target, { registry: reg, console: con, measure: meas } = {}) {
    if (!target) throw new Error('poe.mount: target is required');

    registry = reg || {};
    consoleApi = con || null;
    measure = typeof meas === 'function' ? meas : defaultMeasure;
    resetState();

    target.classList.add('poe');
    target.innerHTML = '';
    root = target;

    // Global progress / status indicator, owned by Poe, hidden when idle. Shows
    // which agent in the chain is currently active.
    indicator = document.createElement('div');
    indicator.className = 'poe-indicator';
    indicator.hidden = true;
    indicator.setAttribute('role', 'status');
    indicator.setAttribute('aria-live', 'polite');
    indicator.setAttribute('aria-label', 'Active agent');

    const bar = document.createElement('div');
    bar.className = 'poe-indicator-bar';

    indicatorLabel = document.createElement('p');
    indicatorLabel.className = 'poe-indicator-label';

    indicator.appendChild(bar);
    indicator.appendChild(indicatorLabel);

    // Conversation feed.
    feed = document.createElement('div');
    feed.className = 'poe-stream';
    feed.setAttribute('role', 'log');
    feed.setAttribute('aria-live', 'polite');
    feed.setAttribute('aria-label', 'Conversation');

    emptyEl = document.createElement('p');
    emptyEl.className = 'poe-empty';
    emptyEl.textContent = DEFAULT_EMPTY;
    feed.appendChild(emptyEl);

    root.appendChild(indicator);
    root.appendChild(feed);

    return api;
  }

  // ----- turn / card construction -----
  function startOpenTurn(agentId) {
    const turn = document.createElement('div');
    turn.className = 'poe-turn';
    turn.dataset.agent = agentId;
    feed.appendChild(turn);
    openTurnByAgent.set(agentId, turn);
    thinkingByAgent.delete(agentId); // a new turn gets a fresh reasoning section
    syncEmpty();
    return turn;
  }

  function currentTurn(agentId) {
    // The map is authoritative for the lifetime of a mount; a turn is removed
    // from it only when receive() closes it. (isConnected is unreliable here
    // because a mounted-but-detached tree reports false.)
    const open = openTurnByAgent.get(agentId);
    if (open) return open;
    return startOpenTurn(agentId);
  }

  function newCardSlot(agentId) {
    const card = document.createElement('div');
    card.className = 'poe-card';
    card.dataset.agent = agentId;
    return card;
  }

  // Skeleton state: a single shimmer block at the exact measured dimensions of a
  // finished card for this agent. Never approximated; only rendered when a real
  // card has been measured before.
  function renderSkeleton(card, dims) {
    card.dataset.state = 'skeleton';
    const fill = document.createElement('div');
    fill.className = 'poe-skeleton skeleton';
    fill.setAttribute('aria-hidden', 'true');
    fill.style.width = `${dims.width}px`;
    fill.style.height = `${dims.height}px`;
    card.replaceChildren(fill);
  }

  // Shell state: the agent header plus an empty body. Used when a card leaves the
  // skeleton state (streaming) or is finalized. Returns the body element. Any
  // inline skeleton sizing is dropped so a later measure reads the natural size.
  function renderShell(card, agentId) {
    card.style.width = '';
    card.style.height = '';
    const header = bracket(`[${agentId}]`);
    header.classList.add('poe-card-agent');
    const body = document.createElement('div');
    body.className = 'poe-card-body';
    card.replaceChildren(header, body);
    return body;
  }

  function cardBody(card, agentId) {
    return card.querySelector('.poe-card-body') || renderShell(card, agentId);
  }

  // ----- setStatus: indicator + agent-console entry, plus skeleton on activate -----
  function resolveCopy(agentId, key) {
    const perAgent = registry && registry[agentId];
    if (perAgent && typeof perAgent[key] === 'string') return perAgent[key];
    // Fallback to the literal string so an ad-hoc message still shows; never a
    // generic placeholder.
    return typeof key === 'string' ? key : '';
  }

  function mirrorConsole(agentId, message) {
    if (!consoleApi) return;
    const entryId = consoleEntryByAgent.get(agentId);
    if (entryId != null && typeof consoleApi.updateEntry === 'function') {
      consoleApi.updateEntry(entryId, { message, state: 'running' });
    } else if (typeof consoleApi.pushEntry === 'function') {
      const id = consoleApi.pushEntry({ agent: agentId, message, state: 'running' });
      consoleEntryByAgent.set(agentId, id);
    }
  }

  function setStatus(agentId, key) {
    ensureMounted('setStatus');

    // No active agent: hide the indicator.
    if (agentId == null || agentId === '') {
      activeAgent = null;
      indicator.hidden = true;
      indicatorLabel.replaceChildren();
      return;
    }

    const message = resolveCopy(agentId, key);
    activeAgent = agentId;

    indicator.hidden = false;
    const copy = document.createElement('span');
    copy.className = 'poe-status-copy';
    copy.textContent = message;
    indicatorLabel.replaceChildren(bracket(`[${agentId}]`), document.createTextNode(' '), copy);

    mirrorConsole(agentId, message);

    // The agent is now waiting on a response: show a skeleton at exact measured
    // dimensions if we have them. With no prior measurement, show no sized box
    // and create no turn, so a backstage agent (one that never renders a card)
    // leaves no empty conversation node in the feed.
    if (!pendingCardByAgent.has(agentId) && dimsByAgent.has(agentId)) {
      const turn = currentTurn(agentId);
      const card = newCardSlot(agentId);
      renderSkeleton(card, dimsByAgent.get(agentId));
      turn.appendChild(card);
      pendingCardByAgent.set(agentId, card);
      scrollFeed();
    }
  }

  // ----- userTurn: render the researcher's own message into the feed -----
  // The composer is a sibling surface and never writes the conversation (TurnGate).
  // So the researcher's message is rendered HERE, by Poe (the only conversation
  // writer), as a distinct turn, so the feed shows both sides of the dialogue.
  function userTurn(text) {
    ensureMounted('userTurn');
    const turn = document.createElement('div');
    turn.className = 'poe-turn poe-user-turn';
    const card = document.createElement('div');
    card.className = 'poe-card poe-user-card';
    const header = bracket('[YOU]');
    header.classList.add('poe-card-agent');
    const body = document.createElement('div');
    body.className = 'poe-card-body';
    body.textContent = text == null ? '' : String(text);
    card.appendChild(header);
    card.appendChild(body);
    turn.appendChild(card);
    feed.appendChild(turn);
    syncEmpty();
    scrollFeed();
    return turn;
  }

  // ----- settle: close a backstage agent's turn without a conversation card -----
  // Every agent but the conversation writer (Poe) is backstage: its output goes to
  // the IO panel (Agent Console + Packet Inspector), not the conversation feed. The
  // orchestrator calls settle() instead of receive() for those agents, so their
  // agent-console entry is marked done (never left running) while no card and no
  // turn are added to the conversation.
  function settle(agentId, summary) {
    ensureMounted('settle');
    if (agentId == null || agentId === '') {
      throw new Error('poe.settle: agentId is required');
    }
    const entryId = consoleEntryByAgent.get(agentId);
    if (consoleApi && entryId != null && typeof consoleApi.complete === 'function') {
      // When the orchestrator passes the agent's own outcome summary (e.g. CV's
      // "Completeness 50% (fail). Blocking: ..."), surface it in the agent console so
      // the user reads the verdict, not just a generic "done". Otherwise mark it done.
      consoleApi.complete(entryId, typeof summary === 'string' && summary ? summary : undefined);
    }
    // Drop any turn bookkeeping so a later turn for this agent starts clean. No
    // conversation node was created for a backstage agent, so there is none to remove.
    pendingCardByAgent.delete(agentId);
    openTurnByAgent.delete(agentId);
  }

  // ----- stream: append raw prose into the agent's pending card -----
  function stream(agentId, chunk) {
    ensureMounted('stream');
    if (agentId == null || agentId === '') {
      throw new Error('poe.stream: agentId is required');
    }
    const turn = currentTurn(agentId);

    let card = pendingCardByAgent.get(agentId);
    let body;
    if (!card) {
      card = newCardSlot(agentId);
      turn.appendChild(card);
      pendingCardByAgent.set(agentId, card);
      body = renderShell(card, agentId);
    } else if (card.dataset.state === 'skeleton') {
      body = renderShell(card, agentId); // leave the skeleton behind for live prose
    } else {
      body = cardBody(card, agentId);
    }

    card.dataset.state = 'pending';
    // Raw, unparsed text. Poe never parses a stream chunk.
    body.appendChild(document.createTextNode(chunk == null ? '' : String(chunk)));
    scrollFeed();
  }

  // ----- receive: finalize with the validated packet -----
  function renderFinal(body, packet) {
    const content = packet ? packet.content : undefined;
    try {
      if (typeof content === 'string') {
        body.textContent = content;
      } else if (content !== undefined) {
        body.textContent =
          typeof content === 'object' ? JSON.stringify(content, null, 2) : String(content);
      } else {
        // No content field: render the packet itself, tolerant of shape (Poe owns
        // no schema). The structured packet also lives in the Packet Inspector.
        body.textContent = JSON.stringify(packet, null, 2);
      }
    } catch (err) {
      // Circular or otherwise unrenderable: surface it rather than swallow it.
      const reason = err && err.message ? err.message : String(err);
      body.textContent = `[unrenderable packet] ${reason}`;
    }
  }

  function receive(packet) {
    ensureMounted('receive');
    const agentId = packet && packet.agentId;
    if (agentId == null || agentId === '') {
      throw new Error('poe.receive: packet.agentId is required for attribution');
    }

    const turn = currentTurn(agentId);
    let card = pendingCardByAgent.get(agentId);
    if (!card) {
      card = newCardSlot(agentId);
      turn.appendChild(card);
    }

    // Rebuild the shell so a fresh body replaces any streamed prose, then render
    // the validated content into it.
    const body = renderShell(card, agentId);
    renderFinal(body, packet);
    card.dataset.state = 'final';

    // The turn is closed: the next setStatus for this agent starts a new turn.
    pendingCardByAgent.delete(agentId);
    openTurnByAgent.delete(agentId);

    // Measure the finished card and cache its exact dimensions for future
    // skeletons. Measure after it is in its final state and in the document.
    const dims = measure(card);
    if (dims && Number.isFinite(dims.width) && Number.isFinite(dims.height)) {
      dimsByAgent.set(agentId, { width: dims.width, height: dims.height });
    }

    // Mark the agent-console entry done.
    const entryId = consoleEntryByAgent.get(agentId);
    if (consoleApi && entryId != null && typeof consoleApi.complete === 'function') {
      consoleApi.complete(entryId);
    }

    syncEmpty();
    scrollFeed();
  }

  // ----- showThinking: one collapsible reasoning section per agent turn -----
  function renderStep(step) {
    const el = document.createElement('div');
    el.className = 'poe-think-step';
    if (step && step.type === 'tool_call') {
      el.dataset.type = 'tool_call';
      const name = bracket(`[${step.name || 'TOOL'}]`);
      name.classList.add('poe-step-tool');
      el.appendChild(name);
      if (step.args !== undefined) {
        const args = document.createElement('span');
        args.className = 'poe-step-args';
        try {
          args.textContent = ` ${typeof step.args === 'string' ? step.args : JSON.stringify(step.args)}`;
        } catch (_err) {
          args.textContent = ' [unrenderable args]';
        }
        el.appendChild(args);
      }
    } else {
      el.dataset.type = (step && step.type) || 'reasoning';
      const text =
        step && typeof step === 'object'
          ? step.text != null
            ? step.text
            : step.content != null
              ? step.content
              : JSON.stringify(step)
          : String(step);
      el.textContent = text;
    }
    return el;
  }

  function createThinking() {
    const details = document.createElement('details');
    details.className = 'poe-thinking';
    // Default collapsed: power users expand it; casual users are not overwhelmed.
    const summary = document.createElement('summary');
    summary.className = 'poe-thinking-summary';
    summary.textContent = THINKING_LABEL;
    const steps = document.createElement('div');
    steps.className = 'poe-think-steps';
    details.appendChild(summary);
    details.appendChild(steps);
    return details;
  }

  function showThinking(agentId, steps) {
    ensureMounted('showThinking');
    if (agentId == null || agentId === '') {
      throw new Error('poe.showThinking: agentId is required');
    }
    const turn = currentTurn(agentId);

    let accordion = thinkingByAgent.get(agentId);
    if (!accordion || accordion.parentElement !== turn) {
      accordion = createThinking();
      // Reasoning sits above the response card for this turn.
      turn.insertBefore(accordion, turn.firstChild);
      thinkingByAgent.set(agentId, accordion);
    }

    const list = accordion.querySelector('.poe-think-steps');
    (steps || []).forEach((step) => list.appendChild(renderStep(step)));
    scrollFeed();
  }

  // ----- cessationCard: the Loop 1 completion card with its trust layer -----
  // A milestone card rendered into the conversation feed when the loop ceases. It
  // is a conversation write, so it lives here (Poe is the only conversation
  // writer): the Output Hook builds the trust model (confidence, review flag,
  // evaluation) and hands Poe the data and the CTA; Poe owns the DOM and wires the
  // button. The card shows the finalized question, paradigm, and novelty signal,
  // plus a layered confidence badge, a requires_human_review banner, and a
  // collapsible evaluation breakdown. Math in the question and rationales renders
  // through KaTeX. Confirmed result and CTA read as active (green); labels are
  // bracket amber; values are monospace data; nothing has a border radius. The
  // confidence pill colors (green/yellow/red) are the one documented exception to
  // the green/amber law, confined to the trust badge and banner (see ARCHITECTURE).

  // A labeled value row. value may be a string (optionally KaTeX-rendered when
  // math:true), an array (joined), or empty (renders a placeholder, never blank).
  function cessationField(label, value, opts = {}) {
    const row = document.createElement('div');
    row.className = 'poe-cessation-field';
    const dt = bracket(`[${label}]`);
    dt.classList.add('poe-cessation-label');
    const dd = document.createElement('span');
    dd.className = 'poe-cessation-value';
    if (opts.confirmed) dd.classList.add('is-confirmed');

    const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) {
      dd.textContent = opts.emptyText || 'not set';
    } else if (Array.isArray(value)) {
      dd.textContent = value.join(', ');
    } else if (opts.math) {
      dd.appendChild(mathToFragment(String(value)));
    } else {
      dd.textContent = String(value);
    }
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  // The layered confidence badge: three distinct elements (a color pill resolved
  // from data-level, a natural-language label, and a hover/focus tooltip carrying
  // the raw reviewer rationale, which may contain math).
  function confidenceBadge(confidence) {
    const badge = document.createElement('span');
    badge.className = 'poe-cessation-badge';
    badge.tabIndex = 0; // focusable so the tooltip is keyboard reachable

    const level = confidence && confidence.level ? confidence.level : 'low';
    const labelText = (confidence && confidence.label) || 'Needs review';

    const pill = document.createElement('span');
    pill.className = 'poe-badge-pill';
    pill.dataset.level = level;
    pill.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'poe-badge-label';
    label.textContent = labelText;

    badge.setAttribute('aria-label', `Confidence: ${labelText}`);
    badge.appendChild(pill);
    badge.appendChild(label);

    const tip = confidence && confidence.tooltip ? String(confidence.tooltip) : '';
    if (tip) {
      const tooltip = document.createElement('span');
      tooltip.className = 'poe-badge-tooltip';
      tooltip.setAttribute('role', 'tooltip');
      tooltip.appendChild(mathToFragment(tip));
      badge.appendChild(tooltip);
    }
    return badge;
  }

  // The requires_human_review banner: a visible alert with the reasons.
  function reviewBanner(reasons) {
    const banner = document.createElement('div');
    banner.className = 'poe-cessation-banner';
    banner.setAttribute('role', 'alert');
    const tag = bracket('[REVIEW]');
    tag.classList.add('poe-banner-tag');
    const text = document.createElement('span');
    text.className = 'poe-banner-text';
    const why = Array.isArray(reasons) && reasons.length ? `: ${reasons.join('; ')}` : '';
    text.textContent = ` Human review recommended${why}.`;
    banner.appendChild(tag);
    banner.appendChild(text);
    return banner;
  }

  // The collapsible evaluation breakdown: CV completeness, the blocking fields that
  // were resolved, the paradigm and its rationale, and the novelty signal with its
  // overlapping papers. Rationales render math.
  function evaluationSection(evaluation) {
    const details = document.createElement('details');
    details.className = 'poe-cessation-eval';
    const summary = document.createElement('summary');
    summary.className = 'poe-cessation-eval-summary';
    summary.textContent = 'Show evaluation';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'poe-cessation-eval-body';
    const score = typeof evaluation.cvScore === 'number' && !Number.isNaN(evaluation.cvScore)
      ? String(evaluation.cvScore)
      : 'n/a';
    body.appendChild(cessationField('COMPLETENESS', score, { emptyText: 'n/a' }));
    body.appendChild(
      cessationField('BLOCKING_RESOLVED', evaluation.resolvedBlockingFields, { emptyText: 'none' }),
    );
    body.appendChild(cessationField('PARADIGM', evaluation.paradigm, { emptyText: 'undetected' }));
    body.appendChild(
      cessationField('PARADIGM_RATIONALE', (evaluation.paradigmRationale || []).join(' '), {
        math: true,
        emptyText: 'none given',
      }),
    );
    body.appendChild(cessationField('NOVELTY_SIGNAL', evaluation.noveltySignal, { emptyText: 'n/a' }));
    body.appendChild(
      cessationField('NOVELTY_RATIONALE', evaluation.noveltyRationale, { math: true, emptyText: 'none given' }),
    );
    body.appendChild(
      cessationField('OVERLAPPING_PAPERS', evaluation.overlappingPapers, { emptyText: 'none cited' }),
    );
    details.appendChild(body);
    return details;
  }

  // The max-reached note: a non-blocking caution that the study hit the iteration cap
  // (a warning, not a stop). Distinct from the review banner.
  function maxWarningNote(maxWarning) {
    const note = document.createElement('div');
    note.className = 'poe-cessation-maxwarning';
    note.setAttribute('role', 'note');
    const tag = bracket('[MAX_REACHED]');
    tag.classList.add('poe-maxwarning-tag');
    const text = document.createElement('span');
    text.className = 'poe-maxwarning-text';
    const message = maxWarning && typeof maxWarning.message === 'string'
      ? maxWarning.message
      : 'This study reached the configured iteration limit.';
    text.textContent = ` ${message}`;
    note.appendChild(tag);
    note.appendChild(text);
    return note;
  }

  function cessationCard(spec = {}) {
    ensureMounted('cessationCard');
    const { researchQuestion, paradigm, noveltySignal, confidence, requiresHumanReview, reviewReasons, evaluation, maxWarning, cta } = spec;

    const card = document.createElement('div');
    card.className = 'poe-cessation';
    card.dataset.state = 'final';

    // Review banner at the top when the result is flagged for human review.
    if (requiresHumanReview) {
      card.dataset.review = 'required';
      card.appendChild(reviewBanner(reviewReasons));
    }

    // Max-reached caution (non-blocking) when the run hit the iteration cap.
    if (maxWarning) {
      card.dataset.maxReached = 'true';
      card.appendChild(maxWarningNote(maxWarning));
    }

    const head = document.createElement('p');
    head.className = 'poe-cessation-head';
    const tag = bracket('[COMPLETE]');
    tag.classList.add('poe-cessation-tag');
    const title = document.createElement('span');
    title.className = 'poe-cessation-title';
    title.textContent = ' Research question finalized.';
    head.appendChild(tag);
    head.appendChild(title);
    if (confidence) head.appendChild(confidenceBadge(confidence));

    const fields = document.createElement('div');
    fields.className = 'poe-cessation-fields';
    fields.appendChild(cessationField('RESEARCH_QUESTION', researchQuestion, { math: true, confirmed: true }));
    fields.appendChild(cessationField('PARADIGM', paradigm));
    fields.appendChild(cessationField('NOVELTY_SIGNAL', noveltySignal));

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'poe-cessation-cta';
    button.textContent = (cta && cta.label) || 'Proceed to Literature Review';
    button.addEventListener('click', () => {
      if (cta && typeof cta.onClick === 'function') cta.onClick();
    });

    card.appendChild(head);
    card.appendChild(fields);
    if (evaluation) card.appendChild(evaluationSection(evaluation));
    card.appendChild(button);
    feed.appendChild(card);
    syncEmpty();
    scrollFeed();
    return card;
  }

  const api = { mount, receive, setStatus, settle, showThinking, stream, cessationCard, userTurn };
  return api;
}

// Default app instance. The app calls poe.mount(conversationRoot, { console,
// registry }) once the IO panel is mounted; loops re-mount with their own
// registry. Tests build isolated instances with createPoe().
export const poe = createPoe();
