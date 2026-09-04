// Erasing text: segmentation mask -> clean plate.
//
// A port of reference/ctd_pipeline.py, which is the spec here and the source of
// every constant. Read it before changing a number.
//
// Diffusion rather than Telea: OpenCV is not available in a browser and porting
// Telea's fast marching is a few hundred lines. On the fixture pages the two
// differ by a mean of 3.0/255 over masked pixels. Telea earns its complexity on
// wide masks, which a dilated per-pixel glyph mask is not.

import { dilate } from "./components.js";

export const SEG_THRESHOLD = 0.30;   // tuned by eye on the fixtures
export const DIFFUSION_PASSES = 48;  // matches Telea to 3.0/255 on a thin mask

// A 9x9 element, where the reference says 5x5, and bounded on both sides.
//
// The mask traces the glyph, and a white glyph on a dark tone has a bright
// antialiased fringe just outside it. At radius 2 that fringe survives dilation
// and is what diffusion then fills from, so every erased character comes back as
// a bright blotch. At radius 6 the mask swallows whole strokes of artwork and
// the fill smears. Threshold barely moves either failure; radius decides it.
export const DILATE_RADIUS = 4;

// The reference's kernel, centre excluded: a masked pixel is the weighted mean
// of its neighbours, and including itself would let its own placeholder value
// hold the fill back.
const K = [0.05, 0.2, 0.05, 0.2, 0.2, 0.05, 0.2, 0.05];
const DX = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Text probability map -> binary erase mask.
 *
 * @param {Float32Array} seg  page-resolution probabilities from Detector.detect
 * @returns {Uint8Array} 1 where a pixel is text and must be repainted
 */
export function textMask(seg, width, height, { threshold = SEG_THRESHOLD, radius } = {}) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = seg[i] > threshold ? 1 : 0;

  // Scaled to the page: the fringe being covered is a property of the glyph,
  // and the glyph scales with the scan.
  const grown = radius ?? Math.max(1, Math.round(
    DILATE_RADIUS * height / STRUCTURE_REFERENCE));
  return dilate(mask, width, height, grown);
}

/**
 * Repaint every masked pixel as the weighted mean of its unmasked neighbours,
 * repeatedly, so colour flows inward from the mask's edge.
 *
 * The reference algorithm, run over the list of masked pixels rather than the
 * page -- unmasked pixels never change, and the mask is ~9% of a page.
 *
 * Iteration is Jacobi, not Gauss-Seidel: every pixel in a pass reads the
 * previous pass's values, matching the reference's whole-array filter2D.
 * Updating in place converges faster and would not match it.
 *
 * Edges differ from the reference by one pixel -- OpenCV reflects at the border,
 * this treats out-of-bounds neighbours as absent, which lowers the weight rather
 * than the value.
 *
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} a new raster
 */
export function diffusionInpaint(raster, mask, { passes = DIFFUSION_PASSES } = {}) {
  const { width, height } = raster;
  const out = new Uint8ClampedArray(raster.data);

  const todo = [];
  for (let p = 0; p < mask.length; p++) if (mask[p]) todo.push(p);
  if (!todo.length) return { width, height, data: out };

  // Float planes: 48 passes of rounding to bytes visibly bands the result.
  // `known` starts true outside the mask and spreads one ring inward per pass.
  const r = new Float32Array(width * height);
  const g = new Float32Array(width * height);
  const b = new Float32Array(width * height);
  const known = new Uint8Array(width * height).fill(1);

  for (let p = 0, i = 0; p < known.length; p++, i += 4) {
    r[p] = out[i]; g[p] = out[i + 1]; b[p] = out[i + 2];
  }
  for (const p of todo) {
    known[p] = 0;
    r[p] = 0; g[p] = 0; b[p] = 0;
  }

  const nr = new Float32Array(todo.length);
  const ng = new Float32Array(todo.length);
  const nb = new Float32Array(todo.length);
  const nk = new Uint8Array(todo.length);

  for (let pass = 0; pass < passes; pass++) {
    for (let t = 0; t < todo.length; t++) {
      const p = todo[t];
      const x = p % width;
      const y = (p - x) / width;

      let sr = 0, sg = 0, sb = 0, den = 0, reach = 0;
      for (let n = 0; n < 8; n++) {
        const xx = x + DX[n];
        const yy = y + DY[n];
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx;
        if (!known[q]) continue;
        const w = K[n];
        sr += w * r[q]; sg += w * g[q]; sb += w * b[q];
        den += w;
        reach += w;
      }

      const d = den + 1e-6;
      nr[t] = sr / d; ng[t] = sg / d; nb[t] = sb / d;
      // The reference's `known |= filter2D(known) > 0.02`.
      nk[t] = reach > 0.02 ? 1 : 0;
    }

    for (let t = 0; t < todo.length; t++) {
      const p = todo[t];
      r[p] = nr[t]; g[p] = ng[t]; b[p] = nb[t];
      if (nk[t]) known[p] = 1;
    }
  }

  for (const p of todo) {
    const i = p * 4;
    out[i] = r[p]; out[i + 1] = g[p]; out[i + 2] = b[p];
  }
  return { width, height, data: out };
}

/**
 * Drop every masked pixel that is not inside one of `boxes`.
 *
 * Erasing text nobody replaces is pure loss. Segmentation finds every piece of
 * text on the page -- chapter titles, page numbers, logos, SFX across artwork --
 * and the ones grouping never numbered get no English drawn over them, so
 * erasing them just removes the page's furniture and leaves a smear. This
 * confines the ghosting that remains to dialogue inside a region, where the
 * English lands on top of it.
 *
 * `pad` should be at least the dilation radius: the boxes are the detected text
 * extent and the mask was grown past it, so an unpadded intersection leaves a
 * rim of un-erased glyph edge inside every box.
 */
export function restrictToBoxes(mask, width, height, boxes, { pad = DILATE_RADIUS } = {}) {
  const keep = new Uint8Array(mask.length);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x0) - pad);
    const y0 = Math.max(0, Math.floor(b.y0) - pad);
    const x1 = Math.min(width, Math.ceil(b.x1) + pad);
    const y1 = Math.min(height, Math.ceil(b.y1) + pad);
    for (let y = y0; y < y1; y++) keep.fill(1, y * width + x0, y * width + x1);
  }
  for (let i = 0; i < mask.length; i++) if (!keep[i]) mask[i] = 0;
  return mask;
}

// Blur radius for the structure test below, swept against hand-labelled regions
// on the fixture pages and bounded on both sides: too small and artwork whose
// detail is coarser than the window reads as flat, too large and text set near
// the page's own dark edge sees that edge in every neighbourhood. At 10 every
// keep scores >= 0.131 and every erase <= 0.093.
const STRUCTURE_BLUR = 10;

// The page height the radii above were tuned at.
//
// Glyph strokes, screentone pitch and linework all scale with the scan, so a
// 10px window on an 800px page covers twice the drawing it was tuned for and
// reads flat artwork as busy. Height rather than width or the short side: a
// two-page spread is twice as wide as a page at the same scan resolution, which
// would make two scans of the same book disagree by a factor of two.
const STRUCTURE_REFERENCE = 1600;

/**
 * Structure at or above this and the region is left alone.
 *
 * Sits in the gap the sweep measures, but that gap is eight labelled regions on
 * four pages judged by eye, one of them a taste call. Tuned, not settled: re-run
 * tools/bakeoff/clean-plate.mjs and look at the plates before moving it.
 */
export const STRUCTURE_THRESHOLD = 0.11;

// How far from a glyph still counts as "behind the text". Diffusion fills from
// the mask's edge inward, so this is the band it actually draws from.
const STRUCTURE_BAND = 7;

/**
 * How much drawing is behind this region's text, 0 (flat) to 1 (busy). Callers
 * use it to decide whether diffusion can tell the truth here.
 *
 * Three things make this measurable where a plain spread-of-the-background test
 * was not:
 *
 *   1. The mask. Text pixels and their dilated fringe are excluded from the blur
 *      as well as the statistic -- the antialiasing confound that made the old
 *      test a continuum with no gap in it.
 *   2. The blur. Screentone's raw variance is huge but it inpaints perfectly, so
 *      collapsing tone to its mean first leaves structure rather than texture.
 *   3. A band around the glyphs rather than the whole box. Diffusion fills from
 *      the mask's edge, so distant pixels have no say -- including them scored a
 *      sidebar column on a white margin above a logo lying across artwork,
 *      because its box straddled a far-off panel border.
 *
 * The statistic is a median of local variance, not the variance of the band:
 * what matters is whether a typical stroke has structure against it, so one
 * hard edge nearby cannot outvote hundreds of flat neighbourhoods.
 */
export function backgroundStructure(raster, mask, box, opts = {}) {
  const { width, height, data } = raster;

  const scale = height / STRUCTURE_REFERENCE;
  const blurRadius = Math.max(3, Math.round((opts.blur ?? STRUCTURE_BLUR) * scale));
  const bandRadius = Math.max(2, Math.round((opts.band ?? STRUCTURE_BAND) * scale));
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1));
  const y1 = Math.min(height, Math.ceil(box.y1));
  const w = x1 - x0, h = y1 - y0;
  if (w < 4 || h < 4) return 0;

  // Luma, plus the weight that excludes every masked pixel from what follows.
  // Rec. 601, the same coefficients as surface.js and the bake-off.
  const lum = new Float32Array(w * h);
  const known = new Float32Array(w * h);
  const local = new Uint8Array(w * h);             // the mask, cropped to the box
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y0 + y) * width + (x0 + x);
      const i = p * 4;
      const q = y * w + x;
      if (mask[p]) { local[q] = 1; continue; }      // known stays 0
      lum[q] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      known[q] = 1;
    }
  }

  // The band: unmasked, but within reach of a glyph. A region with no text in
  // it has nothing to measure and nothing to erase.
  const grown = dilate(local, w, h, bandRadius);
  let band = 0;
  for (let q = 0; q < grown.length; q++) {
    grown[q] = grown[q] && !local[q] ? 1 : 0;
    band += grown[q];
  }
  if (band < 32) return 0;

  // Separable sliding-window box blur of the known pixels, normalised by how
  // many were known, so a window straddling the mask averages only real
  // background.
  const blur = (src, wt) => {
    const tmpS = new Float32Array(w * h), tmpW = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sv = 0, sw = 0;
      for (let x = 0; x <= Math.min(blurRadius, w - 1); x++) { sv += src[row + x]; sw += wt[row + x]; }
      for (let x = 0; x < w; x++) {
        tmpS[row + x] = sv; tmpW[row + x] = sw;
        const add = x + blurRadius + 1, drop = x - blurRadius;
        if (add < w) { sv += src[row + add]; sw += wt[row + add]; }
        if (drop >= 0) { sv -= src[row + drop]; sw -= wt[row + drop]; }
      }
    }
    const outS = new Float32Array(w * h), outW = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let sv = 0, sw = 0;
      for (let y = 0; y <= Math.min(blurRadius, h - 1); y++) { sv += tmpS[y * w + x]; sw += tmpW[y * w + x]; }
      for (let y = 0; y < h; y++) {
        outS[y * w + x] = sv; outW[y * w + x] = sw;
        const add = y + blurRadius + 1, drop = y - blurRadius;
        if (add < h) { sv += tmpS[add * w + x]; sw += tmpW[add * w + x]; }
        if (drop >= 0) { sv -= tmpS[drop * w + x]; sw -= tmpW[drop * w + x]; }
      }
    }
    return { sum: outS, weight: outW };
  };

  // Local variance in one pass, from mean and mean-of-squares: E[x^2] - E[x]^2.
  const sq = new Float32Array(w * h);
  for (let q = 0; q < lum.length; q++) sq[q] = lum[q] * lum[q];

  const first = blur(lum, known);
  const second = blur(sq, known);

  const spreads = [];
  for (let q = 0; q < lum.length; q++) {
    if (!grown[q] || first.weight[q] < 4) continue;
    const mean = first.sum[q] / first.weight[q];
    const meanSq = second.sum[q] / second.weight[q];
    spreads.push(Math.sqrt(Math.max(0, meanSq - mean * mean)));
  }
  if (!spreads.length) return 0;

  spreads.sort((a, b) => a - b);
  return spreads[spreads.length >> 1] / 255;
}

/** Fraction of a box's area the mask covers. */
export function maskCoverage(mask, width, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1));
  const y1 = Math.ceil(box.y1);
  const area = (x1 - x0) * (y1 - y0);
  if (area <= 0) return 0;

  let on = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) if (mask[row + x]) on++;
  }
  return on / area;
}

/** Clear the mask inside a box, so those pixels are left as drawn. */
export function clearBox(mask, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1));
  const y1 = Math.min(height, Math.ceil(box.y1));
  for (let y = y0; y < y1; y++) mask.fill(0, y * width + x0, y * width + x1);
}
