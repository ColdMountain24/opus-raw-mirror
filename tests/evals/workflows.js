// The five canonical baseline workflow evals for the reliability spine.
//
// Each eval drives the real dispatcher end to end through the simulator and
// asserts the observable workflow: the returned value, how many times each
// provider was contacted, the circuit-breaker state, and the events emitted.
// They contain no loop-specific or agent-specific logic; the agent ids and
// schemas here are generic stand-ins for whatever a loop supplies later.
//
//   1. dispatcher-happy-path            a valid spec for each provider validates and returns
//   2. circuit-breaker-failover-open    3 anthropic failures fail over to groq and trip OPEN
//   3. schema-corrective-retry-success  a schema miss retries once, the valid retry reaches the caller
//   4. hipaa-ollama-only                a HIPAA session never touches a hosted provider
//   5. cache-hit-zero-calls             an identical repeat call is served warm, zero provider calls

import * as sim from '../../src/dispatcher/simulator.js';
import {
  buildSpine,
  virtualTime,
  memStorage,
  recorder,
  counted,
  assert,
  assertEqual,
} from './harness.js';

const EVALS = [
  {
    name: 'dispatcher-happy-path',
    description:
      'a valid call spec for each provider returns a schema-validated response from that provider',
    async run() {
      // Lead each provider in its own single-element failover sequence so every
      // adapter (template + transport + validation) is exercised on its own,
      // without one provider's outcome polluting another's breaker.
      const providers = ['anthropic', 'groq', 'mistral', 'ollama'];
      for (const provider of providers) {
        const vt = virtualTime();
        const log = recorder();
        const body = { ok: true, via: provider };
        const transport = counted(sim.always(sim.success(body)));
        const d = buildSpine({
          transports: { [provider]: transport },
          failoverSequence: [provider],
          vt,
          storage: memStorage(),
          logger: log,
        });

        const out = await d.dispatch({
          agentId: `happy-${provider}`,
          tier: 'large',
          messages: [{ role: 'user', content: `hello ${provider}` }],
          schema: (v) => Boolean(v && v.ok === true && v.via === provider),
          safeDefault: { ok: false },
        });

        assertEqual(out, body, `${provider} should return its validated body`);
        assert(transport.calls === 1, `${provider} should be contacted exactly once, got ${transport.calls}`);
        const success = log.events.find((e) => e.type === 'dispatch:success');
        assert(success && success.provider === provider, `dispatch:success should name ${provider}`);
      }
    },
  },

  {
    name: 'circuit-breaker-failover-open',
    description:
      'three consecutive anthropic failures fail over to groq and trip the anthropic breaker to OPEN; a later call then skips anthropic outright',
    async run() {
      const vt = virtualTime();
      const log = recorder();
      const anthropic = counted(sim.always(sim.server503())); // 5xx: retried then counts toward the breaker
      const groq = counted(sim.always(sim.success({ text: 'from-groq' })));
      const mistral = counted(sim.always(sim.success({ text: 'from-mistral' }))); // must never be reached
      const d = buildSpine({ transports: { anthropic, groq, mistral }, vt, logger: log });

      // The breaker records one failure per provider per dispatch (after the
      // in-call retries exhaust), so three separate dispatches are needed to
      // reach the 3-failure OPEN threshold. Distinct messages keep the cache
      // from short-circuiting the repeat calls.
      for (let i = 0; i < 3; i += 1) {
        const out = await d.dispatch({
          agentId: 'breaker-probe',
          messages: [{ role: 'user', content: `attempt ${i}` }],
          safeDefault: 'SAFE',
        });
        assertEqual(out, { text: 'from-groq' }, `dispatch ${i} should fail over to groq`);
      }

      assertEqual(d.breakerState('anthropic'), 'OPEN', 'anthropic breaker should be OPEN after 3 failures');
      assert(groq.calls === 3, `groq should have served all three calls, got ${groq.calls}`);
      assert(mistral.calls === 0, `mistral should never be reached, got ${mistral.calls}`);
      const opened = log.events.find(
        (e) => e.type === 'circuit:transition' && e.provider === 'anthropic' && e.to === 'OPEN',
      );
      assert(opened, 'expected a circuit:transition to OPEN for anthropic');

      // With anthropic OPEN, the next dispatch skips it at the breaker gate and
      // still resolves via groq (the cooldown has not elapsed in virtual time).
      const skipsBefore = log.events.filter(
        (e) => e.type === 'failover:skip' && e.provider === 'anthropic',
      ).length;
      const out4 = await d.dispatch({
        agentId: 'breaker-probe',
        messages: [{ role: 'user', content: 'attempt 4' }],
        safeDefault: 'SAFE',
      });
      assertEqual(out4, { text: 'from-groq' }, '4th dispatch should still resolve via groq');
      const skipsAfter = log.events.filter(
        (e) => e.type === 'failover:skip' && e.provider === 'anthropic',
      ).length;
      assert(skipsAfter > skipsBefore, 'the 4th dispatch should skip the OPEN anthropic breaker');
    },
  },

  {
    name: 'schema-corrective-retry-success',
    description:
      'a first response that fails the schema triggers one corrective retry; a valid response on the retry reaches the caller, and the safe default is never used',
    async run() {
      const vt = virtualTime();
      const log = recorder();
      // First body fails the schema, the corrective retry returns a valid body.
      const anthropic = counted(
        sim.sequence([sim.success({ text: 'bad' }), sim.success({ text: 'good' })]),
      );
      const d = buildSpine({ transports: { anthropic }, vt, logger: log });

      const out = await d.dispatch({
        agentId: 'grader',
        messages: [{ role: 'user', content: 'grade' }],
        schema: (v) => Boolean(v && v.text === 'good'),
        safeDefault: { text: 'SAFE_DEFAULT' },
      });

      assertEqual(out, { text: 'good' }, 'the corrected retry value should reach the caller');
      assert(anthropic.calls === 2, `expected an initial call plus one corrective retry, got ${anthropic.calls}`);
      assert(log.types().includes('validate:fail'), 'expected a validate:fail event (the corrective retry firing)');
      assert(
        !log.types().includes('validate:safe_default'),
        'the safe default must not be used when the corrective retry succeeds',
      );
      const success = log.events.find((e) => e.type === 'dispatch:success');
      assert(success && success.provider === 'anthropic', 'should succeed on anthropic');
    },
  },

  {
    name: 'hipaa-ollama-only',
    description:
      'a HIPAA session is routed to ollama only; no hosted provider is ever contacted, even though all are wired',
    async run() {
      const vt = virtualTime();
      const log = recorder();
      const ollama = counted(sim.always(sim.success({ phi: 'handled-locally' })));
      const anthropic = counted(sim.always(sim.success({ leak: true })));
      const groq = counted(sim.always(sim.success({ leak: true })));
      const mistral = counted(sim.always(sim.success({ leak: true })));
      const d = buildSpine({
        transports: { ollama, anthropic, groq, mistral },
        vt,
        logger: log,
      });

      const out = await d.dispatch({
        agentId: 'intake',
        messages: [{ role: 'user', content: 'patient record' }],
        loopContext: { hipaa: true },
        safeDefault: 'SAFE',
      });

      assertEqual(out, { phi: 'handled-locally' }, 'should be handled locally by ollama');
      assert(ollama.calls === 1, `ollama should be contacted once, got ${ollama.calls}`);
      assert(
        anthropic.calls === 0 && groq.calls === 0 && mistral.calls === 0,
        `no hosted provider may be contacted: anthropic=${anthropic.calls} groq=${groq.calls} mistral=${mistral.calls}`,
      );
      assert(log.types().includes('hipaa:enforced'), 'expected a hipaa:enforced event');
    },
  },

  {
    name: 'cache-hit-zero-calls',
    description:
      'an identical repeat call is served from the cache with zero additional provider calls',
    async run() {
      const vt = virtualTime();
      const log = recorder();
      const anthropic = counted(sim.always(sim.success({ plan: 'ship it' })));
      const d = buildSpine({ transports: { anthropic }, vt, storage: memStorage(), logger: log });

      const spec = {
        agentId: 'planner',
        tier: 'large',
        messages: [{ role: 'user', content: 'draft a plan' }],
        schema: (v) => Boolean(v && typeof v.plan === 'string'),
        safeDefault: { plan: '' },
      };

      const first = await d.dispatch(spec);
      assertEqual(first, { plan: 'ship it' }, 'first dispatch returns the validated body');
      assert(anthropic.calls === 1, `first call should hit the provider once, got ${anthropic.calls}`);

      const second = await d.dispatch(spec);
      assertEqual(second, { plan: 'ship it' }, 'second dispatch returns the cached body');
      assert(anthropic.calls === 1, `cache hit must make zero new provider calls, got ${anthropic.calls}`);
      assert(log.types().includes('cache:hit'), 'expected a cache:hit event on the repeat call');
    },
  },
];

export { EVALS };

// Run every eval, collecting a result per eval. Never throws: failures are
// captured so a runner can report all of them.
export async function runEvals() {
  const results = [];
  for (const ev of EVALS) {
    try {
      await ev.run();
      results.push({ name: ev.name, ok: true });
    } catch (err) {
      results.push({ name: ev.name, ok: false, error: err && err.message ? err.message : String(err) });
    }
  }
  return results;
}
