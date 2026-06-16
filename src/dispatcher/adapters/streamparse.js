// Streaming response parser for the real fetch transports.
//
// Consumes a fetch Response's streaming body, forwarding each text delta to
// onToken (for Poe's progressive prose) and returning the FULL accumulated
// assistant text, which the transport then normalizes exactly like a buffered
// response. Validation always runs on that full text downstream, never a partial.
//
// Provider-agnostic by two seams: `mode` picks the wire framing and `extract`
// pulls the text delta out of one parsed event. It buffers across read() chunks so
// an event split across two network packets is parsed once, whole, and tolerates an
// unparseable record (a keep-alive, a truncated flush) by skipping it rather than
// throwing mid-stream.
//
//   anthropic  SSE   data: {"type":"content_block_delta","delta":{"text":"..."}}
//   groq       SSE   data: {"choices":[{"delta":{"content":"..."}}]}  ... data: [DONE]
//   mistral    SSE   (OpenAI-style, same as groq)
//   ollama     NDJSON {"message":{"content":"..."},"done":false}\n ...

// Per-provider text-delta extractors. Each returns '' for an event that carries no
// text (anthropic ping / message_stop, an OpenAI role-only opening delta, ollama's
// terminal done:true line), so those never reach onToken.
export const EXTRACT = {
  anthropic: (o) => (o && o.delta && typeof o.delta.text === 'string' ? o.delta.text : ''),
  openai: (o) => {
    const choice = o && Array.isArray(o.choices) ? o.choices[0] : null;
    return choice && choice.delta && typeof choice.delta.content === 'string'
      ? choice.delta.content
      : '';
  },
  ollama: (o) => (o && o.message && typeof o.message.content === 'string' ? o.message.content : ''),
};

// Wire framing + extractor per provider.
export const STREAM_CONFIG = {
  anthropic: { mode: 'sse', extract: EXTRACT.anthropic },
  groq: { mode: 'sse', extract: EXTRACT.openai },
  mistral: { mode: 'sse', extract: EXTRACT.openai },
  ollama: { mode: 'ndjson', extract: EXTRACT.ollama },
};

// The data payload of one SSE event block: the concatenation of its `data:` lines
// (the SSE spec joins multiple data lines with \n; our providers use a single one).
// `event:` / `id:` / comment lines are ignored.
function sseData(eventBlock) {
  const parts = [];
  for (const line of eventBlock.split('\n')) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) parts.push(m[1]);
  }
  return parts.join('\n').trim();
}

// Turn one delimited record into its text delta (or '' to skip it).
function recordDelta(record, mode, extract) {
  const payload = mode === 'ndjson' ? record.trim() : sseData(record);
  if (!payload || payload === '[DONE]') return '';
  let obj;
  try {
    obj = JSON.parse(payload);
  } catch (_err) {
    return ''; // a partial/keep-alive line: skip rather than throw
  }
  try {
    const delta = extract(obj);
    return typeof delta === 'string' ? delta : '';
  } catch (_err) {
    return '';
  }
}

// Read the whole stream. Returns the full assistant text; calls onToken(delta) per
// non-empty delta in order. Returns '' when the response has no readable body stream
// (the caller falls back to a buffered read).
export async function readStream(response, { mode = 'sse', extract, onToken } = {}) {
  const reader =
    response && response.body && typeof response.body.getReader === 'function'
      ? response.body.getReader()
      : null;
  if (!reader || typeof extract !== 'function') return '';

  const decoder = new TextDecoder();
  const sep = mode === 'ndjson' ? '\n' : '\n\n';
  let buffer = '';
  let full = '';

  const pump = (record) => {
    const delta = recordDelta(record, mode, extract);
    if (delta) {
      full += delta;
      if (typeof onToken === 'function') onToken(delta);
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf(sep)) !== -1) {
      const record = buffer.slice(0, idx);
      buffer = buffer.slice(idx + sep.length);
      pump(record);
    }
  }
  // Flush any trailing partial record (a final NDJSON line or SSE event with no
  // trailing separator) plus any bytes the decoder was holding.
  buffer += decoder.decode();
  if (buffer.trim()) pump(buffer);

  return full;
}
