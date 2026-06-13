// Token pre-counting.
//
// This build has no provider tokenizer, so token counts are a heuristic: about
// four characters per token. Good enough for the 80% throughput gate (5d),
// which only needs to avoid consuming a slot on a request that would clearly
// exceed a token limit. Replace with a real tokenizer when fetch is wired.

export function countText(text) {
  if (text == null) return 0;
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(str.length / 4);
}

export function countMessages(messages = []) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((total, message) => {
    const content = message && message.content != null ? message.content : message;
    return total + countText(content);
  }, 0);
}

// Output tokens are unknown before the call, so reserve the requested ceiling.
export function estimateOutput(spec = {}) {
  return spec.maxTokens != null ? spec.maxTokens : 1024;
}
