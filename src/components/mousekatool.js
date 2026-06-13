import './mousekatool.css';

// Mousekatool: the waiting-game system for long API calls.
//
// When an agent has been running longer than the threshold (default 4s, set in
// settings), a small, dismissible widget appears in the bottom-right corner with
// a pixel-art animation of Poe walking. It is purely an overlay: fixed
// positioning means it never reflows the conversation or the IO panel. It pauses
// (hides) the moment the call completes, and it stays hidden during HIPAA mode
// (local Ollama calls are fast), which the host enforces via setEnabled and by
// stopping the timer when a call is HIPAA-enforced.
//
// The component owns no lifecycle knowledge: the host calls start() when an API
// call begins and stop() when it ends. Timers are injectable so the threshold is
// testable without real time.

const DEFAULT_THRESHOLD_MS = 4000;

// Pixel-art Poe sprite, a 16x16 grid drawn with integer-coordinate rects. Neutral
// colors only: green and amber are reserved tokens, so the sprite uses grays. The
// dark pixels match the widget background, reading as negative-space eyes/mouth.
const SPRITE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" shape-rendering="crispEdges">',
  '<rect x="5" y="3" width="6" height="1" fill="#D8D8E0"/>',
  '<rect x="4" y="4" width="8" height="8" fill="#D8D8E0"/>',
  '<rect x="6" y="6" width="2" height="2" fill="#0D0F12"/>',
  '<rect x="9" y="6" width="2" height="2" fill="#0D0F12"/>',
  '<rect x="7" y="9" width="2" height="1" fill="#0D0F12"/>',
  '<rect x="5" y="12" width="2" height="2" fill="#D8D8E0"/>',
  '<rect x="9" y="12" width="2" height="2" fill="#D8D8E0"/>',
  '</svg>',
].join('');
const SPRITE_SRC = `data:image/svg+xml,${encodeURIComponent(SPRITE_SVG)}`;

function bracketSpan(text) {
  const span = document.createElement('span');
  span.className = 'bracket';
  span.textContent = text;
  return span;
}

export function mountMousekatool(target, {
  threshold = DEFAULT_THRESHOLD_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
} = {}) {
  if (!target) throw new Error('mountMousekatool: target is required');

  let thresholdMs = Number(threshold) >= 0 ? Number(threshold) : DEFAULT_THRESHOLD_MS;
  let enabled = true;
  let timerId = null;
  let dismissed = false;

  target.classList.add('mousekatool-mount');
  target.innerHTML = '';

  const widget = document.createElement('div');
  widget.className = 'mousekatool';
  widget.hidden = true;
  widget.dataset.playing = 'false';
  widget.setAttribute('role', 'button');
  widget.setAttribute('tabindex', '0');
  widget.setAttribute('aria-label', 'Waiting game: Poe is walking. Click to hide.');
  widget.title = 'click to hide';

  const label = document.createElement('p');
  label.className = 'mousekatool-label';
  label.appendChild(bracketSpan('[MOUSEKATOOL]'));

  const stage = document.createElement('div');
  stage.className = 'mousekatool-stage';

  const sprite = document.createElement('img');
  sprite.className = 'mousekatool-sprite';
  sprite.src = SPRITE_SRC;
  sprite.alt = 'Poe';
  sprite.draggable = false;
  sprite.setAttribute('aria-hidden', 'true');

  stage.appendChild(sprite);
  widget.appendChild(label);
  widget.appendChild(stage);
  target.appendChild(widget);

  function clearTimer() {
    if (timerId != null) {
      cancel(timerId);
      timerId = null;
    }
  }

  function show() {
    if (!enabled || dismissed) return;
    widget.hidden = false;
    widget.dataset.playing = 'true';
  }

  function hide() {
    widget.hidden = true;
    widget.dataset.playing = 'false';
  }

  // The host calls start() when a long-running API call begins. A new activation
  // clears any prior dismissal and re-arms the threshold.
  function start() {
    clearTimer();
    dismissed = false;
    if (!enabled) return;
    timerId = schedule(() => {
      timerId = null;
      show();
    }, thresholdMs);
  }

  // The call completed: disarm the threshold and pause (hide) the game.
  function stop() {
    clearTimer();
    hide();
  }

  // Click/keyboard dismissal: hide for the rest of this activation; it can
  // reappear on the next start().
  function dismiss() {
    dismissed = true;
    clearTimer();
    hide();
  }

  function setThreshold(ms) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) thresholdMs = n;
    return thresholdMs;
  }

  // Master switch. HIPAA mode disables the game entirely (Ollama calls are local
  // and fast); disabling also hides any visible widget and cancels the timer.
  function setEnabled(on) {
    enabled = Boolean(on);
    if (!enabled) {
      clearTimer();
      hide();
    }
    return enabled;
  }

  widget.addEventListener('click', dismiss);
  widget.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') {
      event.preventDefault();
      dismiss();
    }
  });

  return {
    start,
    stop,
    dismiss,
    setThreshold,
    setEnabled,
    isVisible: () => widget.hidden === false,
  };
}
