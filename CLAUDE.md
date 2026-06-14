# CLAUDE.md

Guidance for Claude Code working in this repository. Read this first. This is a
living document: update it at the end of every session.

## What this is

Opus CC RAW mirror: a multi-loop agent console web app built on a
reliability-first provider dispatcher. Every LLM call routes through one
dispatcher that handles retries, failover, rate limiting, circuit breaking,
HIPAA routing, schema validation, and caching, so loop and agent code never touch
a provider directly.

"Opus" is the executing agent (the assistant). The product and repo are named
Opus CC; do not rename them.

S0 ships the app shell, the reliability spine, and the eval baseline. S1 builds
Loop 1 (The Agora) end to end on it: six agents through the orchestrator, the FINAL
RQPacket schema + deterministic extraction/CV + the framework registry, the
researcher composer + confirmation, the file-cabinet RQPacket drawer, and the
cessation card with its full trust layer (see `src/loops/loop1/ARCHITECTURE.md`). The
provider transports are now wired (`src/dispatcher/adapters/transports.js`): each
adapter fires a real `fetch()` with the user's API key (from Settings/localStorage),
so a keyed provider returns a live model response and an unkeyed one fails over. Tests
still drive the spine through the deterministic simulator on virtual time.

## Stack and commands

- Vite 8, vanilla JS, no UI framework. App root is `src/`, build output `dist/`.
- Vitest 4 + jsdom for tests; `fake-indexeddb` for the storage suite (dev only).

```
npm run dev      # Vite dev server on :5173
npm run build    # production build to dist/
npm test         # full vitest suite (run once)
npm run eval     # the 5 workflow evals (CI-style PASS/FAIL, non-zero on fail)
```

Always run `npm test` before ending a session.

## Layout

```
src/
  dispatcher/      the reliability spine; single dispatch() entry point
    dispatcher.js  exports dispatch, createDispatcher, configureDispatcher
    adapters/      per-provider template + 429 parser + send() seam
    simulator.js   deterministic transport; circuitBreaker/queue/backoff/failover
    hipaa.js cache.js validate.js errors.js tokens.js RATE_LIMITS.js
  components/      sidebar, ioPanel, agentConsole, packetInspector, poe,
                   dashboard, settings, mousekatool
  utils/storage.js IndexedDB (GlobalKG), localStorage (session), File System export
  styles/          tokens.css (single source of truth), shell.css, main.css
  main.js          shell coordination only (no loop logic, no agents)
tests/             vitest suites mirror src/ (incl. evals/: 5 workflows + gate + rubric)
Opus_DELTAS.md     deviation + decision log (see below)
```

## The dispatcher (the spine)

`dispatch({ tier, messages, schema, loopContext, agentId, safeDefault, priority,
maxTokens }) -> validatedResponse`. Composition order inside `dispatch()`:

1. HIPAA: `loopContext.hipaa` forces `['ollama']` only, resolved first and
   absolute (no hosted fallback).
2. Cache: key = hash(agentId + tier + messages); a hit skips the call.
3. Failover over `['anthropic','groq','mistral']`: breaker gate, queue admission
   (80% of limits), provider template, retry/send with 429 parsing.
4. Validate against the caller schema: one corrective retry (+0.1 temp), then the
   caller `safeDefault`.

The dispatcher is UI-agnostic: it emits typed events to an injected logger and
trace sink. The caller owns `schema` and `safeDefault`; the dispatcher never
invents agent values.

## Hard constraints (PLAYBOOK, always in effect)

Reliability:
- All LLM calls go through the dispatcher. No direct provider calls outside `adapters/`.
- Per-provider prompt templates: Claude, Llama-on-Groq, and Mistral do NOT get identical prompts.
- Backoff 1/2/4/8s + jitter; honor retry-after; retry only 429/5xx/timeout, never 4xx.
- Circuit breaker: 3 consecutive fails -> OPEN, 60s cooldown -> HALF-OPEN, success -> CLOSED.
- Schema validation + corrective retry (+0.1 temp) + safe-default fallback.
- Queue at 80% of rate limits.
- HIPAA flag -> Ollama only, enforced before provider selection.
- localStorage packet cache; a pre-warmed cache makes a repeat run cost zero quota.
- No silent error swallowing: every exception reaches the error boundary with reproducible context.

Visual and copy (the "Dusty University Office" theme; whole-app, by user direction 2026-06-14, superseding the prior deep-slate / neon-green law):
- No em dashes anywhere (text, code, labels, comments, status copy). Use hyphens, colons, or parentheses.
- No border-radius anywhere (structural). This also keeps the Windows-98 bevels square.
- Monospace for IO, console, packets, any data, and the typed-document cessation card; the Win98 sans (`--font-ui`) for non-data UI chrome.
- Warm cream paper for surfaces: `--bg-base` (manila chrome) and the loop-aware `--bg-primary` (the canvas page; per-loop tints live in `tokens.css` under `[data-loop]`, defined in that loop's architecture doc).
- Sepia/brown ink for text (`--fg-default` / `--fg-dim`).
- Deep olive-green for active/live/confirmed only (`--accent-active`). Never idle or decorative.
- Ochre/sienna for bracket notation only (`--accent-bracket`, via `.bracket`): `[AGENT]`, `[FIELD]`.
- Windows-98 chrome: raised/sunken two-tone bevels via `--bevel-light` / `--bevel-dark` (or the `.bevel-raised` / `.bevel-sunken` utilities in `main.css`); raised faces `--surface-raised`, sunken wells `--surface-sunken`, the typed document `--surface-document`. Brick red `--accent-error` for failures.
- A single global progress indicator (owned by Poe, at the top of the conversation).
- Unique status copy; never a generic "Loading...".

Code hygiene and process:
- Components export `mountX(target, opts)`, return a method API, own their DOM and CSS (`import './x.css'`).
- Dependency injection for testability: clock, sleep, random, storage, measure, and transports are injectable; tests run on virtual time and in-memory stubs.
- Typed errors carry classification fields (`retryable`, `failover`, `countsAsFailure`, `retryAfterMs`); decisions read fields, not error strings.
- Factory + default singleton for app-wide services (`createDispatcher`/`dispatch`, `createStorage`/`kg|session|file`, `createPoe`/`poe`).
- Before any bug fix, write a failing regression test named after what broke.
- Run the full test suite before ending any session.

## TurnGate

Poe (`src/components/poe.js`) is the only module that may write to the
conversation layer, enforced structurally: the conversation DOM lives only inside
`poe.js`'s closure, its API exposes methods only, and Poe owns its own progress
indicator (no shell DOM reference). Do not add a second conversation writer, and
do not give any other module a conversation node.

## Autonomy Charter (what Opus does NOT own)

Opus implements infrastructure and enforcement mechanisms. Opus does not own, and
must not invent: agent logic, packet schemas, inter-agent routing rules, the HIPAA
routing policy (FINAL; Opus only implements the enforcement mechanism), or any
item marked `(FINAL)`. Components and the dispatcher stay schema-agnostic: they
render or validate what they are handed, reading a small documented set of
presentation fields, never defining the shapes.

## Opus_DELTAS.md

The audit trail of every deviation from the literal spec, every silently
documented decision, and every reusable pattern, with the reason. Append a row
whenever you deviate, make a judgment call the spec did not dictate, or establish
a pattern. It records deviations and decisions, never constraints (constraints
live in this file).

## Testing and evals

- Unit suites under `tests/` mirror `src/` (the dispatcher has one suite per
  reliability sub-step under `tests/dispatcher/`).
- The 5 workflow evals (`tests/evals/`) drive the whole spine through the
  simulator on virtual time (happy path per provider, breaker-OPEN failover,
  corrective-retry success, HIPAA ollama-only, cache hit). They run as `npm run
  eval`, as `tests/evals.test.js`, and via a `Stop` hook
  (`.claude/settings.json` -> `tests/evals/gate.js`) that blocks a clean stop on
  any FAIL; `tests/evals/rubric.md` is the LLM-judge rubric.
