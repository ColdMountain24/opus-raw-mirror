import './paperCard.css';
import { mathToFragment } from '../utils/mathtext.js';

// The paper detail card: shown in the IO panel's [PAPER] tab when a researcher clicks a citation chip on
// the Post-Doc's LRSummary card. It renders one retrieved paper record (Edgar's shape: title, authors,
// year, doi, abstract, source, full_text_available) - the credibility detail behind a synthesized finding,
// for a PI or grant-reviewer audience. The abstract is math-rendered (abstracts carry statistics).
// Presentation only: it renders the record it is handed and owns no schema.

const IDLE_COPY = 'No paper selected. Click a citation chip on the synthesis to inspect its source.';

export function mountPaperCard(target, opts = {}) {
  if (!target) throw new Error('mountPaperCard: target is required');
  const doc = opts.document || target.ownerDocument || (typeof document !== 'undefined' ? document : null);

  target.classList.add('paper-card-host');
  target.innerHTML = '';

  const idle = doc.createElement('p');
  idle.className = 'paper-card-idle';
  idle.textContent = IDLE_COPY;

  const card = doc.createElement('div');
  card.className = 'paper-card';
  card.hidden = true;

  target.appendChild(idle);
  target.appendChild(card);

  function labeledRow(label, fill) {
    const row = doc.createElement('div');
    row.className = 'paper-card-row';
    const dt = doc.createElement('span');
    dt.className = 'paper-card-label bracket';
    dt.textContent = `[${label}]`;
    const dd = doc.createElement('span');
    dd.className = 'paper-card-value';
    fill(dd);
    row.appendChild(dt);
    row.appendChild(dd);
    return row;
  }

  function open(record = {}) {
    const r = record && typeof record === 'object' ? record : {};
    card.innerHTML = '';

    const title = doc.createElement('p');
    title.className = 'paper-card-title';
    title.textContent = typeof r.title === 'string' && r.title.trim() ? r.title : r.doi || 'Untitled paper';
    card.appendChild(title);

    const authors = Array.isArray(r.authors) ? r.authors.join(', ') : typeof r.authors === 'string' ? r.authors : '';
    const yr = Number.isInteger(r.year) ? ` (${r.year})` : '';
    card.appendChild(labeledRow('AUTHORS', (dd) => { dd.textContent = `${authors || 'unknown'}${yr}`; }));
    card.appendChild(labeledRow('DOI', (dd) => { dd.textContent = r.doi || '(none)'; dd.classList.add('paper-card-doi'); }));
    card.appendChild(labeledRow('SOURCE', (dd) => {
      dd.textContent = r.source || 'unknown';
      const badge = doc.createElement('span');
      badge.className = 'paper-card-fulltext';
      badge.dataset.available = String(Boolean(r.full_text_available));
      badge.textContent = r.full_text_available ? 'full text' : 'abstract only';
      dd.appendChild(doc.createTextNode(' '));
      dd.appendChild(badge);
    }));

    const abstract = doc.createElement('div');
    abstract.className = 'paper-card-abstract';
    const aLabel = doc.createElement('span');
    aLabel.className = 'paper-card-label bracket';
    aLabel.textContent = '[ABSTRACT]';
    const aBody = doc.createElement('p');
    aBody.className = 'paper-card-abstract-body';
    if (typeof r.abstract === 'string' && r.abstract.trim()) aBody.appendChild(mathToFragment(r.abstract, doc));
    else aBody.textContent = 'No abstract available.';
    abstract.appendChild(aLabel);
    abstract.appendChild(aBody);
    card.appendChild(abstract);

    card.hidden = false;
    idle.style.display = 'none';
    return card;
  }

  function clear() {
    card.innerHTML = '';
    card.hidden = true;
    idle.style.display = '';
  }

  return { open, clear, el: card };
}
