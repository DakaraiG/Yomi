// Box shaping: giving English a shape it can be set in.
//
// Japanese sets vertically, so a region's box is tall and narrow, and English
// inherits that shape and wraps into eight-line slivers where a letterer would
// use four wider lines.
//
// Width is the only lever -- trading height for width around the centre would
// leave the original Japanese showing below the English.
//
// What bounds the width is not the other text boxes: the span between
// neighbouring regions is a median of 5.3x the box width on the fixture pages,
// and that space is artwork rather than emptiness. The real boundary is the
// bubble, which lib/surface.js finds by stepping outward while the pixels are
// still the same uniform surface. That probe is the safety, which is why the
// growth cap can afford to be loose.

/** Aspect (w/h) English wants. Slightly wider than tall: a lettered text block. */
export const TARGET_ASPECT = 1.1;
/** Backstop only -- the pixel probe is what actually stops the expansion. */
export const MAX_GROW = 4;
/** Keep this much clear of a neighbouring region, in pixels. */
export const NEIGHBOUR_GAP = 6;

/** How far a strip may drift from the base surface and still be the same one. */
const TOL_LUM = 0.08;
const TOL_SD = 0.10;

/**
 * Horizontal span a box may occupy without touching a neighbour that shares
 * any of its rows. Returns pixel [left, right], never tighter than the box.
 */
export function freeSpan(box, neighbours, imageW, gap = NEIGHBOUR_GAP) {
  let L = 0, R = imageW;
  for (const o of neighbours) {
    if (o === box) continue;
    if (Math.min(box.y1, o.y1) - Math.max(box.y0, o.y0) <= 0) continue;
    if (o.x1 <= box.x0) L = Math.max(L, o.x1 + gap);
    if (o.x0 >= box.x1) R = Math.min(R, o.x0 - gap);
  }
  return [Math.min(L, box.x0), Math.max(R, box.x1)];
}

/** Is this strip still the surface we started on? */
export function sameSurface(strip, base) {
  return !!strip &&
    strip.sd <= TOL_SD &&
    Math.abs(strip.lum - base.bgLum) <= TOL_LUM;
}

/**
 * Widen a vertical-source box until the pixels beside it stop being the same
 * surface, it meets a neighbour, or it is wide enough for English.
 *
 * Grows from whichever side is currently narrower, so the text stays centred on
 * the original: an off-centre block reads as a mistake even when it is legible.
 *
 * @param {{x0:number,y0:number,x1:number,y1:number}} box Pixel space.
 * @param {object} o
 * @param {{bgLum:number}} o.base Surface measured inside the region.
 * @param {Array} o.neighbours Other regions' pixel boxes.
 * @param {number} o.imageW
 * @param {(x:number,y:number,w:number,h:number)=>{lum:number,sd:number}|null} o.probe
 * @returns {{x0:number,y0:number,x1:number,y1:number}} A new box, or the same one.
 */
export function widenBox(box, { base, neighbours, imageW, probe }) {
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  if (w <= 0 || h <= 0) return box;

  const want = h * TARGET_ASPECT;
  if (w >= want) return box;

  const limit = Math.min(want, w * MAX_GROW);
  const [L, R] = freeSpan(box, neighbours, imageW);
  const step = Math.max(3, Math.round(w * 0.15));

  let x0 = box.x0, x1 = box.x1;
  let openL = true, openR = true;

  while ((openL || openR) && x1 - x0 < limit) {
    const takeLeft = openL && (!openR || (box.x0 - x0) <= (x1 - box.x1));
    const room = limit - (x1 - x0);
    const d = Math.min(step, room);
    if (d < 1) break;

    if (takeLeft) {
      const nx0 = Math.max(L, x0 - d);
      if (nx0 >= x0 || !sameSurface(probe(nx0, box.y0, x0 - nx0, h), base)) openL = false;
      else x0 = nx0;
    } else {
      const nx1 = Math.min(R, x1 + d);
      if (nx1 <= x1 || !sameSurface(probe(x1, box.y0, nx1 - x1, h), base)) openR = false;
      else x1 = nx1;
    }
  }

  return { x0, y0: box.y0, x1, y1: box.y1 };
}

/**
 * The detector returns the text, not the bubble, so a little of the bubble's
 * margin is spent giving English room.
 */
export const BOX_EXPAND = 0.08;

/**
 * Expand each side by up to dx/dy, taking only the sides whose new strip is
 * still the same surface. Every edge of the final box has been probed, so the
 * overlay can use the rect to its edges rather than hedging.
 */
function grow(b, dx, dy, { base, probe, imageW, imageH }) {
  let { x0, y0, x1, y1 } = b;

  if (dx >= 1) {
    const l = Math.max(0, x0 - dx);
    if (l < x0 && sameSurface(probe(l, y0, x0 - l, y1 - y0), base)) x0 = l;
    const r = Math.min(imageW, x1 + dx);
    if (r > x1 && sameSurface(probe(x1, y0, r - x1, y1 - y0), base)) x1 = r;
  }
  if (dy >= 1) {
    const t = Math.max(0, y0 - dy);
    if (t < y0 && sameSurface(probe(x0, t, x1 - x0, y0 - t), base)) y0 = t;
    const btm = Math.min(imageH, y1 + dy);
    if (btm > y1 && sameSurface(probe(x0, y1, x1 - x0, btm - y1), base)) y1 = btm;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Final layout rect for one region, in pixels.
 *
 * Every pixel of what comes back has been measured as the same surface the
 * region sits on. A vertical region's width is not inflated again afterwards:
 * the probe already refused whatever lies past its edge.
 */
export function shapeBox(box, { vertical, base, neighbours, imageW, imageH, probe }) {
  const opts = { base, probe, imageW, imageH };

  let b = vertical
    ? widenBox(box, { base, neighbours, imageW, probe })
    : grow(box, (box.x1 - box.x0) * BOX_EXPAND, 0, opts);

  b = grow(b, 0, (b.y1 - b.y0) * BOX_EXPAND, opts);

  return {
    x0: Math.max(0, b.x0), y0: Math.max(0, b.y0),
    x1: Math.min(imageW, b.x1), y1: Math.min(imageH, b.y1)
  };
}
