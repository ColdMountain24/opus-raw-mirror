import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountIoPanel } from '../src/components/ioPanel.js';

describe('IO panel', () => {
  let host;
  let api;
  let onToggle;

  beforeEach(() => {
    host = document.createElement('div');
    onToggle = vi.fn();
    api = mountIoPanel(host, { onToggleCollapse: onToggle });
  });

  it('mounts the console, packet, claims, and paper tabs', () => {
    expect(host.querySelectorAll('.io-tab').length).toBe(4);
    expect(host.querySelector('.agent-console')).toBeTruthy();
    expect(host.querySelector('.packet-inspector')).toBeTruthy();
    expect(api.console).toBeTruthy();
    expect(api.packet).toBeTruthy();
    // The claims + paper panels are exposed as empty elements for a loop to mount its own surface.
    expect(api.claims).toBeTruthy();
    expect(api.claims.id).toBe('io-tab-claims');
    expect(api.paper).toBeTruthy();
    expect(api.paper.id).toBe('io-tab-paper');
  });

  it('defaults to the console tab', () => {
    expect(api.activeTab()).toBe('console');
    expect(host.querySelector('#io-tab-console').hidden).toBe(false);
    expect(host.querySelector('#io-tab-packet').hidden).toBe(true);
  });

  it('switches to the packet tab', () => {
    host.querySelector('#io-tabbtn-packet').click();
    expect(api.activeTab()).toBe('packet');
    expect(host.querySelector('#io-tabbtn-packet').getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('#io-tab-packet').hidden).toBe(false);
    expect(host.querySelector('#io-tab-console').hidden).toBe(true);
  });

  it('collapses and expands, reporting intent through the callback', () => {
    onToggle.mockClear(); // mount called setCollapsed(false) once
    host.querySelector('#io-toggle').click();
    expect(host.dataset.collapsed).toBe('true');
    expect(host.querySelector('#io-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(onToggle).toHaveBeenCalledWith(true);

    host.querySelector('#io-rail').click();
    expect(host.dataset.collapsed).toBe('false');
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('updates the debug trace fields', () => {
    api.setTrace({ model: 'opus-4-8', retries: 3 });
    expect(host.querySelector('#dbg-model').textContent).toBe('opus-4-8');
    expect(host.querySelector('#dbg-retries').textContent).toBe('3');
  });
});
