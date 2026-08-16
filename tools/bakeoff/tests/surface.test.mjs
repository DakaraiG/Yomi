// The fill decision: what surface is a region sitting on?
//
// These are synthetic rasters, not real pages, and they are here to BRACKET the
// two thresholds rather than to prove them. Each case pins one end of a range:
// a grey gradient panel must come out fillable (it is the defect this whole
// measurement exists to fix), continuous artwork must not, and the four flat
// surfaces must survive both tests. Real tuning happens against the per-region
// lum/sd/share table content.js logs to the console.
//
//   node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { measureBackground, snapFill } from "../../../extension/lib/surface.js";

// Kept in sync with background.js by hand -- the extension ships without a
// bundler, so there is nothing to import them from.
const BUSY_STD = 0.10;
const MIN_SHARE = 0.5;

const isBusy = (m) => m.bgStd > BUSY_STD || m.bgShare < MIN_SHARE;

/** RGBA raster from a per-pixel function. */
function raster(w, h, fn) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return d;
}

const W = 120, H = 200;
// Vertical glyph columns, roughly the ink coverage of Japanese set in a bubble.
const glyph = (x, y) => (x % 18 < 4) && (y % 13 < 9);
// Deterministic +/-4 jitter, standing in for JPEG noise.
const noise = (x, y) => ((x * 7 + y * 13) % 9) - 4;

test("white bubble, black text: fills white", () => {
  const m = measureBackground(
    raster(W, H, (x, y) => glyph(x, y) ? [10, 10, 10] : [252, 252, 252]));
  assert.equal(isBusy(m), false);
  assert.deepEqual(m.fill, [252, 252, 252]);
});

test("grey gradient panel fills GREY, not white and not nothing", () => {
  // The reported defect. Under the old near-white test this region scored ~0
  // and got no fill at all, so the Japanese stayed visible under the English.
  const m = measureBackground(raster(W, H, (x, y) => {
    const g = 150 + Math.round((y / H) * 40) + noise(x, y);
    return glyph(x, y) ? [20, 20, 20] : [g, g, g];
  }));
  assert.equal(isBusy(m), false, "a gradient panel is a surface, and fillable");
  assert.ok(m.fill[0] > 150 && m.fill[0] < 200, `mid grey, got ${m.fill}`);
  assert.ok(m.bgLum > 0.5, "light enough to still take dark ink");
});

test("inverted panel: white text on black reads as a dark surface", () => {
  const m = measureBackground(
    raster(W, H, (x, y) => glyph(x, y) ? [245, 245, 245] : [18, 18, 18]));
  assert.equal(isBusy(m), false);
  assert.ok(m.bgLum < 0.2, `background is the black, got lum ${m.bgLum}`);
});

test("cream bubble keeps its tint", () => {
  // Regression: classifying the second pass on the float luminance while the
  // histogram used the truncated one put the glyphs' own bin on the background
  // side, which dragged this fill to rgb(204,197,182) and marked it artwork.
  const m = measureBackground(
    raster(W, H, (x, y) => glyph(x, y) ? [30, 25, 20] : [238, 230, 214]));
  assert.equal(isBusy(m), false);
  assert.deepEqual(m.fill, [238, 230, 214]);
});

test("continuous artwork is busy, and outlines instead", () => {
  const m = measureBackground(raster(W, H, (x, y) => {
    const v = 40 + Math.round(180 * (0.5 + 0.5 * Math.sin(x / 9 + y / 14)));
    return [v, v, v];
  }));
  assert.equal(isBusy(m), true);
});

test("hard screentone survives the share floor -- SFX kind must catch it", () => {
  // The one case the two measures cannot separate from dense text on a flat
  // surface: a 50/50 dot field splits into two internally-uniform classes, so
  // sd sees nothing and share lands at ~0.58 against dense text's ~0.60. This
  // asserts the gap is real, which is WHY "SFX always outlines" is a rule about
  // kind rather than another threshold.
  const tone = measureBackground(raster(W, H, (x, y) => {
    const v = ((x * 3 + y * 5) % 40 < 20) ? 30 : 235;
    return glyph(x, y) ? [0, 0, 0] : [v, v, v];
  }));
  const dense = measureBackground(raster(W, H, (x, y) =>
    ((x % 10 < 5) && (y % 9 < 6)) ? [15, 15, 15] : [250, 250, 250]));

  assert.ok(tone.bgShare < dense.bgShare,
    `screentone ${tone.bgShare} vs dense text ${dense.bgShare}`);
  assert.equal(isBusy(dense), false, "dense text must not be mistaken for art");
});

test("a flat region with no text at all is uniform", () => {
  const m = measureBackground(raster(W, H, () => [200, 200, 200]));
  assert.equal(isBusy(m), false);
  assert.equal(m.bgShare, 1);
  assert.equal(m.bgStd, 0);
});

// --- stark white ------------------------------------------------------------
//
// The scans this imitates letter in pure black on pure white. Matching a
// bubble's measured average instead leaves a visibly grey patch on it, because
// the bubble is not really 252 -- it is 255 with JPEG noise on it.

test("a near-white bubble is filled with stark white, not its average", () => {
  for (const v of [250, 252, 253, 254, 255]) {
    assert.deepEqual(snapFill([v, v, v]), [255, 255, 255], `${v} should snap`);
  }
});

test("a near-black surface snaps to stark black", () => {
  assert.deepEqual(snapFill([9, 9, 9]), [0, 0, 0]);
});

test("a tinted bubble keeps its tint", () => {
  // The neutrality guard. Cream is close to white in luminance but is a real
  // colour, and flattening it to #fff would undo the measurement.
  assert.deepEqual(snapFill([238, 230, 214]), [238, 230, 214]);
});

test("a grey panel keeps its grey", () => {
  // The Task 1 case: far enough from either end that snapping never applies,
  // which is what keeps a gradient narration panel filling with grey.
  assert.deepEqual(snapFill([170, 170, 170]), [170, 170, 170]);
});

test("snapping does not reach a light grey that is genuinely grey", () => {
  // 230 is light but visibly not white; pulling it to #fff would put a bright
  // patch on the page.
  assert.deepEqual(snapFill([230, 230, 230]), [230, 230, 230]);
});

test("the measured fill of a white bubble snaps end to end", () => {
  const d = new Uint8ClampedArray(120 * 200 * 4);
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 120; x++) {
      const glyph = (x % 18 < 4) && (y % 13 < 9);
      const v = glyph ? 12 : 252;          // a 252 "white" bubble
      const i = (y * 120 + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  assert.deepEqual(snapFill(measureBackground(d).fill), [255, 255, 255]);
});
