// Mistral adapter: template (5b), 429 parser (5f), send seam.
//
// Mistral uses its own chat format with system inline. It responds best to a
// compact directive framing, so the system text is wrapped in a directive
// marker. Again, deliberately distinct from the Claude and Groq prompts.

import { TransportNotWiredError } from '../errors.js';
import { headerGet, retryAfterToMs } from '../parse429helpers.js';
import { splitSystem, resolveModel, clampTemp, maxTokensOf } from './shared.js';

const MODELS = {
  large: 'mistral-large-latest',
  small: 'mistral-small-latest',
  default: 'mistral-small-latest',
};

export const mistral = {
  name: 'mistral',

  template(messages, spec = {}) {
    const { system, rest } = splitSystem(messages);
    const sys = system ? `[SYSTEM DIRECTIVE]\n${system}` : '';
    const msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    for (const m of rest) msgs.push({ role: m.role, content: m.content });
    return {
      model: resolveModel(MODELS, spec.tier),
      messages: msgs,
      max_tokens: maxTokensOf(spec),
      temperature: clampTemp(spec),
      safe_prompt: false,
    };
  },

  // Mistral sends Retry-After plus X-RateLimit-Remaining.
  parse429(response = {}) {
    const h = response.headers || {};
    const remainingRaw = headerGet(h, 'x-ratelimit-remaining');
    return {
      retryAfterMs: retryAfterToMs(headerGet(h, 'retry-after')),
      remaining: remainingRaw != null ? Number(remainingRaw) : undefined,
    };
  },

  async send(request, { transport, onToken } = {}) {
    if (typeof transport === 'function') return transport(request, { onToken });
    throw new TransportNotWiredError('mistral transport not wired (real fetch pending)', {
      provider: 'mistral',
    });
  },
};
