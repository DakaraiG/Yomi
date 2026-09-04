// seriesId derivation.
//
// Two properties, neither visible at runtime -- a wrong key just means the
// glossary quietly learns the wrong things:
//
//   same series, different chapters  -> must match
//   different series, same host      -> must not match

import test from "node:test";
import assert from "node:assert/strict";

import { deriveSeriesId } from "../../../extension/lib/series.js";

const chapters = [
  ["mangafire", [
    "https://mangafire.to/read/one-piece.dkw/en/chapter-1",
    "https://mangafire.to/read/one-piece.dkw/en/chapter-1047",
    "https://mangafire.to/manga/one-piece.dkw"
  ]],
  ["namicomi", [
    "https://namicomi.com/en/title/8f4c1b2e/rooster-fighter/chapter/aaaa-1111",
    "https://namicomi.com/en/title/8f4c1b2e/rooster-fighter/chapter/bbbb-2222",
    "https://namicomi.com/ja/title/8f4c1b2e/rooster-fighter"
  ]],
  ["mangadex", [
    "https://mangadex.org/title/2b1c9e/vinland-saga",
    "https://mangadex.org/title/2b1c9e/vinland-saga/chapter/77"
  ]],
  ["generic reader", [
    "https://example-reader.test/manga/yotsuba/chapter-3",
    "https://example-reader.test/manga/yotsuba/chapter-88",
    "https://example-reader.test/manga/yotsuba"
  ]],
  ["chapter in the slug", [
    "https://scans.test/series/berserk-chapter-1",
    "https://scans.test/series/berserk-chapter-370"
  ]]
];

for (const [name, urls] of chapters) {
  test(`${name}: chapters of one series share an id`, () => {
    const ids = urls.map((u) => deriveSeriesId(u));
    assert.equal(new Set(ids).size, 1, `expected one id, got ${JSON.stringify(ids)}`);
  });
}

const siblings = [
  ["mangafire", [
    "https://mangafire.to/read/one-piece.dkw/en/chapter-1",
    "https://mangafire.to/read/berserk.q7z/en/chapter-1"
  ]],
  ["namicomi", [
    "https://namicomi.com/en/title/8f4c1b2e/rooster-fighter/chapter/aaaa",
    "https://namicomi.com/en/title/99887766/dandadan/chapter/aaaa"
  ]],
  ["mangadex", [
    "https://mangadex.org/title/2b1c9e/vinland-saga",
    "https://mangadex.org/title/7f3a01/blame"
  ]],
  ["generic reader", [
    "https://example-reader.test/manga/yotsuba/chapter-3",
    "https://example-reader.test/manga/nichijou/chapter-3"
  ]]
];

for (const [name, urls] of siblings) {
  test(`${name}: different series on one host stay apart`, () => {
    const ids = urls.map((u) => deriveSeriesId(u));
    assert.equal(new Set(ids).size, urls.length, `ids collided: ${JSON.stringify(ids)}`);
  });
}

test("v0.3's failure is actually fixed", () => {
  // The naive rule collapses everything on mangafire to "mangafire.to/read",
  // the first path segment being a constant there.
  const a = deriveSeriesId("https://mangafire.to/read/one-piece.dkw/en/chapter-1");
  const b = deriveSeriesId("https://mangafire.to/read/berserk.q7z/en/chapter-1");
  assert.notEqual(a, b);
  assert.ok(!a.endsWith("/read"), `still keyed on the constant segment: ${a}`);
});

test("chapter-only URLs fall back to the page title", () => {
  // A reader whose chapter pages carry no series identity in the URL at all.
  const url = "https://reader.test/chapter/6f1e2d3c-4b5a";
  const one = deriveSeriesId(url, { title: "Dandadan - Chapter 12 | Reader" });
  const two = deriveSeriesId("https://reader.test/chapter/9a8b7c6d-5e4f",
    { title: "Dandadan - Chapter 13 | Reader" });
  assert.equal(one, two);
  assert.ok(one.includes("dandadan"), one);

  const other = deriveSeriesId(url, { title: "Chainsaw Man - Chapter 1 | Reader" });
  assert.notEqual(one, other);
});

test("locale segments are not mistaken for a series", () => {
  assert.equal(
    deriveSeriesId("https://reader.test/en/spy-family/chapter-4"),
    deriveSeriesId("https://reader.test/ja/spy-family/chapter-4"));
});

test("junk input does not throw", () => {
  assert.equal(deriveSeriesId("not a url"), "unknown");
  assert.equal(typeof deriveSeriesId("https://reader.test/"), "string");
});
