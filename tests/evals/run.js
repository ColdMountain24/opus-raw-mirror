// Workflow eval runner (CLI). Runs the five baseline spine evals and prints a
// PASS/FAIL line each, then a summary. Exits non-zero if any eval fails, so it
// works as a CI gate (npm run eval).

import { runEvals } from './workflows.js';

const results = await runEvals();
let failed = 0;

for (const r of results) {
  if (r.ok) {
    console.log(`PASS  ${r.name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${r.name}`);
    console.log(`      ${r.error}`);
  }
}

console.log('');
console.log(`${results.length - failed}/${results.length} workflow evals passing`);
process.exit(failed === 0 ? 0 : 1);
