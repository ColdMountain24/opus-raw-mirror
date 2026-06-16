// Anthropic (Claude) adapter: template (5b), 429 parser (5f), send seam.
//
// Claude uses the Messages API: the system prompt is a top-level field and the
// messages array holds only user/assistant turns. Claude follows nuanced system
// prompts well, so the system text is passed through verbatim.

import { TransportNotWiredError } from '../errors.js';
import { headerGet, retryAfterToMs } from '../parse429helpers.js';
import { splitSystem, resolveModel, maxTokensOf } from './shared.js';

const MODELS = {
  large: 'claude-opus-4-8',
  medium: 'claude-sonnet-4-6',
  small: 'claude-haiku-4-5-20251001',
  // Default to Sonnet: it is the cost/quality balance for the Loop 1 tiers (which all
  // resolve to `default`), and it avoids the Opus 4.8 id that some keys 400 on. Opus
  // is reachable only via an explicit `large` tier request (none in Loop 1).
  default: 'claude-sonnet-4-6',
};

export const anthropic = {
  name: 'anthropic',

  template(messages, spec = {}) {
    const { system, rest } = splitSystem(messages);
    // NOTE: no `temperature`. The current Claude models reject it
    // ("temperature is deprecated for this model" -> 400), so it is omitted here.
    // The dispatcher's corrective-retry temperature bump is therefore a no-op for
    // Anthropic (the other adapters still honor it).
    const body = {
      model: resolveModel(MODELS, spec.tier),
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: maxTokensOf(spec),
    };
    if (system) body.system = system;
    return body;
  },

  // Anthropic: retry-after first, then the x-ratelimit reset headers. A 529
  // overloaded_error is a platform saturation signal, flagged so the spine
  // backs off AND fails over rather than treating it as a usage limit.
  parse429(response = {}) {
    const h = response.headers || {};
    const body = response.body || {};
    const overloaded =
      response.status === 529 ||
      (body.error && body.error.type === 'overloaded_error') ||
      body.type === 'overloaded_error';
    let retryAfterMs = retryAfterToMs(headerGet(h, 'retry-after'));
    if (retryAfterMs == null) {
      const reset =
        headerGet(h, 'anthropic-ratelimit-requests-reset') ||
        headerGet(h, 'anthropic-ratelimit-tokens-reset') ||
        headerGet(h, 'x-ratelimit-reset');
      retryAfterMs = retryAfterToMs(reset);
    }
    return { retryAfterMs, overloaded };
  },

  async send(request, { transport, onToken } = {}) {
    // onToken (when present) opts this call into prose streaming; the transport
    // forwards text deltas to it and still resolves with the full { status, headers, body }.
    if (typeof transport === 'function') return transport(request, { onToken });
    throw new TransportNotWiredError('anthropic transport not wired (real fetch pending)', {
      provider: 'anthropic',
    });
  },
};
