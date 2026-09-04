// Differentiable Binarization (DB) post-processing.
//
// Both ONNX text detectors in the bake-off (PaddleOCR's det model and CRAFT's
// link/region maps, with different thresholds) emit a per-pixel probability
// map rather than boxes. Turning that map into boxes is where all the tuning
// lives, so it is one shared implementation with parameters rather than two.
//
// The pipeline: threshold -> connected components -> filter -> unclip -> score.

import { connectedComponents } from "./components.js";

/**
 * Expand a box the way DB's unclip step expands a polygon.
 *
 * DB is trained on shrunk text regions, so the raw component is smaller than the
 * real text. Upstream offsets the polygon by `area * ratio / perimeter`, which
 * for an axis-aligned box is the same distance on all four sides. Skipping this
 * is why a from-scratch DB port produces boxes that clip the glyphs.
 */
function unclip(box, ratio) {
  const w = box.x1 - box.x0;
  const h = box.y1 - box.y0;
  const perimeter = 2 * (w + h);
  if (perimeter === 0) return box;
  const distance = (w * h * ratio) / perimeter;
  return {
    x0: box.x0 - distance,
    y0: box.y0 - distance,
    x1: box.x1 + distance,
    y1: box.y1 + distance
  };
}

/** Mean probability inside a box — DB's own confidence measure. */
function boxScore(prob, width, height, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1));
  const y1 = Math.min(height, Math.ceil(box.y1));
  if (x1 <= x0 || y1 <= y0) return 0;

  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) { sum += prob[row + x]; n++; }
  }
  return n ? sum / n : 0;
}

/**
 * @param {Float32Array} prob            probability map, `width` x `height`
 * @param {object} opts
 * @param {number} opts.width            probability map width
 * @param {number} opts.height           probability map height
 * @param {number} [opts.binaryThreshold=0.3]  pixel is text above this
 * @param {number} [opts.boxThreshold=0.5]     drop boxes scoring below this
 * @param {number} [opts.unclipRatio=1.8]      see unclip()
 * @param {number} [opts.minSide=3]            drop boxes thinner than this
 * @param {number} [opts.scaleX=1]             map -> original image scale
 * @param {number} [opts.scaleY=1]
 * @param {number} [opts.imageWidth]           clamp target, defaults to map size
 * @param {number} [opts.imageHeight]
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number,score:number}>} pixel coords
 */
export function probabilityMapToBoxes(prob, {
  width,
  height,
  binaryThreshold = 0.3,
  boxThreshold = 0.5,
  unclipRatio = 1.8,
  minSide = 3,
  scaleX = 1,
  scaleY = 1,
  imageWidth,
  imageHeight
} = {}) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > binaryThreshold ? 1 : 0;

  const { boxes } = connectedComponents(mask, width, height, { eightWay: true });
  const clampW = imageWidth ?? width;
  const clampH = imageHeight ?? height;
  const out = [];

  for (const raw of boxes) {
    // Cheap rejections before the expensive per-pixel score.
    if (raw.x1 - raw.x0 < minSide || raw.y1 - raw.y0 < minSide) continue;

    const score = boxScore(prob, width, height, raw);
    if (score < boxThreshold) continue;

    const grown = unclip(raw, unclipRatio);
    const box = {
      x0: Math.max(0, Math.round(grown.x0 * scaleX)),
      y0: Math.max(0, Math.round(grown.y0 * scaleY)),
      x1: Math.min(clampW, Math.round(grown.x1 * scaleX)),
      y1: Math.min(clampH, Math.round(grown.y1 * scaleY)),
      score
    };
    if (box.x1 - box.x0 < minSide || box.y1 - box.y0 < minSide) continue;
    out.push(box);
  }

  return out;
}

/**
 * Merge line-level boxes into block-level ones.
 *
 * The crude version, used only to make the bake-off's debug renders comparable
 * and give an honest region count; deliberately not part of the recall metric.
 * The real grouper is lib/group.js.
 *
 * Two boxes merge when they overlap after being grown by `gap`. Manga is usually
 * vertical, so the horizontal gap between columns is what matters, but pages mix
 * both -- so grow on each axis and let overlap decide.
 */
export function mergeIntoBlocks(boxes, { gapRatio = 0.35, maxPasses = 6 } = {}) {
  // `members` lets this be scored by the same grouping metric as lib/group.js.
  let current = boxes.map((b, i) => ({ ...b, members: [i] }));

  for (let pass = 0; pass < maxPasses; pass++) {
    const merged = [];
    const used = new Array(current.length).fill(false);
    let changed = false;

    for (let i = 0; i < current.length; i++) {
      if (used[i]) continue;
      let a = current[i];
      used[i] = true;

      for (let j = i + 1; j < current.length; j++) {
        if (used[j]) continue;
        const b = current[j];

        // A fraction of the smaller box's short side: using the larger lets one
        // big block hoover up every unrelated line near it.
        const shortA = Math.min(a.x1 - a.x0, a.y1 - a.y0);
        const shortB = Math.min(b.x1 - b.x0, b.y1 - b.y0);
        const pad = Math.min(shortA, shortB) * gapRatio;

        const overlaps =
          a.x0 - pad < b.x1 && b.x0 < a.x1 + pad &&
          a.y0 - pad < b.y1 && b.y0 < a.y1 + pad;

        if (!overlaps) continue;
        a = {
          x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
          x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
          score: Math.max(a.score ?? 0, b.score ?? 0),
          members: [...a.members, ...b.members]
        };
        used[j] = true;
        changed = true;
      }
      merged.push(a);
    }

    current = merged;
    if (!changed) break;
  }

  return current;
}
