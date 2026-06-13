// Ollama (local) adapter: template (5b), 429 parser (5f), send seam.
//
// Ollama runs locally and is the exclusive target for HIPAA sessions (5h). Its
// /api/chat format nests sampling under options and uses num_predict for the
// output ceiling. System stays inline.

import { TransportNotWiredError } from '../errors.js';
import { headerGet, retryAfterToMs } from '../parse429helpers.js';
import { splitSystem, resolveModel, clampTemp, maxTokensOf } from './shared.js';

const MODELS = {
  large: 'llama3',
  small: 'llama3.2',
  default: 'llama3',
};

export const ollama = {
  name: 'ollama',

  template(messages, spec = {}) {
    const { system, rest } = splitSystem(messages);
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    for (const m of rest) msgs.push({ role: m.role, content: m.content });
    return {
      model: resolveModel(MODELS, spec.tier),
      messages: msgs,
      stream: false,
      options: {
        temperature: clampTemp(spec),
        num_predict: maxTokensOf(spec),
      },
    };
  },

  // Local server; rate limiting is not expected, but honor retry-after if set.
  parse429(response = {}) {
    return { retryAfterMs: retryAfterToMs(headerGet(response.headers || {}, 'retry-after')) };
  },

  async send(request, { transport } = {}) {
    if (typeof transport === 'function') return transport(request);
    throw new TransportNotWiredError('ollama transport not wired (local server pending)', {
      provider: 'ollama',
    });
  },
};
