// Copyright (c) 2026 Ljh0107-L. SPDX-License-Identifier: MIT

// Local cache of session events, so reopening a session is instant: fold the
// cached events for an immediate paint, then pull only what arrived since
// (`?after=<lastSeq>`). The cache stores *raw* events -- they are immutable
// and seq-numbered, so re-folding is deterministic -- not the folded
// transcript. Everything here is best-effort: a cache failure must never
// break opening a session, so every entry point swallows its own errors.

const DB_NAME = 'caden';
const STORE = 'events';
/// Self-imposed ceiling. IndexedDB's own quota is far higher, but the cache
/// is a convenience, not an archive -- once it grows past this the oldest
/// sessions are evicted until it fits again.
const MAX_BYTES = 100 * 1024 * 1024;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('savedAt', 'savedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const asPromise = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const recordKey = (serverId, sessionId) => `${serverId}:${sessionId}`;

/// The cached record for a session, or null. A record is
/// `{ fingerprint, events, lastSeq, truncated, bytes, savedAt }`.
export async function cacheLoad(serverId, sessionId) {
  try {
    const db = await open();
    return await asPromise(
      db.transaction(STORE, 'readonly').objectStore(STORE)
        .get(recordKey(serverId, sessionId)));
  } catch {
    return null;
  }
}

/// Write a session's events and evict oldest-first past the ceiling. The
/// just-written record is never evicted in the same pass.
export async function cacheSave(serverId, sessionId, { fingerprint, events,
                                                          lastSeq, truncated }) {
  try {
    const db = await open();
    const record = {
      key: recordKey(serverId, sessionId),
      serverId, sessionId, fingerprint,
      events, lastSeq, truncated: !!truncated,
      bytes: JSON.stringify(events).length,
      savedAt: Date.now(),
    };
    const t = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    store.put(record);
    const all = await asPromise(store.getAll());
    let total = all.reduce((sum, r) => sum + (r.bytes || 0), 0);
    if (total > MAX_BYTES) {
      all.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
      for (const r of all) {
        if (total <= MAX_BYTES) break;
        if (r.key === record.key) continue;
        store.delete(r.key);
        total -= r.bytes || 0;
      }
    }
    await new Promise((resolve, reject) => {
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } catch {
    /* best-effort */
  }
}

export async function cacheClear(serverId, sessionId) {
  try {
    const db = await open();
    await asPromise(
      db.transaction(STORE, 'readwrite').objectStore(STORE)
        .delete(recordKey(serverId, sessionId)));
  } catch {
    /* best-effort */
  }
}
