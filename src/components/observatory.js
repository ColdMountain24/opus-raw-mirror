import './observatory.css';
import cytoscapeLib from 'cytoscape';
import coseBilkent from 'cytoscape-cose-bilkent';

// The Observatory: Loop 2's Cytoscape.js knowledge-graph canvas (The Archive).
//
// The primary visual surface for Loop 2. It renders the SubspecializationKG + GlobalKG
// as a force-directed (cose-bilkent) node-edge graph and updates INCREMENTALLY as the
// Bookkeeper promotes nodes - only new nodes/edges are added, the existing graph is
// never re-laid-out from scratch. Pan + zoom + a minimap; clicking a node reports its
// data to the caller (main.js shows it in the IO panel).
//
// Schema-agnostic, the same family as poe.js: it reads a small documented set of
// presentation fields off each element - node `data.type` in {subspecialization, claim,
// paper} with `data.confidence` in {high, uncertain} for claims, and edge `data.type` in
// {supports, contradicts, derived-from} - and never defines the KG shape (that is the
// agents' FINAL output). Cytoscape, the cose-bilkent layout, and the minimap canvas are
// dependency-injected and guarded (the same DI rationale as Poe's measure()): jsdom has
// no renderer, so tests inject a stub cy and the real layout never runs.
//
// NOTE: Cytoscape's style engine does not read CSS custom properties, so the node/edge
// colors below are the LITERAL Dusty-palette token values (kept in sync with tokens.css):
//   --accent-bracket #94621A (amber/ochre)  --accent-active #4A6B1F (olive/green)
//   --fg-dim #6B6044 (muted/grey)           --surface-document #F6F1E1 (cream/white)
//   --accent-error #9B3B2E (brick red)      --bevel-dark #8C7C54   --fg-default #2E2616

let layoutRegistered = false;
function ensureLayout(cy) {
  if (layoutRegistered || !cy || typeof cy.use !== 'function') return;
  try {
    cy.use(coseBilkent);
    layoutRegistered = true;
  } catch (_err) {
    // already registered (or unavailable): the layout falls back to a no-op run
    layoutRegistered = true;
  }
}

// Incremental cose-bilkent: keep existing positions (randomize:false) and do not snap the
// viewport (fit:false), so a promotion settles only the new nodes.
const INCREMENTAL_LAYOUT = {
  name: 'cose-bilkent',
  randomize: false,
  fit: false,
  animate: 'end',
  animationDuration: 400,
  nodeDimensionsIncludeLabels: true,
};

// Square nodes (no border-radius, the structural law). Type/confidence selectors carry
// the size + color contract.
const STYLE = [
  {
    selector: 'node',
    style: {
      shape: 'rectangle',
      label: 'data(label)',
      color: '#2E2616',
      'font-family': 'monospace',
      'font-size': 9,
      'text-valign': 'bottom',
      'text-halign': 'center',
      'text-margin-y': 3,
      'text-wrap': 'ellipsis',
      'text-max-width': 90,
      'background-color': '#CFC2A0',
      'border-width': 1,
      'border-color': '#8C7C54',
    },
  },
  // Subspecialization: large, amber.
  { selector: 'node[type="subspecialization"]', style: { width: 46, height: 46, 'background-color': '#94621A', color: '#F6F1E1', 'font-size': 11 } },
  // Claim: medium, green when high-confidence, muted/grey when uncertain.
  { selector: 'node[type="claim"]', style: { width: 28, height: 28 } },
  { selector: 'node[type="claim"][confidence="high"]', style: { 'background-color': '#4A6B1F', color: '#F6F1E1' } },
  { selector: 'node[type="claim"][confidence="uncertain"]', style: { 'background-color': '#6B6044', color: '#F6F1E1' } },
  // Claim lifecycle states (Grad Student streaming). Confidence is null until Post-Doc, so a
  // streaming claim is confidence-NEUTRAL; `state` drives the loading -> parsed -> confirmed
  // (olive border) / flagged-rejected (brick border) transition. The confidence selectors above
  // take over only once Post-Doc assigns confidence in a later phase.
  { selector: 'node[state="loading"]', style: { 'background-opacity': 0.4, 'border-style': 'dashed', 'border-color': '#8C7C54', 'border-width': 1 } },
  { selector: 'node[type="claim"][state="parsed"]', style: { 'background-opacity': 1, 'border-style': 'solid', 'border-color': '#8C7C54' } },
  { selector: 'node[type="claim"][state="confirmed"]', style: { 'background-opacity': 1, 'border-style': 'solid', 'border-color': '#4A6B1F', 'border-width': 2 } },
  { selector: 'node[type="claim"][state="flagged"]', style: { 'border-style': 'solid', 'border-color': '#9B3B2E', 'border-width': 2 } },
  { selector: 'node[type="claim"][state="rejected"]', style: { 'background-opacity': 0.5, 'border-style': 'dotted', 'border-color': '#9B3B2E', 'border-width': 2 } },
  // Senior Grad Student quality review (a SEPARATE dimension from the Salvia `state` above): a
  // flagged claim is kept in the KG but wears an amber/ochre quality ring so it reads as "kept,
  // with a concern". A rejected claim is removed from the graph entirely (removeElements), so it
  // has no style. The amber ring layers over whatever Salvia state the node already carries.
  { selector: 'node[type="claim"][review="flag"]', style: { 'border-style': 'double', 'border-color': '#94621A', 'border-width': 4 } },
  // Paper: small, white/cream.
  { selector: 'node[type="paper"]', style: { width: 16, height: 16, 'background-color': '#F6F1E1' } },
  // GlobalKG (unified) view: claim/subspecialization nodes are sized by data(size) - supporting-paper
  // count for a claim, claim count for a subspecialization. The metric rides on the node data; the
  // renderer owns the pixel mapping (see sizeForGlobalNode). Placed after the per-type rules so it
  // overrides their fixed width/height in the global view only.
  { selector: 'node[view="global"]', style: { width: 'data(size)', height: 'data(size)' } },
  // A claim that participates in a contradiction wears a red halo (cytoscape underlay), so a
  // contradiction cluster reads at a glance in the unified view. A separate dimension from the
  // brick state/border above (which is the Salvia state); this is set from contradiction_partners.
  { selector: 'node[contradiction=1]', style: { 'underlay-color': '#9B3B2E', 'underlay-opacity': 0.25, 'underlay-padding': 8 } },
  // Edges by relation type.
  { selector: 'edge', style: { 'curve-style': 'straight', width: 1, 'line-color': '#8C7C54', 'target-arrow-color': '#8C7C54', 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7 } },
  { selector: 'edge[type="supports"]', style: { 'line-color': '#4A6B1F', 'target-arrow-color': '#4A6B1F', width: 2 } },
  { selector: 'edge[type="contradicts"]', style: { 'line-color': '#9B3B2E', 'target-arrow-color': '#9B3B2E', 'line-style': 'dashed', width: 2 } },
  { selector: 'edge[type="derived-from"]', style: { 'line-color': '#6B6044', 'target-arrow-color': '#6B6044', 'line-style': 'dotted', width: 1 } },
];

export const OBSERVATORY_STYLE = STYLE;

// The GlobalKG-view node sizing contract (renderer-owned pixel mapping). A claim grows with its
// supporting-paper count, a subspecialization with its claim count, both clamped so a dense node
// never swamps the canvas. The agent supplies the COUNT (supportCount / claimCount); the pixels
// live here, like the fixed per-type sizes above.
const GLOBAL_NODE_SIZE = { base: 24, step: 6, min: 22, max: 60 };

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sizeForGlobalNode(data) {
  const metric = data && data.type === 'subspecialization' ? Number(data.claimCount) : Number(data.supportCount);
  const count = Number.isFinite(metric) && metric > 0 ? metric : 0;
  return clamp(GLOBAL_NODE_SIZE.base + count * GLOBAL_NODE_SIZE.step, GLOBAL_NODE_SIZE.min, GLOBAL_NODE_SIZE.max);
}

// A node's view membership: explicit data.view, else 'subspec' (the streamed nodes carry no view and
// belong to the per-subspecialization view, so existing behavior is unchanged).
function viewOf(data) {
  return data && data.view === 'global' ? 'global' : 'subspec';
}

// A claim's quality-flag bucket for the filter facet: 'flag' (Senior review flagged, streamed as
// data.review or carried as data.quality / quality_review), 'pass', else 'none'.
function qualityOf(data) {
  const q = (data && (data.quality || (data.quality_review && data.quality_review.quality) || data.review)) || null;
  if (q === 'flag') return 'flag';
  if (q === 'pass') return 'pass';
  return 'none';
}

// The real subspecialization id behind a node id: global-view subspec nodes are namespaced
// 'gsub::<id>' to stay distinct from the streamed subspec nodes (which use the raw id).
function subspecIdOf(data) {
  if (!data) return null;
  if (typeof data.subspecialization_id === 'string') return data.subspecialization_id;
  if (data.type === 'subspecialization' && typeof data.id === 'string') {
    return data.id.startsWith('gsub::') ? data.id.slice('gsub::'.length) : data.id;
  }
  return null;
}

function activeSet(arr) {
  return Array.isArray(arr) && arr.length ? new Set(arr) : null;
}

export function mountObservatory(target, opts = {}) {
  if (!target) throw new Error('mountObservatory: target is required');

  const cyFactory = opts.cytoscape || cytoscapeLib;
  ensureLayout(cyFactory);
  const layout = opts.layout || INCREMENTAL_LAYOUT;
  const onNodeClick = typeof opts.onNodeClick === 'function' ? opts.onNodeClick : null;
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);

  target.classList.add('observatory');
  target.innerHTML = '';

  const graphEl = doc.createElement('div');
  graphEl.className = 'observatory-graph';
  // Unique idle copy (never "Loading..."); hidden once the first elements land.
  const emptyEl = doc.createElement('p');
  emptyEl.className = 'observatory-empty';
  emptyEl.textContent = 'Observatory idle. No subspecializations mapped yet.';
  target.appendChild(graphEl);
  target.appendChild(emptyEl);

  const seen = new Set(); // element ids already in the graph (incremental dedup)
  // The in-memory graph model the view toggle + filter panel act on (id -> { group, data, source,
  // target }). It mirrors what is in cytoscape but is renderer-independent, so view/filter visibility
  // is computed and asserted without a live renderer (and filters never re-read IndexedDB).
  const elements = new Map();
  const visible = new Set(); // ids currently shown (after view + filter); the introspection surface
  let currentView = 'subspec'; // 'subspec' (per-subspecialization sub-graphs) | 'global' (unified GlobalKG)
  let filter = null; // { subspecializations?, claimTypes?, confidences?, qualityFlags? } | null
  let cy = null;
  let error = null;
  if (typeof cyFactory === 'function') {
    try {
      cy = cyFactory({
        container: graphEl,
        elements: [],
        style: STYLE,
        layout: { name: 'preset' }, // initial; the real layout runs per addElements
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        minZoom: 0.2,
        maxZoom: 3,
      });
    } catch (err) {
      error = err;
      cy = null;
    }
  }

  // Node click -> report the node data to the caller (no conversation write here).
  if (cy && onNodeClick && typeof cy.on === 'function') {
    cy.on('tap', 'node', (evt) => {
      const data = evt && evt.target && typeof evt.target.data === 'function' ? evt.target.data() : null;
      onNodeClick(data);
    });
  }

  const minimap = opts.minimap === false || !cy ? null : mountMinimap(target, { cy, doc });

  // Incremental add: only elements whose id is not already in the graph are added, so a
  // Bookkeeper promotion never rebuilds the whole graph. Returns the count added.
  function addElements(payload = {}) {
    if (!cy) return { added: 0 };
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const edges = Array.isArray(payload.edges) ? payload.edges : [];
    const fresh = [];
    const take = (group, el) => {
      const id = el && el.data ? el.data.id : undefined;
      if (id == null || seen.has(id)) return;
      seen.add(id);
      const data = el.data;
      if (group === 'nodes') decorateNode(data);
      elements.set(id, { group, data, source: data.source, target: data.target });
      fresh.push({ group, data });
    };
    nodes.forEach((n) => take('nodes', n));
    edges.forEach((e) => take('edges', e));
    if (fresh.length === 0) return { added: 0 };

    cy.add(fresh);
    if (typeof cy.layout === 'function') {
      const run = cy.layout(layout);
      if (run && typeof run.run === 'function') run.run();
    }
    // Pulse any freshly-added loading nodes (renderer-only; jsdom/stub is a no-op).
    fresh.forEach((el) => {
      if (el.group === 'nodes' && el.data && el.data.state === 'loading') {
        const node = nodeById(el.data.id);
        if (node) pulse(node);
      }
    });
    applyVisibility();
    return { added: fresh.length };
  }

  // ----- view toggle + filter panel: visibility over the in-memory model -----

  // Decorate a node's data in place: a global-view node gets its renderer-computed pixel `size`
  // (idempotent; a caller-supplied size is respected).
  function decorateNode(data) {
    if (data && data.view === 'global' && !Number.isFinite(data.size)) {
      data.size = sizeForGlobalNode(data);
    }
  }

  // Does a node pass the active filter? A facet constrains only the nodes that carry its field, so a
  // structural node (a paper) is never hidden by a claim-type filter; an inactive facet passes all.
  function passesFilter(data) {
    if (!filter) return true;
    const subs = activeSet(filter.subspecializations);
    const types = activeSet(filter.claimTypes);
    const confs = activeSet(filter.confidences);
    const quals = activeSet(filter.qualityFlags);
    if (subs) {
      const sid = subspecIdOf(data);
      if (sid != null && !subs.has(sid)) return false;
    }
    if (types && Array.isArray(data.claim_type) && data.claim_type.length) {
      if (!data.claim_type.some((t) => types.has(t))) return false;
    }
    if (confs && data.type === 'claim') {
      const c = data.confidence == null ? 'unassigned' : String(data.confidence);
      if (!confs.has(c)) return false;
    }
    if (quals && data.type === 'claim') {
      if (!quals.has(qualityOf(data))) return false;
    }
    return true;
  }

  // Toggle a single element's cytoscape display (guarded for the stub / missing renderer). The
  // in-memory `visible` set is the source of truth the tests read, so a stub node without .style()
  // still yields correct visibleIds().
  function setDisplay(id, vis) {
    const node = nodeById(id);
    if (node && typeof node.style === 'function') {
      try {
        node.style('display', vis ? 'element' : 'none');
      } catch (_err) {
        // a renderer that rejects a display change must not break the chain
      }
    }
  }

  // Recompute and apply view + filter visibility across the whole model. A node is shown when it is in
  // the active view AND passes the filter; an edge is shown when both endpoints are shown; a paper that
  // a filter orphaned (had edges, none now visible) is hidden so an isolated sub-graph reads clean.
  function applyVisibility() {
    if (!cy) return;
    const nodeVisible = new Map();
    elements.forEach((el, id) => {
      if (el.group !== 'nodes') return;
      nodeVisible.set(id, viewOf(el.data) === currentView && passesFilter(el.data));
    });
    const edgeVisible = new Map();
    elements.forEach((el, id) => {
      if (el.group !== 'edges') return;
      edgeVisible.set(id, Boolean(nodeVisible.get(el.source)) && Boolean(nodeVisible.get(el.target)));
    });
    // Leaf cleanup: a still-visible paper whose every incident edge is hidden is an orphan; drop it.
    elements.forEach((el, id) => {
      if (el.group !== 'nodes' || el.data.type !== 'paper' || !nodeVisible.get(id)) return;
      let incident = 0;
      let shown = 0;
      edgeVisible.forEach((vis, eid) => {
        const e = elements.get(eid);
        if (!e || (e.source !== id && e.target !== id)) return;
        incident += 1;
        if (vis) shown += 1;
      });
      if (incident > 0 && shown === 0) nodeVisible.set(id, false);
    });
    visible.clear();
    let nodeCount = 0;
    nodeVisible.forEach((vis, id) => {
      setDisplay(id, vis);
      if (vis) {
        visible.add(id);
        nodeCount += 1;
      }
    });
    edgeVisible.forEach((vis, id) => {
      setDisplay(id, vis);
      if (vis) visible.add(id);
    });
    if (emptyEl) {
      emptyEl.textContent = currentView === 'global'
        ? 'No GlobalKG promoted yet. The unified graph fills in once the Bookkeeper promotes.'
        : 'Observatory idle. No subspecializations mapped yet.';
      emptyEl.style.display = nodeCount > 0 ? 'none' : '';
    }
    target.dataset.graph = nodeCount > 0 ? 'true' : 'false';
    if (minimap) minimap.update();
  }

  // Switch the rendered view: 'subspec' (per-subspecialization sub-graphs) | 'global' (unified GlobalKG).
  function setView(view) {
    const next = view === 'global' ? 'global' : 'subspec';
    if (next === currentView) return { view: currentView };
    currentView = next;
    applyVisibility();
    return { view: currentView };
  }

  // Apply an in-memory filter (no IndexedDB re-fetch): { subspecializations?, claimTypes?, confidences?,
  // qualityFlags? } as arrays of selected values; a null/empty facet is inactive. null clears all.
  function setFilter(state) {
    filter = state && typeof state === 'object' ? state : null;
    applyVisibility();
    return { filter };
  }

  // Look up a live node by id, returning null when it is absent (or there is no renderer).
  function nodeById(id) {
    if (!cy || id == null || typeof cy.getElementById !== 'function') return null;
    const node = cy.getElementById(id);
    if (!node) return null;
    if (typeof node.empty === 'function' && node.empty()) return null;
    if (typeof node.length === 'number' && node.length === 0) return null;
    return node;
  }

  function refreshStyle() {
    if (cy && typeof cy.style === 'function') {
      try {
        const s = cy.style();
        if (s && typeof s.update === 'function') s.update();
      } catch (_err) {
        // a style refresh failure must not break the chain
      }
    }
  }

  // Merge `patch` onto an existing node's data (e.g. { state: 'confirmed' }) and refresh its
  // style, so the loading -> confirmed transition mutates the live node in place rather than
  // re-adding it. DI-guarded no-op without a renderer or a missing node; never rebuilds the graph.
  function setNodeData(id, patch) {
    if (!cy || id == null || !patch || typeof patch !== 'object') return { updated: 0 };
    const node = nodeById(id);
    if (!node || typeof node.data !== 'function') return { updated: 0 };
    Object.keys(patch).forEach((k) => {
      if (k !== 'id') node.data(k, patch[k]);
    });
    // Mirror the patch onto the in-memory model so the filter sees live state/review/quality changes.
    const rec = elements.get(id);
    if (rec && rec.data) Object.keys(patch).forEach((k) => { if (k !== 'id') rec.data[k] = patch[k]; });
    refreshStyle();
    if (patch.state === 'loading') pulse(node);
    // Re-evaluate visibility only when a view/filter is actually in effect (the streaming default -
    // subspec view, no filter - needs no per-token recompute).
    if (filter || currentView !== 'subspec') applyVisibility();
    if (minimap) minimap.update();
    return { updated: 1 };
  }

  // Update existing nodes from a node payload (each node's data.id selects the target). Mirrors
  // addElements' shape so the same { nodes } payload style works for updates.
  function updateElements(payload = {}) {
    if (!cy) return { updated: 0 };
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    let updated = 0;
    nodes.forEach((n) => {
      const id = n && n.data ? n.data.id : undefined;
      if (id == null) return;
      updated += setNodeData(id, n.data).updated;
    });
    return { updated };
  }

  // Remove nodes/edges by id (e.g. a claim the Senior Grad Student rejected, which is dropped from
  // the KG). Removing a node removes its connected edges too (cytoscape does this), and the ids are
  // freed from the incremental-dedup `seen` set so a later re-add is not suppressed. DI-guarded
  // no-op without a renderer or for an absent id; never rebuilds the graph. Returns the count removed.
  function removeElements(ids = []) {
    if (!cy) return { removed: 0 };
    const list = Array.isArray(ids) ? ids : [ids];
    let removed = 0;
    list.forEach((id) => {
      if (id == null) return;
      const el = nodeById(id);
      if (el && typeof el.remove === 'function') {
        try {
          el.remove();
          removed += 1;
        } catch (_err) {
          // a renderer that fails to remove must not break the chain
        }
      }
      seen.delete(id);
      elements.delete(id);
      visible.delete(id);
    });
    if (removed) applyVisibility();
    return { removed };
  }

  // A gentle opacity pulse on a loading node (renderer-only; the stub/jsdom node has no animate,
  // so this is a no-op in tests). Self-cancels the moment the node leaves the loading state.
  function pulse(node) {
    if (!node || typeof node.animate !== 'function' || typeof node.data !== 'function') return;
    const step = (toOpacity, next) => {
      if (node.data('state') !== 'loading') return;
      try {
        node.animate({ style: { 'background-opacity': toOpacity } }, { duration: 480, complete: next });
      } catch (_err) {
        // renderer churn during teardown must not throw
      }
    };
    const loop = () => step(0.85, () => step(0.35, loop));
    loop();
  }

  function clear() {
    seen.clear();
    elements.clear();
    visible.clear();
    currentView = 'subspec';
    filter = null;
    if (cy && typeof cy.elements === 'function') {
      try {
        cy.elements().remove();
      } catch (_err) {
        // an empty graph has nothing to remove
      }
    }
    if (emptyEl) {
      emptyEl.textContent = 'Observatory idle. No subspecializations mapped yet.';
      emptyEl.style.display = '';
    }
    target.dataset.graph = 'false';
    if (minimap) minimap.update();
  }

  function fit() {
    if (cy && typeof cy.fit === 'function') cy.fit();
  }

  function destroy() {
    if (minimap) minimap.destroy();
    if (cy && typeof cy.destroy === 'function') {
      try {
        cy.destroy();
      } catch (_err) {
        // a renderer that fails to tear down must not block loop teardown
      }
    }
    cy = null;
    target.innerHTML = '';
    target.classList.remove('observatory');
  }

  return {
    addElements,
    updateElements,
    setNodeData,
    removeElements,
    setView,
    setFilter,
    clear,
    fit,
    destroy,
    getCy: () => cy,
    getError: () => error,
    hasGraph: () => Boolean(cy),
    getView: () => currentView,
    visibleIds: () => [...visible],
    isVisible: (id) => visible.has(id),
  };
}

// A small custom minimap (no jQuery / cytoscape-navigator). Draws scaled node dots plus
// the current viewport rectangle from the live cytoscape graph; click-to-pan recenters.
// Canvas drawing is guarded (jsdom has no 2D context), so update() is a no-op in tests
// while the minimap element still mounts.
function mountMinimap(host, { cy, doc }) {
  const el = doc.createElement('div');
  el.className = 'observatory-minimap';
  el.setAttribute('aria-hidden', 'true');
  const canvas = doc.createElement('canvas');
  canvas.className = 'observatory-minimap-canvas';
  el.appendChild(canvas);
  host.appendChild(el);

  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  let scale = 1;
  let ox = 0;
  let oy = 0;

  function colorFor(node) {
    const t = node.data('type');
    if (t === 'subspecialization') return '#94621A';
    if (t === 'paper') return '#F6F1E1';
    return node.data('confidence') === 'high' ? '#4A6B1F' : '#6B6044';
  }

  function draw() {
    if (!ctx || !cy || typeof cy.elements !== 'function') return;
    const W = (canvas.width = el.clientWidth || 160);
    const H = (canvas.height = el.clientHeight || 110);
    ctx.clearRect(0, 0, W, H);
    const bb = cy.elements().boundingBox();
    if (!bb || !Number.isFinite(bb.w) || bb.w === 0 || bb.h === 0) return;
    const pad = 6;
    scale = Math.min((W - 2 * pad) / bb.w, (H - 2 * pad) / bb.h);
    ox = pad - bb.x1 * scale;
    oy = pad - bb.y1 * scale;
    cy.nodes().forEach((n) => {
      const p = n.position();
      ctx.fillStyle = colorFor(n);
      ctx.fillRect(ox + p.x * scale - 1.5, oy + p.y * scale - 1.5, 3, 3);
    });
    const ext = cy.extent();
    ctx.strokeStyle = '#4A6B1F';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + ext.x1 * scale, oy + ext.y1 * scale, ext.w * scale, ext.h * scale);
  }

  function update() {
    draw();
  }

  if (cy && typeof cy.on === 'function') cy.on('render pan zoom add', update);

  // Click-to-pan: translate the minimap point back to graph coords and recenter.
  el.addEventListener('click', (event) => {
    if (!cy || typeof cy.pan !== 'function' || scale === 0) return;
    const rect = canvas.getBoundingClientRect();
    const gx = (event.clientX - rect.left - ox) / scale;
    const gy = (event.clientY - rect.top - oy) / scale;
    const zoom = typeof cy.zoom === 'function' ? cy.zoom() : 1;
    const width = typeof cy.width === 'function' ? cy.width() : 0;
    const height = typeof cy.height === 'function' ? cy.height() : 0;
    cy.pan({ x: width / 2 - gx * zoom, y: height / 2 - gy * zoom });
  });

  function destroy() {
    if (cy && typeof cy.off === 'function') {
      try {
        cy.off('render pan zoom add', update);
      } catch (_err) {
        // best effort
      }
    }
    if (host.contains(el)) host.removeChild(el);
  }

  return { update, destroy, el };
}
