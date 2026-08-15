// Group text LINES into text BLOCKS.
//
// This step did not exist in v0.3 and is the main thing the rewrite has to
// invent. comic-text-detector returned one box per text block; every MIT/Apache
// replacement returns one box per line, because they are general text detectors
// and a line is what general text is made of. A bubble holding three vertical
// columns arrives as three boxes.
//
// Blocks matter downstream in a way lines do not: the overlay draws one English
// string per bubble, and Phase 3's numbered handoff gives the model one number
// per region. Three numbers on one bubble means three fragments of a sentence
// translated independently.
//
// WHY PROXIMITY ALONE FAILS. The obvious rule -- grow each box a little, merge
// what overlaps -- chains. A is near B, B is near C, C is near D, and a single
// pass welds a margin sidebar to a speech bubble two panels away because a run
// of small SFX happened to bridge the gap. That is not a tuning problem; it is
// what transitive closure over a proximity graph does on a dense page.
//
// So grouping here is driven by STRUCTURE first and geometry only as a
// fallback, using two signals that cost nothing because we already compute them:
//
//   1. PANELS (lib/panels.js). Two lines in different panels are never the same
//      region, whatever their geometry says. This is a hard partition and it
//      alone kills the worst over-merges.
//   2. BUBBLES. A speech bubble is a closed light region bounded by a dark
//      contour -- the same observation the classical detector candidate rests
//      on. Lines sharing an enclosing bubble are the same block, full stop, and
//      no gap heuristic is consulted.
//
// Geometry is used only for text with no bubble around it: SFX and narration
// set over artwork. There it is orientation-aware and tight, and it still
// cannot cross a panel boundary.

import { WhiteField, WHITE_LEVEL } from "./panels.js";
import { detectPages } from "./panels.js";
import { panelIndexFor } from "./ordering.js";

// Bubble-interior detection. Looser than the classical DETECTOR's filters,
// because the job is different: we are not trying to find text, only to decide
// whether two boxes sit inside the same enclosure. A blob that is a bad text
// region can still be a perfectly good grouping key.
const MIN_BUBBLE_AREA_FRACTION = 0.0002;
const MAX_BUBBLE_AREA_FRACTION = 0.35;

// On-art fallback. Vertical Japanese sets columns about one character apart, so
// the gap that still counts as "same block" scales with the column's short side.
const ADJACENT_GAP_RATIO = 0.9;
// Inside a shared bubble the same test runs looser: enclosure has already ruled
// out everything structurally unrelated, so the only question left is whether
// this is one bubble or two touching ones.
//
// SWEPT, not guessed, and it is a genuine trade-off rather than a value that
// wants tuning further. Low settings separate ynko3's touching double bubble
// correctly and then over-split ordinary bubbles on ynko2; high settings do the
// reverse. Measured across the three pages (exact-match rate):
//
//   0.3-0.5   100.0 / 84.6 / 100.0     ynko3 right, ynko2 splits 4 bubbles
//   0.9       100.0 / 92.3 /  90.9
//   1.2-1.6   100.0 / 96.2 /  90.9     best aggregate, one weld left
//
// No value fixes both, because gap size is not what separates the two cases: a
// double bubble's lobes are 28px apart, which is also a plausible column gap.
// The discriminator that would work is alignment -- columns of one text block
// share y extents almost exactly, while two bubbles' columns do not -- but
// fitting a second heuristic to two remaining errors across three pages is
// overfitting, not engineering. Revisit with more pages.
const BUBBLE_GAP_RATIO = 1.2;
// Two columns of the same block run alongside each other; this is how much they
// must overlap on the long axis to count as neighbours rather than as unrelated
// text that happens to pass nearby.
const MIN_PARALLEL_OVERLAP = 0.35;

/**
 * Label every enclosed light region.
 *
 * The enclosure does the work for free: flood the light pixels and the page
 * margin is one component, each bubble interior is another, because the drawn
 * outline severs them. The margin is the component touching the image edge.
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

  // Label EVERY light component first, then decide which are bubbles and remap.
  //
  // The obvious shape -- flood, judge, and zero the labels again if it is not a
  // bubble -- is quadratic, and lethally so. Zeroing puts those pixels back in
  // the "unvisited" state the outer scan tests for, so the page margin (the
  // largest component on every page, and never a bubble) gets re-flooded from
  // each of its own pixels in turn.
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
 * Sampled over the box rather than at its centre. The centre of a text line
 * lands on a glyph as often as not, and a glyph is ink -- label 0 -- so a
 * centre probe reports "no bubble" for text that is plainly inside one.
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

  // Require the winner to actually dominate. A line that merely brushes a
  // neighbouring bubble picks up a few of its pixels, and inheriting that
  // bubble's identity would merge it into the wrong block.
  return sampled && bestCount / sampled >= 0.25 ? best : 0;
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

    // Joining two existing groups at once is legitimate -- a line can bridge
    // them -- so fold them together rather than picking one.
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
 * @returns {Array<{x0,y0,x1,y1,score,members:number[]}>} blocks, unordered --
 *   run panelReadingOrder over the result to sort them.
 */
export function groupIntoBlocks(raster, lines) {
  if (!lines.length) return [];

  const field = new WhiteField(raster);
  const pages = detectPages(field);
  const bubbles = bubbleMap(raster, field);

  // Bucket by structure: page, then panel (or "furniture"), then bubble.
  // Anything landing in a different bucket cannot merge, full stop.
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
        // Beside the panels. Key by which furniture STRIP it falls in, not by a
        // single "furniture" bucket: two commentary columns 3px apart are two
        // regions, and no gap threshold can say so -- real column spacing
        // inside one block is just as tight. The strips already know, because
        // a full-height white column is exactly what separates them.
        const strip = page.furniture.findIndex(
          ([fx0, fy0, fx1, fy1]) => fx0 <= cx && cx < fx1 && fy0 <= cy && cy < fy1);
        where = strip === -1 ? "aside" : `f${strip}`;
      } else if (cy < by0) {
        // Above the panels: a page title. Kept apart from the side furniture,
        // which it would otherwise chain into along the margin.
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
    // Inside one bubble, geometry is still consulted -- just generously. Manga
    // draws double bubbles whose outlines touch, and a touching pair is ONE
    // light region however plainly it reads as two utterances (ynko3's
    // "俺だってやりたくねえけど" and "金が無い以上..." are one blob, id 33).
    // Enclosure therefore constrains rather than decides: it says what CANNOT
    // merge, and the loose gap test separates lobes while still joining the
    // columns of an ordinary bubble, whose spacing is about one character.
    const gapRatio = bubble !== 0 ? BUBBLE_GAP_RATIO : ADJACENT_GAP_RATIO;
    for (const group of mergeByAdjacency(lines, indices, gapRatio)) {
      blocks.push({ ...group.box, members: group.members });
    }
  }

  return blocks;
}

export { WHITE_LEVEL };
