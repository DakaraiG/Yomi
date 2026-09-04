// Regression guard for the IndexedDB hang.
//
// IDBTransaction fires `complete`; IDBRequest fires `success`. Awaiting a
// transaction through the request-shaped helper sets an `onsuccess` nothing ever
// calls, so the promise never settles -- no error, no rejection, no log, and the
// write itself succeeds, so the entry appears in the cache on the next run while
// the current one waits for an event that does not exist. It presents as "the
// extension hangs intermittently".
//
// Static rather than behavioural: there is no IndexedDB in Node, and a
// behavioural test for a hang would itself hang rather than fail.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_SRC = join(HERE, "..", "..", "..", "extension", "lib", "cache.js");

const source = await readFile(CACHE_SRC, "utf8");

test("transactions are never awaited through the request helper", () => {
  // Matches promisify(tx) and not promisify(tx.objectStore(...).count()), which
  // is a genuine IDBRequest reached through the transaction. A `\btx\b` pattern
  // flags both, a word boundary sitting between "tx" and the dot.
  const misuse = source.match(/promisify\(\s*tx\s*\)/g);
  assert.equal(
    misuse, null,
    "promisify() is for IDBRequest. A transaction passed to it never settles — use txDone().");
});

test("txDone listens for the events a transaction actually fires", () => {
  const body = source.slice(source.indexOf("function txDone"));
  for (const handler of ["oncomplete", "onerror", "onabort"]) {
    assert.ok(body.includes(handler), `txDone must handle ${handler}`);
  }
  assert.ok(
    !/tx\.onsuccess/.test(source),
    "a transaction never fires 'success'");
});

test("every await on a transaction goes through txDone", () => {
  // Any `db.transaction(...)` whose completion is awaited must use txDone.
  const awaited = source.match(/await\s+(\w+)\(tx\)/g) ?? [];
  for (const call of awaited) {
    assert.match(call, /txDone/, `${call} should be txDone(tx)`);
  }
});
