import { beforeEach, describe, expect, it } from 'vitest';
import { mountAgentConsole } from '../src/components/agentConsole.js';

describe('agent console', () => {
  let host;
  let api;

  beforeEach(() => {
    host = document.createElement('div');
    api = mountAgentConsole(host);
  });

  it('shows an idle placeholder before any entry', () => {
    expect(host.querySelector('.console-empty')).toBeTruthy();
    expect(api.size).toBe(0);
  });

  it('renders an entry as [AGENT_NAME] message with an amber bracket', () => {
    api.pushEntry({ agent: 'PLANNER', message: 'thinking', state: 'running' });
    const entry = host.querySelector('.console-entry');
    expect(entry).toBeTruthy();
    const name = entry.querySelector('.console-agent');
    expect(name.textContent).toBe('[PLANNER]');
    expect(name.classList.contains('bracket')).toBe(true);
    expect(entry.querySelector('.console-msg').textContent).toBe('thinking');
    expect(entry.dataset.state).toBe('running');
  });

  it('completing an entry marks it done so it dims', () => {
    const id = api.pushEntry({ agent: 'PLANNER', message: 'thinking' });
    api.complete(id, 'plan ready');
    const entry = host.querySelector('.console-entry');
    expect(entry.dataset.state).toBe('done');
    expect(entry.querySelector('.console-msg').textContent).toBe('plan ready');
  });

  it('requires an agent name', () => {
    expect(() => api.pushEntry({ message: 'orphan' })).toThrow();
  });

  it('clears all entries back to the placeholder', () => {
    api.pushEntry({ agent: 'A', message: '1' });
    api.pushEntry({ agent: 'B', message: '2' });
    expect(api.size).toBe(2);
    api.clear();
    expect(api.size).toBe(0);
    expect(host.querySelector('.console-empty').style.display).toBe('');
  });
});
