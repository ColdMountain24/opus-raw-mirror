import { describe, expect, it } from 'vitest';
import { mountClaimCard } from '../src/components/claimCard.js';

// The progressive claim card: the IO-panel surface that fills field-by-field as the Grad
// Student's claim stream parses, then locks to confirmed / flagged / rejected on validation.

describe('mountClaimCard', () => {
  it('requires a target', () => {
    expect(() => mountClaimCard(null)).toThrow();
  });

  it('opens in a loading state and renders the fields already present', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.open({ claim_id: 'c1', text: 'Fasting aids memory' });
    const el = target.querySelector('.claim-card');
    expect(el).toBeTruthy();
    expect(el.dataset.status).toBe('loading');
    expect(target.textContent).toContain('c1');
    expect(target.textContent).toContain('Fasting aids memory');
  });

  it('fills fields progressively, arrays joined for display', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.open({ claim_id: 'c1' });
    card.fill('text', 'Hello');
    card.fill('claim_type', ['causal', 'descriptive']);
    card.fill('supporting_paper_dois', ['10.1/a', '10.1/b']);
    expect(target.textContent).toContain('Hello');
    expect(target.textContent).toContain('causal, descriptive');
    expect(target.textContent).toContain('10.1/a, 10.1/b');
  });

  it('settles to valid (confirmed), and to rejected with surfaced reasons', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.open({ claim_id: 'c1', text: 't' });
    card.settle('valid', {});
    expect(target.querySelector('.claim-card').dataset.status).toBe('valid');

    card.settle('rejected', { reasons: ['claim cites no supporting papers'] });
    expect(target.querySelector('.claim-card').dataset.status).toBe('rejected');
    expect(target.textContent).toContain('claim cites no supporting papers');
  });

  it('clear resets to the idle state', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.open({ claim_id: 'c1' });
    card.clear();
    expect(target.querySelector('.claim-card')).toBeFalsy();
    expect(target.querySelector('.claim-card-empty')).toBeTruthy();
  });

  it('logs Senior-review verdicts: a running tally plus a line per flagged/rejected claim', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.review({ quality: 'pass', claimId: 'a', reason: 'solid' });
    card.review({ quality: 'flag', claimId: 'b', reason: 'weak support' });
    card.review({ quality: 'reject', claimId: 'c', reason: 'misread' });

    const head = target.querySelector('.claim-card-review-head');
    expect(head.textContent).toContain('[SENIOR_REVIEW]');
    expect(head.textContent).toContain('1 passed');
    expect(head.textContent).toContain('1 flagged');
    expect(head.textContent).toContain('1 rejected');

    const items = target.querySelectorAll('.claim-card-review-item');
    expect(items).toHaveLength(2); // pass is tallied only; flag + reject get lines
    expect(target.textContent).toContain('weak support');
    expect(target.textContent).toContain('misread');
    expect(target.querySelector('.claim-card-review-item[data-quality="reject"]')).toBeTruthy();
  });

  it('keeps the review log when a new claim card opens (separate hosts)', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.review({ quality: 'flag', claimId: 'b', reason: 'weak' });
    card.open({ claim_id: 'next', text: 'a new claim streaming' });
    // The card rebuilt, but the review log persists.
    expect(target.querySelector('.claim-card')).toBeTruthy();
    expect(target.querySelector('.claim-card-review-item')).toBeTruthy();
    expect(target.textContent).toContain('weak');
  });

  it('clear resets the review log too', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.review({ quality: 'flag', claimId: 'b', reason: 'weak' });
    card.clear();
    expect(target.querySelector('.claim-card-review')).toBeFalsy();
  });

  it('uses no em dashes in its own chrome', () => {
    const target = document.createElement('div');
    const card = mountClaimCard(target);
    card.open({ claim_id: 'c1' });
    card.settle('flagged', { reasons: ['ungrounded'] });
    card.review({ quality: 'reject', claimId: 'c', reason: 'misread' });
    card.clear();
    expect(target.innerHTML.includes('—')).toBe(false);
  });
});
