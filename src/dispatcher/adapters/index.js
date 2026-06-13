// Adapter registry (5b).
//
// Each adapter co-locates its template (5b), 429 parser (5f), and send seam.
// ADAPTERS maps provider name to the adapter; TEMPLATES / templateFor satisfy
// the 5b requirement of a registry from provider name to template function.

import { anthropic } from './anthropic.js';
import { groq } from './groq.js';
import { mistral } from './mistral.js';
import { ollama } from './ollama.js';

export const ADAPTERS = { anthropic, groq, mistral, ollama };

export const TEMPLATES = {
  anthropic: anthropic.template,
  groq: groq.template,
  mistral: mistral.template,
  ollama: ollama.template,
};

export function templateFor(name) {
  const adapter = ADAPTERS[name];
  return adapter ? adapter.template : undefined;
}
