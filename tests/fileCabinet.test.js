import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountFileCabinet } from '../src/components/fileCabinet.js';

// The file-cabinet drawer is a generic, schema-agnostic data view: it renders
// whatever folders it is handed, toggles open/closed from its handle, and dims
// placeholder fields. It never writes to the conversation (TurnGate is untouched).

const FOLDERS = [
  {
    id: 'question',
    label: 'Question',
    fields: [
      { label: 'KnowledgeGap', value: 'a real gap', state: 'filled' },
      { label: 'Claims', value: '(not yet specified)', state: 'empty' },
    ],
  },
  {
    id: 'scope',
    label: 'Scope',
    fields: [{ label: 'Population', value: '(unknown)', state: 'unknown' }],
  },
];

describe('file cabinet drawer', () => {
  let host;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  it('renders a manila tab per folder and shows the first folder body by default', () => {
    const fc = mountFileCabinet(host);
    fc.setFolders(FOLDERS);

    const tabs = host.querySelectorAll('.fc-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].textContent).toContain('Question');
    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(fc.getActive()).toBe('question');

    // Body shows the Question folder's fields with bracketed labels.
    const labels = [...host.querySelectorAll('.fc-field-label')].map((el) => el.textContent);
    expect(labels).toEqual(['[KnowledgeGap]', '[Claims]']);
    expect(host.querySelector('.fc-field-value').textContent).toBe('a real gap');
  });

  it('marks a tab whose section has filled content', () => {
    const fc = mountFileCabinet(host);
    fc.setFolders(FOLDERS);
    const [question, scope] = host.querySelectorAll('.fc-tab');
    expect(question.dataset.filled).toBe('true'); // KnowledgeGap is filled
    expect(scope.dataset.filled).toBeUndefined(); // only an unknown field
  });

  it('switches the active folder on tab click', () => {
    const fc = mountFileCabinet(host);
    fc.setFolders(FOLDERS);
    host.querySelectorAll('.fc-tab')[1].click(); // Scope
    expect(fc.getActive()).toBe('scope');
    const value = host.querySelector('.fc-field-value');
    expect(value.textContent).toBe('(unknown)');
    expect(value.dataset.placeholder).toBe('true');
  });

  it('dims empty and unknown fields as placeholders', () => {
    const fc = mountFileCabinet(host);
    fc.setFolders(FOLDERS);
    const values = host.querySelectorAll('.fc-field-value');
    expect(values[0].dataset.placeholder).toBeUndefined(); // filled
    expect(values[1].dataset.placeholder).toBe('true'); // empty
  });

  it('toggles open/closed from the handle and reports it', () => {
    const onToggle = vi.fn();
    const fc = mountFileCabinet(host, { onToggle });
    const handle = host.querySelector('.file-cabinet-handle');
    const drawer = host.querySelector('.file-cabinet-drawer');

    expect(drawer.hidden).toBe(true);
    expect(handle.getAttribute('aria-expanded')).toBe('false');

    handle.click();
    expect(fc.isOpen()).toBe(true);
    expect(drawer.hidden).toBe(false);
    expect(handle.getAttribute('aria-expanded')).toBe('true');
    expect(onToggle).toHaveBeenLastCalledWith(true);

    handle.click();
    expect(fc.isOpen()).toBe(false);
    expect(drawer.hidden).toBe(true);
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });

  it('preserves the open section across a folder update when it still exists', () => {
    const fc = mountFileCabinet(host);
    fc.setFolders(FOLDERS);
    fc.setActive('scope');
    fc.setFolders(FOLDERS); // a fresh packet, same sections
    expect(fc.getActive()).toBe('scope');
  });

  it('shows an empty-file placeholder when handed no folders', () => {
    const fc = mountFileCabinet(host);
    fc.setFolders([]);
    expect(host.querySelectorAll('.fc-tab')).toHaveLength(0);
    expect(host.querySelector('.file-cabinet-empty')).toBeTruthy();
  });
});
