import './settings.css';

// Settings modal. Opens from the sidebar settings button. It holds provider API
// keys, the Ollama endpoint, a provider-priority toggle, a global HIPAA mode
// toggle, a cache-clear button, and a per-provider connection test.
//
// Security posture:
//   - API keys are persisted to localStorage only (never session storage, never
//     the URL), per spec. The keys are stored in plaintext there because the spec
//     requires localStorage; this module never puts a key in a query string.
//   - A raw key is never displayed in plaintext after entry: on commit the input
//     is cleared and a fixed mask plus a "set" marker is shown. The input is
//     never re-populated with a stored key.
//
// The component owns its own settings store (localStorage, injectable for tests)
// and reports dispatcher-affecting intent through callbacks; main.js applies
// those to the dispatcher (priority order, global HIPAA, cache clear, probe).

const STORE_KEY = 'opuscc:settings:v1';
const DEFAULT_OLLAMA = 'http://localhost:11434';

const PROVIDERS = [
  { id: 'anthropic', label: 'ANTHROPIC' },
  { id: 'groq', label: 'GROQ' },
  { id: 'mistral', label: 'MISTRAL' },
];

function defaults() {
  return {
    keys: {},
    ollamaEndpoint: DEFAULT_OLLAMA,
    priority: 'anthropic',
    hipaa: false,
    mousekatoolThreshold: 4,
  };
}

function resolveStorage(injected) {
  if (injected) return injected;
  try {
    return globalThis.localStorage || null;
  } catch (_err) {
    return null;
  }
}

// Pure read of persisted settings, for main.js to configure the dispatcher at
// startup. Returns defaults on any failure rather than throwing.
export function loadSettings(storage) {
  const store = resolveStorage(storage);
  if (!store) return defaults();
  try {
    const raw = store.getItem(STORE_KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch (_err) {
    return defaults();
  }
}

// A fixed mask: it reveals nothing about the key, not even its length.
const MASK = '••••••••';

export function mountSettings(target, {
  storage,
  onTestConnection,
  onPriorityChange,
  onHipaaChange,
  onClearCache,
  onSaveKeys,
  onThresholdChange,
} = {}) {
  if (!target) throw new Error('mountSettings: target is required');

  const store = resolveStorage(storage);
  let state = loadSettings(store);

  target.classList.add('settings-mount');
  target.innerHTML = '';

  // ----- overlay + dialog -----
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.hidden = true;

  const modal = document.createElement('div');
  modal.className = 'settings-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Settings');

  overlay.appendChild(modal);
  target.appendChild(overlay);

  // A non-throwing persist that surfaces failures inline instead of swallowing.
  function persist() {
    if (!store) {
      setStatus('settings storage is unavailable; changes are not saved.', 'error');
      return false;
    }
    try {
      store.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      setStatus(`could not save settings: ${err && err.message ? err.message : 'storage error'}`, 'error');
      return false;
    }
  }

  function bracket(text) {
    const span = document.createElement('span');
    span.className = 'bracket';
    span.textContent = text;
    return span;
  }

  // ----- header -----
  const header = document.createElement('header');
  header.className = 'settings-header';
  header.appendChild(bracket('[SETTINGS]'));
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'settings-close';
  closeBtn.setAttribute('aria-label', 'Close settings');
  closeBtn.textContent = 'CLOSE';
  closeBtn.addEventListener('click', () => close());
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'settings-body';
  modal.appendChild(bodyEl);

  function section(labelText) {
    const sec = document.createElement('section');
    sec.className = 'settings-section';
    const h = document.createElement('p');
    h.className = 'settings-section-label';
    h.appendChild(bracket(labelText));
    sec.appendChild(h);
    bodyEl.appendChild(sec);
    return sec;
  }

  // ----- API keys -----
  const keysSection = section('[API_KEYS]');
  const keyStatusEls = new Map();
  const resultEls = new Map();

  PROVIDERS.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'settings-key-row';
    row.dataset.provider = p.id;

    const label = document.createElement('label');
    label.className = 'settings-key-label';
    label.appendChild(bracket(`[${p.label}]`));

    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'settings-input settings-key-input';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = 'enter key';
    input.setAttribute('aria-label', `${p.label} API key`);

    // Mask immediately on commit: persist, wipe the input, show the mask.
    function commitKey() {
      const value = input.value;
      if (!value) return;
      state.keys = { ...state.keys, [p.id]: value };
      input.value = '';
      persist();
      renderKeyStatus(p.id);
      if (typeof onSaveKeys === 'function') {
        // Report only which providers have keys, never the raw values.
        onSaveKeys(Object.keys(state.keys).filter((k) => state.keys[k]));
      }
    }
    input.addEventListener('change', commitKey);
    input.addEventListener('blur', commitKey);

    const status = document.createElement('span');
    status.className = 'settings-key-status';
    keyStatusEls.set(p.id, status);

    const clearKeyBtn = document.createElement('button');
    clearKeyBtn.type = 'button';
    clearKeyBtn.className = 'settings-btn settings-key-clear';
    clearKeyBtn.textContent = 'CLEAR';
    clearKeyBtn.addEventListener('click', () => {
      const next = { ...state.keys };
      delete next[p.id];
      state.keys = next;
      input.value = '';
      persist();
      renderKeyStatus(p.id);
    });

    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'settings-btn settings-test';
    testBtn.textContent = 'TEST';
    const result = document.createElement('span');
    result.className = 'settings-test-result';
    resultEls.set(p.id, result);
    testBtn.addEventListener('click', () => runTest(p.id, testBtn));

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(status);
    row.appendChild(clearKeyBtn);
    row.appendChild(testBtn);
    row.appendChild(result);
    keysSection.appendChild(row);
  });

  function renderKeyStatus(provider) {
    const el = keyStatusEls.get(provider);
    if (!el) return;
    if (state.keys && state.keys[provider]) {
      el.textContent = `${MASK} set`;
      el.dataset.set = 'true';
    } else {
      el.textContent = 'not set';
      el.dataset.set = 'false';
    }
  }

  async function runTest(provider, btn) {
    const result = resultEls.get(provider);
    if (typeof onTestConnection !== 'function') {
      result.textContent = 'test unavailable';
      result.dataset.state = 'fail';
      return;
    }
    btn.disabled = true;
    result.dataset.state = 'pending';
    result.textContent = `probing ${provider}...`;
    try {
      const outcome = await onTestConnection(provider);
      const ok = Boolean(outcome && outcome.ok);
      const breaker = (outcome && outcome.breaker) || 'CLOSED';
      result.dataset.state = ok ? 'pass' : 'fail';
      result.textContent = ok
        ? `PASS  breaker: ${breaker}`
        : `FAIL (${(outcome && outcome.reason) || 'error'})  breaker: ${breaker}`;
    } catch (err) {
      result.dataset.state = 'fail';
      result.textContent = `FAIL (${err && err.message ? err.message : 'error'})`;
    } finally {
      btn.disabled = false;
    }
  }

  // ----- Ollama endpoint -----
  const ollamaSection = section('[OLLAMA_ENDPOINT]');
  const ollamaInput = document.createElement('input');
  ollamaInput.type = 'text';
  ollamaInput.className = 'settings-input settings-ollama-input';
  ollamaInput.spellcheck = false;
  ollamaInput.setAttribute('aria-label', 'Ollama endpoint');
  ollamaInput.value = state.ollamaEndpoint || DEFAULT_OLLAMA;
  ollamaInput.addEventListener('change', () => {
    state.ollamaEndpoint = ollamaInput.value || DEFAULT_OLLAMA;
    ollamaInput.value = state.ollamaEndpoint;
    persist();
  });
  ollamaSection.appendChild(ollamaInput);

  // ----- provider priority -----
  const prioritySection = section('[PROVIDER_PRIORITY]');
  const priorityWrap = document.createElement('div');
  priorityWrap.className = 'settings-radio-group';
  priorityWrap.setAttribute('role', 'radiogroup');
  priorityWrap.setAttribute('aria-label', 'Provider priority');
  const PRIORITY_OPTIONS = [
    { value: 'anthropic', label: 'Anthropic primary' },
    { value: 'groq', label: 'Groq primary' },
  ];
  const priorityInputs = new Map();
  PRIORITY_OPTIONS.forEach((opt) => {
    const lab = document.createElement('label');
    lab.className = 'settings-radio';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'provider-priority';
    radio.value = opt.value;
    radio.checked = state.priority === opt.value;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state.priority = opt.value;
      persist();
      if (typeof onPriorityChange === 'function') onPriorityChange(opt.value);
    });
    priorityInputs.set(opt.value, radio);
    lab.appendChild(radio);
    lab.appendChild(document.createTextNode(` ${opt.label}`));
    priorityWrap.appendChild(lab);
  });
  prioritySection.appendChild(priorityWrap);

  // ----- HIPAA mode -----
  const hipaaSection = section('[HIPAA_MODE]');
  const hipaaLabel = document.createElement('label');
  hipaaLabel.className = 'settings-toggle';
  const hipaaInput = document.createElement('input');
  hipaaInput.type = 'checkbox';
  hipaaInput.checked = Boolean(state.hipaa);
  hipaaInput.addEventListener('change', () => {
    state.hipaa = hipaaInput.checked;
    persist();
    if (typeof onHipaaChange === 'function') onHipaaChange(hipaaInput.checked);
  });
  hipaaLabel.appendChild(hipaaInput);
  hipaaLabel.appendChild(
    document.createTextNode(' route all calls to Ollama, regardless of availability'),
  );
  hipaaSection.appendChild(hipaaLabel);

  // ----- cache -----
  const cacheSection = section('[CACHE]');
  const clearCacheBtn = document.createElement('button');
  clearCacheBtn.type = 'button';
  clearCacheBtn.className = 'settings-btn';
  clearCacheBtn.id = 'settings-clear-cache';
  clearCacheBtn.textContent = 'CLEAR CACHE';
  clearCacheBtn.addEventListener('click', () => {
    if (typeof onClearCache === 'function') onClearCache();
    setStatus('packet cache cleared.', 'ok');
  });
  cacheSection.appendChild(clearCacheBtn);

  // ----- waiting game (Mousekatool) -----
  const waitSection = section('[WAITING_GAME]');
  const thresholdLabel = document.createElement('label');
  thresholdLabel.className = 'settings-field';
  thresholdLabel.appendChild(document.createTextNode('Mousekatool threshold (seconds) '));
  const thresholdInput = document.createElement('input');
  thresholdInput.type = 'number';
  thresholdInput.min = '0';
  thresholdInput.step = '1';
  thresholdInput.className = 'settings-input settings-threshold-input';
  thresholdInput.setAttribute('aria-label', 'Mousekatool threshold in seconds');
  thresholdInput.value = String(state.mousekatoolThreshold ?? 4);
  thresholdInput.addEventListener('change', () => {
    const secs = Number(thresholdInput.value);
    state.mousekatoolThreshold = Number.isFinite(secs) && secs >= 0 ? secs : 4;
    thresholdInput.value = String(state.mousekatoolThreshold);
    persist();
    if (typeof onThresholdChange === 'function') onThresholdChange(state.mousekatoolThreshold);
  });
  thresholdLabel.appendChild(thresholdInput);
  waitSection.appendChild(thresholdLabel);

  // ----- status line + footer -----
  const statusLine = document.createElement('p');
  statusLine.className = 'settings-status';
  statusLine.setAttribute('role', 'status');
  statusLine.setAttribute('aria-live', 'polite');
  modal.appendChild(statusLine);

  function setStatus(message, kind) {
    statusLine.textContent = message;
    statusLine.dataset.kind = kind || 'info';
  }

  // ----- behavior -----
  function syncFromState() {
    PROVIDERS.forEach((p) => renderKeyStatus(p.id));
    ollamaInput.value = state.ollamaEndpoint || DEFAULT_OLLAMA;
    priorityInputs.forEach((radio, value) => {
      radio.checked = state.priority === value;
    });
    hipaaInput.checked = Boolean(state.hipaa);
    thresholdInput.value = String(state.mousekatoolThreshold ?? 4);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') close();
  }

  function open() {
    state = loadSettings(store); // reflect any external change, never raw keys in inputs
    syncFromState();
    setStatus('', 'info');
    overlay.hidden = false;
    document.addEventListener('keydown', onKeydown);
    closeBtn.focus();
  }

  function close() {
    overlay.hidden = true;
    document.removeEventListener('keydown', onKeydown);
  }

  // Backdrop click closes; clicks inside the modal do not.
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });

  syncFromState();

  return {
    open,
    close,
    isOpen: () => overlay.hidden === false,
  };
}
