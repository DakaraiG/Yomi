// Box shaping for vertical-source regions.
//
// The interesting assertions are about what widening REFUSES to do. Growing a
// box is easy; the whole design rests on stopping at the bubble, and on a
// synthetic page it is possible to state exactly where that is.
//
//   node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { widenBox, shapeBox, freeSpan, BOX_EXPAND } from "../../../extension/lib/layout.js";

const WHITE = { bgLum: 0.98 };

/** A probe that reports white inside [x0,x1] and dark artwork outside it. */
const bubbleProbe = (x0, x1) => (x, _y, w) =>
  (x >= x0 && x + w <= x1) ? { lum: 0.98, sd: 0.01 } : { lum: 0.35, sd: 0.22 };

const tall = { x0: 480, y0: 200, x1: 520, y1: 500 };   // 40x300, aspect 0.13

test("a vertical box grows toward the aspect English needs", () => {
  const out = widenBox(tall, {
    base: WHITE, neighbours: [], imageW: 1000, probe: () => ({ lum: 0.98, sd: 0.01 })
  });
  const w = out.x1 - out.x0;
  assert.ok(w > 40, `expected growth, got ${w}`);
  assert.equal(out.y0, tall.y0, "height is never touched");
  assert.equal(out.y1, tall.y1);
});

test("growth stops at the bubble wall, not at the target", () => {
  // Room for 60px of white either side, then artwork.
  const out = widenBox(tall, {
    base: WHITE, neighbours: [], imageW: 1000, probe: bubbleProbe(420, 580)
  });
  assert.ok(out.x0 >= 420, `left edge ${out.x0} walked past the bubble at 420`);
  assert.ok(out.x1 <= 580, `right edge ${out.x1} walked past the bubble at 580`);
  assert.ok(out.x1 - out.x0 > 40, "but it did use the room it had");
});

test("a box hemmed in by neighbours does not grow", () => {
  // The dense-narration case: adjacent vertical columns, no room either side.
  const neighbours = [
    tall,
    { x0: 430, y0: 200, x1: 474, y1: 500 },
    { x0: 526, y0: 200, x1: 570, y1: 500 }
  ];
  const out = widenBox(tall, {
    base: WHITE, neighbours, imageW: 1000, probe: () => ({ lum: 0.98, sd: 0.01 })
  });
  assert.equal(out.x1 - out.x0, 40, "no room, so no growth");
});

test("a neighbour that shares no rows is not an obstacle", () => {
  const elsewhere = [tall, { x0: 430, y0: 900, x1: 474, y1: 1100 }];
  const [L, R] = freeSpan(tall, elsewhere, 1000);
  assert.equal(L, 0);
  assert.equal(R, 1000);
});

test("growth stays centred on the original box", () => {
  const out = widenBox(tall, {
    base: WHITE, neighbours: [], imageW: 1000, probe: () => ({ lum: 0.98, sd: 0.01 })
  });
  const drift = Math.abs((out.x0 + out.x1) / 2 - (tall.x0 + tall.x1) / 2);
  assert.ok(drift <= 10, `centre moved ${drift}px`);
});

test("an already-wide box is left alone", () => {
  const wide = { x0: 100, y0: 100, x1: 400, y1: 200 };   // aspect 3.0
  const out = widenBox(wide, {
    base: WHITE, neighbours: [], imageW: 1000, probe: () => ({ lum: 0.98, sd: 0.01 })
  });
  assert.deepEqual(out, wide);
});

test("shapeBox does not inflate a probed width, only the height", () => {
  // BOX_EXPAND on top of a probed width would walk into whatever the probe
  // just refused, so a vertical region gets it on the vertical axis only.
  const out = shapeBox(tall, {
    vertical: true, base: WHITE, neighbours: [], imageW: 1000, imageH: 1000,
    probe: bubbleProbe(420, 580)
  });
  assert.ok(out.x0 >= 420 && out.x1 <= 580, "probe bound still holds after shaping");
  assert.ok(out.y0 < tall.y0 && out.y1 > tall.y1, "height did get the expand");
});

test("a horizontal region gets BOX_EXPAND where the surface allows it", () => {
  const wide = { x0: 100, y0: 100, x1: 300, y1: 160 };
  const out = shapeBox(wide, {
    vertical: false, base: WHITE, neighbours: [], imageW: 1000, imageH: 1000,
    probe: () => ({ lum: 0.98, sd: 0.01 })
  });
  assert.equal(out.x0, 100 - 200 * BOX_EXPAND);
  assert.equal(out.x1, 300 + 200 * BOX_EXPAND);
});

test("NO expansion is taken on trust -- every edge is probed", () => {
  // The overlay fills the box to its edges, which is only safe because each
  // edge was measured. A region whose surroundings do not match keeps the box
  // it was detected with rather than growing blind.
  const wide = { x0: 100, y0: 100, x1: 300, y1: 160 };
  const out = shapeBox(wide, {
    vertical: false, base: WHITE, neighbours: [], imageW: 1000, imageH: 1000,
    probe: () => ({ lum: 0.2, sd: 0.3 })      // artwork on every side
  });
  assert.deepEqual(out, wide, "no edge should have moved");
});

test("shaping is clamped to the image", () => {
  const edge = { x0: 0, y0: 0, x1: 60, y1: 400 };
  const out = shapeBox(edge, {
    vertical: true, base: WHITE, neighbours: [], imageW: 500, imageH: 500,
    probe: () => ({ lum: 0.98, sd: 0.01 })
  });
  assert.ok(out.x0 >= 0 && out.y0 >= 0 && out.x1 <= 500 && out.y1 <= 500);
});
