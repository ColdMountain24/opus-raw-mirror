import { describe, expect, it, vi } from 'vitest';
import { mountObservatoryFilters } from '../../../src/components/loop2/observatoryFilters.js';

// The Loop 2 Observatory filter panel: a presentation-only rail that reports the researcher's view
// toggle + facet selections. It renders whatever facet options it is handed (setFacets) and filters
// the in-memory graph through the Observatory, never re-reading IndexedDB.

function mount(extra = {}) {
  const target = document.createElement('div');
  const onViewChange = vi.fn();
  const onFilterChange = vi.fn();
  const api = mountObservatoryFilters(target, { onViewChange, onFilterChange, ...extra });
  return { target, onViewChange, onFilterChange, api };
}

// jsdom's input.click() toggles .checked but does not dispatch the 'change' event the component
// listens for (the browser does), so drive the checkbox the canonical way.
function toggle(input) {
  input.checked = !input.checked;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('mountObservatoryFilters', () => {
  it('requires a target', () => {
    expect(() => mountObservatoryFilters(null)).toThrow();
  });

  it('renders the view toggle, the four facet groups, and a clear control', () => {
    const { target, api } = mount();
    const views = [...target.querySelectorAll('.filters-view-btn')].map((b) => b.dataset.view);
    expect(views).toEqual(['subspec', 'global']);
    const facets = [...target.querySelectorAll('.filters-facet')].map((f) => f.dataset.facet);
    expect(facets).toEqual(['subspecializations', 'claimTypes', 'confidences', 'qualityFlags']);
    expect(target.querySelector('.filters-clear')).toBeTruthy();
    // Default view is the per-subspecialization view, marked active.
    expect(api.getView()).toBe('subspec');
    expect(target.querySelector('.filters-view-btn[data-view="subspec"]').dataset.active).toBe('true');
  });

  it('fires onViewChange and reflects the active button when a view button is clicked', () => {
    const { target, onViewChange, api } = mount();
    target.querySelector('.filters-view-btn[data-view="global"]').click();
    expect(onViewChange).toHaveBeenCalledWith('global');
    expect(api.getView()).toBe('global');
    expect(target.querySelector('.filters-view-btn[data-view="global"]').dataset.active).toBe('true');
    expect(target.querySelector('.filters-view-btn[data-view="subspec"]').dataset.active).toBe('false');
  });

  it('setFacets populates the data-driven options (subspec labels + dynamic claim types)', () => {
    const { target, api } = mount();
    api.setFacets({
      subspecializations: [{ id: 's1', label: 'Cognitive aging' }, { id: 's2', label: 'Sleep' }],
      claimTypes: ['causal', 'descriptive'],
      confidences: ['unassigned'],
      qualityFlags: ['flag', 'pass', 'none'],
    });
    const subHost = target.querySelector('.filters-facet[data-facet="subspecializations"] .facet-options');
    expect([...subHost.querySelectorAll('input')].map((i) => i.value)).toEqual(['s1', 's2']);
    expect(subHost.querySelector('input[value="s1"]').closest('.facet-option').textContent).toContain('Cognitive aging');
    const typeHost = target.querySelector('.filters-facet[data-facet="claimTypes"] .facet-options');
    expect([...typeHost.querySelectorAll('input')].map((i) => i.value)).toEqual(['causal', 'descriptive']);
  });

  it('checking a box fires onFilterChange with the selected values per facet', () => {
    const { target, onFilterChange, api } = mount();
    api.setFacets({ subspecializations: [{ id: 's1', label: 'A' }, { id: 's2', label: 'B' }], claimTypes: ['causal'] });

    toggle(target.querySelector('input[value="s1"]'));
    expect(onFilterChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ subspecializations: ['s1'], claimTypes: [], confidences: [], qualityFlags: [] }),
    );
    toggle(target.querySelector('input[value="causal"]'));
    expect(onFilterChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ subspecializations: ['s1'], claimTypes: ['causal'] }),
    );
    expect(api.getFilter()).toEqual({ subspecializations: ['s1'], claimTypes: ['causal'], confidences: [], qualityFlags: [] });
  });

  it('preserves a still-offered selection across re-population, drops a vanished one', () => {
    const { target, api } = mount();
    api.setFacets({ subspecializations: [{ id: 's1', label: 'A' }, { id: 's2', label: 'B' }] });
    toggle(target.querySelector('input[value="s1"]'));
    toggle(target.querySelector('input[value="s2"]'));
    // s2 is no longer offered; s1 still is -> s1 stays checked, s2 is dropped from the filter.
    api.setFacets({ subspecializations: [{ id: 's1', label: 'A' }] });
    expect(target.querySelector('input[value="s1"]').checked).toBe(true);
    expect(api.getFilter().subspecializations).toEqual(['s1']);
  });

  it('setView reflects an external switch without echoing onViewChange', () => {
    const { target, onViewChange, api } = mount();
    api.setView('global'); // the auto-switch on global promotion
    expect(api.getView()).toBe('global');
    expect(target.querySelector('.filters-view-btn[data-view="global"]').dataset.active).toBe('true');
    expect(onViewChange).not.toHaveBeenCalled();
  });

  it('reset clears every selection and emits an empty filter', () => {
    const { target, onFilterChange, api } = mount();
    api.setFacets({ subspecializations: [{ id: 's1', label: 'A' }], qualityFlags: ['flag'] });
    toggle(target.querySelector('input[value="s1"]'));
    toggle(target.querySelector('input[value="flag"]'));
    onFilterChange.mockClear();

    api.reset();
    expect(target.querySelector('input[value="s1"]').checked).toBe(false);
    expect(onFilterChange).toHaveBeenLastCalledWith({ subspecializations: [], claimTypes: [], confidences: [], qualityFlags: [] });
    expect(api.getFilter()).toEqual({ subspecializations: [], claimTypes: [], confidences: [], qualityFlags: [] });
  });

  it('an unpopulated facet shows a unique idle note (never blank)', () => {
    const { target } = mount();
    const note = target.querySelector('.filters-facet[data-facet="claimTypes"] .facet-empty');
    expect(note).toBeTruthy();
    expect(note.textContent).toBe('none yet');
  });
});
