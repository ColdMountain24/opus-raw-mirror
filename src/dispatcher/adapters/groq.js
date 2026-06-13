// Groq (Llama 3.3 70B) adapter: template (5b), 429 parser (5f), send seam.
//
// Groq uses the OpenAI-style chat format: the system prompt stays inline as the
// first message. Llama follows blunt, explicit instruction better than nuanced
// framing, so a compliance preamble is prepended to the system text. This is
// deliberately not the prompt Claude receives.

import { TransportNotWiredError } from '../errors.js';
import { headerGet, retryAfterToMs } from '../parse429helpers.js';
import { splitSystem, resolveModel, clampTemp, maxTokensOf } from './shared.js';

const MODELS = {
  large: 'llama-3.3-70b-versatile',
  small: 'llama-3.1-8b-instant',
  default: 'llama-3.3-70b-versatile',
};

const COMPLIANCE = 'Follow the instructions exactly and respond only with what is requested.';

export const groq = {
  name: 'groq',

  template(messages, spec = {}) {
    const { system, rest } = splitSystem(messages);
    const sys = [COMPLIANCE, system].filter(Boolean).join('\n\n');
    const msgs = [];
    if (sys) msgs.push({ role: 'system', content: sys });
    for (const m of rest) msgs.push({ role: m.role, content: m.content });
    return {
      model: resolveModel(MODELS, spec.tier),
      messages: msgs,
      max_tokens: maxTokensOf(spec),
      temperature: clampTemp(spec),
      stream: false,
    };
  },

  // Groq sends the wait in a retry-after header.
  parse429(response = {}) {
    return { retryAfterMs: retryAfterToMs(headerGet(response.headers || {}, 'retry-after')) };
  },

  async send(request, { transport } = {}) {
    if (typeof transport === 'function') return transport(request);
    throw new TransportNotWiredError('groq transport not wired (real fetch pending)', {
      provider: 'groq',
    });
  },
};
