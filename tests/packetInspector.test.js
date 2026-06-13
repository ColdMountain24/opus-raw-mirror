import { beforeEach, describe, expect, it } from 'vitest';
import { mountPacketInspector } from '../src/components/packetInspector.js';

describe('packet inspector', () => {
  let host;
  let api;

  beforeEach(() => {
    host = document.createElement('div');
    api = mountPacketInspector(host);
  });

  it('starts empty', () => {
    const pre = host.querySelector('.packet-output');
    expect(pre.dataset.empty).toBe('true');
    expect(pre.textContent).toBe('no packet loaded.');
  });

  it('pretty-prints an object packet as JSON', () => {
    api.setPacket({ kind: 'task', id: 7 });
    const pre = host.querySelector('.packet-output');
    expect(pre.dataset.empty).toBe('false');
    expect(pre.textContent).toContain('"kind": "task"');
    expect(pre.textContent).toContain('"id": 7');
  });

  it('shows a string packet verbatim', () => {
    api.setPacket('raw frame');
    expect(host.querySelector('.packet-output').textContent).toBe('raw frame');
  });

  it('handles a non-serializable packet without throwing or swallowing', () => {
    const circular = {};
    circular.self = circular;
    expect(() => api.setPacket(circular)).not.toThrow();
    expect(host.querySelector('.packet-output').textContent).toMatch(/unrenderable packet/);
  });

  it('clears back to the placeholder', () => {
    api.setPacket('x');
    api.clear();
    expect(host.querySelector('.packet-output').dataset.empty).toBe('true');
  });
});
