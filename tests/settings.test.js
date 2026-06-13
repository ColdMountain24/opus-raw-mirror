import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSettings, loadSettings } from '../src/components/settings.js';

const STORE_KEY = 'opuscc:settings:v1';

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const row = (host, p) => host.querySelector(`.settings-key-row[data-provider="${p}"]`);

describe('settings modal', () => {
  let host;
  let storage;

  beforeEach(() => {
    host = document.createElement('div');
    storage = memStorage();
  });

  it('opens and closes', () => {
    const api = mountSettings(host, { storage });
    expect(api.isOpen()).toBe(false);
    api.open();
    expect(api.isOpen()).toBe(true);
    expect(host.querySelector('.settings-overlay').hidden).toBe(false);
    api.close();
    expect(api.isOpen()).toBe(false);
  });

  it('masks an API key immediately on entry and never shows it in plaintext', () => {
    const onSaveKeys = vi.fn();
    mountSettings(host, { storage, onSaveKeys });
    const input = row(host, 'anthropic').querySelector('.settings-key-input');
    input.value = 'sk-secret-12345';
    input.dispatchEvent(new Event('change'));

    expect(input.value).toBe(''); // input wiped
    expect(host.textContent).not.toContain('sk-secret-12345'); // never in the DOM
    const status = row(host, 'anthropic').querySelector('.settings-key-status');
    expect(status.dataset.set).toBe('true');
    expect(onSaveKeys).toHaveBeenCalledWith(['anthropic']);
  });

  it('stores keys in localStorage (the injected store), not elsewhere', () => {
    mountSettings(host, { storage });
    const input = row(host, 'groq').querySelector('.settings-key-input');
    input.value = 'gsk-abc';
    input.dispatchEvent(new Event('change'));
    const saved = JSON.parse(storage.getItem(STORE_KEY));
    expect(saved.keys.groq).toBe('gsk-abc');
  });

  it('does not re-populate the input with a stored key on open', () => {
    storage.setItem(STORE_KEY, JSON.stringify({ keys: { anthropic: 'sk-existing' } }));
    const api = mountSettings(host, { storage });
    api.open();
    const input = row(host, 'anthropic').querySelector('.settings-key-input');
    expect(input.value).toBe('');
    expect(host.textContent).not.toContain('sk-existing');
    expect(row(host, 'anthropic').querySelector('.settings-key-status').dataset.set).toBe('true');
  });

  it('clears a stored key', () => {
    storage.setItem(STORE_KEY, JSON.stringify({ keys: { mistral: 'm-key' } }));
    mountSettings(host, { storage });
    row(host, 'mistral').querySelector('.settings-key-clear').click();
    expect(JSON.parse(storage.getItem(STORE_KEY)).keys.mistral).toBeUndefined();
    expect(row(host, 'mistral').querySelector('.settings-key-status').dataset.set).toBe('false');
  });

  it('defaults the Ollama endpoint to localhost:11434', () => {
    mountSettings(host, { storage });
    expect(host.querySelector('.settings-ollama-input').value).toBe('http://localhost:11434');
  });

  it('reports a provider priority change and persists it', () => {
    const onPriorityChange = vi.fn();
    mountSettings(host, { storage, onPriorityChange });
    const groq = host.querySelector('input[name="provider-priority"][value="groq"]');
    groq.checked = true;
    groq.dispatchEvent(new Event('change'));
    expect(onPriorityChange).toHaveBeenCalledWith('groq');
    expect(JSON.parse(storage.getItem(STORE_KEY)).priority).toBe('groq');
  });

  it('reports HIPAA mode toggling and persists it', () => {
    const onHipaaChange = vi.fn();
    mountSettings(host, { storage, onHipaaChange });
    const toggle = host.querySelector('.settings-toggle input[type="checkbox"]');
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(onHipaaChange).toHaveBeenCalledWith(true);
    expect(JSON.parse(storage.getItem(STORE_KEY)).hipaa).toBe(true);
  });

  it('fires the cache clear callback', () => {
    const onClearCache = vi.fn();
    mountSettings(host, { storage, onClearCache });
    host.querySelector('#settings-clear-cache').click();
    expect(onClearCache).toHaveBeenCalled();
  });

  it('reports a Mousekatool threshold change and persists it', () => {
    const onThresholdChange = vi.fn();
    mountSettings(host, { storage, onThresholdChange });
    const input = host.querySelector('.settings-threshold-input');
    expect(input.value).toBe('4'); // default 4 seconds
    input.value = '8';
    input.dispatchEvent(new Event('change'));
    expect(onThresholdChange).toHaveBeenCalledWith(8);
    expect(JSON.parse(storage.getItem(STORE_KEY)).mousekatoolThreshold).toBe(8);
  });

  it('runs a connection test and shows fail with the breaker state', async () => {
    const onTestConnection = vi.fn(async () => ({
      ok: false,
      reason: 'transport_not_wired',
      breaker: 'CLOSED',
    }));
    mountSettings(host, { storage, onTestConnection });
    row(host, 'anthropic').querySelector('.settings-test').click();
    await flush();
    expect(onTestConnection).toHaveBeenCalledWith('anthropic');
    const result = row(host, 'anthropic').querySelector('.settings-test-result');
    expect(result.dataset.state).toBe('fail');
    expect(result.textContent).toContain('FAIL');
    expect(result.textContent).toContain('transport_not_wired');
    expect(result.textContent).toContain('CLOSED');
  });

  it('shows a passing connection test in the active state', async () => {
    const onTestConnection = vi.fn(async () => ({ ok: true, breaker: 'CLOSED' }));
    mountSettings(host, { storage, onTestConnection });
    row(host, 'groq').querySelector('.settings-test').click();
    await flush();
    const result = row(host, 'groq').querySelector('.settings-test-result');
    expect(result.dataset.state).toBe('pass');
    expect(result.textContent).toContain('PASS');
  });

  it('requires a target', () => {
    expect(() => mountSettings(null)).toThrow();
  });
});

describe('loadSettings', () => {
  it('returns defaults when nothing is stored', () => {
    const s = loadSettings(memStorage());
    expect(s).toEqual({
      keys: {},
      ollamaEndpoint: 'http://localhost:11434',
      priority: 'anthropic',
      hipaa: false,
      mousekatoolThreshold: 4,
    });
  });

  it('merges stored values over defaults', () => {
    const storage = memStorage({ [STORE_KEY]: JSON.stringify({ priority: 'groq', hipaa: true }) });
    const s = loadSettings(storage);
    expect(s.priority).toBe('groq');
    expect(s.hipaa).toBe(true);
    expect(s.ollamaEndpoint).toBe('http://localhost:11434');
  });
});
