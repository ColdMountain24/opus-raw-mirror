// Stop-hook eval gate.
//
// Wired as a Claude Code `Stop` hook (see .claude/settings.json). It runs the
// five workflow evals at the end of every turn and grades them PASS/FAIL. If any
// eval fails the session does not end cleanly: the gate exits 2, which blocks the
// stop and feeds the failure (on stderr) back into the console.
//
// Loop guard: a Stop hook receives `stop_hook_active: true` when the agent is
// already continuing because of a prior Stop-hook block. In that case the gate
// reports the failures but allows the stop, so a persistently failing eval can
// never trap the session.
//
// This is plain ESM with no vitest dependency, so it runs under bare `node`.

import { runEvals } from './workflows.js';

// Read the hook payload from stdin. Resolves to '' if there is no piped input.
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    // Fallback so the gate never hangs if stdin is left open with no data.
    setTimeout(() => resolve(data), 250);
  });
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (_err) {
    input = {}; // a malformed payload is treated as a fresh (non-continuing) stop
  }
  const stopHookActive = Boolean(input.stop_hook_active);

  const results = await runEvals();
  const failed = results.filter((r) => !r.ok);

  // Report every eval on stderr so the grade shows in the console regardless of
  // the exit code.
  for (const r of results) {
    if (r.ok) {
      process.stderr.write(`PASS  ${r.name}\n`);
    } else {
      process.stderr.write(`FAIL  ${r.name}\n`);
      process.stderr.write(`      ${r.error}\n`);
    }
  }
  process.stderr.write(`\n${results.length - failed.length}/${results.length} workflow evals passing\n`);

  if (failed.length === 0) {
    process.exit(0);
  }

  if (stopHookActive) {
    process.stderr.write(
      '\nEval gate already retried this stop (stop_hook_active); allowing the session to end so it is not trapped. Fix the failing evals above before the next run.\n',
    );
    process.exit(0);
  }

  // Block the stop: a non-clean session end. Exit code 2 routes stderr back to
  // the agent, surfacing the failure and prompting a fix.
  process.stderr.write(
    `\nSession not ending cleanly: ${failed.length} workflow eval(s) failing. Run "npm run eval", fix the failures, then stop.\n`,
  );
  process.exit(2);
}

main().catch((err) => {
  // An unexpected gate fault (not an eval failure) is surfaced but does not block
  // the stop, so a harness bug cannot trap the session. Exit 1 is a non-blocking
  // hook error in Claude Code.
  process.stderr.write(`eval gate error: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
