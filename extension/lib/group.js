// Group text lines into text blocks.
//
// The detectors available under MIT/Apache are general text detectors, so they
// return one box per line where comic-text-detector returned one per block: a
// bubble holding three vertical columns arrives as three boxes. Downstream needs
// blocks -- the overlay draws one English string per bubble, and the numbered
// handoff gives the model one number per region, so three numbers on one bubble
// means three fragments of a sentence translated independently.
//
// Proximity alone cannot do it. Grow each box and merge what overlaps, and the
// result chains: A near B near C welds a margin sidebar to a bubble two panels
// away because a run of small SFX bridged the gap. That is what transitive
// closure over a proximity graph does on a dense page, not a tuning problem.
//
// So structure decides first, from two signals already computed elsewhere:
//
//   1. Panels. Two lines in different panels are never the same region,
//      whatever their geometry says -- a hard partition that alone kills the
//      worst over-merges.
//   2. Bubbles. A speech bubble is a closed light region bounded by a dark
//      contour, so lines sharing an enclosure are candidates to merge.
//
// Geometry runs inside a structural bucket and never across one. For text with
// no bubble -- SFX and narration over artwork -- it is the only signal left.

import { WhiteField, WHITE_LEVEL } from "./panels.js";
import { detectPages } from "./panels.js";
import { panelIndexFor } from "./ordering.js";

// Looser than the classical detector's filters, because the job is only to
// decide whether two boxes sit in the same enclosure: a blob that is a bad text
// region can still be a good grouping key.
const MIN_BUBBLE_AREA_FRACTION = 0.0002;
const MAX_BUBBLE_AREA_FRACTION = 0.35;

// On-art fallback. Vertical Japanese sets columns about one character apart, so
// the gap that still counts as "same block" scales with the column's short side.
const ADJACENT_GAP_RATIO = 0.9;
// Inside a shared bubble the same test runs looser, since enclosure has already
// ruled out everything structurally unrelated and the only question left is one
// bubble or two touching ones.
//
// A swept trade-off with no correct answer: low settings separate a touching
// double bubble and over-split ordinary ones, high settings do the reverse. Gap
// size cannot separate the two cases -- a double bubble's lobes sit about one
// column-gap apart. Alignment would (columns of one block share y extents almost
// exactly), but fitting a second heuristic to two errors across three pages is
// overfitting. Revisit with more pages.
const BUBBLE_GAP_RATIO = 1.2;
// How far two boxes must overlap on their long axis to be columns of one block
// rather than unrelated text passing nearby.
const MIN_PARALLEL_OVERLAP = 0.35;

/**
 * Label every enclosed light region.
 *
 * Flooding the light pixels does the work: the drawn outline severs each bubble
 * interior from the page margin, and the margin is the component touching the
 * image edge.
 *
 * @returns {{labels: Int32Array, width: number, height: number}} 0 = not inside
 *   any bubble.
 */
export function bubbleMap(raster, field = null) {
  const { width, height } = raster;
  const white = field ?? new WhiteField(raster);
  const mask = white.mask;

  const labels = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  const pageArea = width * height;
  const areas = [];
  const edged = [];
  let next = 1;

  // Label every light component first, then decide which are bubbles and remap.
  // Zeroing a rejected component's labels instead would put its pixels back in
  // the unvisited state this scan tests for, so the page margin -- the largest
  // component on every page, and never a bubble -- gets re-flooded from each of
  // its own pixels in turn.
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;

    const id = next++;
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = id;

    let area = 0;
    let touchesEdge = false;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;
      area++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < width - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - width] && !labels[p - width]) { labels[p - width] = id; stack[sp++] = p - width; }
      if (y < height - 1 && mask[p + width] && !labels[p + width]) { labels[p + width] = id; stack[sp++] = p + width; }
    }

    areas.push(area);
    edged.push(touchesEdge);
  }

  // id -> bubble id, or 0 for "not a bubble". Index 0 stays 0.
  const remap = new Int32Array(next);
  let kept = 0;
  for (let id = 1; id < next; id++) {
    const fraction = areas[id - 1] / pageArea;
    const isBubble = !edged[id - 1] &&
      fraction >= MIN_BUBBLE_AREA_FRACTION &&
      fraction <= MAX_BUBBLE_AREA_FRACTION;
    remap[id] = isBubble ? ++kept : 0;
  }
  for (let p = 0; p < labels.length; p++) labels[p] = remap[labels[p]];

  return { labels, width, height, count: kept };
}

/**
 * Which bubble encloses this box, or 0.
 *
 * Sampled over the box, not at its centre: the centre of a text line lands on a
 * glyph as often as not, and a glyph is ink -- label 0 -- so a centre probe
 * reports "no bubble" for text plainly inside one.
 */
function enclosingBubble({ labels, width, height }, box) {
  const x0 = Math.max(0, Math.floor(box.x0));
  const y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1));
  const y1 = Math.min(height, Math.ceil(box.y1));
  if (x1 <= x0 || y1 <= y0) return 0;

  const counts = new Map();
  const stepX = Math.max(1, Math.floor((x1 - x0) / 32));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 32));

  let sampled = 0;
  for (let y = y0; y < y1; y += stepY) {
    const row = y * width;
    for (let x = x0; x < x1; x += stepX) {
      sampled++;
      const id = labels[row + x];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  let best = 0, bestCount = 0;
  for (const [id, n] of counts) if (n > bestCount) { best = id; bestCount = n; }

  // The winner must enclose the line, not merely touch it. Measured over 222
  // lines on the fixture pages the score is sharply bimodal -- 0.6-0.9 inside a
  // bubble, 0.0-0.5 on art -- and the threshold belongs in the empty valley
  // between.
  //
  // Set low, this fails structurally rather than cosmetically: a screentone
  // panel breaks into a scatter of small light blobs, each column of thought
  // text claims a different one, and since bucketing happens by bubble id before
  // any geometry is considered, plainly adjacent columns are never even asked.
  // Text with no bubble has to report no bubble to reach the geometry fallback.
  const ENCLOSURE = 0.55;
  return sampled && bestCount / sampled >= ENCLOSURE ? best : 0;
}

function union(a, b) {
  return {
    x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
    score: Math.max(a.score ?? 0, b.score ?? 0)
  };
}

/** Do these two boxes sit alongside each other as columns/lines of one block? */
function adjacent(a, b, gapRatio = ADJACENT_GAP_RATIO) {
  const aw = a.x1 - a.x0, ah = a.y1 - a.y0;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;

  const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);

  const xGap = -xOverlap;
  const yGap = -yOverlap;

  // Side by side: vertical columns of the same bubble.
  if (yOverlap > 0 && yOverlap >= MIN_PARALLEL_OVERLAP * Math.min(ah, bh)) {
    if (xGap <= gapRatio * Math.min(aw, bw)) return true;
  }
  // Stacked: horizontal lines of the same caption.
  if (xOverlap > 0 && xOverlap >= MIN_PARALLEL_OVERLAP * Math.min(aw, bw)) {
    if (yGap <= gapRatio * Math.min(ah, bh)) return true;
  }
  return false;
}

/** Transitively merge a bucket of boxes on `adjacent`. */
function mergeByAdjacency(boxes, indices, gapRatio = ADJACENT_GAP_RATIO) {
  const groups = [];
  for (const i of indices) {
    const box = boxes[i];
    const hits = [];
    for (let g = 0; g < groups.length; g++) {
      if (groups[g].members.some((m) => adjacent(boxes[m], box, gapRatio))) hits.push(g);
    }

    if (!hits.length) {
      groups.push({ box: { ...box }, members: [i] });
      continue;
    }

    // A line can bridge two existing groups, so fold them together rather than
    // picking one.
    const target = groups[hits[0]];
    target.box = union(target.box, box);
    target.members.push(i);
    for (let k = hits.length - 1; k >= 1; k--) {
      const g = groups[hits[k]];
      target.box = union(target.box, g.box);
      target.members.push(...g.members);
      groups.splice(hits[k], 1);
    }
  }
  return groups;
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
 * @param {Array<{x0:number,y0:number,x1:number,y1:number,score?:number}>} lines
 * @returns {Array<{x0,y0,x1,y1,score,members:number[],inBubble:boolean}>}
 *   blocks, unordered -- run panelReadingOrder over the result to sort them.
 */
export function groupIntoBlocks(raster, lines) {
  if (!lines.length) return [];

  const field = new WhiteField(raster);
  const pages = detectPages(field);
  const bubbles = bubbleMap(raster, field);

  // Bucket by structure -- page, then panel or furniture strip, then bubble.
  // Lines in different buckets can never merge.
  const buckets = new Map();

  lines.forEach((line, i) => {
    const cx = (line.x0 + line.x1) / 2;
    const cy = (line.y0 + line.y1) / 2;

    let pageIndex = pages.findIndex((p) => p.x0 <= cx && cx < p.x1);
    if (pageIndex === -1) pageIndex = pages.length - 1;
    const page = pages[pageIndex];

    let where;
    if (page.block === null) {
      where = "nopanels";
    } else {
      const [bx0, by0, bx1, by1] = page.block;
      if (cx < bx0 || cx > bx1) {
        // Beside the panels, keyed by which furniture strip rather than one
        // shared bucket: two commentary columns 3px apart are two regions, and
        // no gap threshold can say so, since column spacing inside one block is
        // just as tight. The strips already know.
        const strip = page.furniture.findIndex(
          ([fx0, fy0, fx1, fy1]) => fx0 <= cx && cx < fx1 && fy0 <= cy && cy < fy1);
        where = strip === -1 ? "aside" : `f${strip}`;
      } else if (cy < by0) {
        // A page title, kept apart from the side furniture it would otherwise
        // chain into along the margin.
        where = "above";
      } else if (cy > by1) {
        where = "below";
      } else {
        where = `p${panelIndexFor(page.panels, cx, cy)}`;
      }
    }

    const bubble = enclosingBubble(bubbles, line);
    const key = `${pageIndex}/${where}/${bubble}`;
    if (!buckets.has(key)) buckets.set(key, { bubble, indices: [] });
    buckets.get(key).indices.push(i);
  });

  const blocks = [];
  for (const { bubble, indices } of buckets.values()) {
    // Enclosure constrains rather than decides: manga draws double bubbles whose
    // outlines touch, and a touching pair is one light region however plainly it
    // reads as two utterances. So geometry still runs inside a bubble, loosely
    // enough to join the columns of an ordinary one.
    const gapRatio = bubble !== 0 ? BUBBLE_GAP_RATIO : ADJACENT_GAP_RATIO;
    for (const group of mergeByAdjacency(lines, indices, gapRatio)) {
      // `inBubble` is carried out with the block because it cannot be recovered
      // downstream: text on a blank area of a page is pixel-for-pixel
      // indistinguishable from text in a bubble, both being uniformly light.
      // Only the connected-component pass knows there is no outline around it.
      blocks.push({ ...group.box, members: group.members, inBubble: bubble !== 0 });
    }
  }

  return blocks;
}

export { WHITE_LEVEL };
