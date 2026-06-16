import { describe, expect, it } from 'vitest';
import { mountPaperCard } from '../../src/components/paperCard.js';

// The paper detail card (IO panel [PAPER] tab): renders one retrieved paper record (Edgar's shape) when
// a citation chip on the Post-Doc synthesis is clicked. Presentation only; it renders what it is handed.

const record = {
  title: 'Fasting and memory',
  authors: ['Smith', 'Lee'],
  year: 2021,
  doi: '10.1/abc',
  abstract: 'Fasting improved recall ($p<0.05$) in older adults.',
  source: 'pubmed',
  full_text_available: true,
};

function mount() {
  const target = document.createElement('div');
  const api = mountPaperCard(target);
  return { target, api };
}

describe('mountPaperCard', () => {
  it('requires a target', () => {
    expect(() => mountPaperCard(null)).toThrow();
  });

  it('shows a unique idle message before a paper is opened (never blank)', () => {
    const { target } = mount();
    const idle = target.querySelector('.paper-card-idle');
    expect(idle).toBeTruthy();
    expect(idle.textContent).toMatch(/No paper selected/);
    expect(target.querySelector('.paper-card').hidden).toBe(true);
  });

  it('open renders the title, authors+year, DOI, source + full-text marker, and the math-rendered abstract', () => {
    const { target, api } = mount();
    api.open(record);
    const card = target.querySelector('.paper-card');
    expect(card.hidden).toBe(false);
    expect(card.querySelector('.paper-card-title').textContent).toBe('Fasting and memory');
    expect(card.textContent).toContain('Smith, Lee');
    expect(card.textContent).toContain('(2021)');
    expect(card.querySelector('.paper-card-doi').textContent).toBe('10.1/abc');
    const fulltext = card.querySelector('.paper-card-fulltext');
    expect(fulltext.dataset.available).toBe('true');
    expect(fulltext.textContent).toBe('full text');
    // The abstract renders statistics as KaTeX.
    expect(card.querySelector('.paper-card-abstract-body').innerHTML).toContain('class="katex"');
    // The idle copy is hidden once a paper is open.
    expect(target.querySelector('.paper-card-idle').style.display).toBe('none');
  });

  it('degrades gracefully for a minimal record (a missing-record click is never dead)', () => {
    const { target, api } = mount();
    api.open({ doi: '10.1/x', title: '10.1/x', source: 'unknown', abstract: '' });
    const card = target.querySelector('.paper-card');
    expect(card.querySelector('.paper-card-title').textContent).toBe('10.1/x');
    expect(card.querySelector('.paper-card-fulltext').dataset.available).toBe('false');
    expect(card.querySelector('.paper-card-abstract-body').textContent).toBe('No abstract available.');
  });

  it('clear resets to the idle state', () => {
    const { target, api } = mount();
    api.open(record);
    api.clear();
    expect(target.querySelector('.paper-card').hidden).toBe(true);
    expect(target.querySelector('.paper-card-idle').style.display).toBe('');
  });
});
