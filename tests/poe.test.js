import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPoe } from '../src/components/poe.js';

// Poe conversation component. Mounted into a detached node. The agent-console
// and the layout measurer are injected (jsdom has no layout, so measure() is a
// stub returning fixed dimensions, the same DI rationale as the dispatcher).

function fakeConsole() {
  let seq = 0;
  const entries = new Map();
  return {
    pushEntry: vi.fn(({ agent, message, state }) => {
      const id = `e${(seq += 1)}`;
      entries.set(id, { agent, message, state });
      return id;
    }),
    updateEntry: vi.fn((id, patch) => {
      const e = entries.get(id);
      if (e) Object.assign(e, patch);
      return true;
    }),
    complete: vi.fn((id) => {
      const e = entries.get(id);
      if (e) e.state = 'done';
      return true;
    }),
    entries,
  };
}

describe('poe conversation component', () => {
  let host;
  let poe;
  let con;
  let measure;

  beforeEach(() => {
    host = document.createElement('div');
    con = fakeConsole();
    measure = vi.fn(() => ({ width: 320, height: 120 }));
    poe = createPoe();
  });

  it('mounts an idle shell with a hidden indicator and a methods-only API', () => {
    const api = poe.mount(host, { console: con, measure });
    expect(host.classList.contains('poe')).toBe(true);
    expect(host.querySelector('.poe-indicator').hidden).toBe(true);
    expect(host.querySelector('.poe-empty')).toBeTruthy();
    expect(Object.keys(api).sort()).toEqual([
      'mount',
      'receive',
      'setStatus',
      'showThinking',
      'stream',
    ]);
    Object.values(api).forEach((v) => expect(typeof v).toBe('function'));
  });

  it('throws when a method runs before mount, and when mount has no target', () => {
    const fresh = createPoe();
    expect(() => fresh.receive({ agentId: 'A', content: 'x' })).toThrow();
    expect(() => poe.mount(null)).toThrow();
  });

  it('receive renders a final card attributed to the agent with its content', () => {
    poe.mount(host, { console: con, measure });
    poe.receive({ agentId: 'PLANNER', content: 'here is the plan' });
    const card = host.querySelector('.poe-card');
    expect(card.dataset.agent).toBe('PLANNER');
    expect(card.dataset.state).toBe('final');
    expect(card.querySelector('.poe-card-agent').textContent).toBe('[PLANNER]');
    expect(card.querySelector('.poe-card-body').textContent).toBe('here is the plan');
    expect(host.querySelector('.poe-empty').style.display).toBe('none');
  });

  it('receive pretty-prints an object packet and requires an agent id', () => {
    poe.mount(host, { measure });
    poe.receive({ agentId: 'A', content: { ok: true } });
    expect(host.querySelector('.poe-card-body').textContent).toContain('"ok": true');
    expect(() => poe.receive({ content: 'orphan' })).toThrow();
  });

  it('setStatus resolves copy from the registry, shows the indicator, mirrors to the console', () => {
    const registry = { PLANNER: { thinking: 'drafting the plan' } };
    poe.mount(host, { console: con, registry, measure });
    poe.setStatus('PLANNER', 'thinking');
    expect(host.querySelector('.poe-indicator').hidden).toBe(false);
    expect(host.querySelector('.poe-indicator-label .bracket').textContent).toBe('[PLANNER]');
    expect(host.querySelector('.poe-status-copy').textContent).toBe('drafting the plan');
    expect(con.pushEntry).toHaveBeenCalledTimes(1);
    expect(con.pushEntry.mock.calls[0][0]).toMatchObject({
      agent: 'PLANNER',
      message: 'drafting the plan',
      state: 'running',
    });
  });

  it('setStatus falls back to the literal key, and a null agent hides the indicator', () => {
    poe.mount(host, { console: con, measure });
    poe.setStatus('A', 'literal message');
    expect(host.querySelector('.poe-status-copy').textContent).toBe('literal message');
    poe.setStatus(null);
    expect(host.querySelector('.poe-indicator').hidden).toBe(true);
  });

  it('setStatus reuses one console entry per agent across calls', () => {
    poe.mount(host, { console: con, measure });
    poe.setStatus('A', 'one');
    poe.setStatus('A', 'two');
    expect(con.pushEntry).toHaveBeenCalledTimes(1);
    expect(con.updateEntry).toHaveBeenCalledTimes(1);
  });

  it('stream appends raw chunks into a pending card; receive then replaces them', () => {
    poe.mount(host, { measure });
    poe.stream('WRITER', 'Hello ');
    poe.stream('WRITER', 'world');
    const pending = host.querySelector('.poe-card[data-agent="WRITER"]');
    expect(pending.dataset.state).toBe('pending');
    expect(pending.querySelector('.poe-card-body').textContent).toBe('Hello world');

    poe.receive({ agentId: 'WRITER', content: 'FINAL' });
    const cards = host.querySelectorAll('.poe-card[data-agent="WRITER"]');
    expect(cards.length).toBe(1); // same card finalized, not a second one
    expect(cards[0].dataset.state).toBe('final');
    expect(cards[0].querySelector('.poe-card-body').textContent).toBe('FINAL');
  });

  it('showThinking renders a collapsed accordion labelled "Show reasoning"', () => {
    poe.mount(host, { measure });
    poe.showThinking('A', [{ type: 'reasoning', text: 'step 1' }]);
    const details = host.querySelector('details.poe-thinking');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('Show reasoning');
    expect(details.querySelectorAll('.poe-think-step').length).toBe(1);
  });

  it('groups consecutive thinking for one agent into one section; another agent gets its own', () => {
    poe.mount(host, { measure });
    poe.showThinking('A', [{ type: 'reasoning', text: 's1' }]);
    poe.showThinking('A', [{ type: 'tool_call', name: 'SEARCH', args: { q: 'x' } }]);
    const aSections = host.querySelectorAll('.poe-turn[data-agent="A"] details.poe-thinking');
    expect(aSections.length).toBe(1);
    expect(aSections[0].querySelectorAll('.poe-think-step').length).toBe(2);
    expect(aSections[0].querySelector('.poe-step-tool').textContent).toBe('[SEARCH]');

    poe.showThinking('B', [{ type: 'reasoning', text: 's' }]);
    expect(host.querySelectorAll('details.poe-thinking').length).toBe(2);
  });

  it('caches measured dims on receive and renders a skeleton at the exact size next turn', () => {
    poe.mount(host, { console: con, measure });
    poe.receive({ agentId: 'A', content: 'first answer' });
    expect(measure).toHaveBeenCalledTimes(1);

    poe.setStatus('A', 'thinking again');
    const skel = host.querySelector('.poe-card[data-state="skeleton"] .poe-skeleton');
    expect(skel).toBeTruthy();
    expect(skel.classList.contains('skeleton')).toBe(true);
    expect(skel.style.width).toBe('320px');
    expect(skel.style.height).toBe('120px');
  });

  it('renders no sized skeleton for an agent with no prior measurement', () => {
    poe.mount(host, { measure });
    poe.setStatus('NEW', 'thinking');
    expect(host.querySelector('.poe-skeleton')).toBeNull();
    expect(host.querySelector('.poe-card[data-state="skeleton"]')).toBeNull();
  });

  it('replaces a skeleton in place when its result arrives (no duplicate card)', () => {
    poe.mount(host, { measure });
    poe.receive({ agentId: 'A', content: 'one' }); // measures + caches dims
    poe.setStatus('A', 'again'); // skeleton for the new turn
    expect(host.querySelectorAll('.poe-card[data-agent="A"]').length).toBe(2);

    poe.receive({ agentId: 'A', content: 'two' }); // finalizes the skeleton
    const aCards = host.querySelectorAll('.poe-card[data-agent="A"]');
    expect(aCards.length).toBe(2);
    expect(aCards[1].dataset.state).toBe('final');
    expect(aCards[1].querySelector('.poe-card-body').textContent).toBe('two');
  });

  it('keeps every conversation node under the mount target (TurnGate)', () => {
    const api = poe.mount(host, { measure });
    poe.receive({ agentId: 'A', content: 'x' });
    Object.values(api).forEach((v) => expect(typeof v).toBe('function'));
    host
      .querySelectorAll('.poe-card, .poe-turn, .poe-indicator, .poe-stream')
      .forEach((n) => expect(host.contains(n)).toBe(true));
  });
});
