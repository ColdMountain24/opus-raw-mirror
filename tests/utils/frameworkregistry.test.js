import { describe, expect, it } from 'vitest';
import {
  createFrameworkRegistry,
  FrameworkRegistryError,
  frameworkRegistry,
} from '../../src/utils/frameworkregistry.js';

// FrameworkRegistry is the client-side framework content store: register(id, def)
// + deterministic lookup(id). It is a pure in-memory map (no dispatch); these
// tests pin the mechanism and its failure model.

describe('FrameworkRegistry', () => {
  it('registers and looks up a framework deterministically', () => {
    const reg = createFrameworkRegistry();
    reg.register('clinical-rct', { fields: ['population', 'intervention'] });

    const first = reg.lookup('clinical-rct');
    const second = reg.lookup('clinical-rct');
    expect(first).toEqual({ fields: ['population', 'intervention'] });
    // Same id always returns the same field set (the same frozen reference).
    expect(second).toBe(first);
  });

  it('returns null for an unregistered id (absence is a value, not an error)', () => {
    const reg = createFrameworkRegistry();
    expect(reg.lookup('does-not-exist')).toBeNull();
    expect(reg.has('does-not-exist')).toBe(false);
  });

  it('seeds definitions passed to the factory', () => {
    const reg = createFrameworkRegistry({
      'a': { fields: ['x'] },
      'b': { fields: ['y'] },
    });
    expect(reg.ids().sort()).toEqual(['a', 'b']);
    expect(reg.has('a')).toBe(true);
    expect(reg.lookup('b')).toEqual({ fields: ['y'] });
  });

  it('freezes stored definitions so a caller cannot mutate registry content', () => {
    const reg = createFrameworkRegistry();
    reg.register('f', { fields: ['one'], nested: { deep: true } });
    const def = reg.lookup('f');
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.fields)).toBe(true);
    expect(Object.isFrozen(def.nested)).toBe(true);
    expect(() => {
      def.fields.push('two');
    }).toThrow();
    // The stored content is unchanged after the attempted mutation.
    expect(reg.lookup('f').fields).toEqual(['one']);
  });

  it('rejects a blank id, a non-object definition, and a duplicate id (typed, not swallowed)', () => {
    const reg = createFrameworkRegistry();

    expect(() => reg.register('', { fields: [] })).toThrow(FrameworkRegistryError);
    expect(() => reg.register('   ', { fields: [] })).toThrow(FrameworkRegistryError);
    expect(() => reg.register('ok', null)).toThrow(FrameworkRegistryError);
    expect(() => reg.register('ok', 'not-an-object')).toThrow(FrameworkRegistryError);
    expect(() => reg.lookup(42)).toThrow(FrameworkRegistryError);

    reg.register('dup', { fields: ['a'] });
    expect(() => reg.register('dup', { fields: ['b'] })).toThrow(FrameworkRegistryError);
    // The original registration is intact after the rejected duplicate.
    expect(reg.lookup('dup')).toEqual({ fields: ['a'] });
  });

  it('the typed error carries the op and id for the boundary', () => {
    const reg = createFrameworkRegistry();
    try {
      reg.register('', {});
      throw new Error('expected a throw');
    } catch (err) {
      expect(err).toBeInstanceOf(FrameworkRegistryError);
      expect(err.op).toBe('register');
      expect(err.name).toBe('FrameworkRegistryError');
    }
  });

  it('ships the default singleton empty (framework content is FINAL, registered as data later)', () => {
    expect(frameworkRegistry.ids()).toEqual([]);
  });
});
