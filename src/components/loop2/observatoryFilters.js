import './observatoryFilters.css';

// The Loop 2 Observatory filter panel: a left rail beside the Cytoscape canvas. It carries the
// view toggle (per-subspecialization sub-graphs vs the unified GlobalKG) and four facet groups
// (subspecialization, claim type, confidence, quality flag) that filter the IN-MEMORY graph model
// (Observatory.setFilter), never re-reading IndexedDB. The panel is presentation only: it reports
// the researcher's selections through onViewChange / onFilterChange and renders whatever facet
// options it is handed (setFacets), inventing no shapes. Dusty University Office law: square,
// Windows-98 bevels, monospace data labels, no em dashes, unique copy.

const VIEWS = [
  { id: 'subspec', label: '[SUBSPEC_VIEW]' },
  { id: 'global', label: '[GLOBAL_VIEW]' },
];

// The four facets, in render order. `key` is the filter-state key the Observatory reads.
const FACETS = [
  { key: 'subspecializations', legend: 'Subspecialization' },
  { key: 'claimTypes', legend: 'Claim type' },
  { key: 'confidences', legend: 'Confidence' },
  { key: 'qualityFlags', legend: 'Quality flag' },
];

// Normalize a facet option to { value, label }: a plain string, or an { id, label } record (the
// subspecializations carry a human label distinct from their id).
function toOption(opt) {
  if (opt && typeof opt === 'object') {
    const value = opt.id != null ? String(opt.id) : String(opt.value);
    return { value, label: typeof opt.label === 'string' ? opt.label : value };
  }
  return { value: String(opt), label: String(opt) };
}

export function mountObservatoryFilters(target, opts = {}) {
  if (!target) throw new Error('mountObservatoryFilters: target is required');
  const onViewChange = typeof opts.onViewChange === 'function' ? opts.onViewChange : null;
  const onFilterChange = typeof opts.onFilterChange === 'function' ? opts.onFilterChange : null;
  const doc = opts.document || target.ownerDocument || (typeof document !== 'undefined' ? document : null);

  target.classList.add('observatory-filters');
  target.innerHTML = '';

  // Selected values per facet (Sets, preserved across re-population when still offered).
  const selected = new Map(FACETS.map((f) => [f.key, new Set()]));
  const optionHosts = new Map(); // facet key -> the container the checkboxes render into
  const viewButtons = new Map();
  let currentView = 'subspec';

  // ----- header -----
  const title = doc.createElement('div');
  title.className = 'filters-title bracket';
  title.textContent = '[FILTERS]';
  target.appendChild(title);

  // ----- view toggle -----
  const viewGroup = doc.createElement('div');
  viewGroup.className = 'filters-view';
  viewGroup.setAttribute('role', 'group');
  viewGroup.setAttribute('aria-label', 'Observatory view');
  VIEWS.forEach((v) => {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'filters-view-btn bracket';
    btn.dataset.view = v.id;
    btn.textContent = v.label;
    btn.addEventListener('click', () => selectView(v.id, true));
    viewGroup.appendChild(btn);
    viewButtons.set(v.id, btn);
  });
  target.appendChild(viewGroup);

  // ----- facet groups -----
  FACETS.forEach((facet) => {
    const fs = doc.createElement('fieldset');
    fs.className = 'filters-facet';
    fs.dataset.facet = facet.key;
    const legend = doc.createElement('legend');
    legend.className = 'filters-legend bracket';
    legend.textContent = `[${facet.legend}]`;
    fs.appendChild(legend);
    const options = doc.createElement('div');
    options.className = 'facet-options';
    fs.appendChild(options);
    target.appendChild(fs);
    optionHosts.set(facet.key, options);
    renderFacet(facet.key, []); // start empty (populated by setFacets)
  });

  // ----- clear -----
  const clearBtn = doc.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'filters-clear bracket';
  clearBtn.textContent = '[CLEAR_FILTERS]';
  clearBtn.addEventListener('click', () => reset());
  target.appendChild(clearBtn);

  selectView('subspec', false);

  // ----- behavior -----
  function renderFacet(key, options) {
    const host = optionHosts.get(key);
    if (!host) return;
    host.innerHTML = '';
    const keep = selected.get(key);
    const offered = new Set();
    const normalized = (Array.isArray(options) ? options : []).map(toOption);
    if (normalized.length === 0) {
      const note = doc.createElement('p');
      note.className = 'facet-empty';
      note.textContent = 'none yet';
      host.appendChild(note);
    }
    normalized.forEach((opt) => {
      offered.add(opt.value);
      const row = doc.createElement('label');
      row.className = 'facet-option';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.value = opt.value;
      box.checked = keep.has(opt.value);
      box.addEventListener('change', () => {
        if (box.checked) keep.add(opt.value);
        else keep.delete(opt.value);
        emitFilter();
      });
      const text = doc.createElement('span');
      text.className = 'facet-option-label';
      text.textContent = opt.label;
      row.appendChild(box);
      row.appendChild(text);
      host.appendChild(row);
    });
    // Drop any previously-selected value the new option set no longer offers, so a stale filter
    // never silently hides everything.
    [...keep].forEach((v) => {
      if (!offered.has(v)) keep.delete(v);
    });
  }

  function buildFilter() {
    const out = {};
    FACETS.forEach((f) => {
      out[f.key] = [...selected.get(f.key)];
    });
    return out;
  }

  function emitFilter() {
    if (onFilterChange) onFilterChange(buildFilter());
  }

  function selectView(view, fire) {
    const next = view === 'global' ? 'global' : 'subspec';
    currentView = next;
    viewButtons.forEach((btn, id) => {
      const active = id === next;
      btn.dataset.active = String(active);
      btn.setAttribute('aria-pressed', String(active));
    });
    if (fire && onViewChange) onViewChange(next);
  }

  function setFacets(facets = {}) {
    FACETS.forEach((f) => {
      if (Object.prototype.hasOwnProperty.call(facets, f.key)) {
        renderFacet(f.key, facets[f.key]);
      }
    });
  }

  function setView(view) {
    selectView(view, false); // external switch (e.g. the auto-switch on promotion); no echo back
  }

  function reset() {
    selected.forEach((set) => set.clear());
    optionHosts.forEach((host) => {
      host.querySelectorAll('input[type="checkbox"]').forEach((box) => {
        box.checked = false;
      });
    });
    emitFilter();
  }

  function destroy() {
    target.innerHTML = '';
    target.classList.remove('observatory-filters');
  }

  return {
    setFacets,
    setView,
    reset,
    destroy,
    getFilter: () => buildFilter(),
    getView: () => currentView,
  };
}
