// Deterministic transport simulator.
//
// Tests and (later) the workflow evals import this directly to script exact
// provider response sequences without any network. Each helper returns a step:
// a thunk that produces a normalized response { status, headers, body } or
// throws. A transport is an async function (request) -> response.
//
// Real fetch() drops in later behind the same per-adapter send() seam; the
// spine never knows the difference.

import { TimeoutError } from './errors.js';

export const success = (body = {}, headers = {}) => () => ({ status: 200, headers, body });

export const rate429 = ({ retryAfter, headers = {} } = {}) => () => ({
  status: 429,
  headers: {
    ...(retryAfter != null ? { 'retry-after': String(retryAfter) } : {}),
    ...headers,
  },
  body: { error: 'rate_limited' },
});

export const server503 = ({ headers = {} } = {}) => () => ({
  status: 503,
  headers,
  body: { error: 'server_error' },
});

// Anthropic platform saturation.
export const overloaded529 = ({ retryAfter, headers = {} } = {}) => () => ({
  status: 529,
  headers: {
    ...(retryAfter != null ? { 'retry-after': String(retryAfter) } : {}),
    ...headers,
  },
  body: { type: 'error', error: { type: 'overloaded_error' } },
});

// 4xx bad request (auth, validation, etc.).
export const requestError = (status = 400, body = { error: 'bad_request' }) => () => ({
  status,
  headers: {},
  body,
});

export const timeout = () => () => {
  throw new TimeoutError('simulated timeout');
};

// A transport that consumes one scripted step per call, in order. Throws if
// called more times than scripted, so a test that over-calls fails loudly.
export function sequence(steps = []) {
  let i = 0;
  return async () => {
    if (i >= steps.length) {
      throw new Error('simulator sequence exhausted');
    }
    return steps[i++]();
  };
}

// A transport that returns the same step on every call.
export function always(step) {
  return async () => step();
}
