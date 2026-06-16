import { describe, expect, it, vi } from 'vitest';
import { mountObservatory } from '../src/components/observatory.js';

// The Observatory (Cytoscape) component. The renderer is dependency-injected as a stub
// (jsdom has no WebGL/canvas layout), so these prove the data model + incremental-add
// logic + click wiring without instantiating the real renderer - the same DI rationale
// as Poe's measure().

function fakeCy() {
  // Backs add()/getElementById() with an in-memory node-data store so the update-seam tests can
  // mutate a node and read it back, while add() stays a spy for the incremental-add assertions.
  const store = new Map();
  const cy = {
    add: vi.fn((els) => {
      (Array.isArray(els) ? els : [els]).forEach((el) => {
        if (el && el.group === 'nodes' && el.data && el.data.id != null) store.set(el.data.id, { ...el.data });
      });
    }),
    getElementById: vi.fn((id) => {
      const exists = store.has(id);
      return {
        empty: () => !exists,
        length: exists ? 1 : 0,
        data: (k, v) => {
          if (v === undefined) return exists ? store.get(id)[k] : undefined;
          if (exists) store.get(id)[k] = v;
          return v;
        },
        animate: vi.fn(),
        remove: vi.fn(() => store.delete(id)),
      };
    }),
    style: vi.fn(() => ({ update: vi.fn() })),
    _data: (id) => store.get(id),
    on: vi.fn(),
    off: vi.fn(),
    layout: vi.fn(() => ({ run: vi.fn() })),
    elements: vi.fn(() => ({ remove: vi.fn(() => store.clear()), boundingBox: () => ({ x1: 0, y1: 0, x2: 10, y2: 10, w: 10, h: 10 }) })),
    nodes: vi.fn(() => ({ forEach: () => {} })),
    extent: vi.fn(() => ({ x1: 0, y1: 0, x2: 10, y2: 10, w: 10, h: 10 })),
    fit: vi.fn(),
    destroy: vi.fn(),
    pan: vi.fn(),
    zoom: vi.fn(() => 1),
    width: vi.fn(() => 100),
    height: vi.fn(() => 100),
  };
  return cy;
}

function mountWith(extra = {}) {
  const target = document.createElement('div');
  const cy = fakeCy();
  const cytoscape = vi.fn(() => cy);
  const obs = mountObservatory(target, { cytoscape, ...extra });
  return { target, cy, cytoscape, obs };
}

const SUB = { data: { id: 's1', type: 'subspecialization', label: 'Cognitive aging' } };
const CLAIM = { data: { id: 'c1', type: 'claim', confidence: 'high', label: 'fasting aids memory' } };
const PAPER = { data: { id: 'p1', type: 'paper', label: 'Smith 2021' } };
const EDGE = { data: { id: 'e1', source: 'c1', target: 'p1', type: 'supports' } };

describe('mountObservatory', () => {
  it('requires a target', () => {
    expect(() => mountObservatory(null)).toThrow();
  });

  it('inits the injected renderer with the type/confidence style, pan+zoom, and the idle copy', () => {
    const { target, cytoscape, obs } = mountWith();
    expect(cytoscape).toHaveBeenCalledTimes(1);
    const config = cytoscape.mock.calls[0][0];
    expect(config.userZoomingEnabled).toBe(true);
    expect(config.userPanningEnabled).toBe(true);
    const selectors = config.style.map((s) => s.selector);
    expect(selectors).toContain('node[type="subspecialization"]');
    expect(selectors).toContain('node[type="claim"][confidence="high"]');
    expect(selectors).toContain('node[type="claim"][confidence="uncertain"]');
    expect(selectors).toContain('node[type="paper"]');
    expect(selectors).toContain('edge[type="contradicts"]');
    expect(target.querySelector('.observatory-empty').textContent).toMatch(/Observatory idle/);
    expect(target.querySelector('.observatory-minimap')).toBeTruthy();
    expect(obs.hasGraph()).toBe(true);
  });

  it('adds elements incrementally: only NEW nodes/edges are added on a second call', () => {
    const { cy, obs, target } = mountWith();

    const first = obs.addElements({ nodes: [SUB, CLAIM], edges: [] });
    expect(first.added).toBe(2);
    expect(cy.add).toHaveBeenCalledTimes(1);
    expect(cy.add.mock.calls[0][0].map((e) => e.data.id)).toEqual(['s1', 'c1']);
    expect(target.dataset.graph).toBe('true');
    expect(target.querySelector('.observatory-empty').style.display).toBe('none');

    // s1 + c1 already in the graph; only p1 + e1 are new.
    const second = obs.addElements({ nodes: [SUB, CLAIM, PAPER], edges: [EDGE] });
    expect(second.added).toBe(2);
    expect(cy.add).toHaveBeenCalledTimes(2);
    expect(cy.add.mock.calls[1][0].map((e) => e.data.id)).toEqual(['p1', 'e1']);

    // A third call with nothing new makes no add.
    expect(obs.addElements({ nodes: [SUB] }).added).toBe(0);
    expect(cy.add).toHaveBeenCalledTimes(2);
  });

  it('runs an incremental (non-randomizing, non-fitting) layout on each add', () => {
    const { cy, obs } = mountWith();
    obs.addElements({ nodes: [SUB] });
    expect(cy.layout).toHaveBeenCalledTimes(1);
    const layoutArg = cy.layout.mock.calls[0][0];
    expect(layoutArg.name).toBe('cose-bilkent');
    expect(layoutArg.randomize).toBe(false);
    expect(layoutArg.fit).toBe(false);
  });

  it('reports a clicked node\'s data to onNodeClick', () => {
    const onNodeClick = vi.fn();
    const { cy } = mountWith({ onNodeClick });
    const tap = cy.on.mock.calls.find((c) => c[0] === 'tap' && c[1] === 'node');
    expect(tap).toBeTruthy();
    const handler = tap[2];
    handler({ target: { data: () => ({ id: 'c1', type: 'claim' }) } });
    expect(onNodeClick).toHaveBeenCalledWith({ id: 'c1', type: 'claim' });
  });

  it('clear removes all elements and resets the incremental dedup', () => {
    const { cy, obs, target } = mountWith();
    obs.addElements({ nodes: [SUB] });
    obs.clear();
    expect(target.dataset.graph).toBe('false');
    // After clear, the same id is treated as new again.
    const after = obs.addElements({ nodes: [SUB] });
    expect(after.added).toBe(1);
  });

  it('destroy tears down the renderer and its DOM', () => {
    const { cy, obs, target } = mountWith();
    obs.destroy();
    expect(cy.destroy).toHaveBeenCalledTimes(1);
    expect(target.children.length).toBe(0);
  });

  it('exposes the claim lifecycle state selectors in the style', () => {
    const { cytoscape } = mountWith();
    const selectors = cytoscape.mock.calls[0][0].style.map((s) => s.selector);
    expect(selectors).toContain('node[state="loading"]');
    expect(selectors).toContain('node[type="claim"][state="confirmed"]');
    expect(selectors).toContain('node[type="claim"][state="rejected"]');
    // The Senior Grad Student quality-review dimension (separate from the Salvia state).
    expect(selectors).toContain('node[type="claim"][review="flag"]');
  });

  it('setNodeData can carry the Senior-review quality flag onto a live claim node', () => {
    const { cy, obs } = mountWith();
    obs.addElements({ nodes: [{ data: { id: 'c1', type: 'claim', label: 'x', state: 'confirmed' } }] });
    obs.setNodeData('c1', { review: 'flag' });
    expect(cy._data('c1').review).toBe('flag');
    expect(cy._data('c1').state).toBe('confirmed'); // the Salvia state is preserved alongside
  });

  it('removeElements drops a rejected claim node and frees its id from the dedup set', () => {
    const { cy, obs } = mountWith();
    obs.addElements({ nodes: [SUB, CLAIM] });
    const r = obs.removeElements(['c1']);
    expect(r.removed).toBe(1);
    expect(cy._data('c1')).toBeUndefined();

    // The freed id is treated as new again on a later add (dedup set was cleared for it).
    cy.add.mockClear();
    const after = obs.addElements({ nodes: [CLAIM] });
    expect(after.added).toBe(1);
  });

  it('removeElements is a guarded no-op for an unknown id and without a renderer', () => {
    const { obs } = mountWith();
    expect(obs.removeElements(['nope']).removed).toBe(0);
    const bare = mountObservatory(document.createElement('div'), { cytoscape: null });
    expect(bare.removeElements(['x']).removed).toBe(0);
  });

  it('updateElements merges data onto an existing node in place, without re-adding it', () => {
    const { cy, obs } = mountWith();
    obs.addElements({ nodes: [{ data: { id: 'c1', type: 'claim', label: 'x', state: 'loading' } }] });
    cy.add.mockClear();

    const r = obs.updateElements({ nodes: [{ data: { id: 'c1', state: 'confirmed', confidence: null } }] });
    expect(r.updated).toBe(1);
    expect(cy.add).not.toHaveBeenCalled(); // a transition mutates the live node, never re-adds
    expect(cy._data('c1').state).toBe('confirmed');
    expect(cy._data('c1').label).toBe('x'); // existing data preserved
  });

  it('setNodeData / updateElements no-op for unknown nodes and without a renderer', () => {
    const { obs } = mountWith();
    expect(obs.setNodeData('missing', { state: 'confirmed' }).updated).toBe(0);

    const bare = mountObservatory(document.createElement('div'), { cytoscape: null });
    expect(bare.updateElements({ nodes: [{ data: { id: 'x', state: 'confirmed' } }] }).updated).toBe(0);
  });

  it('degrades to a no-op harness (no throw) when the renderer is unavailable', () => {
    const target = document.createElement('div');
    const obs = mountObservatory(target, { cytoscape: null });
    expect(obs.hasGraph()).toBe(false);
    expect(() => obs.addElements({ nodes: [SUB] })).not.toThrow();
    expect(obs.addElements({ nodes: [SUB] }).added).toBe(0);
    expect(target.querySelector('.observatory-graph')).toBeTruthy();
  });
});

// ----- GlobalKG view toggle + in-memory filter + support-weighted sizing + contradiction halo -----

describe('Observatory GlobalKG view + filter panel', () => {
  // view-global nodes; the streamed (no-view) nodes belong to the subspec view.
  const GSUB = { data: { id: 'gsub::s1', type: 'subspecialization', view: 'global', label: 's1', claimCount: 4 } };
  const GCLAIM_S1 = { data: { id: 's1::a', type: 'claim', view: 'global', label: 'a', subspecialization_id: 's1', claim_type: ['causal'], confidence: null, quality: 'pass', supportCount: 1 } };
  const GCLAIM_S2 = { data: { id: 's2::b', type: 'claim', view: 'global', label: 'b', subspecialization_id: 's2', claim_type: ['descriptive'], confidence: null, quality: 'flag', supportCount: 5 } };
  const GEDGE = { data: { id: 'contra::s1::a::s2::b', source: 's1::a', target: 's2::b', type: 'contradicts' } };

  it('exposes the global-view size selector and the contradiction halo selector in the style', () => {
    const { cytoscape } = mountWith();
    const selectors = cytoscape.mock.calls[0][0].style.map((s) => s.selector);
    expect(selectors).toContain('node[view="global"]');
    expect(selectors).toContain('node[contradiction=1]');
  });

  it('setView toggles between the per-subspecialization graph and the unified GlobalKG graph', () => {
    const { obs } = mountWith();
    obs.addElements({ nodes: [SUB, CLAIM, GSUB, GCLAIM_S1], edges: [] });
    // Default subspec view: the streamed (no-view) nodes show, the global nodes are hidden.
    expect(obs.getView()).toBe('subspec');
    expect(obs.isVisible('s1')).toBe(true);
    expect(obs.isVisible('c1')).toBe(true);
    expect(obs.isVisible('gsub::s1')).toBe(false);
    expect(obs.isVisible('s1::a')).toBe(false);
    // Switch to the global view: the global nodes show, the streamed nodes hide.
    obs.setView('global');
    expect(obs.getView()).toBe('global');
    expect(obs.isVisible('s1::a')).toBe(true);
    expect(obs.isVisible('gsub::s1')).toBe(true);
    expect(obs.isVisible('s1')).toBe(false);
    expect(obs.isVisible('c1')).toBe(false);
  });

  it('an edge is visible only when both endpoints are in the active view', () => {
    const { obs } = mountWith();
    obs.addElements({ nodes: [GCLAIM_S1, GCLAIM_S2], edges: [GEDGE] });
    expect(obs.isVisible('contra::s1::a::s2::b')).toBe(false); // subspec view: endpoints hidden
    obs.setView('global');
    expect(obs.isVisible('contra::s1::a::s2::b')).toBe(true);
  });

  it('filters by subspecialization against the in-memory model and restores on clear', () => {
    const { obs } = mountWith();
    obs.addElements({ nodes: [GCLAIM_S1, GCLAIM_S2], edges: [GEDGE] });
    obs.setView('global');
    obs.setFilter({ subspecializations: ['s1'] });
    expect(obs.isVisible('s1::a')).toBe(true);
    expect(obs.isVisible('s2::b')).toBe(false);
    expect(obs.isVisible('contra::s1::a::s2::b')).toBe(false); // an endpoint is filtered out
    obs.setFilter(null);
    expect(obs.isVisible('s2::b')).toBe(true);
  });

  it('filters by claim type, confidence (unassigned), and quality flag', () => {
    const { obs } = mountWith();
    obs.addElements({ nodes: [GCLAIM_S1, GCLAIM_S2] });
    obs.setView('global');

    obs.setFilter({ claimTypes: ['causal'] });
    expect(obs.isVisible('s1::a')).toBe(true); // claim_type ['causal']
    expect(obs.isVisible('s2::b')).toBe(false); // claim_type ['descriptive']

    // confidence is null until Post-Doc -> the 'unassigned' bucket holds every claim today.
    obs.setFilter({ confidences: ['unassigned'] });
    expect(obs.isVisible('s1::a')).toBe(true);
    expect(obs.isVisible('s2::b')).toBe(true);
    obs.setFilter({ confidences: ['high'] });
    expect(obs.isVisible('s1::a')).toBe(false);

    obs.setFilter({ qualityFlags: ['flag'] });
    expect(obs.isVisible('s1::a')).toBe(false); // quality 'pass'
    expect(obs.isVisible('s2::b')).toBe(true); // quality 'flag'
  });

  it('sizes a global claim by supporting-paper count and a global subspec by claim count', () => {
    const { cy, obs } = mountWith();
    obs.addElements({ nodes: [GSUB, GCLAIM_S1, GCLAIM_S2] });
    // claim sizing is monotonic in supportCount (1 -> smaller than 5), within the clamp.
    expect(cy._data('s1::a').size).toBeLessThan(cy._data('s2::b').size);
    // a subspecialization is sized off its claimCount, distinct from the per-type fixed 46.
    expect(typeof cy._data('gsub::s1').size).toBe('number');
    expect(cy._data('gsub::s1').size).toBeGreaterThan(0);
  });

  it('hides a paper orphaned by a filter (no visible incident edge) and restores it on clear', () => {
    const { obs } = mountWith();
    // subspec-view sub-graph: a claim, its source paper, the derived-from edge.
    obs.addElements({
      nodes: [
        { data: { id: 'c1', type: 'claim', label: 'a', subspecialization_id: 's1' } },
        { data: { id: 'paper::p1', type: 'paper', label: 'p1' } },
      ],
      edges: [{ data: { id: 'df::c1', source: 'c1', target: 'paper::p1', type: 'derived-from' } }],
    });
    expect(obs.isVisible('paper::p1')).toBe(true);
    obs.setFilter({ subspecializations: ['s2'] }); // filters the claim out
    expect(obs.isVisible('c1')).toBe(false);
    expect(obs.isVisible('paper::p1')).toBe(false); // orphaned -> hidden
    obs.setFilter(null);
    expect(obs.isVisible('paper::p1')).toBe(true);
  });
});
