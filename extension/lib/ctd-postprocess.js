// comic-text-detector: input preparation and output decoding.
//
// Lives in the extension rather than the bake-off so that the bake-off measures
// what ships: tools/bakeoff/candidates/ctd.mjs imports this file. A copy on each
// side would drift invisibly, with the harness reporting numbers for a decoder
// nobody runs.
//
// Model signature, confirmed against the file:
//   in   images   [1,3,1024,1024] float32, RGB, 0-1, letterboxed
//   out  blk      [1,64512,7]     YOLOv5 detections, already anchor-decoded:
//                                 cx, cy, w, h, obj, cls0, cls1 in input space
//   out  seg      [1,1,1024,1024] per-pixel text mask
//   out  det      [1,2,1024,1024] DBNet-style line head, channel 0 = probability
//
// 64512 = (128^2 + 64^2 + 32^2) x 3 anchors, the arithmetic to check if a future
// export changes shape.

import { resizeRGBA } from "./imageops.js";

export const CTD_SIZE = 1024;

// Not 0 and not 255: black or white pad reads as page content -- white merges
// with the margin and pulls detections outward, black reads as panel gutter. The
// image goes at the top-left, so undoing the pad is a crop, not an offset.
export const CTD_PAD = 114;

/**
 * Fit a page into the model's square input.
 * @returns {{raster:object, r:number, nw:number, nh:number}} `r` is the scale
 *   applied, `nw`/`nh` the occupied region -- everything outside it is padding
 *   and has to be cropped off before any output map is mapped back to pixels.
 */
export function letterbox(raster, size = CTD_SIZE) {
  const r = size / Math.max(raster.width, raster.height);
  const nw = Math.round(raster.width * r);
  const nh = Math.round(raster.height * r);
  const resized = resizeRGBA(raster, nw, nh);

  const data = new Uint8ClampedArray(size * size * 4).fill(CTD_PAD);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;   // alpha, not 114

  for (let y = 0; y < nh; y++) {
    const src = y * nw * 4;
    data.set(resized.data.subarray(src, src + nw * 4), y * size * 4);
  }
  return { raster: { width: size, height: size, data }, r, nw, nh };
}

/** Greedy IoU non-maximum suppression, highest score first. */
export function nms(boxes, threshold = 0.35) {
  const kept = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    let drop = false;
    for (const k of kept) {
      const w = Math.min(b.x1, k.x1) - Math.max(b.x0, k.x0);
      const h = Math.min(b.y1, k.y1) - Math.max(b.y0, k.y0);
      if (w <= 0 || h <= 0) continue;
      const inter = w * h;
      const union = (b.x1 - b.x0) * (b.y1 - b.y0) +
                    (k.x1 - k.x0) * (k.y1 - k.y0) - inter;
      if (inter / union > threshold) { drop = true; break; }
    }
    if (!drop) kept.push(b);
  }
  return kept;
}

/**
 * YOLO head -> block-level boxes in page pixels.
 *
 * @param {Float32Array} data  the blk output
 * @param {number} stride      columns per detection (7)
 * @param {number} count       detections (64512)
 */
export function decodeBlocks(data, { stride, count, r, width, height,
                                     confThreshold = 0.4, nmsThreshold = 0.35 } = {}) {
  const raw = [];
  for (let i = 0; i < count; i++) {
    const o = i * stride;
    const obj = data[o + 4];
    if (obj < confThreshold) continue;      // cheap reject before the class loop

    let best = 0, cls = 0;
    for (let c = 5; c < stride; c++) {
      if (data[o + c] > best) { best = data[o + c]; cls = c - 5; }
    }
    const score = obj * best;
    if (score < confThreshold) continue;

    // cx,cy,w,h in letterboxed input space -> page pixels.
    const cx = data[o], cy = data[o + 1], w = data[o + 2], h = data[o + 3];
    const box = {
      x0: Math.max(0, Math.round((cx - w / 2) / r)),
      y0: Math.max(0, Math.round((cy - h / 2) / r)),
      x1: Math.min(width, Math.round((cx + w / 2) / r)),
      y1: Math.min(height, Math.round((cy + h / 2) / r)),
      score, cls
    };
    if (box.x1 > box.x0 && box.y1 > box.y0) raw.push(box);
  }
  return nms(raw, nmsThreshold);
}

/**
 * Crop one channel of a [1,C,size,size] output down to the unpadded region.
 *
 * Always before resizing: scaling the full square back to page dimensions treats
 * the padding as image and offsets every box and mask pixel.
 */
export function cropChannel(data, { size = CTD_SIZE, nw, nh, channel = 0 } = {}) {
  const off = channel * size * size;
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const src = off + y * size;
    out.set(data.subarray(src, src + nw), y * nw);
  }
  return out;
}

/** Bilinear resize of a single-channel float map. */
export function resizeMap(src, srcW, srcH, outW, outH) {
  const out = new Float32Array(outW * outH);
  const xRatio = srcW / outW;
  const yRatio = srcH / outH;

  for (let y = 0; y < outH; y++) {
    const sy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = sy - y0;

    for (let x = 0; x < outW; x++) {
      const sx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = sx - x0;

      const top = src[y0 * srcW + x0] * (1 - fx) + src[y0 * srcW + x1] * fx;
      const bot = src[y1 * srcW + x0] * (1 - fx) + src[y1 * srcW + x1] * fx;
      out[y * outW + x] = top * (1 - fy) + bot * fy;
    }
  }
  return out;
}

/**
 * Line boxes plus the block boxes no line landed in.
 *
 * The cheap version of upstream's fusion, and what fixtures/baseline.json was
 * produced by -- which is why neither head alone scores 100% against it.
 *
 * Only uncovered blocks are added: handing a block box downstream alongside the
 * lines it contains costs nothing in recall and hurts grouping, which was tuned
 * on line geometry and has never been shown a region box sitting on its own
 * lines.
 *
 * Coverage is by a line's centre rather than by overlap, since a line box on a
 * neighbouring bubble routinely clips this block's edge, and an edge clip is not
 * evidence that this block's own text was found.
 */
export function fuse(lines, blocks) {
  const uncovered = blocks.filter((b) => !lines.some((l) => {
    const cx = (l.x0 + l.x1) / 2, cy = (l.y0 + l.y1) / 2;
    return cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1;
  }));
  return [...lines, ...uncovered];
}
