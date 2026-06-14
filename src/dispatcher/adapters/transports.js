// Real fetch() transports, the send() seam fill-in (S0 always called these the
// "one-line fill-ins per adapter"). Each adapter's send() does
//   if (typeof transport === 'function') return transport(request)
// so a transport is just an async (request) -> { status, headers, body }. The
// spine (errors.js classification, parse429, retry, breaker, failover) never knows
// the difference between these and the deterministic simulator.
//
// Each transport closes over a settings reader (so the API key + Ollama endpoint
// are pulled FRESH at call time: a key entered in Settings takes effect on the next
// dispatch, no dispatcher rebuild) and an injectable fetch (the default is the real
// one; tests pass a fake). The `request` argument is the provider-ready body the
// adapter's template() already built; the transport only adds the URL, the auth
// headers, and response normalization.
//
// Charter boundary: this is transport mechanism only. It invents no agent values.
// On a 2xx it shuttles the model's text into the body shape the caller's schema
// expects (parsed JSON when the model emitted JSON, else { message: text }); if
// that does not satisfy the schema, the dispatcher's own corrective retry / safe
// default takes over. Non-2xx responses pass through untouched so the spine classifies
// 429 / 5xx / 4xx and reads retry-after itself.

import { loadSettings } from '../../components/settings.js';
import { ApiKeyMissingError, NetworkError } from '../errors.js';

// Per-provider wiring: the endpoint, the auth/content headers given a key, and how
// to pull the assistant text out of that provider's response envelope. Each adapter's
// template() already shapes the request body for its provider, so only these three
// differ here.
const HOSTED = {
  anthropic: {
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: (key) => ({
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Anthropic blocks browser calls unless this opt-in header is present. RAW is
      // a browser app with user-supplied keys, so it is required for a live call.
      'anthropic-dangerous-direct-browser-access': 'true',
    }),
    content: (body) =>
      Array.isArray(body && body.content)
        ? body.content
            .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('')
        : '',
  },
  groq: {
    url: () => 'https://api.groq.com/openai/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    content: (body) => openAiContent(body),
  },
  mistral: {
    url: () => 'https://api.mistral.ai/v1/chat/completions',
    headers: (key) => ({ 'content-type': 'application/json', authorization: `Bearer ${key}` }),
    content: (body) => openAiContent(body),
  },
};

// OpenAI-style chat completion envelope (Groq, Mistral).
function openAiContent(body) {
  const choice = body && Array.isArray(body.choices) ? body.choices[0] : null;
  const msg = choice && choice.message;
  return msg && typeof msg.content === 'string' ? msg.content : '';
}

// Ollama (local, HIPAA-only): no key, endpoint from settings, /api/chat envelope.
function ollamaContent(body) {
  const msg = body && body.message;
  return msg && typeof msg.content === 'string' ? msg.content : '';
}

// Strip a leading/trailing markdown code fence (```json ... ```), which some models
// wrap structured output in despite a "JSON only" instruction.
function stripFences(text) {
  const t = text.trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```[^\n]*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

// Pull a JSON object/array out of a model response, tolerant of a model that wraps
// it: a "Here is the assessment: {...}" preamble, a trailing note, or ```json fences.
// Tries a direct parse first (the clean, "JSON only" case), then the outermost
// {...} / [...] substring. Returns null when there is no parseable object/array, so
// genuine prose (Poe's questions) falls through to { message }.
function extractJson(text) {
  const t = stripFences(text);
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' ? v : null;
    } catch (_err) {
      return null;
    }
  };
  if (t.startsWith('{') || t.startsWith('[')) {
    const direct = tryParse(t);
    if (direct) return direct;
  }
  const objFirst = t.indexOf('{');
  const objLast = t.lastIndexOf('}');
  if (objFirst !== -1 && objLast > objFirst) {
    const obj = tryParse(t.slice(objFirst, objLast + 1));
    if (obj) return obj;
  }
  const arrFirst = t.indexOf('[');
  const arrLast = t.lastIndexOf(']');
  if (arrFirst !== -1 && arrLast > arrFirst) {
    const arr = tryParse(t.slice(arrFirst, arrLast + 1));
    if (arr) return arr;
  }
  return null;
}

// Normalize a model's assistant text into the body the caller's schema expects. If a
// JSON object/array can be extracted (even with surrounding prose), hand back the
// parsed value (the structured agents: extraction, RQSupervisor, Novelty). Otherwise
// wrap the prose as { message: text } so Poe's conversational turn (poeMessageSchema)
// is satisfied. (Poe's academic questions do not contain standalone JSON, so the
// extraction does not mis-fire on them; if one ever did, the corrective retry / Poe
// safe default handle it.)
export function normalizeContent(text) {
  const raw = text == null ? '' : String(text);
  const parsed = extractJson(raw);
  if (parsed) return parsed;
  return { message: raw.trim() };
}

// Convert a fetch Headers instance (or a plain object) to a plain object so the
// per-adapter parse429 helpers (which iterate Object.keys) can read retry-after.
function headersToObject(headers) {
  if (!headers) return {};
  if (typeof headers.forEach === 'function' && typeof headers.entries === 'function') {
    const out = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  return headers; // already a plain object (e.g. a test stub)
}

// Best-effort JSON parse of a response body; never throws (a non-JSON or empty body
// yields an empty object, which is enough for both the content path and the error path).
async function readJson(response) {
  try {
    return await response.json();
  } catch (_err) {
    return {};
  }
}

// Build a single provider transport. `name` selects the config; `getSettings` and
// `fetchImpl` are captured so the key/endpoint are read per call.
function makeTransport(name, getSettings, fetchImpl) {
  const isOllama = name === 'ollama';
  return async function transport(request) {
    const settings = getSettings() || {};
    const key = settings.keys ? settings.keys[name] : undefined;
    if (!isOllama && !key) {
      // Fails over to the next provider without tripping this one's breaker.
      throw new ApiKeyMissingError(`${name} api key not set`, { provider: name });
    }

    const url = isOllama
      ? `${(settings.ollamaEndpoint || 'http://localhost:11434').replace(/\/+$/, '')}/api/chat`
      : HOSTED[name].url();
    const headers = isOllama
      ? { 'content-type': 'application/json' }
      : HOSTED[name].headers(key);

    if (typeof fetchImpl !== 'function') {
      // No fetch in this environment (e.g. a non-browser host without a polyfill).
      // Fail over rather than crash; a real browser always has fetch.
      throw new NetworkError(`${name} has no fetch implementation`, { provider: name });
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(request),
      });
    } catch (cause) {
      // Network failure, offline, or a browser CORS block: fail over to the next provider.
      throw new NetworkError(`${name} request failed: ${cause && cause.message ? cause.message : cause}`, {
        provider: name,
      });
    }

    const status = response.status;
    const headerObj = headersToObject(response.headers);
    const body = await readJson(response);

    // Non-2xx: pass the real status + headers + body through unchanged so the spine
    // classifies 429 / 5xx / 4xx and parse429 reads retry-after.
    if (status < 200 || status >= 300) {
      return { status, headers: headerObj, body };
    }

    const text = isOllama ? ollamaContent(body) : HOSTED[name].content(body);
    return { status, headers: headerObj, body: normalizeContent(text) };
  };
}

// Build the transport map main.js injects into configureDispatcher. getSettings
// defaults to the persisted settings reader; fetchImpl defaults to the real fetch.
export function createTransports({ getSettings = loadSettings, fetchImpl } = {}) {
  // Resolve fetch lazily-tolerant: construction never throws (so the app shell boots
  // even where fetch is absent); a transport with no fetch fails over at call time.
  const doFetch =
    fetchImpl ||
    (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  return {
    anthropic: makeTransport('anthropic', getSettings, doFetch),
    groq: makeTransport('groq', getSettings, doFetch),
    mistral: makeTransport('mistral', getSettings, doFetch),
    ollama: makeTransport('ollama', getSettings, doFetch),
  };
}
