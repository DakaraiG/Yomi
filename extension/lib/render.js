// Numbered-box rendering.
//
// Descended from sidecar/app/main.py's /detect/debug, which drew boxes and
// reading-order numbers so a human could judge detection. In v0.4 the same
// drawing becomes load-bearing rather than diagnostic: with no local OCR, the
// numbered render is HOW the model knows which text belongs to which polygon.
// It reads the number off the page and keys its transcription to it.
//
// That changes what the drawing has to achieve. The debug render wants boxes
// that shout. The handoff render has to be legible to the model while hiding
// nothing -- because the model is transcribing the Japanese underneath, and a
// label sitting on a glyph is a glyph it cannot read. Every choice below is
// downstream of that one constraint.

/** Human-facing: thick red boxes, big numbers. Judge detection by eye. */
export const DEBUG = {
  strokeWidth: 3,
  stroke: "#ff0000",
  labelBackground: "#ff0000",
  labelColour: "#ffffff",
  fontSize: 28,
  labelPadding: 5,
  labelOutside: false
};

/**
 * Model-facing.
 *
 * Magenta because manga is greyscale: nothing on the page competes with it, so
 * the model cannot mistake a label for artwork or a label's edge for linework.
 *
 * Labels sit OUTSIDE their box. Inside, a number covers the first character of
 * the very region it identifies -- the one piece of text it must not hide.
 */
export const HANDOFF = {
  strokeWidth: 1.5,
  stroke: "#ff2d95",
  labelBackground: "#ff2d95",
  labelColour: "#ffffff",
  fontSize: 15,
  labelPadding: 2,
  labelOutside: true
};

/** Scale line and label sizes with the page, so a 3000px scan is not hairlined. */
function scaleFor(width, height) {
  return Math.max(0.75, Math.min(2.5, Math.max(width, height) / 1400));
}

function overlaps(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Where the label goes.
 *
 * Outside its own box, and -- the part that matters -- outside every OTHER
 * region's box too. Clearing only its own box is not enough: on a page of
 * vertical columns, a label placed to the left of column N lands squarely on
 * column N+1's text, and hiding a neighbour's glyphs is exactly as bad as
 * hiding your own. Manga margins are dense enough that this happens on a
 * typical page rather than a pathological one.
 *
 * Candidates are tried in order of preference and the first clean one wins. If
 * every position collides -- a region ringed by others -- the last is used
 * anyway, because a label drawn off-canvas or omitted is worse: the model sees
 * a box with no number and answers for it regardless, with an id it invented.
 */
function labelPosition(box, chipW, chipH, canvasW, canvasH, outside, others) {
  const candidates = outside
    ? [
        [box.x0 - chipW, box.y0 - chipH],   // outside top-left
        [box.x1, box.y0 - chipH],           // outside top-right
        [box.x0 - chipW, box.y1],           // outside bottom-left
        [box.x1, box.y1],                   // outside bottom-right
        [box.x0 - chipW, box.y0],           // flush left
        [box.x1, box.y0],                   // flush right
        [box.x0, box.y0 - chipH]            // directly above
      ]
    : [[box.x0, box.y0 - chipH], [box.x0, box.y0]];

  let fallback = null;
  for (const [rawX, rawY] of candidates) {
    const x = Math.max(0, Math.min(rawX, canvasW - chipW));
    const y = Math.max(0, Math.min(rawY, canvasH - chipH));
    const chip = { x0: x, y0: y, x1: x + chipW, y1: y + chipH };
    fallback ??= [x, y];
    if (!others.some((o) => overlaps(chip, o))) return [x, y];
  }
  return fallback;
}

/**
 * @param {object} opts
 * @param {*} opts.canvas       a canvas to draw into, sized to the image
 * @param {*} opts.image        anything drawImage accepts
 * @param {Array<{x0,y0,x1,y1}>} opts.boxes  pixel coords, IN READING ORDER --
 *   the label is the array index, and that index is the id the model answers
 *   with, so the caller must order before rendering
 * @param {object} [opts.style]
 * @param {string[]} [opts.labels]  override the numbering
 */
export function drawNumberedBoxes({ canvas, image, boxes, style = HANDOFF, labels = null }) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;

  ctx.drawImage(image, 0, 0);

  const k = scaleFor(width, height);
  const fontSize = Math.round(style.fontSize * k);
  const stroke = style.strokeWidth * k;
  const pad = style.labelPadding * k;

  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textBaseline = "top";
  ctx.lineJoin = "miter";

  boxes.forEach((box, i) => {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = style.stroke;
    ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);

    const label = labels?.[i] ?? String(i);
    const chipW = ctx.measureText(label).width + pad * 2;
    const chipH = fontSize + pad * 2;
    const others = boxes.filter((_, j) => j !== i);
    const [cx, cy] = labelPosition(box, chipW, chipH, width, height, style.labelOutside, others);

    ctx.fillStyle = style.labelBackground;
    ctx.fillRect(cx, cy, chipW, chipH);
    ctx.fillStyle = style.labelColour;
    ctx.fillText(label, cx + pad, cy + pad);
  });

  return canvas;
}
