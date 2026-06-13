import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountSidebar } from '../src/components/sidebar.js';

// The sidebar now delegates its loop navigation to the session-driven navigator
// from dashboard.js. Lock state comes from the session (via setSession), not from
// an unlocked option the sidebar holds.

describe('sidebar', () => {
  let host;

  beforeEach(() => {
    host = document.createElement('div');
  });

  it('renders six loops via the delegated navigator; only Loop 1 unlocked by default', () => {
    mountSidebar(host, {});
    expect(host.querySelectorAll('.nav-item').length).toBe(6);
    expect(host.querySelector('.nav-item[data-loop="1"]').disabled).toBe(false);
    expect(host.querySelector('.nav-item[data-loop="2"]').disabled).toBe(true);
    expect(host.querySelector('.nav-item[data-loop="3"] .nav-lock')).toBeTruthy();
  });

  it('unlocks loops from the injected session and selecting one fires the callback', () => {
    const onSelectLoop = vi.fn();
    const api = mountSidebar(host, { onSelectLoop });
    api.setSession({ completedLoops: [1] });
    host.querySelector('.nav-item[data-loop="2"]').click();
    expect(onSelectLoop).toHaveBeenCalledWith(2);
    expect(host.querySelector('.nav-item[data-loop="2"]').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.nav-item[data-loop="1"]').getAttribute('aria-pressed')).toBe('false');
  });

  it('never selects a locked loop', () => {
    const onSelectLoop = vi.fn();
    mountSidebar(host, { onSelectLoop });
    host.querySelector('.nav-item[data-loop="4"]').click();
    expect(onSelectLoop).not.toHaveBeenCalled();
  });

  it('updates the session status indicator', () => {
    const api = mountSidebar(host, {});
    api.setSessionId('SX1');
    api.setSessionStatus('running');
    expect(host.querySelector('#session-id').textContent).toBe('SX1');
    expect(host.querySelector('#session-status').dataset.state).toBe('running');
    expect(host.querySelector('#session-state').textContent).toBe('running');
  });

  it('wires the session and settings buttons', () => {
    const onNewSession = vi.fn();
    const onClearSession = vi.fn();
    const onSettings = vi.fn();
    mountSidebar(host, { onNewSession, onClearSession, onSettings });
    host.querySelector('#new-session').click();
    host.querySelector('#clear-session').click();
    host.querySelector('#settings-btn').click();
    expect(onNewSession).toHaveBeenCalled();
    expect(onClearSession).toHaveBeenCalled();
    expect(onSettings).toHaveBeenCalled();
  });
});
