import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mountComposer } from '../src/components/composer.js';

// The composer is the researcher input surface (a sibling of Poe's feed). The
// orchestrator drives enable / confirm / lock through setStatus; the composer
// reports intent through onSubmit / onConfirm.

describe('composer', () => {
  let host;
  let onSubmit;
  let onConfirm;
  let api;

  beforeEach(() => {
    host = document.createElement('div');
    onSubmit = vi.fn();
    onConfirm = vi.fn();
    api = mountComposer(host, { onSubmit, onConfirm });
  });

  const input = () => host.querySelector('.composer-input');
  const sendBtn = () => host.querySelector('.composer-send');
  const confirmBtn = () => host.querySelector('.composer-confirm');

  it('starts disabled with the confirm affordance hidden', () => {
    expect(input().disabled).toBe(true);
    expect(sendBtn().disabled).toBe(true);
    expect(confirmBtn().hidden).toBe(true);
  });

  it('enables input while awaiting and submits a trimmed message, clearing the field', () => {
    api.setStatus({ awaitingInput: true, canConfirm: false, locked: false });
    expect(input().disabled).toBe(false);

    input().value = '  fasting and memory  ';
    sendBtn().click();
    expect(onSubmit).toHaveBeenCalledWith('fasting and memory');
    expect(input().value).toBe('');
  });

  it('does not submit an empty message or while not awaiting', () => {
    api.setStatus({ awaitingInput: true, canConfirm: false, locked: false });
    input().value = '   ';
    sendBtn().click();
    expect(onSubmit).not.toHaveBeenCalled();

    api.setStatus({ awaitingInput: false, canConfirm: false, locked: false });
    input().value = 'something';
    sendBtn().click();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Enter submits, Shift+Enter does not', () => {
    api.setStatus({ awaitingInput: true, canConfirm: false, locked: false });
    input().value = 'a question';
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(onSubmit).not.toHaveBeenCalled();
    input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSubmit).toHaveBeenCalledWith('a question');
  });

  it('surfaces Confirm only when canConfirm, and fires onConfirm on click', () => {
    api.setStatus({ awaitingInput: true, canConfirm: true, locked: false });
    expect(confirmBtn().hidden).toBe(false);
    confirmBtn().click();
    expect(onConfirm).toHaveBeenCalledTimes(1);

    api.setStatus({ awaitingInput: true, canConfirm: false, locked: false });
    expect(confirmBtn().hidden).toBe(true);
  });

  it('locks after cessation: input and both actions disabled, locked note shown', () => {
    api.setStatus({ awaitingInput: false, canConfirm: false, locked: true });
    expect(input().disabled).toBe(true);
    expect(sendBtn().disabled).toBe(true);
    expect(confirmBtn().hidden).toBe(true);
    expect(host.querySelector('.composer-locked-note').hidden).toBe(false);
    expect(host.dataset.locked).toBe('true');

    // A locked composer never submits or confirms even if invoked.
    input().value = 'late edit';
    sendBtn().click();
    confirmBtn().click();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
