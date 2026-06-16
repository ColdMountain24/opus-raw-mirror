import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Phase 2 shell smoke test. Loads the real markup from src/index.html (minus
// the module script) and imports main.js so the test exercises the shell the
// app actually ships. Verifies the three regions mount, the IO panel collapses
// and expands, loop navigation switches, the canvas reflow path runs, and no
// init error is surfaced.

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'src', 'index.html'), 'utf-8');
const body = html
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');

beforeAll(async () => {
  document.body.innerHTML = body;
  // main.js runs initShell() on import, against the markup set above.
  await import('../src/main.js');
});

describe('app shell', () => {
  it('mounts the three layout regions', () => {
    expect(document.querySelector('.sidebar')).toBeTruthy();
    expect(document.querySelector('.canvas')).toBeTruthy();
    expect(document.querySelector('.io-panel')).toBeTruthy();
  });

  it('does not surface an init error', () => {
    expect(document.getElementById('error-boundary').hidden).toBe(true);
  });

  it('collapses and expands the IO panel', () => {
    const shell = document.getElementById('app');
    expect(shell.dataset.ioCollapsed).toBe('false');

    document.getElementById('io-toggle').click();
    expect(shell.dataset.ioCollapsed).toBe('true');
    expect(document.getElementById('io-toggle').getAttribute('aria-expanded')).toBe('false');

    document.getElementById('io-rail').click();
    expect(shell.dataset.ioCollapsed).toBe('false');
    expect(document.getElementById('io-toggle').getAttribute('aria-expanded')).toBe('true');
  });

  it('locks downstream loops until the preceding loop is complete', () => {
    // No session has progress yet, so only Loop 1 is navigable; Loop 2 is locked.
    expect(document.querySelector('.nav-item[data-loop="1"]').disabled).toBe(false);
    expect(document.querySelector('.nav-item[data-loop="2"]').disabled).toBe(true);
  });

  it('navigates to an unlocked loop and reveals the loop view', () => {
    const shell = document.getElementById('app');
    const loop1 = document.querySelector('.nav-item[data-loop="1"]');
    loop1.click();
    expect(shell.dataset.loop).toBe('1');
    const title = document.getElementById('canvas-title');
    expect(title.hidden).toBe(false);
    expect(title.textContent).toBe('LOOP 1');
    expect(loop1.getAttribute('aria-pressed')).toBe('true');
    // Landing dashboard gives way to the conversation surface.
    expect(document.getElementById('dashboard-root').hidden).toBe(true);
    expect(document.getElementById('conversation-root').hidden).toBe(false);
  });

  it('mounts Loop 1 into its own loop-surface (the per-loop teardown mechanism)', () => {
    const convo = document.getElementById('conversation-root');
    const surfaces = convo.querySelectorAll('.loop-surface');
    // Exactly one surface (Loop 1's), and the conversation feed lives inside it, not
    // directly in the conversation root, so switching loops swaps the whole surface.
    expect(surfaces.length).toBe(1);
    expect(surfaces[0].dataset.loop).toBe('1');
    expect(surfaces[0].querySelector('.conversation-feed')).toBeTruthy();
    expect(surfaces[0].hidden).toBe(false);
  });

  it('reflows the canvas on init via the ResizeObserver guard path', () => {
    // jsdom has no ResizeObserver, so the guarded fallback runs reflowCanvas
    // once on init, stamping the canvas dataset and the dimension readout. The
    // readout now lives in the IO debug footer (#dbg-canvas), not on the canvas.
    const canvas = document.querySelector('.canvas');
    expect(canvas.dataset.width).toBeDefined();
    expect(document.getElementById('dbg-canvas').textContent).toMatch(/^\d+ x \d+$/);
  });

  it('updates the session id from the controls and tears down the loop surfaces', () => {
    document.getElementById('new-session').click();
    const id = document.getElementById('session-id').textContent;
    expect(id).not.toBe('S?');
    expect(document.getElementById('dbg-session').textContent).toBe(id);
    // A fresh session drops every mounted loop surface, so the next navigation
    // re-mounts from scratch (no stale conversation lingers).
    expect(document.getElementById('conversation-root').querySelectorAll('.loop-surface').length).toBe(0);
  });
});
