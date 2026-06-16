import { describe, expect, it, vi } from 'vitest';
import { createTransports, normalizeContent } from '../../src/dispatcher/adapters/transports.js';
import { ApiKeyMissingError, NetworkError } from '../../src/dispatcher/errors.js';

// The real fetch() transports: the send() seam fill-in. Exercised with an injected
// fake fetch and a fake settings reader (no network), proving each provider's URL,
// auth headers, request body, response normalization, and the error paths.

// A minimal Response-like object. headers can be a plain object or a Headers-like
// (forEach + entries), both of which the transport must read.
function fakeResponse({ status = 200, headers = {}, body = {} } = {}) {
  return { status, headers, json: async () => body };
}

// A 2xx streaming Response: body.getReader() yields each string as an encoded chunk,
// the same shape a real fetch() streaming response exposes.
function streamingResponse(chunks, { status = 200, headers = {} } = {}) {
  const enc = new TextEncoder();
  let i = 0;
  return {
    status,
    headers,
    json: async () => ({}),
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: enc.encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
  };
}

// A Headers-like stub (forEach + entries) so the headers-normalization path is covered.
function headersLike(obj) {
  return {
    forEach: (fn) => Object.entries(obj).forEach(([k, v]) => fn(v, k)),
    entries: () => Object.entries(obj)[Symbol.iterator](),
  };
}

const KEYS = { keys: { anthropic: 'sk-ant', groq: 'gsk', mistral: 'mk' }, ollamaEndpoint: 'http://localhost:11434' };

describe('fetch transports', () => {
  it('anthropic: posts to the messages endpoint with the browser-access + version headers', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ body: { content: [{ type: 'text', text: 'hello from claude' }] } }),
    );
    const t = createTransports({ getSettings: () => KEYS, fetchImpl });

    const res = await t.anthropic({ model: 'claude-opus-4-8', messages: [] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('sk-ant');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(JSON.parse(init.body).model).toBe('claude-opus-4-8');
    // The transport returns the response envelope; body is the normalized content.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'hello from claude' });
  });

  it('groq and mistral: bearer auth, OpenAI-style content extraction', async () => {
    const groqFetch = vi.fn(async () =>
      fakeResponse({ body: { choices: [{ message: { content: 'groq says hi' } }] } }),
    );
    const groq = createTransports({ getSettings: () => KEYS, fetchImpl: groqFetch }).groq;
    const out = await groq({ messages: [] });
    expect(groqFetch.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(groqFetch.mock.calls[0][1].headers.authorization).toBe('Bearer gsk');
    expect(out.body).toEqual({ message: 'groq says hi' });

    const mistralFetch = vi.fn(async () =>
      fakeResponse({ body: { choices: [{ message: { content: 'bonjour' } }] } }),
    );
    const mistral = createTransports({ getSettings: () => KEYS, fetchImpl: mistralFetch }).mistral;
    await mistral({ messages: [] });
    expect(mistralFetch.mock.calls[0][0]).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(mistralFetch.mock.calls[0][1].headers.authorization).toBe('Bearer mk');
  });

  it('ollama: no auth, endpoint from settings, /api/chat envelope', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse({ body: { message: { content: 'local llama' } } }));
    const t = createTransports({
      getSettings: () => ({ keys: {}, ollamaEndpoint: 'http://127.0.0.1:11434/' }),
      fetchImpl,
    });
    const out = await t.ollama({ messages: [] });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:11434/api/chat');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();
    expect(out.body).toEqual({ message: 'local llama' });
  });

  it('parses structured JSON output (and strips code fences) into the body', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({
        body: { content: [{ type: 'text', text: '```json\n{"KnowledgeGap":"a gap","Claims":null}\n```' }] },
      }),
    );
    const t = createTransports({ getSettings: () => KEYS, fetchImpl });
    const out = await t.anthropic({ messages: [] });
    expect(out.body).toEqual({ KnowledgeGap: 'a gap', Claims: null });
  });

  it('reads the key fresh on every call (a key entered later takes effect)', async () => {
    let settings = { keys: {} };
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ body: { content: [{ type: 'text', text: 'ok' }] } }),
    );
    const t = createTransports({ getSettings: () => settings, fetchImpl });

    await expect(t.anthropic({ messages: [] })).rejects.toBeInstanceOf(ApiKeyMissingError);
    expect(fetchImpl).not.toHaveBeenCalled();

    settings = { keys: { anthropic: 'sk-now-set' } };
    await t.anthropic({ messages: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe('sk-now-set');
  });

  it('a missing key fails over without counting as a breaker fault', async () => {
    const fetchImpl = vi.fn();
    const t = createTransports({ getSettings: () => ({ keys: {} }), fetchImpl });
    const err = await t.groq({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiKeyMissingError);
    expect(err.failover).toBe(true);
    expect(err.countsAsFailure).toBe(false);
    expect(err.provider).toBe('groq');
  });

  it('passes a 429 status and retry-after through for the spine to classify', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ status: 429, headers: headersLike({ 'retry-after': '7' }), body: { error: 'rate_limited' } }),
    );
    const t = createTransports({ getSettings: () => KEYS, fetchImpl });
    const res = await t.anthropic({ messages: [] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('7');
    expect(res.body).toEqual({ error: 'rate_limited' });
  });

  it('wraps a fetch rejection (network / CORS) in a typed NetworkError', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const t = createTransports({ getSettings: () => KEYS, fetchImpl });
    const err = await t.anthropic({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err.failover).toBe(true);
    expect(err.provider).toBe('anthropic');
  });

  it('streams when an onToken sink is supplied: flips stream:true and drains the SSE deltas', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Lit"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"erature"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchImpl = vi.fn(async () => streamingResponse(chunks));
    const t = createTransports({ getSettings: () => KEYS, fetchImpl });

    const tokens = [];
    const res = await t.groq({ messages: [] }, { onToken: (tk) => tokens.push(tk) });

    // The request body opted into streaming.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).stream).toBe(true);
    // Prose was delivered progressively, then the full text normalized into the body.
    expect(tokens).toEqual(['Lit', 'erature']);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Literature' });
  });

  it('does not stream when no onToken is supplied (buffered read, stream:false)', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ body: { choices: [{ message: { content: 'buffered' } }] } }),
    );
    const t = createTransports({ getSettings: () => KEYS, fetchImpl });
    const res = await t.groq({ messages: [], stream: false });
    // No stream flag was forced on, and the response was read as buffered JSON.
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).stream).toBe(false);
    expect(res.body).toEqual({ message: 'buffered' });
  });
});

describe('normalizeContent', () => {
  it('wraps non-JSON prose as a message', () => {
    expect(normalizeContent('just a sentence')).toEqual({ message: 'just a sentence' });
  });
  it('returns a parsed JSON object verbatim', () => {
    expect(normalizeContent('{"a":1}')).toEqual({ a: 1 });
  });
  it('extracts JSON even when the model wraps it in prose (preamble + trailing note)', () => {
    expect(
      normalizeContent('Here is my assessment:\n{"approved": true, "feedback": []}\nLet me know.'),
    ).toEqual({ approved: true, feedback: [] });
  });
  it('extracts a JSON array embedded in prose', () => {
    expect(normalizeContent('The papers are: ["a", "b"].')).toEqual(['a', 'b']);
  });
  it('does not mis-parse prose that merely mentions braces', () => {
    expect(normalizeContent('Use a set like {x, y} in your notation.')).toEqual({
      message: 'Use a set like {x, y} in your notation.',
    });
  });
  it('handles empty/nullish input without throwing', () => {
    expect(normalizeContent('')).toEqual({ message: '' });
    expect(normalizeContent(null)).toEqual({ message: '' });
  });
});
