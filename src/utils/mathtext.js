// Math text rendering for agent prose.
//
// Research questions and rationales can carry mathematical notation. This util
// normalizes the two delimiter dialects to one, then renders the math with KaTeX,
// returning a DOM fragment that interleaves rendered math with plain text. The
// rendering is client-side and pure (katex.renderToString needs no browser), so it
// works in tests; the KaTeX stylesheet is imported once at the app entry, not here.
//
// The math is rendered as KaTeX HTML, never wrapped in code backticks (it is
// notation, not a code literal).

import katex from 'katex';

// Normalize ChatGPT-style delimiters to dollar delimiters: \(...\) -> $...$ (inline)
// and \[...\] -> $$...$$ (display). Function replacers avoid the special meaning of
// "$" inside a replacement string.
export function normalizeMathDelimiters(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expr) => `$$${expr}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, expr) => `$${expr}$`);
}

// Render text that may contain $...$ (inline) or $$...$$ (display) math into a
// DocumentFragment: math segments become KaTeX spans, the rest stays text. KaTeX
// runs with throwOnError:false so a malformed expression renders in its error style
// rather than throwing; a hard failure falls back to the literal source so nothing
// is silently dropped.
export function mathToFragment(text, doc = globalThis.document) {
  const fragment = doc.createDocumentFragment();
  const normalized = normalizeMathDelimiters(text == null ? '' : String(text));

  // $$...$$ first (display), then $...$ (inline); inline excludes newlines and empty
  // bodies so a lone "$" in prose is left as text.
  const pattern = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      fragment.appendChild(doc.createTextNode(normalized.slice(lastIndex, match.index)));
    }
    const displayMode = match[1] != null;
    const expr = displayMode ? match[1] : match[2];
    const span = doc.createElement('span');
    span.className = 'poe-math';
    try {
      span.innerHTML = katex.renderToString(expr, { displayMode, throwOnError: false });
    } catch (_err) {
      // KaTeX should not throw under throwOnError:false, but never drop the source.
      span.textContent = displayMode ? `$$${expr}$$` : `$${expr}$`;
    }
    fragment.appendChild(span);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < normalized.length) {
    fragment.appendChild(doc.createTextNode(normalized.slice(lastIndex)));
  }
  return fragment;
}
