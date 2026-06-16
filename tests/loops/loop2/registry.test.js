import { describe, expect, it } from 'vitest';
import { STATUS_COPY } from '../../../src/loops/loop2/registry.js';

// Every Loop 2 agent (and the deterministic control points) has unique running +
// complete copy. No generic "Loading...".

describe('loop 2 status-copy registry', () => {
  it('gives every agent a unique, non-generic running and complete message', () => {
    const running = [];
    const complete = [];
    for (const [agentId, copy] of Object.entries(STATUS_COPY)) {
      expect(typeof copy.running).toBe('string');
      expect(copy.running.length).toBeGreaterThan(0);
      expect(typeof copy.complete).toBe('string');
      expect(copy.complete.length).toBeGreaterThan(0);
      expect(copy.running.toLowerCase()).not.toContain('loading');
      running.push(copy.running);
      complete.push(copy.complete);
      void agentId;
    }
    // No two agents share running copy (each step is visibly distinct).
    expect(new Set(running).size).toBe(running.length);
    expect(new Set(complete).size).toBe(complete.length);
  });

  it('carries the nine worker agents plus Poe and the two deterministic control points', () => {
    const keys = Object.keys(STATUS_COPY);
    [
      'Poe',
      'Fearless Leader',
      'Grad Students',
      'Senior Grad Student',
      'Bookkeeper',
      'Post-Doc',
      'Salvia',
      'Skips',
      'Edgar Allan',
      'p53',
      'Revision Check',
      'Packager',
    ].forEach((agentId) => expect(keys).toContain(agentId));
  });
});
