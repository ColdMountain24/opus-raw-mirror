import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountDashboard, mountLoopNav } from '../src/components/dashboard.js';

describe('loop navigator', () => {
  let host;
  beforeEach(() => {
    host = document.createElement('div');
  });

  it('renders six loops; with no session only Loop 1 is unlocked', () => {
    mountLoopNav(host, {});
    expect(host.querySelectorAll('.nav-item').length).toBe(6);
    expect(host.querySelector('.nav-item[data-loop="1"]').disabled).toBe(false);
    expect(host.querySelector('.nav-item[data-loop="2"]').disabled).toBe(true);
    expect(host.querySelector('.nav-item[data-loop="6"]').disabled).toBe(true);
    expect(host.querySelector('.nav-item[data-loop="2"] .nav-lock')).toBeTruthy();
  });

  it('derives unlock state from session.completedLoops (preceding loop complete)', () => {
    const api = mountLoopNav(host, {});
    api.setSession({ completedLoops: [1, 2] });
    expect(host.querySelector('.nav-item[data-loop="2"]').disabled).toBe(false); // 1 complete
    expect(host.querySelector('.nav-item[data-loop="3"]').disabled).toBe(false); // 2 complete
    expect(host.querySelector('.nav-item[data-loop="4"]').disabled).toBe(true); // 3 not complete
    expect(api.isUnlocked(3)).toBe(true);
    expect(api.isUnlocked(4)).toBe(false);
  });

  it('holds no own lock state: a later session re-derives and can re-lock', () => {
    const api = mountLoopNav(host, {});
    api.setSession({ completedLoops: [1] });
    expect(host.querySelector('.nav-item[data-loop="2"]').disabled).toBe(false);
    api.setSession({ completedLoops: [] });
    expect(host.querySelector('.nav-item[data-loop="2"]').disabled).toBe(true);
    api.setSession(null);
    expect(host.querySelector('.nav-item[data-loop="2"]').disabled).toBe(true);
  });

  it('navigates on an unlocked loop and ignores a locked one', () => {
    const onSelectLoop = vi.fn();
    const api = mountLoopNav(host, { onSelectLoop });
    api.setSession({ completedLoops: [1] });

    host.querySelector('.nav-item[data-loop="2"]').click();
    expect(onSelectLoop).toHaveBeenCalledWith(2);
    expect(host.querySelector('.nav-item[data-loop="2"]').getAttribute('aria-pressed')).toBe('true');

    host.querySelector('.nav-item[data-loop="5"]').click(); // locked
    expect(onSelectLoop).toHaveBeenCalledTimes(1);
  });

  it('setActiveLoop reflects the selected loop via aria-pressed', () => {
    const api = mountLoopNav(host, {});
    api.setSession({ completedLoops: [1, 2, 3] });
    api.setActiveLoop(3);
    expect(host.querySelector('.nav-item[data-loop="3"]').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.nav-item[data-loop="1"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('requires a target', () => {
    expect(() => mountLoopNav(null)).toThrow();
  });
});

describe('dashboard landing', () => {
  let host;
  beforeEach(() => {
    host = document.createElement('div');
  });

  it('renders the RAW logo and a Begin button', () => {
    mountDashboard(host, {});
    expect(host.querySelector('.dashboard-mark').textContent).toBe('RAW');
    expect(host.querySelector('#dashboard-begin').textContent).toBe('Begin');
  });

  it('Begin reports intent to launch Loop 1', () => {
    const onBegin = vi.fn();
    mountDashboard(host, { onBegin });
    host.querySelector('#dashboard-begin').click();
    expect(onBegin).toHaveBeenCalledTimes(1);
  });

  it('shows session state from setSession (research question, current loop, last active)', () => {
    const api = mountDashboard(host, {});
    const at = 1700000000000;
    api.setSession({ researchQuestion: 'Does X cause Y?', currentLoop: 2, lastActiveAt: at });
    expect(host.querySelector('#dash-question').textContent).toBe('Does X cause Y?');
    expect(host.querySelector('#dash-loop').textContent).toBe('LOOP 2');
    expect(host.querySelector('#dash-active').textContent).toBe(new Date(at).toISOString());
  });

  it('shows defaults when no session and no research question', () => {
    const api = mountDashboard(host, {});
    api.setSession(null);
    expect(host.querySelector('#dash-question').textContent).toBe('No research question set.');
    expect(host.querySelector('#dash-loop').textContent).toBe('not started');
    expect(host.querySelector('#dash-active').textContent).toBe('never');
  });

  it('requires a target', () => {
    expect(() => mountDashboard(null)).toThrow();
  });
});
