import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createStorage, StorageError } from '../../src/utils/storage.js';

// Storage layer (src/utils/storage.js). Every backend is injected:
//   - IndexedDB:    a fresh fake-indexeddb IDBFactory per test for isolation.
//   - localStorage: an in-memory Map stub (jsdom localStorage throws on opaque
//                   origins, matching the cache suite's convention).
//   - File System Access API / download fallback: fake picker + fake DOM.
// The suite asserts both the happy round-trips and that every failure path
// raises a typed StorageError with context instead of failing silently.

function memStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    has: (k) => m.has(k),
    get length() {
      return m.size;
    },
    key: (i) => Array.from(m.keys())[i] ?? null,
  };
}

// Resolve to the rejection reason, or fail loudly if the promise resolved.
async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// kg: IndexedDB
// ---------------------------------------------------------------------------
describe('kg storage (IndexedDB)', () => {
  const freshKg = () => createStorage({ indexedDB: new IDBFactory() }).kg;

  it('round-trips a serialized KG object keyed by loop id + version', async () => {
    const kg = freshKg();
    const data = { nodes: [{ id: 'n1', label: 'cessation' }], edges: [], meta: { built: 42 } };
    const ack = await kg.save('loop-1', 3, data);
    expect(ack).toEqual({ loopId: 'loop-1', version: 3 });
    expect(await kg.load('loop-1', 3)).toEqual(data);
  });

  it('returns null for a key that was never written (absence, not an error)', async () => {
    const kg = freshKg();
    expect(await kg.load('loop-9', 1)).toBeNull();
  });

  it('keys independently by version and by loop id', async () => {
    const kg = freshKg();
    await kg.save('loop-1', 1, { v: 'one' });
    await kg.save('loop-1', 2, { v: 'two' });
    await kg.save('loop-2', 1, { v: 'other' });
    expect(await kg.load('loop-1', 1)).toEqual({ v: 'one' });
    expect(await kg.load('loop-1', 2)).toEqual({ v: 'two' });
    expect(await kg.load('loop-2', 1)).toEqual({ v: 'other' });
  });

  it('overwrites the snapshot for an existing loop id + version', async () => {
    const kg = freshKg();
    await kg.save('loop-1', 1, { rev: 1 });
    await kg.save('loop-1', 1, { rev: 2 });
    expect(await kg.load('loop-1', 1)).toEqual({ rev: 2 });
  });

  it('throws a typed StorageError when the value is not serializable', async () => {
    const kg = freshKg();
    const circular = {};
    circular.self = circular;
    const err = await rejection(kg.save('loop-1', 1, circular));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.op).toBe('kg.save');
    expect(err.backend).toBe('indexeddb');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('rejects a missing or invalid key part explicitly', async () => {
    const kg = freshKg();
    const noVersion = await rejection(kg.save('loop-1', undefined, { a: 1 }));
    expect(noVersion).toBeInstanceOf(StorageError);
    expect(noVersion.op).toBe('kg.save');
    expect(noVersion.message).toMatch(/requires a version/);

    const badLoop = await rejection(kg.load({}, 1));
    expect(badLoop).toBeInstanceOf(StorageError);
    expect(badLoop.message).toMatch(/must be a string or finite number/);
  });

  it('reports that IndexedDB is unavailable rather than failing silently', async () => {
    const kg = createStorage({ indexedDB: null }).kg;
    const err = await rejection(kg.save('loop-1', 1, { a: 1 }));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).toMatch(/IndexedDB is not available/);
  });
});

// ---------------------------------------------------------------------------
// session: localStorage
// ---------------------------------------------------------------------------
describe('session storage (localStorage)', () => {
  const sessionKey = 'opuscc:session:v1';

  it('round-trips session state through localStorage', async () => {
    const mem = memStorage();
    const { session } = createStorage({ localStorage: mem });
    const state = { currentLoop: 2, machine: 'AWAIT_TURN', activePacket: { id: 'p7' } };
    expect(await session.save(state)).toBe(true);
    expect(mem.has(sessionKey)).toBe(true);
    expect(await session.load()).toEqual(state);
  });

  it('returns null when no session has been saved', async () => {
    const { session } = createStorage({ localStorage: memStorage() });
    expect(await session.load()).toBeNull();
  });

  it('clears the saved session', async () => {
    const mem = memStorage();
    const { session } = createStorage({ localStorage: mem });
    await session.save({ currentLoop: 1 });
    expect(await session.clear()).toBe(true);
    expect(mem.has(sessionKey)).toBe(false);
    expect(await session.load()).toBeNull();
  });

  it('surfaces a write failure (such as quota exceeded) as a StorageError', async () => {
    const broken = {
      ...memStorage(),
      setItem: () => {
        const e = new Error('quota');
        e.name = 'QuotaExceededError';
        throw e;
      },
    };
    const { session } = createStorage({ localStorage: broken });
    const err = await rejection(session.save({ big: 'state' }));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.op).toBe('session.save');
    expect(err.backend).toBe('localstorage');
    expect(err.cause.name).toBe('QuotaExceededError');
  });

  it('surfaces corrupt stored state as a StorageError on load', async () => {
    const mem = memStorage({ [sessionKey]: '{not valid json' });
    const { session } = createStorage({ localStorage: mem });
    const err = await rejection(session.load());
    expect(err).toBeInstanceOf(StorageError);
    expect(err.op).toBe('session.load');
    expect(err.message).toMatch(/corrupt/);
  });

  it('reports that localStorage is unavailable rather than failing silently', async () => {
    const { session } = createStorage({ localStorage: null });
    const err = await rejection(session.load());
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).toMatch(/localStorage is not available/);
  });
});

// ---------------------------------------------------------------------------
// file: File System Access API (+ download fallback)
// ---------------------------------------------------------------------------
describe('file export (File System Access API)', () => {
  function fakePicker({ abort = false } = {}) {
    const writes = [];
    const closed = { value: false };
    const picker = vi.fn(async () => {
      if (abort) {
        const e = new Error('user dismissed');
        e.name = 'AbortError';
        throw e;
      }
      return {
        createWritable: async () => ({
          write: async (c) => writes.push(c),
          close: async () => {
            closed.value = true;
          },
        }),
      };
    });
    return { picker, writes, closed };
  }

  it('writes the content through the picker handle and reports the method', async () => {
    const { picker, writes, closed } = fakePicker();
    const { file } = createStorage({ showSaveFilePicker: picker });
    const result = await file.export('kg-export.json', '{"ok":true}');
    expect(result).toEqual({ saved: true, filename: 'kg-export.json', method: 'file-system-access' });
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'kg-export.json' });
    expect(writes).toEqual(['{"ok":true}']);
    expect(closed.value).toBe(true);
  });

  it('treats a user cancellation as a reported outcome, not an error', async () => {
    const { picker } = fakePicker({ abort: true });
    const { file } = createStorage({ showSaveFilePicker: picker });
    const result = await file.export('x.json', 'data');
    expect(result).toEqual({ saved: false, cancelled: true, filename: 'x.json' });
  });

  it('wraps a write failure in a StorageError', async () => {
    const picker = vi.fn(async () => ({
      createWritable: async () => ({
        write: async () => {
          throw new Error('disk full');
        },
        close: async () => {},
      }),
    }));
    const { file } = createStorage({ showSaveFilePicker: picker });
    const err = await rejection(file.export('x.json', 'data'));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.op).toBe('file.export');
    expect(err.cause.message).toBe('disk full');
  });

  it('requires a filename', async () => {
    const { file } = createStorage({ showSaveFilePicker: vi.fn() });
    const err = await rejection(file.export('', 'data'));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).toMatch(/requires a filename/);
  });

  it('falls back to an anchor download when the API is absent', async () => {
    const revoked = [];
    const anchors = [];
    const documentRef = {
      createElement: () => {
        const el = { clicked: 0, click() { this.clicked += 1; } };
        anchors.push(el);
        return el;
      },
      body: { appendChild() {}, removeChild() {} },
    };
    const urlRef = {
      createObjectURL: () => 'blob:opuscc',
      revokeObjectURL: (u) => revoked.push(u),
    };
    function blobCtor(parts, opts) {
      this.parts = parts;
      this.opts = opts;
    }
    const { file } = createStorage({
      showSaveFilePicker: null,
      documentRef,
      urlRef,
      blobCtor,
    });
    const result = await file.export('x.json', 'data');
    expect(result).toEqual({ saved: true, filename: 'x.json', method: 'anchor-download' });
    expect(anchors[0].clicked).toBe(1);
    expect(anchors[0].download).toBe('x.json');
    expect(revoked).toEqual(['blob:opuscc']); // object URL is released
  });

  it('reports lack of support when there is no API and no fallback', async () => {
    const { file } = createStorage({
      showSaveFilePicker: null,
      documentRef: null,
      urlRef: null,
      blobCtor: null,
    });
    const err = await rejection(file.export('x.json', 'data'));
    expect(err).toBeInstanceOf(StorageError);
    expect(err.message).toMatch(/not supported/);
  });
});
