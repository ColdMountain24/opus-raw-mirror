import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoeOverlay, poeOverlay } from '../../../src/components/loop2/poeoverlay.js';
import { createPoe } from '../../../src/components/poe.js';

// Loop 2 Poe overlay panel. The overlay wraps the S0 Poe component in a slide-up
// panel mounted into the loop surface; a conversation write raises it, a backstage
// signal does not, and the researcher (or hideOverlay) lowers it. The Observatory
// dim is exercised through the injected onToggle. A recording stub stands in for the
// inner Poe so the overlay mechanics are asserted without Poe's DOM; one integration
// test uses the real createPoe() to prove "the same Poe in a different mount config".

function stubPoe() {
  const mountTargets = [];
  return {
    mount: vi.fn((target, opts) => {
      mountTargets.push({ target, opts });
    }),
    receive: vi.fn(),
    milestoneCard: vi.fn(),
    cessationCard: vi.fn(),
    userTurn: vi.fn(),
    setStatus: vi.fn(),
    settle: vi.fn(),
    stream: vi.fn(),
    showThinking: vi.fn(),
    mountTargets,
  };
}

describe('Loop 2 Poe overlay panel', () => {
  let host;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    host.remove();
  });

  it('mounts a closed slide-up panel and mounts the S0 Poe into the panel feed', () => {
    const poe = stubPoe();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host, { registry: { foo: {} }, console: { id: 'con' } });

    const panel = host.querySelector('.poe-overlay');
    expect(panel).toBeTruthy();
    expect(panel.dataset.state).toBe('closed');
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-hidden')).toBe('true');
    expect(host.classList.contains('poe-overlay-host')).toBe(true);
    expect(overlay.isOpen()).toBe(false);

    // The same Poe component, in a different mount configuration: into the panel
    // feed, with the loop registry + console forwarded unchanged.
    const feed = host.querySelector('.poe-overlay-feed');
    expect(poe.mount).toHaveBeenCalledTimes(1);
    expect(poe.mountTargets[0].target).toBe(feed);
    expect(poe.mountTargets[0].opts.registry).toEqual({ foo: {} });
    expect(poe.mountTargets[0].opts.console).toEqual({ id: 'con' });
  });

  it('showOverlay(packet) raises the panel, renders the packet via Poe, and dims (onToggle true)', () => {
    const poe = stubPoe();
    const onToggle = vi.fn();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host, { onToggle });

    const packet = { agentId: 'Poe', content: 'review this contradiction' };
    overlay.showOverlay(packet);

    expect(poe.receive).toHaveBeenCalledWith(packet);
    expect(overlay.isOpen()).toBe(true);
    expect(host.querySelector('.poe-overlay').dataset.state).toBe('open');
    expect(host.querySelector('.poe-overlay').getAttribute('aria-hidden')).toBe('false');
    expect(onToggle).toHaveBeenLastCalledWith(true);
  });

  it('showOverlay() with no packet raises without rendering (a bare raise)', () => {
    const poe = stubPoe();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host);
    overlay.showOverlay();
    expect(poe.receive).not.toHaveBeenCalled();
    expect(overlay.isOpen()).toBe(true);
  });

  it('the researcher can dismiss the panel (button + hideOverlay), which un-dims (onToggle false)', () => {
    const poe = stubPoe();
    const onToggle = vi.fn();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host, { onToggle });
    overlay.showOverlay({ agentId: 'Poe', content: 'x' });
    onToggle.mockClear();

    host.querySelector('.poe-overlay-dismiss').click();
    expect(overlay.isOpen()).toBe(false);
    expect(host.querySelector('.poe-overlay').dataset.state).toBe('closed');
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('a conversation write raises the panel; a backstage signal does not', () => {
    const poe = stubPoe();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host);

    // backstage: status + settle pass through to Poe without raising the panel (the
    // autonomous sweep must leave the Observatory in full view).
    overlay.setStatus('Fearless Leader', 'running');
    overlay.settle('Fearless Leader', 'done');
    overlay.stream('Fearless Leader', 'chunk');
    expect(poe.setStatus).toHaveBeenCalledWith('Fearless Leader', 'running');
    expect(poe.settle).toHaveBeenCalled();
    expect(poe.stream).toHaveBeenCalled();
    expect(overlay.isOpen()).toBe(false);

    // a conversation write raises it
    overlay.receive({ agentId: 'Poe', content: 'c' });
    expect(overlay.isOpen()).toBe(true);

    // milestoneCard (the intake gate / cessation card) also raises it
    overlay.hideOverlay();
    overlay.milestoneCard({ tag: '[INTAKE]' });
    expect(poe.milestoneCard).toHaveBeenCalled();
    expect(overlay.isOpen()).toBe(true);
  });

  it('fires onToggle only on a real open/close edge (idempotent calls do not re-dim)', () => {
    const poe = stubPoe();
    const onToggle = vi.fn();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host, { onToggle });

    overlay.showOverlay({ agentId: 'Poe', content: 'a' });
    overlay.showOverlay({ agentId: 'Poe', content: 'b' }); // already open
    expect(onToggle.mock.calls.filter(([o]) => o === true)).toHaveLength(1);

    overlay.hideOverlay();
    overlay.hideOverlay(); // already closed
    expect(onToggle.mock.calls.filter(([o]) => o === false)).toHaveLength(1);
  });

  it('setOnToggle binds the dim after construction (main.js binds the per-surface Observatory)', () => {
    const poe = stubPoe();
    const onToggle = vi.fn();
    const overlay = createPoeOverlay({ poe });
    overlay.mount(host);
    overlay.setOnToggle(onToggle);
    overlay.showOverlay({ agentId: 'Poe', content: 'x' });
    expect(onToggle).toHaveBeenLastCalledWith(true);
  });

  it('throws if used before mount', () => {
    const overlay = createPoeOverlay({ poe: stubPoe() });
    expect(() => overlay.showOverlay({ agentId: 'Poe' })).toThrow(/mount/);
    expect(() => overlay.hideOverlay()).toThrow(/mount/);
  });

  it('integration: renders a real S0 Poe card into the raised panel feed', () => {
    const overlay = createPoeOverlay({ poe: createPoe() });
    overlay.mount(host, { measure: () => ({ width: 200, height: 80 }) });
    overlay.showOverlay({ agentId: 'Poe', content: 'a material contradiction surfaced' });

    const feed = host.querySelector('.poe-overlay-feed');
    expect(feed.classList.contains('poe')).toBe(true); // Poe mounted into the feed
    expect(feed.textContent).toContain('a material contradiction surfaced');
    expect(host.querySelector('.poe-overlay').dataset.state).toBe('open');
  });

  it('exposes a default singleton with the overlay + Poe surface', () => {
    expect(typeof poeOverlay.mount).toBe('function');
    expect(typeof poeOverlay.showOverlay).toBe('function');
    expect(typeof poeOverlay.hideOverlay).toBe('function');
    expect(typeof poeOverlay.receive).toBe('function');
  });
});
