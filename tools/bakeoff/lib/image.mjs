// Image loading and pixel helpers, written against the Canvas2D API so that the
// preprocessing and rendering here run unchanged in the extension's offscreen
// document.

import { createCanvas, loadImage } from "@napi-rs/canvas";

/** @typedef {{width:number,height:number,data:Uint8ClampedArray}} Raster RGBA. */

/** Decode a file into an RGBA raster plus the canvas it came from. */
export async function loadRaster(path) {
  const img = await loadImage(path);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  return { width: img.width, height: img.height, data, canvas };
}

/**
 * Rec. 601 luma, one byte per pixel.
 *
 * Same coefficients as the extension's background sampler and as panels.py's
 * white test, so "how light is this pixel" means one thing across the project.
 */
export function toGray({ width, height, data }) {
  const gray = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  }
  return gray;
}

/**
 * Bilinear resize of an RGBA raster into a new one.
 *
 * Written by hand rather than via ctx.drawImage scaling because detector
 * preprocessing has to match what the model was trained on, and drawImage's
 * resampling is implementation-defined.
 */
export function resizeRGBA(src, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  const xRatio = src.width / outW;
  const yRatio = src.height / outH;

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(src.height - 1, (y + 0.5) * yRatio - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < outW; x++) {
      const sx = Math.min(src.width - 1, (x + 0.5) * xRatio - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;

      const i00 = (y0 * src.width + x0) * 4;
      const i01 = (y0 * src.width + x1) * 4;
      const i10 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const o = (y * outW + x) * 4;

      for (let c = 0; c < 4; c++) {
        const top = src.data[i00 + c] * (1 - fx) + src.data[i01 + c] * fx;
        const bot = src.data[i10 + c] * (1 - fx) + src.data[i11 + c] * fx;
        out[o + c] = top * (1 - fy) + bot * fy;
      }
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * RGBA raster -> NCHW Float32 tensor, normalised.
 *
 * `mean` and `std` are per-channel in 0-1 units, matching the convention every
 * candidate's published preprocessing uses.
 */
export function toTensor(raster, { mean = [0, 0, 0], std = [1, 1, 1] } = {}) {
  const { width, height, data } = raster;
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = (data[i] / 255 - mean[0]) / std[0];
    out[plane + p] = (data[i + 1] / 255 - mean[1]) / std[1];
    out[2 * plane + p] = (data[i + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

/** Round dimensions up to a multiple of `n`, which most detectors require. */
export function padTo(value, n = 32) {
  return Math.max(n, Math.ceil(value / n) * n);
}
