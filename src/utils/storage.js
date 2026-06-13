// Storage layer: three backends behind clean async wrappers.
//
//   kg       GlobalKG snapshots         -> IndexedDB  (durable, large, keyed by
//                                          loop id + KG version)
//   session  orchestrator/session state -> localStorage (small, synchronous,
//                                          current loop + state-machine position
//                                          + active packet)
//   file     explicit user exports      -> File System Access API (save dialog),
//                                          with an anchor-download fallback
//
// Every wrapper is async for a uniform interface, and every wrapper handles
// errors explicitly: a low-level failure (a blocked open, a QuotaExceededError,
// a corrupt JSON blob, a non-serializable value) is translated into a typed
// StorageError that carries the operation, backend, and key, then re-thrown so
// it reaches the global error boundary with reproducible context. Nothing is
// swallowed. A genuine "absent" read (no row, no key) is reported as null, which
// is a value and not an error.
//
// The layer owns the storage mechanism, not the shapes it persists. KG objects
// and session state are serialized verbatim (JSON), so the agent and
// orchestrator layers stay the single owners of those schemas.
//
// All three backends are injectable through createStorage() so tests run against
// in-memory fakes (jsdom ships no IndexedDB, and localStorage throws on opaque
// origins). The module also exports default kg/session/file instances bound to
// the real browser globals; binding is guarded so importing this file never
// throws even where a backend is missing.

// ---------------------------------------------------------------------------
// Typed error. Carries enough context to locate the failure from the boundary.
// ---------------------------------------------------------------------------
export class StorageError extends Error {
  constructor(message, { op, backend, key, cause } = {}) {
    super(message);
    this.name = 'StorageError';
    this.op = op; // 'kg.save' | 'kg.load' | 'session.save' | 'session.load' | 'file.export'
    this.backend = backend; // 'indexeddb' | 'localstorage' | 'filesystem'
    this.key = key; // the key or filename involved, when there is one
    this.cause = cause; // the original low-level error, preserved for the chain
  }
}

// Read a global without letting its mere access throw (localStorage on an opaque
// origin throws a SecurityError just from property access).
function safeGlobal(getter) {
  try {
    return getter();
  } catch (_err) {
    return undefined;
  }
}

// Wrap a low-level backend error in a contextualized StorageError. Already typed
// errors pass through unchanged so context is never doubled.
function wrap(op, backend, key, err) {
  if (err instanceof StorageError) return err;
  const detail = err && err.message ? err.message : String(err);
  return new StorageError(`${op} failed: ${detail}`, { op, backend, key, cause: err });
}

// IndexedDB accepts string, finite number, Date, or arrays of those as keys. We
// compose [loopId, version] and validate the parts up front so a bad key fails
// with a clear message instead of an opaque DataError deep in a transaction.
function assertKeyPart(op, label, value) {
  if (value === undefined || value === null) {
    throw new StorageError(`${op} requires a ${label}`, { op, backend: 'indexeddb' });
  }
  const t = typeof value;
  const ok = t === 'string' || (t === 'number' && Number.isFinite(value));
  if (!ok) {
    throw new StorageError(`${op} ${label} must be a string or finite number`, {
      op,
      backend: 'indexeddb',
      key: value,
    });
  }
}

function serialize(op, backend, key, value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch (err) {
    // Circular references and the like surface here rather than silently.
    throw new StorageError(`${op} could not serialize the value`, { op, backend, key, cause: err });
  }
  if (json === undefined) {
    // JSON.stringify(undefined) is undefined; a function or raw undefined value.
    throw new StorageError(`${op} value is not serializable`, { op, backend, key });
  }
  return json;
}

function deserialize(op, backend, key, raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new StorageError(`${op} stored value is corrupt and could not be parsed`, {
      op,
      backend,
      key,
      cause: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory. Inject backends for tests; defaults bind the real browser globals.
// ---------------------------------------------------------------------------
export function createStorage({
  indexedDB = safeGlobal(() => globalThis.indexedDB),
  localStorage = safeGlobal(() => globalThis.localStorage),
  showSaveFilePicker = safeGlobal(() =>
    typeof globalThis.showSaveFilePicker === 'function'
      ? globalThis.showSaveFilePicker.bind(globalThis)
      : undefined,
  ),
  documentRef = safeGlobal(() => globalThis.document),
  urlRef = safeGlobal(() => globalThis.URL),
  blobCtor = safeGlobal(() => globalThis.Blob),
  dbName = 'opuscc-kg',
  dbVersion = 1,
  storeName = 'kg',
  sessionKey = 'opuscc:session:v1',
} = {}) {
  // -----------------------------------------------------------------------
  // IndexedDB plumbing. The connection is opened once and cached; a failed
  // open clears the cache so a later call can try again.
  // -----------------------------------------------------------------------
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, dbVersion);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
    return dbPromise;
  }

  // Run one request inside a transaction and resolve with its result only after
  // the transaction completes, so a write is durable before we report success.
  function runTx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      let request;
      let tx;
      try {
        tx = db.transaction(storeName, mode);
      } catch (err) {
        reject(err);
        return;
      }
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
      try {
        request = fn(tx.objectStore(storeName));
      } catch (err) {
        try {
          tx.abort();
        } catch (_abortErr) {
          // The transaction may already be unusable; the reject below is what
          // matters and the original error is preserved.
        }
        reject(err);
      }
    });
  }

  // -----------------------------------------------------------------------
  // kg: GlobalKG snapshots in IndexedDB, keyed by [loopId, version].
  // -----------------------------------------------------------------------
  const kg = {
    async save(loopId, version, data) {
      if (!indexedDB) {
        throw new StorageError('IndexedDB is not available in this environment', {
          op: 'kg.save',
          backend: 'indexeddb',
        });
      }
      assertKeyPart('kg.save', 'loopId', loopId);
      assertKeyPart('kg.save', 'version', version);
      const key = [loopId, version];
      const value = serialize('kg.save', 'indexeddb', key, data);
      try {
        const db = await openDb();
        await runTx(db, 'readwrite', (store) => store.put(value, key));
        return { loopId, version };
      } catch (err) {
        throw wrap('kg.save', 'indexeddb', key, err);
      }
    },

    async load(loopId, version) {
      if (!indexedDB) {
        throw new StorageError('IndexedDB is not available in this environment', {
          op: 'kg.load',
          backend: 'indexeddb',
        });
      }
      assertKeyPart('kg.load', 'loopId', loopId);
      assertKeyPart('kg.load', 'version', version);
      const key = [loopId, version];
      let raw;
      try {
        const db = await openDb();
        raw = await runTx(db, 'readonly', (store) => store.get(key));
      } catch (err) {
        throw wrap('kg.load', 'indexeddb', key, err);
      }
      if (raw === undefined) return null; // no snapshot for this key: absence, not error
      return deserialize('kg.load', 'indexeddb', key, raw);
    },
  };

  // -----------------------------------------------------------------------
  // session: current loop / state-machine position / active packet in
  // localStorage under a single key.
  // -----------------------------------------------------------------------
  const session = {
    async save(state) {
      if (!localStorage) {
        throw new StorageError('localStorage is not available in this environment', {
          op: 'session.save',
          backend: 'localstorage',
          key: sessionKey,
        });
      }
      const value = serialize('session.save', 'localstorage', sessionKey, state);
      try {
        localStorage.setItem(sessionKey, value);
        return true;
      } catch (err) {
        // QuotaExceededError and friends land here.
        throw wrap('session.save', 'localstorage', sessionKey, err);
      }
    },

    async load() {
      if (!localStorage) {
        throw new StorageError('localStorage is not available in this environment', {
          op: 'session.load',
          backend: 'localstorage',
          key: sessionKey,
        });
      }
      let raw;
      try {
        raw = localStorage.getItem(sessionKey);
      } catch (err) {
        throw wrap('session.load', 'localstorage', sessionKey, err);
      }
      if (raw == null) return null; // no saved session yet
      return deserialize('session.load', 'localstorage', sessionKey, raw);
    },

    async clear() {
      if (!localStorage) {
        throw new StorageError('localStorage is not available in this environment', {
          op: 'session.clear',
          backend: 'localstorage',
          key: sessionKey,
        });
      }
      try {
        localStorage.removeItem(sessionKey);
        return true;
      } catch (err) {
        throw wrap('session.clear', 'localstorage', sessionKey, err);
      }
    },
  };

  // -----------------------------------------------------------------------
  // file: explicit user-initiated export. File System Access API first, with a
  // download fallback for browsers that lack it.
  // -----------------------------------------------------------------------
  const file = {
    async export(filename, content) {
      if (filename == null || String(filename).length === 0) {
        throw new StorageError('file.export requires a filename', {
          op: 'file.export',
          backend: 'filesystem',
        });
      }

      // Primary path: the File System Access API save dialog.
      if (typeof showSaveFilePicker === 'function') {
        let handle;
        try {
          handle = await showSaveFilePicker({ suggestedName: filename });
        } catch (err) {
          if (err && err.name === 'AbortError') {
            // The user dismissed the dialog. A cancellation is a reported
            // outcome, not a failure, so it is surfaced rather than thrown.
            return { saved: false, cancelled: true, filename };
          }
          throw wrap('file.export', 'filesystem', filename, err);
        }
        try {
          const writable = await handle.createWritable();
          await writable.write(content);
          await writable.close();
          return { saved: true, filename, method: 'file-system-access' };
        } catch (err) {
          throw wrap('file.export', 'filesystem', filename, err);
        }
      }

      // Fallback: synthesize a download via an anchor element.
      if (documentRef && urlRef && typeof urlRef.createObjectURL === 'function' && blobCtor) {
        let url;
        try {
          const blob = new blobCtor([content], { type: 'application/octet-stream' });
          url = urlRef.createObjectURL(blob);
          const anchor = documentRef.createElement('a');
          anchor.href = url;
          anchor.download = filename;
          documentRef.body.appendChild(anchor);
          anchor.click();
          documentRef.body.removeChild(anchor);
          return { saved: true, filename, method: 'anchor-download' };
        } catch (err) {
          throw wrap('file.export', 'filesystem', filename, err);
        } finally {
          if (url && typeof urlRef.revokeObjectURL === 'function') {
            urlRef.revokeObjectURL(url);
          }
        }
      }

      throw new StorageError(
        'file.export is not supported: no File System Access API and no download fallback',
        { op: 'file.export', backend: 'filesystem', key: filename },
      );
    },
  };

  return { kg, session, file };
}

// ---------------------------------------------------------------------------
// Default instances bound to the real browser globals. App code imports these;
// tests build isolated instances with createStorage(injectedBackends).
// ---------------------------------------------------------------------------
const defaultStorage = createStorage();
export const kg = defaultStorage.kg;
export const session = defaultStorage.session;
export const file = defaultStorage.file;
