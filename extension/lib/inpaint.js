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
export function textMask(seg, width, height, {
  threshold = SEG_THRESHOLD, radius = DILATE_RADIUS
} = {}) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = seg[i] > threshold ? 1 : 0;
  return dilate(mask, width, height, radius);
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
