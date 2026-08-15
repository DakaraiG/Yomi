// Phase 2 verification: the JS panel/ordering port against the Python original.
//
// Two kinds of test, and the second is the one that matters.
//
//   1. The synthetic cases ported from sidecar/tests/test_pipeline.py, asserting
//      the same orders on the same fixtures.
//   2. Real-page parity: for every fixture page, the port must reproduce
//      comic-text-detector's reading order exactly, from shuffled input.
//
// (2) is the brief's "identical reading order to the Python version". It works
// because fixtures/baseline.json stores regions in the sidecar's own order --
// r0, r1, r2... are already ranked -- so recovering [0..n-1] from a shuffle IS
// agreement with Python, on real manga rather than on drawn rectangles.
//
//   node --test tests/

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

import { loadRaster } from "../lib/image.mjs";
import { detectPages, spreadSplit, WhiteField } from "../../../extension/lib/panels.js";
import { readingOrder, panelReadingOrder } from "../../../extension/lib/ordering.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "..", "fixtures");

// --- PIL-compatible drawing --------------------------------------------------
//
// PIL's rectangle takes INCLUSIVE corners and draws its outline inward; canvas
// takes width/height and strokes centred on the path. Porting the fixtures
// without reconciling that shifts every border by 1.5px, which is inside the
// tolerance of some thresholds here and outside others -- so the fixtures stop
// testing what they tested.

function pilRect(ctx, x0, y0, x1, y1, { fill, outline, width = 1 } = {}) {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x0, y0, w, h);
  }
  if (outline) {
    ctx.fillStyle = outline;
    ctx.fillRect(x0, y0, w, width);                 // top
    ctx.fillRect(x0, y1 - width + 1, w, width);     // bottom
    ctx.fillRect(x0, y0, width, h);                 // left
    ctx.fillRect(x1 - width + 1, y0, width, h);     // right
  }
}

function blankPage(width, height) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  return { canvas, ctx };
}

function raster(canvas) {
  const ctx = canvas.getContext("2d");
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: canvas.width, height: canvas.height, data };
}

/**
 * Two rows of two bordered panels, with mid-grey "artwork" inside.
 *
 * The grey matters: an empty white panel interior leaves scanlines through it
 * >98% white, so the row split would cut the panel in half. Real pages have art
 * there.
 */
function panelPage(width = 800, height = 1000) {
  const { canvas, ctx } = blankPage(width, height);
  const panels = [
    [40, 40, 390, 440], [410, 40, 760, 440],
    [40, 460, 390, 860], [410, 460, 760, 860]
  ];
  for (const [x0, y0, x1, y1] of panels) {
    pilRect(ctx, x0, y0, x1, y1, { fill: "#b4b4b4", outline: "#000000", width: 3 });
  }
  return { canvas, ctx, panels };
}

/**
 * A column of glyph-ish marks: horizontal strokes with gaps between.
 *
 * Not decoration. A solid block would pass for a drawn panel -- it is dark
 * across its width *and* down its height -- whereas real type is only dark
 * across. That asymmetry is what tells furniture from a panel, so the fixture
 * has to have it.
 */
function verticalText(ctx, x0, y0, x1, y1, cell = 44, stroke = 3) {
  let y = y0;
  while (y + cell <= y1) {
    for (const k of [0.2, 0.5, 0.8]) {
      const top = y + Math.trunc(cell * k);
      pilRect(ctx, x0, top, x1, top + stroke, { fill: "#141414" });
    }
    y += cell;
  }
}

function centres(panels, pad = 40) {
  return panels.map((p) => [
    (p[0] + p[2]) / 2 - pad, (p[1] + p[3]) / 2 - pad,
    (p[0] + p[2]) / 2 + pad, (p[1] + p[3]) / 2 + pad
  ]);
}

// --- pure geometry -----------------------------------------------------------

test("single row is right to left", () => {
  const boxes = [
    [10, 10, 100, 100],   // left
    [200, 12, 290, 105],  // middle
    [400, 8, 490, 98]     // right
  ];
  assert.deepEqual(readingOrder(boxes), [2, 1, 0]);
});

test("rows run top to bottom", () => {
  const boxes = [
    [400, 300, 490, 390],  // row 2, right
    [10, 10, 100, 100],    // row 1, left
    [400, 10, 490, 100],   // row 1, right
    [10, 300, 100, 390]    // row 2, left
  ];
  assert.deepEqual(readingOrder(boxes), [2, 1, 0, 3]);
});

test("slight vertical offset stays in one band", () => {
  // The case a naive (y, -x) sort gets wrong: same visual row, different y0.
  const boxes = [
    [10, 40, 100, 130],
    [400, 10, 490, 100]
  ];
  assert.deepEqual(readingOrder(boxes), [1, 0]);
});

test("tall column does not swallow a distant row", () => {
  const boxes = [
    [400, 10, 460, 300],   // tall column, top right
    [10, 600, 100, 690]    // well below it
  ];
  assert.deepEqual(readingOrder(boxes), [0, 1]);
});

test("empty input", () => {
  assert.deepEqual(readingOrder([]), []);
});

test("band uses its seed, not a growing envelope", () => {
  // Each box overlaps the previous one enough to join, but the accumulated
  // envelope creeps down the page until it reaches a box that belongs to the
  // row below. Banding against the seed keeps the two rows apart.
  const boxes = [
    [600, 0, 700, 100],    // row 1 seed
    [400, 45, 500, 145],
    [200, 90, 300, 190],
    [600, 200, 700, 300]   // row 2 -- 10px clear of the row-1 envelope
  ];
  assert.deepEqual(readingOrder(boxes), [0, 1, 2, 3]);
});

// --- panel-major -------------------------------------------------------------

test("panels are right to left, then top to bottom", () => {
  const { canvas, panels } = panelPage();
  const boxes = panels.map((p) => {
    const cx = (p[0] + p[2]) / 2, cy = (p[1] + p[3]) / 2;
    return [cx - 40, cy - 40, cx + 40, cy + 40];
  });
  assert.deepEqual(panelReadingOrder(raster(canvas), boxes), [1, 0, 3, 2]);
});

test("two bubbles in one panel stay together", () => {
  const { canvas } = panelPage();
  const boxes = [
    [100, 80, 200, 160],    // left panel, high
    [450, 60, 550, 140],    // right panel, high
    [600, 300, 700, 380]    // right panel, low
  ];
  assert.deepEqual(panelReadingOrder(raster(canvas), boxes), [1, 2, 0]);
});

test("artwork whitespace is not a gutter", () => {
  const { canvas, ctx } = blankPage(800, 600);
  pilRect(ctx, 40, 40, 760, 560, { fill: "#b4b4b4", outline: "#000000", width: 3 });
  pilRect(ctx, 380, 44, 420, 556, { fill: "#ffffff" });   // the false gutter

  const img = raster(canvas);
  assert.equal(detectPages(img)[0].panels.length, 1);
  assert.deepEqual(panelReadingOrder(img, [[100, 100, 200, 200], [600, 100, 700, 200]]), [1, 0]);
});

test("stacked sidebars are furniture and read last", () => {
  const { canvas, ctx, panels } = panelPage(900);
  const sidebars = [[810, 60, 870, 290], [810, 350, 870, 580], [810, 640, 870, 870]];
  for (const bar of sidebars) verticalText(ctx, ...bar);

  const title = [300, 5, 500, 30];
  const boxes = [...sidebars, ...centres(panels), title];

  const order = panelReadingOrder(raster(canvas), boxes);
  assert.equal(order[0], 7);                            // title first
  assert.deepEqual(order.slice(1, 5), [4, 3, 6, 5]);    // panels, TR TL BR BL
  assert.deepEqual(order.slice(5), [0, 1, 2]);          // sidebars last, top to bottom
});

test("spread orders the right page first", () => {
  const left = panelPage(800);
  const right = panelPage(800);
  const { canvas, ctx } = blankPage(1700, 1000);
  ctx.drawImage(left.canvas, 0, 0);
  ctx.drawImage(right.canvas, 900, 0);

  const img = raster(canvas);
  assert.notEqual(spreadSplit(new WhiteField(img)), null);

  const pages = detectPages(img);
  assert.deepEqual(pages.map((p) => p.panels.length), [4, 4]);
  assert.ok(pages[0].x0 > pages[1].x0, "right page first");

  const boxes = [
    ...centres(left.panels),
    ...centres(right.panels.map((p) => [p[0] + 900, p[1], p[2] + 900, p[3]]))
  ];
  // 0-3 left page, 4-7 right page; each in TL TR BL BR order.
  assert.deepEqual(panelReadingOrder(img, boxes), [5, 4, 7, 6, 1, 0, 3, 2]);
});

test("single page grid is not split as a spread", () => {
  const { canvas } = panelPage(800, 1000);
  const img = raster(canvas);
  assert.equal(spreadSplit(new WhiteField(img)), null);
  const pages = detectPages(img);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].panels.length, 4);
});

test("landscape without a central gutter is one page", () => {
  // Wide, but the panels straddle the middle -- no full-height white column.
  const { canvas, ctx } = blankPage(1600, 900);
  pilRect(ctx, 40, 40, 1560, 430, { fill: "#b4b4b4", outline: "#000000", width: 3 });
  pilRect(ctx, 40, 460, 1560, 860, { fill: "#b4b4b4", outline: "#000000", width: 3 });
  assert.equal(spreadSplit(new WhiteField(raster(canvas))), null);
});

test("blank page falls back to geometry", () => {
  const { canvas } = blankPage(800, 600);
  const img = raster(canvas);
  assert.equal(detectPages(img)[0].block, null);
  assert.deepEqual(panelReadingOrder(img, [[10, 10, 100, 100], [400, 10, 490, 100]]), [1, 0]);
});

// --- real-page parity --------------------------------------------------------

/** Deterministic shuffle, so a failure is reproducible rather than flaky. */
function shuffled(n, seed = 12345) {
  const idx = [...Array(n).keys()];
  let s = seed;
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;   // glibc LCG, ample here
    const j = s % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

const baseline = JSON.parse(
  await readFile(join(FIXTURES, "baseline.json"), "utf8").catch(() => "null")
);

test("real pages reproduce the Python reading order", async (t) => {
  if (!baseline) {
    t.skip("no fixtures/baseline.json — run `node baseline.mjs` with the sidecar up");
    return;
  }

  for (const [name, page] of Object.entries(baseline.pages)) {
    await t.test(name, async () => {
      const img = await loadRaster(join(FIXTURES, "pages", name));

      // baseline.boxes is already in the sidecar's reading order, so feeding it
      // in shuffled and getting the identity permutation back is exactly
      // "agrees with Python".
      const perm = shuffled(page.boxes.length);
      const boxes = perm.map((i) => {
        const b = page.boxes[i];
        return [b.x0, b.y0, b.x1, b.y1];
      });

      const order = panelReadingOrder(img, boxes);
      const recovered = order.map((k) => perm[k]);

      assert.deepEqual(
        recovered,
        [...Array(page.boxes.length).keys()],
        `${name}: reading order diverges from comic-text-detector's`
      );
    });
  }
});
