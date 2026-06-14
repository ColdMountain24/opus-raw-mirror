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
    complete: vi.fn((id, message) => {
      const e = entries.get(id);
      if (e) {
        e.state = 'done';
        if (typeof message === 'string') e.message = message;
      }
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
      'cessationCard',
      'mount',
      'receive',
      'setStatus',
      'settle',
      'showThinking',
      'stream',
      'userTurn',
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

  it('cessationCard renders the completion card with the finalized facts and wires the CTA', () => {
    poe.mount(host, { console: con, measure });
    const onClick = vi.fn();
    poe.cessationCard({
      researchQuestion: 'Does intermittent fasting improve memory in older adults?',
      paradigm: 'clinical',
      noveltySignal: 'high',
      cta: { label: 'Proceed to Literature Review', onClick },
    });

    const card = host.querySelector('.poe-cessation');
    expect(card).toBeTruthy();
    expect(card.textContent).toContain('Does intermittent fasting improve memory in older adults?');
    expect(card.textContent).toContain('clinical');
    expect(card.textContent).toContain('high');
    // The finalized question reads as confirmed (green), per the token law.
    expect(card.querySelector('.poe-cessation-value.is-confirmed')).toBeTruthy();
    // The empty placeholder is hidden once a card is in the feed.
    expect(host.querySelector('.poe-empty').style.display).toBe('none');

    const btn = card.querySelector('.poe-cessation-cta');
    expect(btn.textContent).toBe('Proceed to Literature Review');
    btn.click();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('cessationCard requires a mount and tolerates missing facts', () => {
    const fresh = createPoe();
    expect(() => fresh.cessationCard({})).toThrow(); // not mounted
    poe.mount(host, { console: con, measure });
    expect(() => poe.cessationCard({})).not.toThrow();
    const value = host.querySelector('.poe-cessation-value');
    expect(value.textContent).toBe('not set'); // absent fact renders a placeholder, not blank
  });

  it('cessationCard renders the full trust layer: badge, banner, collapsible evaluation, and KaTeX math', () => {
    poe.mount(host, { console: con, measure });
    poe.cessationCard({
      researchQuestion: 'Does the dose $d = 2^n$ scale linearly?',
      paradigm: 'clinical',
      noveltySignal: 'low',
      confidence: { level: 'low', label: 'Needs review', tooltip: 'lots of overlap / scope concern' },
      requiresHumanReview: true,
      reviewReasons: ['completeness 0.70 is below 0.85', 'novelty signal is low'],
      evaluation: {
        cvScore: 0.7,
        resolvedBlockingFields: ['the population'],
        paradigm: 'clinical',
        paradigmRationale: ['scope is appropriate'],
        noveltySignal: 'low',
        noveltyRationale: 'Close to $\\alpha$ prior work.',
        overlappingPapers: ['Prior trial A', 'Prior trial B'],
      },
      cta: { label: 'Proceed to Literature Review', onClick: () => {} },
    });

    const card = host.querySelector('.poe-cessation');

    // Confidence badge: three separate elements (pill + label + tooltip).
    const pill = card.querySelector('.poe-badge-pill');
    expect(pill.dataset.level).toBe('low');
    expect(card.querySelector('.poe-badge-label').textContent).toBe('Needs review');
    const tooltip = card.querySelector('.poe-badge-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip.textContent).toContain('lots of overlap');

    // requires_human_review banner.
    const banner = card.querySelector('.poe-cessation-banner');
    expect(banner).toBeTruthy();
    expect(card.dataset.review).toBe('required');
    expect(banner.textContent).toContain('below 0.85');

    // Collapsible evaluation breakdown.
    const details = card.querySelector('details.poe-cessation-eval');
    expect(details).toBeTruthy();
    expect(details.querySelector('summary').textContent).toBe('Show evaluation');
    expect(details.textContent).toContain('the population'); // resolved blocking field
    expect(details.textContent).toContain('Prior trial A'); // overlapping paper cited

    // KaTeX math in the research question and in the (eval) rationale.
    const rqValue = card.querySelector('.poe-cessation-value');
    expect(rqValue.innerHTML).toContain('class="katex"');
    expect(details.innerHTML).toContain('class="katex"');
  });

  it('cessationCard omits the badge, banner, and evaluation when the trust model is absent', () => {
    poe.mount(host, { console: con, measure });
    poe.cessationCard({ researchQuestion: 'plain question', cta: { label: 'Go', onClick: () => {} } });
    const card = host.querySelector('.poe-cessation');
    expect(card.querySelector('.poe-cessation-badge')).toBeNull();
    expect(card.querySelector('.poe-cessation-banner')).toBeNull();
    expect(card.querySelector('details.poe-cessation-eval')).toBeNull();
    expect(card.dataset.review).toBeUndefined();
    expect(card.querySelector('.poe-cessation-maxwarning')).toBeNull();
  });

  it('cessationCard renders the max-reached note (a warning, not a stop) when present', () => {
    poe.mount(host, { console: con, measure });
    poe.cessationCard({
      researchQuestion: 'q',
      maxWarning: { kind: 'max_reached', iteration: 5, max_iterations: 5, message: 'Hit the limit of 5 rounds.' },
      cta: { label: 'Go', onClick: () => {} },
    });
    const card = host.querySelector('.poe-cessation');
    const note = card.querySelector('.poe-cessation-maxwarning');
    expect(note).toBeTruthy();
    expect(note.textContent).toContain('Hit the limit of 5 rounds.');
    expect(card.dataset.maxReached).toBe('true');
  });

  it('settle closes a backstage agent console entry done, with no conversation card or turn', () => {
    poe.mount(host, { console: con, registry: { CV: { running: 'checking', complete: 'done checking' } }, measure });
    poe.setStatus('CV', 'running');
    poe.setStatus('CV', 'complete');
    // A backstage agent leaves no conversation node before it settles.
    expect(host.querySelector('.poe-card')).toBeNull();
    expect(host.querySelector('.poe-turn')).toBeNull();

    poe.settle('CV');
    // The agent-console entry ends done; still no conversation card or turn.
    const entry = [...con.entries.values()].find((e) => e.agent === 'CV');
    expect(entry.state).toBe('done');
    expect(host.querySelector('.poe-card')).toBeNull();
    expect(host.querySelector('.poe-turn')).toBeNull();
    expect(() => poe.settle('')).toThrow();
  });

  it('settle surfaces the agent outcome summary in the console entry', () => {
    poe.mount(host, { console: con, registry: { CV: { running: 'checking', complete: 'done' } }, measure });
    poe.setStatus('CV', 'running');
    poe.settle('CV', 'Completeness 50% (fail). Blocking: Claims.');
    const entry = [...con.entries.values()].find((e) => e.agent === 'CV');
    expect(entry.state).toBe('done');
    expect(entry.message).toBe('Completeness 50% (fail). Blocking: Claims.');
  });

  it('userTurn renders the researcher message and hides the empty placeholder', () => {
    poe.mount(host, { console: con, measure });
    expect(host.querySelector('.poe-empty').style.display).not.toBe('none');
    poe.userTurn('Does fasting improve memory?');
    const turn = host.querySelector('.poe-user-turn');
    expect(turn).toBeTruthy();
    expect(turn.querySelector('.poe-card-agent').textContent).toBe('[YOU]');
    expect(turn.querySelector('.poe-card-body').textContent).toBe('Does fasting improve memory?');
    expect(host.querySelector('.poe-empty').style.display).toBe('none');
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
