// Per-loop conversation-surface manager.
//
// Each loop owns a persistent container (a `.loop-surface`) inside the conversation
// root. `show(n)` reveals the target loop's surface and HIDES every other one, so:
//   - switching loops never leaves a prior loop's conversation on screen (the defect
//     this fixes: navigating Loop 1 -> Loop 2 used to keep Loop 1's feed/composer up);
//   - a loop's DOM and in-progress state survive a tab away and back (the surface is
//     hidden, not destroyed), so returning to a loop does not restart it.
//
// A loop mounts its surface exactly once through an injected mounter
// (`mounters[n](surfaceEl)`), the first time it is shown. A loop with no registered
// mounter still gets an (empty) surface, so navigation always has a clean target;
// Loop 2's real mounter registers in phase 1. `teardown()` drops every surface (NEW
// SESSION / RESET) so the next navigation re-mounts fresh.
//
// DOM-only mechanism: it owns no loop logic and no schema. The `.loop-surface` layout
// lives in shell.css alongside `.conversation-root` (it replaces the feed/composer's
// former direct-child relationship to that flex page).

export function createLoopSurfaces({ root, mounters = {} } = {}) {
  if (!root) throw new Error('createLoopSurfaces: root is required');

  const surfaces = new Map(); // n -> { el, mounted }

  function ensure(n) {
    let surface = surfaces.get(n);
    if (!surface) {
      const el = document.createElement('div');
      el.className = 'loop-surface';
      el.dataset.loop = String(n);
      el.hidden = true; // created hidden; show() reveals exactly one
      root.appendChild(el);
      surface = { el, mounted: false };
      surfaces.set(n, surface);
    }
    return surface;
  }

  // Reveal loop n's surface (mounting it once if a mounter is registered) and hide
  // every other loop's surface. Returns the surface element.
  function show(n) {
    const key = Number(n);
    const surface = ensure(key);
    if (!surface.mounted && typeof mounters[key] === 'function') {
      mounters[key](surface.el);
      surface.mounted = true;
    }
    surfaces.forEach((s, k) => {
      s.el.hidden = k !== key;
    });
    return surface.el;
  }

  // Drop every surface so the next show() rebuilds from scratch (NEW SESSION / RESET).
  function teardown() {
    surfaces.clear();
    root.innerHTML = '';
  }

  function has(n) {
    return surfaces.has(Number(n));
  }

  function isVisible(n) {
    const surface = surfaces.get(Number(n));
    return Boolean(surface && !surface.el.hidden);
  }

  return { show, teardown, has, isVisible };
}
