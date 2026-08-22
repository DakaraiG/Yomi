// Erasing text: segmentation mask -> clean plate.
//
// The port of reference/ctd_pipeline.py, which is the spec for everything here
// and the source of every constant. Read that file before changing a number.
//
// DIFFUSION, NOT TELEA. cv2.inpaint(..., cv2.INPAINT_TELEA) is what a desktop
// tool would use and OpenCV is not available in a browser; porting Telea's fast
// marching is a few hundred lines. Measured on the fixture pages, iterative
// diffusion differs from Telea by a mean of 3.0/255 over masked pixels and the
// two are visually indistinguishable. Telea earns its complexity on WIDE masks.
// A per-pixel glyph mask, dilated by two, is not one.

import { dilate } from "./components.js";

export const SEG_THRESHOLD = 0.30;   // tuned by eye on the fixtures
export const DIFFUSION_PASSES = 48;  // matches Telea to 3.0/255 on a thin mask

// A 9x9 element, where the reference says 5x5. CHANGED AFTER LOOKING AT ynko4,
// which is the page with white lettering set on a dark screentone gradient.
//
// The mask CTD returns traces the glyph, and a white glyph on a dark tone has a
// bright antialiased fringe just outside it. At radius 2 that fringe survives
// the dilation, so it is exactly what diffusion finds when it looks for
// "unmasked neighbours" -- and every erased character came back as a bright
// blotch, on a page where the correct answer is flat dark tone. Radius 4 clears
// the fringe and those panels come out clean.
//
// Swept rather than guessed: threshold barely moves the result (0.30/0.15/0.05
// all blotch at radius 2) and radius decides it. Radius 6 is worse than either
// -- the mask starts swallowing whole strokes of artwork and diffusion fills
// the hole with a smear. Cost of 4 over 2 is mask area, 9.4% -> 12.2% of the
// page on ynko.jpg, and no visible damage: the table, the dice and the
// characters' faces survive identically.
export const DILATE_RADIUS = 4;

// The reference's kernel, centre excluded. A masked pixel is the weighted mean
// of its NEIGHBOURS -- including itself would let a masked pixel's own
// placeholder value hold the fill back.
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

  // Scaled for the same reason the structure radii are: the fringe this is
  // covering is a property of the glyph, and the glyph scales with the scan.
  const grown = radius ?? Math.max(1, Math.round(
    DILATE_RADIUS * height / STRUCTURE_REFERENCE));
  return dilate(mask, width, height, grown);
}

/**
 * Repaint every masked pixel as the weighted mean of its unmasked neighbours,
 * repeatedly, so colour flows inward from the mask's edge.
 *
 * Structurally the reference algorithm, with one change that is worth stating:
 * it runs over the LIST of masked pixels rather than over the page. Unmasked
 * pixels never change and `known` never changes for them, so a full-page
 * convolution spends 90% of its time proving that 90% of the page is already
 * finished. On a 1134x1606 page the mask is ~9% of the pixels, so this is
 * roughly an order of magnitude less work for an identical result.
 *
 * Iteration is Jacobi, not Gauss-Seidel: every pixel in a pass reads the
 * PREVIOUS pass's values, which is what the reference's whole-array filter2D
 * does. Updating in place converges faster and would not match it.
 *
 * Edges differ from the reference by one pixel: OpenCV reflects at the border,
 * this treats out-of-bounds neighbours as absent. A missing neighbour lowers
 * the weight rather than the value, so a masked pixel touching the page edge
 * still fills from inside the page.
 *
 * @returns {{width:number,height:number,data:Uint8ClampedArray}} a new raster
 */
export function diffusionInpaint(raster, mask, { passes = DIFFUSION_PASSES } = {}) {
  const { width, height } = raster;
  const out = new Uint8ClampedArray(raster.data);

  const todo = [];
  for (let p = 0; p < mask.length; p++) if (mask[p]) todo.push(p);
  if (!todo.length) return { width, height, data: out };

  // Float planes for the arithmetic, because 48 passes of rounding to bytes
  // visibly banded the result. `known` starts true everywhere the mask is not,
  // and spreads one ring inward per pass.
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
      // The reference's `known |= filter2D(known) > 0.02`: one ring of the mask
      // becomes usable per pass, so the fill converges from the outside in.
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
 * ERASING TEXT NOBODY REPLACES IS PURE LOSS. The segmentation head finds all
 * the text on the page, which is more than the pipeline has any use for: a
 * chapter title, a page number, a stylised logo the size of a panel, an SFX
 * scribbled across the artwork. None of those are regions -- grouping never
 * numbered them, the model was never asked about them, and the overlay draws
 * nothing where they were. Erasing them removes the page's own furniture and
 * hands back a smear in its place, which is exactly the failure that reads as
 * "the cleanup is bad": the worst-looking damage on a page is usually text that
 * was never going to be translated.
 *
 * It also confines the known inpainting failure to the case where it is
 * survivable. A big stylised logo over artwork is the one thing diffusion
 * cannot fake, and it is now left alone; what still ghosts is dialogue inside a
 * region, where English lands on top of it.
 *
 * `pad` should be at least the dilation radius. The boxes are the detected text
 * extent, and the mask was grown past it, so an unpadded intersection leaves a
 * rim of un-erased glyph edge around the inside of every box.
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

// Blur radius for the structure test below, and it is not a free parameter:
// swept against hand-labelled regions on the fixture pages, it is the setting
// that separates them, and it is bounded on BOTH sides.
//
//   radius                              6      8     10     12
//   KEEP  394mg logo over the table  0.191  0.210  0.222  0.231
//   KEEP  SFX over fluffy artwork    0.006  0.009  0.149  0.215
//   KEEP  text over kitchen artwork  0.231  0.219  0.218  0.218
//   KEEP  DOKIDOKI over hair         0.113  0.125  0.131  0.137
//   ERASE narration on a tone panel  0.092  0.092  0.093  0.092
//   ERASE sidebar at the page edge   0.004  0.006  0.058  0.145
//   ERASE sidebar on the margin      0.004  0.005  0.005  0.005
//   ERASE bubble dialogue            0.003  0.003  0.004  0.004
//
// Too small and artwork whose detail is coarser than the window reads as flat
// (the fluffy SFX at 8). Too large and a column of text set near the page's own
// dark edge starts seeing that edge in every neighbourhood (the edge sidebar at
// 12). At 10 every KEEP is at or above 0.131 and every ERASE at or below 0.093.
const STRUCTURE_BLUR = 10;

// The page HEIGHT the radii above were tuned at.
//
// Every fixture page is 1588-1606px tall -- portrait pages and two-page spreads
// alike, because a spread is two pages side by side and no taller than one --
// so a radius in pixels held still across all of them and the fact that it is a
// scale-dependent number never showed up. It is: glyph strokes, screentone
// pitch and linework all scale with the scan, so a 10px window on an 800px page
// covers twice the drawing it was tuned to cover and reads flat artwork as
// busy. That is a page-format assumption and it is worth stating: height rather
// than width because a spread is twice as wide as a page at the same scan
// resolution, and height rather than the short side for the same reason -- the
// short side is the width on a portrait page and the height on a spread, which
// makes two scans of the same book disagree by a factor of two.
const STRUCTURE_REFERENCE = 1600;

/**
 * Structure at or above this and the region is left alone.
 *
 * It sits in the gap the table above measures: 0.093 below, 0.131 above. That
 * gap is real but it is eight labelled regions on four pages, judged by my eye,
 * and one of them (narration on a tone panel, which ghosts but is covered by
 * the English that replaces it) is a taste call rather than an obvious one.
 * Treat this as tuned, not settled, and re-run tools/bakeoff/clean-plate.mjs
 * and LOOK at the plates before moving it.
 */
export const STRUCTURE_THRESHOLD = 0.11;

// How far from a glyph still counts as "behind the text". Diffusion fills from
// the mask's edge inward, so this is the band it actually draws from.
const STRUCTURE_BAND = 7;

/**
 * How much drawing is behind this region's text, 0 (flat) to 1 (busy).
 *
 * THIS IS THE QUESTION THE PLATE ACTUALLY HAS TO ANSWER, and it is not "is this
 * a bubble" or "is this SFX". Diffusion fills a masked pixel from its unmasked
 * neighbours, so it is truthful exactly when those neighbours are flat: a
 * bubble interior, a tone, a gradient. When they are linework -- a hand, a
 * face, a black speed-line burst with hand-drawn onomatopoeia over it -- there
 * is no "behind" to recover and the fill is a smear.
 *
 * A spread-of-the-background test was tried before and abandoned (BUSY_STD),
 * for a good reason: it measured the text's own antialiasing rather than
 * anything behind it, and came out as a continuum with no gap in it. Two things
 * are different now.
 *
 *   1. THE MASK. The text pixels and their dilated fringe are known, exactly,
 *      and excluded -- from the blur as well as from the statistic. That is the
 *      confound that sank the old test, removed rather than mitigated.
 *   2. THE BLUR. Screentone is high-frequency and its raw variance is huge, but
 *      it inpaints perfectly well: diffusion turns it into the grey it averages
 *      to, which is what it looked like anyway. Blurring first collapses tone
 *      to its mean and leaves edges standing, so what is measured is structure
 *      rather than texture.
 *
 * MEASURED IN A BAND AROUND THE GLYPHS, not across the whole box, and that is
 * the third difference. Diffusion fills from the mask's edge, so pixels far
 * from any stroke have no say in what the fill looks like -- and including them
 * produced exactly the false positive you would expect: a 61x929 sidebar column
 * on a white margin scored 0.255, higher than a logo lying across artwork,
 * because its box straddled a panel border a long way from any text.
 *
 * AND IT IS A MEDIAN OF LOCAL VARIANCE, not the variance of the band. Pooling
 * the whole band keeps the same bug in a smaller form: a column of text set on
 * flat white beside a thick black panel border has one very dark neighbourhood
 * and hundreds of flat ones, and pooled variance reads that as a busy region
 * when the fill would in fact be perfect. What matters is whether a TYPICAL
 * stroke has structure against it, so each band pixel is scored on its own
 * neighbourhood and the median decides. One hard edge nearby cannot outvote
 * hundreds of flat neighbourhoods; artwork behind the whole word can.
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

  // Luma, and the weight that excludes every masked pixel from everything that
  // follows. Rec. 601, the same coefficients as surface.js and the bake-off.
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

  // Separable box blur of the known pixels, normalised by how many were known
  // -- so a window straddling the mask averages only real background.
  // Separable, and a SLIDING WINDOW rather than a re-summed one: the radius
  // that separates texture from structure is 12, so the naive version does 25
  // additions per pixel per axis, twice over (values and squares), on every
  // region of every page. Adding the entering column and subtracting the
  // leaving one is the same answer for a constant cost.
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

  // Local mean and local mean-of-squares from the same weighted blur give the
  // local variance in one pass: E[x^2] - E[x]^2.
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
