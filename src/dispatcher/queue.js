// Per-provider request queue (5d).
//
// Caps throughput at THROTTLE (80%) of each provider's documented limit, with
// each dimension enforced independently (Anthropic RPM/ITPM/OTPM; Groq RPM/TPM;
// Mistral a ~1 req/s minimum interval). A sliding 60s window tracks usage.
//
// Admission is FIFO with a priority lane: cessation-critical calls jump ahead of
// normal ones. Token pre-counting rejects a request that alone exceeds a token
// cap, so it never consumes a slot it could not use.
//
// The clock and sleep are injected so tests run on virtual time.

import { RATE_LIMITS, THROTTLE } from './RATE_LIMITS.js';
import { RequestError } from './errors.js';

const WINDOW_MS = 60_000;

export function createQueue({
  limits = RATE_LIMITS,
  throttle = THROTTLE,
  clock = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  windowMs = WINDOW_MS,
} = {}) {
  const state = new Map();

  function st(name) {
    let s = state.get(name);
    if (!s) {
      s = { events: [], lastAt: -Infinity, critical: [], normal: [], pumping: false, seq: 0 };
      state.set(name, s);
    }
    return s;
  }

  function caps(name) {
    const l = limits[name] || {};
    const cap = (v) => (v == null ? null : Math.max(1, Math.floor(v * throttle)));
    return {
      rpm: cap(l.rpm),
      itpm: cap(l.itpm),
      otpm: cap(l.otpm),
      tpm: cap(l.tpm),
      rps: l.rps != null ? l.rps * throttle : null,
    };
  }

  function prune(s, now) {
    const cutoff = now - windowMs;
    while (s.events.length && s.events[0].t <= cutoff) s.events.shift();
  }

  function usage(s) {
    let tin = 0;
    let tout = 0;
    for (const e of s.events) {
      tin += e.tokensIn;
      tout += e.tokensOut;
    }
    return { req: s.events.length, tin, tout, ttot: tin + tout };
  }

  // A request whose own tokens exceed a cap can never fit; name the dimension.
  function exceedsAlone(req, c) {
    if (c.itpm != null && req.tokensIn > c.itpm) return 'itpm';
    if (c.otpm != null && req.outReserve > c.otpm) return 'otpm';
    if (c.tpm != null && req.tokensIn + req.outReserve > c.tpm) return 'tpm';
    return null;
  }

  // Earliest time the request would fit. Returns <= now if it fits immediately.
  function readyAt(name, s, req, now) {
    const c = caps(name);
    prune(s, now);
    const u = usage(s);

    let earliest = now;
    if (c.rps != null) {
      const minGap = 1000 / c.rps;
      earliest = Math.max(earliest, s.lastAt + minGap);
    }

    const dims = [];
    if (c.rpm != null) dims.push({ used: u.req + 1, cap: c.rpm, weight: () => 1 });
    if (c.itpm != null) dims.push({ used: u.tin + req.tokensIn, cap: c.itpm, weight: (e) => e.tokensIn });
    if (c.otpm != null) dims.push({ used: u.tout + req.outReserve, cap: c.otpm, weight: (e) => e.tokensOut });
    if (c.tpm != null) {
      dims.push({
        used: u.ttot + req.tokensIn + req.outReserve,
        cap: c.tpm,
        weight: (e) => e.tokensIn + e.tokensOut,
      });
    }

    for (const d of dims) {
      if (d.used > d.cap) {
        const need = d.used - d.cap;
        let freed = 0;
        let freeTime = earliest;
        for (const e of s.events) {
          freed += d.weight(e);
          if (freed >= need) {
            freeTime = Math.max(freeTime, e.t + windowMs);
            break;
          }
        }
        if (freed < need) freeTime = Math.max(freeTime, now + windowMs);
        earliest = Math.max(earliest, freeTime);
      }
    }
    return earliest;
  }

  function record(s, req, now) {
    s.events.push({ t: now, tokensIn: req.tokensIn || 0, tokensOut: req.outReserve || 0 });
    s.lastAt = now;
  }

  async function pump(name) {
    const s = st(name);
    if (s.pumping) return;
    s.pumping = true;
    try {
      while (s.critical.length || s.normal.length) {
        const lane = s.critical.length ? s.critical : s.normal;
        const waiter = lane[0];
        const now = clock();
        const c = caps(name);

        const tooBig = exceedsAlone(waiter.req, c);
        if (tooBig) {
          lane.shift();
          waiter.reject(new RequestError(`request exceeds ${name} ${tooBig} limit`, { provider: name }));
          continue;
        }

        const ready = readyAt(name, s, waiter.req, now);
        if (ready <= now) {
          lane.shift();
          record(s, waiter.req, now);
          // Resolve with the admission timestamp so callers (and tests on
          // virtual time) see the exact moment of admission.
          waiter.resolve(now);
        } else {
          await sleep(ready - now);
        }
      }
    } finally {
      s.pumping = false;
    }
  }

  function acquire(name, req = {}) {
    const s = st(name);
    const waiterReq = { tokensIn: req.tokensIn || 0, outReserve: req.outReserve || 0 };
    const critical = req.priority === 'critical';
    return new Promise((resolve, reject) => {
      const waiter = { req: waiterReq, resolve, reject, seq: s.seq++ };
      if (critical) s.critical.push(waiter);
      else s.normal.push(waiter);
      pump(name);
    });
  }

  return { acquire };
}
