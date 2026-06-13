import { describe, it } from 'vitest';
import { EVALS } from './evals/workflows.js';

// The workflow evals double as suite tests so the Stop-hook test gate covers
// them. Each eval's run() throws on failure, which fails the corresponding test.
// The standalone runner (npm run eval) reports them as a CI-style PASS/FAIL list.

describe('workflow evals (reliability spine, end to end)', () => {
  for (const ev of EVALS) {
    it(ev.name, async () => {
      await ev.run();
    });
  }
});
