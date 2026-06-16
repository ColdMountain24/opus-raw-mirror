import './claimCard.css';

// The progressive claim card (IO panel). A Grad Student's claim streams in: open() creates the
// card in a loading state, fill() adds/updates each field the moment the incremental parser
// emits it, and settle() locks the card to confirmed (valid) / flagged / rejected once the
// authoritative claim passes the validation seam. Below the card, a persistent SENIOR_REVIEW log
// records the Senior Grad Student's per-claim quality verdicts (one running tally + a line per
// flagged/rejected claim) so the quality results land in the IO panel, never the conversation.
// Presentation only; the card never owns claim data. Dusty University Office / Win98 chrome:
// monospace data, bracket [FIELD] labels, square bevels, no em dashes.

const FIELD_ORDER = ['claim_id', 'text', 'claim_type', 'entity_references', 'supporting_paper_dois'];
const FIELD_LABELS = {
  claim_id: 'CLAIM_ID',
  text: 'TEXT',
  claim_type: 'CLAIM_TYPE',
  entity_references: 'ENTITIES',
  supporting_paper_dois: 'SUPPORTING_DOIS',
};
const STATUSES = ['valid', 'flagged', 'rejected'];
const QUALITIES = ['pass', 'flag', 'reject'];

function renderValue(v) {
  if (Array.isArray(v)) return v.join(', ');
  if (v == null) return '';
  return String(v);
}

export function mountClaimCard(target) {
  if (!target) throw new Error('mountClaimCard: target is required');
  target.classList.add('claim-card-root');
  target.innerHTML = '';

  // Two stable hosts so the per-claim card (rebuilt on each open) and the persistent review log
  // never clobber each other.
  const cardHost = document.createElement('div');
  cardHost.className = 'claim-card-host';
  const reviewHost = document.createElement('div');
  reviewHost.className = 'claim-card-review-host';
  target.appendChild(cardHost);
  target.appendChild(reviewHost);

  let card = null;
  let bodyEl = null;
  let pillEl = null;
  let reasonsEl = null;
  let fieldRows = new Map();

  // Review log state (persists across card rebuilds).
  let reviewSection = null;
  let reviewHeadEl = null;
  let reviewListEl = null;
  const tally = { pass: 0, flag: 0, reject: 0 };

  function clearCard() {
    cardHost.innerHTML = '';
    card = null;
    bodyEl = null;
    pillEl = null;
    reasonsEl = null;
    fieldRows = new Map();
    const empty = document.createElement('p');
    empty.className = 'claim-card-empty';
    empty.textContent = 'No claim streaming. Awaiting extraction.';
    cardHost.appendChild(empty);
  }

  function clear() {
    clearCard();
    reviewHost.innerHTML = '';
    reviewSection = null;
    reviewHeadEl = null;
    reviewListEl = null;
    tally.pass = 0;
    tally.flag = 0;
    tally.reject = 0;
  }

  function ensureCard() {
    if (card) return;
    cardHost.innerHTML = '';
    card = document.createElement('div');
    card.className = 'claim-card';
    card.dataset.status = 'loading';

    const head = document.createElement('div');
    head.className = 'claim-card-head';
    const tag = document.createElement('span');
    tag.className = 'bracket';
    tag.textContent = '[CLAIM]';
    pillEl = document.createElement('span');
    pillEl.className = 'claim-card-pill';
    pillEl.textContent = 'streaming';
    head.appendChild(tag);
    head.appendChild(pillEl);

    bodyEl = document.createElement('div');
    bodyEl.className = 'claim-card-body';

    reasonsEl = document.createElement('p');
    reasonsEl.className = 'claim-card-reasons';
    reasonsEl.hidden = true;

    card.appendChild(head);
    card.appendChild(bodyEl);
    card.appendChild(reasonsEl);
    cardHost.appendChild(card);
  }

  function setField(key, value) {
    ensureCard();
    let row = fieldRows.get(key);
    if (!row) {
      row = document.createElement('div');
      row.className = 'claim-card-field';
      const label = document.createElement('span');
      label.className = 'claim-card-label bracket';
      label.textContent = `[${FIELD_LABELS[key] || key.toUpperCase()}]`;
      const val = document.createElement('span');
      val.className = 'claim-card-value';
      row.appendChild(label);
      row.appendChild(val);
      row.dataset.field = key;
      fieldRows.set(key, row);
      bodyEl.appendChild(row); // fields arrive in parse order, which the prompt pins
    }
    row.querySelector('.claim-card-value').textContent = renderValue(value);
  }

  // Open a streaming claim card. The partial carries whatever fields parsed before claim_id.
  function open(claim = {}) {
    ensureCard();
    card.dataset.status = 'loading';
    pillEl.textContent = 'streaming';
    reasonsEl.hidden = true;
    reasonsEl.textContent = '';
    FIELD_ORDER.forEach((k) => {
      if (claim[k] !== undefined) setField(k, claim[k]);
    });
  }

  function fill(key, value) {
    setField(key, value);
  }

  // Lock the card on validation. status: 'valid' | 'flagged' | 'rejected'.
  function settle(status, opts = {}) {
    ensureCard();
    const s = STATUSES.includes(status) ? status : 'valid';
    card.dataset.status = s;
    pillEl.textContent = s === 'valid' ? 'confirmed' : s;
    const reasons = Array.isArray(opts.reasons) ? opts.reasons : [];
    if ((s === 'flagged' || s === 'rejected') && reasons.length) {
      reasonsEl.hidden = false;
      reasonsEl.textContent = reasons.join('; ');
    } else {
      reasonsEl.hidden = true;
      reasonsEl.textContent = '';
    }
  }

  function ensureReviewSection() {
    if (reviewSection) return;
    reviewSection = document.createElement('div');
    reviewSection.className = 'claim-card-review';
    reviewHeadEl = document.createElement('div');
    reviewHeadEl.className = 'claim-card-review-head bracket';
    reviewListEl = document.createElement('div');
    reviewListEl.className = 'claim-card-review-list';
    reviewSection.appendChild(reviewHeadEl);
    reviewSection.appendChild(reviewListEl);
    reviewHost.appendChild(reviewSection);
  }

  function updateReviewHead() {
    if (reviewHeadEl) {
      reviewHeadEl.textContent = `[SENIOR_REVIEW] ${tally.pass} passed, ${tally.flag} flagged, ${tally.reject} rejected`;
    }
  }

  // Record one Senior Grad Student verdict. Updates the running tally; a flagged or rejected claim
  // also gets its own line (the actionable verdicts); passes are tallied only, to keep the log
  // readable. entry: { quality, claimId, reason }.
  function review(entry = {}) {
    const quality = QUALITIES.includes(entry.quality) ? entry.quality : 'pass';
    ensureReviewSection();
    tally[quality] += 1;
    updateReviewHead();
    if (quality === 'flag' || quality === 'reject') {
      const item = document.createElement('div');
      item.className = 'claim-card-review-item';
      item.dataset.quality = quality;
      const verb = document.createElement('span');
      verb.className = 'claim-card-review-verb bracket';
      verb.textContent = quality === 'flag' ? '[FLAG]' : '[REJECT]';
      const detail = document.createElement('span');
      detail.className = 'claim-card-review-detail';
      const cid = entry.claimId ? `${entry.claimId}: ` : '';
      detail.textContent = `${cid}${entry.reason || ''}`;
      item.appendChild(verb);
      item.appendChild(detail);
      reviewListEl.appendChild(item);
    }
  }

  clear();
  return { open, fill, settle, review, clear };
}
