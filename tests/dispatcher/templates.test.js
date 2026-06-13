import { describe, expect, it } from 'vitest';
import { ADAPTERS, TEMPLATES, templateFor } from '../../src/dispatcher/adapters/index.js';

// 5b: per-provider templates. Each produces a distinct, provider-ready body, and
// Claude, Llama-on-Groq, and Mistral do not receive identical prompts.

const messages = [
  { role: 'system', content: 'You are a careful assistant.' },
  { role: 'user', content: 'Summarize this.' },
];

describe('provider templates (5b)', () => {
  it('maps provider name to a template function', () => {
    expect(Object.keys(ADAPTERS).sort()).toEqual(['anthropic', 'groq', 'mistral', 'ollama']);
    for (const name of Object.keys(ADAPTERS)) {
      expect(typeof TEMPLATES[name]).toBe('function');
      expect(templateFor(name)).toBe(ADAPTERS[name].template);
    }
  });

  it('anthropic puts system at the top level with a claude model', () => {
    const body = ADAPTERS.anthropic.template(messages, { tier: 'large', maxTokens: 256 });
    expect(body.model).toMatch(/claude/);
    expect(body.system).toContain('careful assistant');
    expect(body.messages.every((m) => m.role !== 'system')).toBe(true);
    expect(body.max_tokens).toBe(256);
  });

  it('groq keeps system inline with a llama model', () => {
    const body = ADAPTERS.groq.template(messages, {});
    expect(body.model).toMatch(/llama/);
    expect(body.messages[0].role).toBe('system');
    expect(body.system).toBeUndefined();
    expect(body.stream).toBe(false);
  });

  it('mistral uses its own directive framing and model', () => {
    const body = ADAPTERS.mistral.template(messages, {});
    expect(body.model).toMatch(/mistral/);
    expect(body.messages[0].content).toContain('[SYSTEM DIRECTIVE]');
    expect(body).toHaveProperty('safe_prompt');
  });

  it('ollama nests sampling under options with a local model', () => {
    const body = ADAPTERS.ollama.template(messages, { temperature: 0.5 });
    expect(body.stream).toBe(false);
    expect(body.options.temperature).toBe(0.5);
    expect(body.model).toMatch(/llama/);
  });

  it('claude, llama-on-groq, and mistral do not receive identical prompts', () => {
    const a = ADAPTERS.anthropic.template(messages, {});
    const g = ADAPTERS.groq.template(messages, {});
    const m = ADAPTERS.mistral.template(messages, {});
    const systemOf = (b) =>
      b.system || (b.messages.find((x) => x.role === 'system') || {}).content || '';
    expect(systemOf(a)).not.toBe(systemOf(g));
    expect(systemOf(g)).not.toBe(systemOf(m));
    expect(systemOf(a)).not.toBe(systemOf(m));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(g));
    expect(JSON.stringify(g)).not.toBe(JSON.stringify(m));
  });
});
