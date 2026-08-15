// Regression guard for the IndexedDB hang.
//
// IDBTransaction fires `complete`; IDBRequest fires `success`. Awaiting a
// transaction through the request-shaped helper sets an `onsuccess` property
// nothing ever calls, so the promise never settles and the await hangs
// forever -- no error, no rejection, no log, and the write itself succeeds, so
// the entry appears in the cache on the NEXT run while the current one waits
// for an event that does not exist.
//
// That cost most of a debugging session, presenting as "the extension hangs
// intermittently" and sending us through WebGPU, ORT vendoring and provider
// timeouts first. It is worth a test even though the test is a static one:
// there is no IndexedDB in Node, and the failure mode is a hang rather than an
// exception, so a behavioural test would itself hang rather than fail.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_SRC = join(HERE, "..", "..", "..", "extension", "lib", "cache.js");

const source = await readFile(CACHE_SRC, "utf8");

test("transactions are never awaited through the request helper", () => {
  // Matches promisify(tx) exactly. NOT promisify(tx.objectStore(...).count()),
  // which is a genuine IDBRequest that happens to be reached through the
  // transaction -- an earlier `\btx\b` pattern flagged it, because a word
  // boundary sits between "tx" and the dot.
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
