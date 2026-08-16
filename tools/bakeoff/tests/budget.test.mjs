// The spend ceiling for unattended translation.
//
// The property that matters is that it cannot be raced. Auto-translate runs
// three pages at a time, and a ceiling that checks and then increments across
// an await lets all three through a gate only one should pass -- which is the
// difference between a ceiling and a suggestion.
//
//   node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { createBudget, DEFAULT_LIMIT } from "../../../extension/lib/budget.js";

test("reserves up to the limit and then refuses", () => {
  const b = createBudget(3);
  assert.equal(b.reserve(), true);
  assert.equal(b.reserve(), true);
  assert.equal(b.reserve(), true);
  assert.equal(b.reserve(), false, "the fourth must be refused");
  assert.equal(b.spent, 3, "a refusal must not count as spend");
  assert.equal(b.remaining, 0);
});

test("check and take are one step, so concurrent pages cannot overshoot", () => {
  // What three in-flight pages actually do against one remaining slot.
  const b = createBudget(1);
  const results = [b.reserve(), b.reserve(), b.reserve()];
  assert.deepEqual(results, [true, false, false]);
  assert.equal(b.spent, 1);
});

test("a call that never happened gives its reservation back", () => {
  const b = createBudget(2);
  b.reserve();
  b.release();
  assert.equal(b.spent, 0, "a failed call must not eat the session's budget");
  assert.equal(b.reserve(), true);
});

test("release never goes negative", () => {
  const b = createBudget(2);
  b.release();
  b.release();
  assert.equal(b.spent, 0);
});

test("a zero limit stops scrolling from spending anything", () => {
  const b = createBudget(0);
  assert.equal(b.reserve(), false);
  assert.equal(b.spent, 0);
});

test("restore carries a count across a worker restart", () => {
  // The service worker is killed on idle constantly. A ceiling that forgets
  // what it spent every time that happens is not a ceiling.
  const b = createBudget(10);
  b.restore(7);
  assert.equal(b.spent, 7);
  assert.equal(b.remaining, 3);
});

test("restore never lowers a count", () => {
  // Persistence lags on purpose -- it is fire-and-forget -- so a stale value
  // read back must not hand out budget that has already been used.
  const b = createBudget(10);
  b.reserve(); b.reserve(); b.reserve();
  b.restore(1);
  assert.equal(b.spent, 3);
});

test("raising the limit mid-session frees more, lowering it stops early", () => {
  const b = createBudget(1);
  b.reserve();
  assert.equal(b.reserve(), false);
  b.setLimit(3);
  assert.equal(b.reserve(), true, "raising the ceiling in options takes effect");
  b.setLimit(1);
  assert.equal(b.reserve(), false, "already over the new limit");
  assert.equal(b.remaining, 0);
});

test("a nonsense limit is ignored rather than applied", () => {
  const b = createBudget(5);
  b.setLimit(NaN);
  b.setLimit(-2);
  b.setLimit(undefined);
  assert.equal(b.limit, 5);
});

test("the default limit is a real number of pages", () => {
  assert.ok(Number.isInteger(DEFAULT_LIMIT) && DEFAULT_LIMIT > 0);
});
