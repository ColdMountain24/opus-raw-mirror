import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mountMousekatool } from '../src/components/mousekatool.js';

// Timers are injected so the threshold is exercised without real time.
function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    schedule: (fn, ms) => {
      id += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    cancel: (i) => pending.delete(i),
    flush: () => {
      const items = [...pending.values()];
      pending.clear();
      items.forEach((t) => t.fn());
    },
    lastMs: () => {
      const arr = [...pending.values()];
      return arr.length ? arr[arr.length - 1].ms : null;
    },
    size: () => pending.size,
  };
}

describe('mousekatool', () => {
  let host;
  let timers;

  beforeEach(() => {
    host = document.createElement('div');
    timers = fakeTimers();
  });

  const mount = (opts = {}) =>
    mountMousekatool(host, { schedule: timers.schedule, cancel: timers.cancel, ...opts });

  it('mounts hidden with a pixel sprite', () => {
    const api = mount();
    expect(host.querySelector('.mousekatool').hidden).toBe(true);
    expect(api.isVisible()).toBe(false);
    expect(host.querySelector('.mousekatool-sprite')).toBeTruthy();
  });

  it('appears only after the threshold elapses', () => {
    const api = mount({ threshold: 4000 });
    api.start();
    expect(timers.lastMs()).toBe(4000);
    expect(api.isVisible()).toBe(false);
    timers.flush();
    expect(api.isVisible()).toBe(true);
  });

  it('does not appear if the call completes before the threshold', () => {
    const api = mount({ threshold: 4000 });
    api.start();
    api.stop();
    expect(timers.size()).toBe(0); // timer cancelled
    timers.flush();
    expect(api.isVisible()).toBe(false);
  });

  it('hides on dismiss (click) and pauses on stop', () => {
    const api = mount({ threshold: 1000 });
    api.start();
    timers.flush();
    expect(api.isVisible()).toBe(true);
    host.querySelector('.mousekatool').click();
    expect(api.isVisible()).toBe(false);

    // stop() also hides a visible widget
    api.start();
    timers.flush();
    expect(api.isVisible()).toBe(true);
    api.stop();
    expect(api.isVisible()).toBe(false);
  });

  it('a fresh start clears a prior dismissal', () => {
    const api = mount({ threshold: 1000 });
    api.start();
    timers.flush();
    host.querySelector('.mousekatool').click(); // dismissed
    expect(api.isVisible()).toBe(false);
    api.start(); // new activation
    timers.flush();
    expect(api.isVisible()).toBe(true);
  });

  it('stays disabled under HIPAA mode (setEnabled false)', () => {
    const api = mount({ threshold: 1000 });
    api.setEnabled(false);
    api.start();
    expect(timers.size()).toBe(0); // never armed
    timers.flush();
    expect(api.isVisible()).toBe(false);

    // disabling while visible hides it
    api.setEnabled(true);
    api.start();
    timers.flush();
    expect(api.isVisible()).toBe(true);
    api.setEnabled(false);
    expect(api.isVisible()).toBe(false);
  });

  it('uses the configured threshold', () => {
    const api = mount({ threshold: 4000 });
    api.setThreshold(1500);
    api.start();
    expect(timers.lastMs()).toBe(1500);
  });

  it('requires a target', () => {
    expect(() => mountMousekatool(null)).toThrow();
  });
});

describe('mousekatool styles', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(
    path.join(here, '..', 'src', 'components', 'mousekatool.css'),
    'utf-8',
  );

  it('renders the sprite with pixelated image rendering', () => {
    expect(css).toMatch(/\.mousekatool-sprite\s*\{[\s\S]*?image-rendering:\s*pixelated/);
  });

  it('disables movement under reduced motion (idle frame only)', () => {
    const reduced = css.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.mousekatool-sprite\s*\{([\s\S]*?)\}/,
    );
    expect(reduced, 'no reduced-motion sprite block').toBeTruthy();
    expect(reduced[1]).toMatch(/animation:\s*none/);
  });
});
