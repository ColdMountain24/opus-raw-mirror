// Incremental partial-JSON parser for streaming claim extraction.
//
// The Grad Students stream their claim JSON; this parser is fed each token delta as it
// arrives (from dispatch's onToken) and emits open/field/close events the MOMENT each
// piece parses, so a claim node can appear in the Observatory and a claim card in the IO
// panel before the full extraction completes. It is a char-fed state machine: every
// character is processed exactly once and events fire on completion, so it is O(n) and
// never re-parses the accumulated string (naive JSON.parse-per-chunk is O(n^2) and
// visibly stutters past a few KB).
//
// It is schema-agnostic at the JSON level. It is tuned only for the documented Grad
// Student output shape `{ "claims": [ { ... }, ... ] }`: it recognizes the `claims`
// array of the root object and reports each element object as a claim (by array index),
// with its top-level fields. Anything else parses correctly but emits no claim events.
//
// Presentation only. The authoritative claims still come from the dispatcher's FULL
// validated body (the hard constraint: never feed a partial parse downstream). This
// parser drives the loading -> parsed render preview, nothing the KG depends on.
//
// Events:
//   onClaimOpen(index, partial)            once, when the claim's claim_id first parses
//   onClaimField(index, key, value, partial) each time a top-level claim field completes
//   onClaimClose(index, claim)             when the claim object closes
// `partial` is the live claim object being built (already carries the completed fields).

export function createClaimStreamParser(handlers = {}) {
  const onClaimOpen = typeof handlers.onClaimOpen === 'function' ? handlers.onClaimOpen : () => {};
  const onClaimField = typeof handlers.onClaimField === 'function' ? handlers.onClaimField : () => {};
  const onClaimClose = typeof handlers.onClaimClose === 'function' ? handlers.onClaimClose : () => {};

  const stack = []; // open containers, innermost last
  let root = null; // the parsed root value once it closes
  let claimCounter = 0; // next claim index

  // string scan state
  let inStr = false;
  let strBuf = '';
  let esc = false; // a backslash escape is pending
  let uniBuf = null; // collecting the 4 hex digits of \uXXXX

  // literal scan state (numbers, true, false, null)
  let litBuf = null;

  const top = () => (stack.length ? stack[stack.length - 1] : null);
  const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';

  function openContainer(kind) {
    const parent = top();
    let role = 'other';
    let claimIndex = -1;
    if (!parent) {
      role = 'root';
    } else if (parent.kind === 'object' && parent.role === 'root' && parent.pendingKey === 'claims' && kind === 'array') {
      role = 'claims-array';
    } else if (parent.role === 'claims-array' && kind === 'object') {
      role = 'claim';
      claimIndex = claimCounter++;
    }
    stack.push({ kind, value: kind === 'object' ? {} : [], role, claimIndex, pendingKey: null, opened: false });
  }

  function emitClaimField(frame, key, value) {
    if (!frame.opened && key === 'claim_id' && typeof value === 'string' && value) {
      frame.opened = true;
      onClaimOpen(frame.claimIndex, frame.value);
    }
    onClaimField(frame.claimIndex, key, value, frame.value);
  }

  // Assign a completed value (primitive or closed container) to the current container.
  function assign(v) {
    const t = top();
    if (!t) {
      root = v;
      return;
    }
    if (t.kind === 'array') {
      t.value.push(v);
      return;
    }
    const key = t.pendingKey;
    t.pendingKey = null;
    if (key == null) return; // a value with no key: malformed, ignore rather than throw
    t.value[key] = v;
    if (t.role === 'claim') emitClaimField(t, key, v);
  }

  function closeContainer() {
    const frame = stack.pop();
    if (!frame) return; // a stray close bracket: ignore
    if (frame.role === 'claim' && frame.opened) onClaimClose(frame.claimIndex, frame.value);
    assign(frame.value);
  }

  function commitString(s) {
    const t = top();
    if (t && t.kind === 'object' && t.pendingKey == null) {
      t.pendingKey = s; // an object expecting a key reads this string as the key
    } else {
      assign(s); // otherwise it is a value (object value, array element, or root)
    }
  }

  function finishLiteral() {
    const lit = litBuf;
    litBuf = null;
    let v;
    if (lit === 'true') v = true;
    else if (lit === 'false') v = false;
    else if (lit === 'null') v = null;
    else v = Number(lit);
    assign(v);
  }

  function structural(c) {
    if (isWs(c)) return;
    if (stack.length === 0) {
      // Top level: ignore prose until the root container opens, and any trailing noise
      // after it closes. The Grad Student prompt pins a `{ "claims": [...] }` object.
      if (root === null && (c === '{' || c === '[')) openContainer(c === '{' ? 'object' : 'array');
      return;
    }
    if (c === '{') return void openContainer('object');
    if (c === '[') return void openContainer('array');
    if (c === '}' || c === ']') return void closeContainer();
    if (c === '"') {
      inStr = true;
      strBuf = '';
      return;
    }
    if (c === ':' || c === ',') return; // separators: key/value commit tracks the rest
    litBuf = c; // a number / true / false / null begins
  }

  const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

  function feedChar(c) {
    if (inStr) {
      if (esc) {
        esc = false;
        if (c === 'u') {
          uniBuf = '';
          return;
        }
        strBuf += Object.prototype.hasOwnProperty.call(ESCAPES, c) ? ESCAPES[c] : c;
        return;
      }
      if (uniBuf != null) {
        uniBuf += c;
        if (uniBuf.length === 4) {
          strBuf += String.fromCharCode(parseInt(uniBuf, 16) || 0);
          uniBuf = null;
        }
        return;
      }
      if (c === '\\') {
        esc = true;
        return;
      }
      if (c === '"') {
        inStr = false;
        commitString(strBuf);
        strBuf = '';
        return;
      }
      strBuf += c;
      return;
    }
    if (litBuf != null) {
      if (isWs(c) || c === ',' || c === '}' || c === ']') {
        finishLiteral();
        structural(c); // the delimiter still needs structural handling (e.g. close)
        return;
      }
      litBuf += c;
      return;
    }
    structural(c);
  }

  function push(text) {
    if (text == null) return;
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) feedChar(s[i]);
  }

  function end() {
    if (litBuf != null) finishLiteral(); // flush a number that ran to the end of input
  }

  return { push, end, getResult: () => root };
}
