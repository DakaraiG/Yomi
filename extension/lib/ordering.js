// Reading-order sort for manga text regions.
//
// Port of sidecar/app/ordering.py.
//
// Reading order is panel-major: finish one panel before starting the next,
// panels right-to-left within a row, rows top-to-bottom. That needs panel
// boundaries, and panel boundaries are not recoverable from box geometry --
// see lib/panels.js for why, and for how they are recovered from the image.
//
// Two entry points, deliberately split:
//
//   readingOrder()       pure geometry, no image. Bands regions into rows and
//                        sorts each row right-to-left. Used inside a single
//                        panel, and as the fallback when panel detection comes
//                        up empty (borderless page, blank page).
//
//   panelReadingOrder()  the real thing. Needs the page image.
//
// The split keeps the banding sort unit-testable on plain coordinate tuples now
// that the layer above it needs pixels.

import { detectPages, WhiteField } from "./panels.js";

export const BAND_THRESHOLD = 0.4;

/** Fraction of the shorter box's height that overlaps the taller one. */
function verticalOverlap(a, b) {
  const top = Math.max(a[1], b[1]);
  const bottom = Math.min(a[3], b[3]);
  const overlap = bottom - top;
  if (overlap <= 0) return 0;
  const shorter = Math.min(a[3] - a[1], b[3] - b[1]);
  return shorter > 0 ? overlap / shorter : 0;
}

/**
 * Indices of `boxes` in reading order, ignoring panels.
 *
 * @param {Array<[number,number,number,number]>} boxes
 * @param {number} [bandThreshold]  minimum vertical overlap fraction for two
 *   regions to be considered part of the same row.
 */
export function readingOrder(boxes, bandThreshold = BAND_THRESHOLD) {
  if (!boxes.length) return [];

  // Stable by construction: ties on y0 keep their original relative order, which
  // is what Python's sorted() does and what the fixtures were generated with.
  const indexed = boxes.map((_, i) => i).sort((i, j) => boxes[i][1] - boxes[j][1]);

  const bands = [];
  for (const i of indexed) {
    let placed = false;
    for (const band of bands) {
      // Against the band's seed -- the topmost box, since `indexed` is sorted by
      // y0 -- not against its accumulated envelope. The envelope grows every
      // time a slightly lower box joins, so a long row of staggered bubbles
      // drags the band down the page and swallows the row below it.
      if (verticalOverlap(boxes[band[0]], boxes[i]) >= bandThreshold) {
        band.push(i);
        placed = true;
        break;
      }
    }
    if (!placed) bands.push([i]);
  }

  bands.sort((a, b) => {
    const ay = Math.min(...a.map((j) => boxes[j][1]));
    const by = Math.min(...b.map((j) => boxes[j][1]));
    return ay - by;
  });

  const ordered = [];
  for (const band of bands) {
    // Right-to-left: rightmost edge first.
    ordered.push(...band.slice().sort((a, b) => boxes[b][2] - boxes[a][2]));
  }
  return ordered;
}

/** readingOrder() over a subset, mapped back to original indices. */
function sortedSubset(boxes, idxs, bandThreshold) {
  const local = readingOrder(idxs.map((i) => boxes[i]), bandThreshold);
  return local.map((k) => idxs[k]);
}

/**
 * Index of the panel owning this centroid.
 *
 * Falls back to the nearest panel centre, which covers a bubble whose middle
 * lands in a gutter because it straddles two panels.
 *
 * Exported because grouping needs the same answer ordering does: two text lines
 * in different panels are never the same region, whatever their geometry says.
 */
export function panelIndexFor(panels, cx, cy) {
  for (let i = 0; i < panels.length; i++) {
    const [x0, y0, x1, y1] = panels[i];
    if (x0 <= cx && cx <= x1 && y0 <= cy && cy <= y1) return i;
  }
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < panels.length; i++) {
    const [x0, y0, x1, y1] = panels[i];
    const dx = cx - (x0 + x1) / 2;
    const dy = cy - (y0 + y1) / 2;
    const d = dx * dx + dy * dy;
    if (d < bestDistance) { bestDistance = d; best = i; }
  }
  return best;
}

/**
 * Order one page's regions, panel-major.
 *
 * Furniture -- anything outside the panel block -- is placed by where it falls:
 * above the block (a page title) reads first, beside or below it (margin
 * commentary, character sidebars) reads last.
 */
function orderPage(boxes, idxs, page, bandThreshold) {
  if (!idxs.length) return [];
  if (page.block === null) return sortedSubset(boxes, idxs, bandThreshold);

  const [bx0, by0, bx1, by1] = page.block;
  const leading = [];
  const trailing = [];
  const buckets = page.panels.map(() => []);

  for (const i of idxs) {
    const [x0, y0, x1, y1] = boxes[i];
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    if (cx < bx0 || cx > bx1) trailing.push(i);          // beside the panels
    else if (cy < by0) leading.push(i);                  // above them
    else if (cy > by1) trailing.push(i);
    else buckets[panelIndexFor(page.panels, cx, cy)].push(i);
  }

  const ordered = sortedSubset(boxes, leading, bandThreshold);
  for (const bucket of buckets) {  // panels are already in reading order
    ordered.push(...sortedSubset(boxes, bucket, bandThreshold));
  }
  ordered.push(...sortedSubset(boxes, trailing, bandThreshold));
  return ordered;
}

/**
 * Indices of `boxes` in panel-major reading order.
 *
 * On a double-page spread the right page is ordered out entirely before the
 * left page begins.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}|WhiteField} image
 * @param {Array<[number,number,number,number]>} boxes  pixel coords
 */
export function panelReadingOrder(image, boxes, bandThreshold = BAND_THRESHOLD) {
  if (!boxes.length) return [];

  const field = image instanceof WhiteField ? image : new WhiteField(image);
  const pages = detectPages(field);
  const buckets = pages.map(() => []);

  for (let i = 0; i < boxes.length; i++) {
    const [x0, , x1] = boxes[i];
    const cx = (x0 + x1) / 2;
    // Pages tile the image, so the containment test only misses on a centroid
    // sitting exactly on the far edge.
    let page = pages.findIndex((p) => p.x0 <= cx && cx < p.x1);
    if (page === -1) page = pages.length - 1;
    buckets[page].push(i);
  }

  const ordered = [];
  for (let k = 0; k < pages.length; k++) {
    ordered.push(...orderPage(boxes, buckets[k], pages[k], bandThreshold));
  }
  return ordered;
}
