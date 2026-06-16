import { describe, expect, it, vi } from 'vitest';
import { createLoopSurfaces } from '../src/components/loopSurfaces.js';

// The per-loop surface manager. The defect it fixes: switching loops used to leave the
// prior loop's conversation on screen, and the only loop wired to mount was Loop 1.

describe('createLoopSurfaces', () => {
  it('requires a root', () => {
    expect(() => createLoopSurfaces({})).toThrow();
  });

  it('mounts a loop surface once, the first time it is shown', () => {
    const root = document.createElement('div');
    const mount1 = vi.fn((el) => el.appendChild(document.createElement('span')));
    const surfaces = createLoopSurfaces({ root, mounters: { 1: mount1 } });

    surfaces.show(1);
    surfaces.show(1); // re-showing must not re-mount
    expect(mount1).toHaveBeenCalledTimes(1);
    expect(root.querySelectorAll('.loop-surface[data-loop="1"]').length).toBe(1);
    expect(surfaces.isVisible(1)).toBe(true);
  });

  it('shows only the active loop and hides every other (the teardown-on-switch fix)', () => {
    const root = document.createElement('div');
    const mount1 = vi.fn();
    const mount2 = vi.fn();
    const surfaces = createLoopSurfaces({ root, mounters: { 1: mount1, 2: mount2 } });

    surfaces.show(1);
    expect(surfaces.isVisible(1)).toBe(true);

    surfaces.show(2);
    // Loop 1's surface is hidden (not destroyed), Loop 2 is visible: no bleed-through.
    expect(surfaces.isVisible(1)).toBe(false);
    expect(surfaces.isVisible(2)).toBe(true);
    expect(surfaces.has(1)).toBe(true); // Loop 1's DOM is preserved for a return visit

    surfaces.show(1);
    // Returning to Loop 1 re-shows its preserved surface without re-mounting it.
    expect(surfaces.isVisible(1)).toBe(true);
    expect(surfaces.isVisible(2)).toBe(false);
    expect(mount1).toHaveBeenCalledTimes(1);
  });

  it('gives a loop with no registered mounter an empty surface (clean navigation target)', () => {
    const root = document.createElement('div');
    const surfaces = createLoopSurfaces({ root, mounters: {} });
    const el = surfaces.show(3);
    expect(el.classList.contains('loop-surface')).toBe(true);
    expect(el.dataset.loop).toBe('3');
    expect(surfaces.isVisible(3)).toBe(true);
  });

  it('teardown drops every surface so the next show re-mounts fresh', () => {
    const root = document.createElement('div');
    const mount1 = vi.fn();
    const surfaces = createLoopSurfaces({ root, mounters: { 1: mount1 } });

    surfaces.show(1);
    surfaces.teardown();
    expect(root.children.length).toBe(0);
    expect(surfaces.has(1)).toBe(false);

    surfaces.show(1);
    expect(mount1).toHaveBeenCalledTimes(2); // re-mounted after teardown
  });
});
