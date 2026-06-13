// Typed dispatcher errors and response classification.
//
// Every failure that flows through the spine is one of these typed errors so
// the retry layer (5e), the circuit breaker (5c), and the failover loop (5g)
// can make decisions from fields instead of string matching. Nothing is
// swallowed: an unhandled error still reaches the global error boundary.

export class DispatchError extends Error {
  constructor(message, {
    code,
    status,
    provider,
    retryAfterMs,
    retryable = false,
    failover = false,
    countsAsFailure = true,
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code || this.constructor.name;
    this.status = status;
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable; // safe to retry the same provider
    this.failover = failover; // signal to move to the next provider
    this.countsAsFailure = countsAsFailure; // counts toward the circuit breaker
  }
}

// 429: usage rate limit. Retryable, honors retry-after.
export class RateLimitError extends DispatchError {
  constructor(message = 'rate limited', opts = {}) {
    super(message, { code: 'rate_limited', retryable: true, ...opts });
  }
}

// 5xx: provider server error. Retryable.
export class ServerError extends DispatchError {
  constructor(message = 'server error', opts = {}) {
    super(message, { code: 'server_error', retryable: true, ...opts });
  }
}

// 529: Anthropic platform saturation. Back off AND fail over (not a usage
// limit). Distinct from a 429 so the spine moves to the next provider.
export class OverloadedError extends DispatchError {
  constructor(message = 'overloaded', opts = {}) {
    super(message, { code: 'overloaded', retryable: true, failover: true, ...opts });
  }
}

// Network/time budget exceeded. Retryable.
export class TimeoutError extends DispatchError {
  constructor(message = 'timeout', opts = {}) {
    super(message, { code: 'timeout', retryable: true, ...opts });
  }
}

// 4xx (other than 429): a bad request. Never retried, never failed over (the
// same bad request will not succeed elsewhere). Surfaced to the caller.
export class RequestError extends DispatchError {
  constructor(message = 'request error', opts = {}) {
    super(message, { code: 'request_error', retryable: false, ...opts });
  }
}

// No real transport wired for this adapter yet (this build has no fetch). Fails
// over to the next provider and ultimately the safe default, but does NOT count
// as a provider fault so it never trips the breaker.
export class TransportNotWiredError extends DispatchError {
  constructor(message = 'transport not wired', opts = {}) {
    super(message, {
      code: 'transport_not_wired',
      retryable: false,
      failover: true,
      countsAsFailure: false,
      ...opts,
    });
  }
}

// Map a normalized transport response { status, headers, body } to a typed
// error, or null on success. parse429 (5f) supplies the retry interval; it is
// optional and must be tolerant of any status.
export function errorFromResponse(response, { provider, parse429 } = {}) {
  const status = (response && response.status) || 0;
  if (status >= 200 && status < 300) return null;

  const info = (typeof parse429 === 'function' && parse429(response)) || {};
  const retryAfterMs = info.retryAfterMs;

  if (status === 429) {
    return new RateLimitError('rate limited', { status, provider, retryAfterMs });
  }
  if (status === 529) {
    return new OverloadedError('overloaded', { status, provider, retryAfterMs });
  }
  if (status >= 500) {
    return new ServerError(`server error ${status}`, { status, provider, retryAfterMs });
  }
  if (status >= 400) {
    return new RequestError(`request error ${status}`, { status, provider });
  }
  return new ServerError(`unexpected status ${status}`, { status, provider });
}
