import { describe, it, expect } from 'vitest';
import { readStream, EXTRACT, STREAM_CONFIG } from '../../src/dispatcher/adapters/streamparse.js';

// The streaming-response parser: per-provider SSE / NDJSON framing, buffered across
// read() chunks so an event split mid-packet is parsed once whole, and tolerant of
// keep-alive / terminal records that carry no text.

// A fake fetch Response whose body.getReader() yields the given strings as encoded
// chunks. The chunk boundaries are deliberate: they let a test split one logical
// event across two reads to prove the buffering.
function streamOf(chunks) {
  const enc = new TextEncoder();
  let i = 0;
  return {
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

describe('readStream', () => {
  it('anthropic SSE: accumulates text_delta events split across network chunks', async () => {
    // The second event is split across two reads ("...te" | "xt":"lo"...) to prove the buffer.
    const response = streamOf([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"te',
      'xt_delta","text":"lo"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]);
    const tokens = [];
    const full = await readStream(response, {
      ...STREAM_CONFIG.anthropic,
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(full).toBe('Hello');
  });

  it('groq/openai SSE: extracts choices[].delta.content and stops at [DONE]', async () => {
    const response = streamOf([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"foo"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"bar"}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const tokens = [];
    const full = await readStream(response, {
      ...STREAM_CONFIG.groq,
      onToken: (t) => tokens.push(t),
    });
    // The role-only opening delta carries no text and is skipped.
    expect(tokens).toEqual(['foo', 'bar']);
    expect(full).toBe('foobar');
  });

  it('ollama NDJSON: one object per line, terminal done line has no content, no trailing newline', async () => {
    const response = streamOf([
      '{"message":{"content":"par"},"done":false}\n',
      '{"message":{"content":"tial"},"done":false}\n',
      '{"message":{"content":""},"done":true}', // final line, no trailing \n -> flushed
    ]);
    const tokens = [];
    const full = await readStream(response, {
      ...STREAM_CONFIG.ollama,
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual(['par', 'tial']);
    expect(full).toBe('partial');
  });

  it('returns empty string when the response has no readable stream body', async () => {
    const full = await readStream({ body: {} }, { ...STREAM_CONFIG.anthropic, onToken: () => {} });
    expect(full).toBe('');
  });

  it('skips an unparseable record without throwing', async () => {
    const response = streamOf(['data: not-json\n\n', 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']);
    const tokens = [];
    const full = await readStream(response, { mode: 'sse', extract: EXTRACT.openai, onToken: (t) => tokens.push(t) });
    expect(tokens).toEqual(['ok']);
    expect(full).toBe('ok');
  });
});
