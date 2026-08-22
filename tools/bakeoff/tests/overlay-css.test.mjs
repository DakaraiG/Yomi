// The overlay's stylesheet is a template literal full of prose comments, and
// prose about CSS wants to name selectors. A backtick in one of those comments
// closes the template early -- and the result is still VALID JavaScript, so
// `node --check` passes: the string is followed by another template literal,
// which parses as a tagged template call and throws "... is not a function" at
// load time, with the entire stylesheet quoted in the error.
//
// That cost a debugging round. This is a syntax check the syntax checker
// cannot do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OVERLAY = join(dirname(fileURLToPath(import.meta.url)),
                     "..", "..", "..", "extension", "overlay.js");

test("the overlay's CSS template contains no backtick or ${ }", async () => {
  const source = await readFile(OVERLAY, "utf8");
  const match = source.match(/const CSS = `([\s\S]*?)`;/);
  assert.ok(match, "could not find the CSS template -- has it been renamed?");

  const css = match[1];
  const offenders = css.split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes("`") || line.includes("${"));

  assert.deepEqual(offenders, [],
    "a backtick or interpolation inside the CSS template closes it early:\n" +
    offenders.map(({ n, line }) => `  line ${n}: ${line.trim()}`).join("\n"));
});

test("the CSS template still carries the selectors the renderer applies", async () => {
  const source = await readFile(OVERLAY, "utf8");
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];

  // Every class renderOverlay can put on an element needs a rule, or a
  // rendering decision made in the service worker silently does nothing.
  for (const selector of [".layer", ".plate", ".region",
                          ".region.sfx", ".region.unerased", ".region.untranslated"]) {
    assert.ok(css.includes(selector + " {") || css.includes(selector + ","),
      `${selector} has no rule in the overlay stylesheet`);
  }
});
