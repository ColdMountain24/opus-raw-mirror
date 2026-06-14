import './composer.css';

// Composer: the researcher's input affordance for Loop 1.
//
// It lives OUTSIDE Poe's conversation DOM (the TurnGate rule: only Poe writes the
// conversation feed). The composer is a sibling surface: a text input that submits
// the researcher's message to the orchestrator, plus a Confirm affordance that is
// surfaced ONLY when the orchestrator reports the latest review passed. The
// orchestrator drives the enable / confirm / lock state through setStatus; the
// composer reports intent through onSubmit / onConfirm and never reaches into the
// machine. Post-cessation the composer locks (no further edits).
//
// Visual law: monospace data entry, no border radius, green only for the active
// confirm action.

const DEFAULT_PLACEHOLDER = 'Describe your research question, or answer Poe.';

export function mountComposer(target, { onSubmit, onConfirm, placeholder = DEFAULT_PLACEHOLDER } = {}) {
  if (!target) throw new Error('mountComposer: target is required');

  target.classList.add('composer');
  target.innerHTML = '';

  let status = { awaitingInput: false, canConfirm: false, locked: false };

  const input = document.createElement('textarea');
  input.className = 'composer-input';
  input.rows = 2;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', 'Research question input');
  input.spellcheck = true;

  const actions = document.createElement('div');
  actions.className = 'composer-actions';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'composer-send';
  sendBtn.textContent = 'Send';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'composer-confirm';
  confirmBtn.textContent = 'Confirm research question';
  confirmBtn.hidden = true;

  const lockedNote = document.createElement('p');
  lockedNote.className = 'composer-locked-note';
  lockedNote.textContent = 'Research question confirmed. Loop 1 is complete.';
  lockedNote.hidden = true;

  actions.appendChild(sendBtn);
  actions.appendChild(confirmBtn);
  target.appendChild(input);
  target.appendChild(actions);
  target.appendChild(lockedNote);

  function send() {
    if (!status.awaitingInput || status.locked) return;
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    if (typeof onSubmit === 'function') onSubmit(value);
  }

  function confirm() {
    if (!status.canConfirm || status.locked) return;
    if (typeof onConfirm === 'function') onConfirm();
  }

  sendBtn.addEventListener('click', send);
  confirmBtn.addEventListener('click', confirm);

  // Enter submits; Shift+Enter inserts a newline.
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  function setStatus(next) {
    status = {
      awaitingInput: Boolean(next && next.awaitingInput),
      canConfirm: Boolean(next && next.canConfirm),
      locked: Boolean(next && next.locked),
    };
    const inputEnabled = status.awaitingInput && !status.locked;
    input.disabled = !inputEnabled;
    sendBtn.disabled = !inputEnabled;
    confirmBtn.hidden = !status.canConfirm || status.locked;
    confirmBtn.disabled = !status.canConfirm || status.locked;
    lockedNote.hidden = !status.locked;
    target.dataset.locked = String(status.locked);
    target.dataset.awaiting = String(inputEnabled);
  }

  function focus() {
    if (!input.disabled) input.focus();
  }

  setStatus(status);

  return { setStatus, focus, getStatus: () => ({ ...status }) };
}
