import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Design-token contract. jsdom does not resolve custom properties from linked
// stylesheets through the cascade, so this guards the token system statically: the
// token file's contract, the "Dusty University Office" cream/Win98 palette, the
// per-loop override mechanism, the reduced-motion shimmer degrade, and that the
// token system stays a single source of truth.

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

  it('defines the trust-layer confidence tokens', () => {
    // The cessation card's color-coded confidence pill needs more than the two
    // accents; these tokens are confined to the trust badge/banner (see the Loop 1
    // ARCHITECTURE doc). "high" reuses the confirmed-active accent.
    for (const token of ['--confidence-high', '--confidence-medium', '--confidence-low']) {
      expect(tokens, `missing ${token}`).toContain(`${token}:`);
    }
    expect(tokens).toMatch(/--confidence-high:\s*var\(--accent-active\)/);
  });

  it('defines the cream/Win98 surface, bevel, and error tokens', () => {
    for (const token of [
      '--surface-raised',
      '--surface-sunken',
      '--surface-document',
      '--bevel-light',
      '--bevel-dark',
      '--accent-error',
    ]) {
      expect(tokens, `missing ${token}`).toContain(`${token}:`);
    }
    // The Win98-era sans stack for non-data UI chrome.
    expect(tokens).toMatch(/--font-ui:\s*Tahoma/);
    // The shared bevel utilities live in main.css and use the bevel tokens.
    expect(main).toContain('.bevel-raised');
    expect(main).toContain('.bevel-sunken');
    expect(main).toMatch(/var\(--bevel-light\)/);
  });

  it('defines a z-index scale', () => {
    for (const layer of ['--z-base', '--z-overlay', '--z-error']) {
      expect(tokens, `missing ${layer}`).toContain(`${layer}:`);
    }
  });

  it('defaults --bg-primary to cream paper and ages it only under [data-loop="2"]', () => {
    expect(tokens).toMatch(/--bg-primary:\s*#EFE9D6/i);
    // The Loop 2 override lives in the token layer, keyed on the attribute the
    // orchestrator stamps, not a class and not inside a shared component.
    expect(tokens).toMatch(/\[data-loop="2"\]\s*\{\s*--bg-primary:\s*#E6DCC2/i);
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

  it('tints the canvas with the loop-aware paper token; the chrome reads the constant base', () => {
    // The canvas reads the loop-aware paper token (so Loop 2 can age it); the IO
    // panel reads the constant manila chrome token so it never shifts per loop.
    expect(shell).toMatch(/\.canvas\s*\{[\s\S]*?background(?:-color)?:\s*var\(--bg-primary\)/);
    expect(ioPanel).toMatch(/\.io-panel\s*\{[\s\S]*?background:\s*var\(--bg-base\)/);
  });
});
