// Shared header-parsing helpers for the per-provider 429 parsers (5f).

// Case-insensitive header lookup; transports normalize header names
// inconsistently, so never assume casing.
export function headerGet(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

// Convert a retry-after style value to milliseconds. Accepts a number of
// seconds (possibly fractional) or an HTTP date. Returns undefined if it cannot
// be parsed. now is injectable for deterministic tests of the date branch.
export function retryAfterToMs(value, now = Date.now()) {
  if (value == null) return undefined;
  const s = String(value).trim();
  if (s === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  const date = Date.parse(s);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}
