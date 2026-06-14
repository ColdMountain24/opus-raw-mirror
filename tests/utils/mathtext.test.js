import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters, mathToFragment } from '../../src/utils/mathtext.js';

// mathtext normalizes the two math-delimiter dialects to one and renders the result
// with KaTeX. renderToString is pure (no browser), so these run under jsdom and
// assert on KaTeX's HTML output.

function html(fragment) {
  const host = document.createElement('div');
  host.appendChild(fragment);
  return host.innerHTML;
}

describe('normalizeMathDelimiters', () => {
  it('converts ChatGPT-style inline and display delimiters to dollar delimiters', () => {
    expect(normalizeMathDelimiters('the value \\(x^2\\) grows')).toBe('the value $x^2$ grows');
    expect(normalizeMathDelimiters('display \\[a+b\\] here')).toBe('display $$a+b$$ here');
  });

  it('leaves text with no math untouched and tolerates non-strings', () => {
    expect(normalizeMathDelimiters('no math here')).toBe('no math here');
    expect(normalizeMathDelimiters(null)).toBe('');
    expect(normalizeMathDelimiters(42)).toBe('');
  });
});

describe('mathToFragment', () => {
  it('renders inline math through KaTeX and keeps surrounding text', () => {
    const out = html(mathToFragment('energy is $E = mc^2$ exactly'));
    expect(out).toContain('energy is ');
    expect(out).toContain(' exactly');
    expect(out).toContain('class="katex"'); // KaTeX rendered, not raw text
    expect(out).not.toContain('$E = mc^2$'); // the dollar source is consumed
  });

  it('normalizes ChatGPT delimiters before rendering and supports display math', () => {
    const out = html(mathToFragment('see \\[\\sum_{i=1}^n i\\] below'));
    expect(out).toContain('class="katex"');
    expect(out).toContain(' below');
  });

  it('renders plain text as a text node with no KaTeX when there is no math', () => {
    const out = html(mathToFragment('just a sentence, no notation'));
    expect(out).toBe('just a sentence, no notation');
    expect(out).not.toContain('katex');
  });

  it('does not wrap math in code backticks', () => {
    const out = html(mathToFragment('inline $x$ here'));
    expect(out).not.toContain('<code');
    expect(out).not.toContain('`');
  });

  it('does not throw on a malformed expression', () => {
    expect(() => mathToFragment('broken $\\frac{1}{$ end')).not.toThrow();
  });
});
