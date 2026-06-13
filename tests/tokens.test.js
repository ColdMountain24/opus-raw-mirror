import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Phase 3 design-token contract. jsdom does not resolve custom properties from
// linked stylesheets through the cascade, so this guards the token system
// statically: the token file's contract, the per-loop override mechanism, the
// reduced-motion shimmer degrade, and that consumers were fully migrated off
// the Phase 2 token names (single source of truth, no split vocabulary).

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(here, '..', 'src', 'styles');
const read = (name) => readFileSync(path.join(stylesDir, name), 'utf-8');

const tokens = read('tokens.css');
const main = read('main.css');
const shell = read('shell.css');
const ioPanel = readFileSync(
  path.join(here, '..', 'src', 'components', 'ioPanel.css'),
  'utf-8',
);

describe('design tokens', () => {
  it('defines the mandated token set', () => {
    for (const token of [
      '--bg-primary',
      '--accent-active',
      '--accent-bracket',
      '--font-mono',
      '--font-ui',
    ]) {
      expect(tokens, `missing ${token}`).toContain(`${token}:`);
    }
  });

  it('defines a standard spacing scale', () => {
    for (const step of ['--space-0', '--space-1', '--space-2', '--space-4', '--space-8']) {
      expect(tokens, `missing ${step}`).toContain(`${step}:`);
    }
  });

  it('defines a z-index scale', () => {
    for (const layer of ['--z-base', '--z-overlay', '--z-error']) {
      expect(tokens, `missing ${layer}`).toContain(`${layer}:`);
    }
  });

  it('defaults --bg-primary to deep slate and warms it only under [data-loop="2"]', () => {
    expect(tokens).toMatch(/--bg-primary:\s*#0D0F12/i);
    // The Loop 2 override lives in the token layer, keyed on the attribute the
    // orchestrator stamps, not a class and not inside a shared component.
    expect(tokens).toMatch(/\[data-loop="2"\]\s*\{\s*--bg-primary:\s*#1A1410/i);
  });

  it('provides a shimmer that degrades to a static placeholder under reduced motion', () => {
    expect(tokens).toMatch(/@keyframes\s+shimmer/);
    expect(tokens).toContain('animation: shimmer');
    const reduced = tokens.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.skeleton\s*\{([\s\S]*?)\}/,
    );
    expect(reduced, 'no reduced-motion .skeleton block').toBeTruthy();
    expect(reduced[1]).toMatch(/animation:\s*none/);
  });

  it('keeps the token system as a single source of truth', () => {
    // tokens.css owns the :root block; main.css must not redeclare tokens.
    expect(main).not.toMatch(/:root\s*\{/);
    // The Phase 2 token names must be gone from every consumer.
    const all = `${main}\n${shell}`;
    for (const old of ['--bg-loop-1', '--bg-loop-2', '--accent-live', 'var(--bracket)']) {
      expect(all, `stale token ${old} still referenced`).not.toContain(old);
    }
  });

  it('warms the canvas only, leaving the chrome deep slate', () => {
    // The canvas reads the loop-aware token; the IO panel is pinned deep slate
    // in its own component CSS so it never warms under [data-loop="2"].
    expect(shell).toMatch(/\.canvas\s*\{[\s\S]*?background:\s*var\(--bg-primary\)/);
    expect(ioPanel).toMatch(/\.io-panel\s*\{[\s\S]*?background:\s*var\(--bg-base\)/);
  });
});
