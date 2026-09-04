// Page cache, IndexedDB rather than memory: the service worker is killed on
// idle, so an in-memory cache would lose everything within minutes.
//
// Holds the finished TranslatedPage -- local geometry already merged with the
// model's text -- so a re-read costs nothing rather than another ~250ms of
// detection.

const DB_NAME = "yomi";
const DB_VERSION = 1;
const STORE = "pages";

const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

let dbPromise = null;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "key" });
        // Both indexes exist for pruning: by age, and by least-recently-read.
        store.createIndex("storedAt", "storedAt");
        store.createIndex("readAt", "readAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** For IDBRequest: resolves with the result. */
function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * For IDBTransaction: resolves when the transaction commits.
 *
 * Separate from promisify because a transaction fires `complete`, not `success`.
 * Passing one to promisify() sets an onsuccess nothing ever calls, and the await
 * hangs forever with no error -- the write succeeds, so the entry appears in the
 * cache next run while this one waits for an event that does not exist.
 */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("cache transaction aborted"));
  });
}

/**
 * SHA-256 of the image bytes, as "sha256:...". Callers must hash the original
 * retrieved bytes: the numbered render depends on detection, which is the thing
 * the cache exists to skip.
 */
export async function contentHash(buffer) {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return "sha256:" + [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Look up a cached page, refreshing its read time.
 *
 * Any IndexedDB failure is treated as a miss: a broken cache should cost a
 * re-translation rather than break the extension.
 */
export async function get(key) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const hit = await promisify(store.get(key));
    if (!hit) return null;

    if (Date.now() - hit.storedAt > MAX_AGE_MS) {
      store.delete(key);
      return null;
    }

    hit.readAt = Date.now();
    store.put(hit);
    return hit.page;
  } catch {
    return null;
  }
}

export async function set(key, page) {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const now = Date.now();
    tx.objectStore(STORE).put({ key, page, storedAt: now, readAt: now });
    await txDone(tx);
    void prune();          // fire and forget; never blocks a translation
  } catch {
    /* a cache that cannot write is still a working extension */
  }
}

/** Drop expired entries, then the least recently read down to MAX_ENTRIES. */
async function prune() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const count = await promisify(store.count());

    const cutoff = Date.now() - MAX_AGE_MS;
    const expired = await promisify(store.index("storedAt").getAllKeys(
      IDBKeyRange.upperBound(cutoff)));
    for (const key of expired) store.delete(key);

    const remaining = count - expired.length;
    if (remaining > MAX_ENTRIES) {
      const oldest = await promisify(store.index("readAt").getAllKeys());
      for (const key of oldest.slice(0, remaining - MAX_ENTRIES)) store.delete(key);
    }
  } catch {
    /* pruning is maintenance, never load-bearing */
  }
}

export async function clear() {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  return txDone(tx);
}

export async function stats() {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    return { entries: await promisify(tx.objectStore(STORE).count()) };
  } catch {
    return { entries: 0 };
  }
}
