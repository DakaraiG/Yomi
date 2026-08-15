// Node-side wrapper around extension/lib/render.js.
//
// The renderer itself ships in the extension and knows nothing about where its
// canvas comes from -- OffscreenCanvas there, @napi-rs/canvas here. This file
// supplies the canvas and nothing else, so what the bake-off draws is exactly
// what the extension will send to the model.

import { createCanvas } from "@napi-rs/canvas";
import {
  drawNumberedBoxes as draw,
  DEBUG,
  HANDOFF
} from "../../../extension/lib/render.js";

export { DEBUG, HANDOFF };

/**
 * @param {import("@napi-rs/canvas").Canvas} source  page canvas
 * @param {Array<{x0,y0,x1,y1}>} boxes  pixel coords, in reading order
 * @param {object} [style]
 */
export function drawNumberedBoxes(source, boxes, style = DEBUG) {
  return draw({
    canvas: createCanvas(source.width, source.height),
    image: source,
    boxes,
    style
  });
}

/** Candidate boxes numbered, plus the baseline in dashed blue underneath. */
export function drawComparison(source, candidate, baseline) {
  const canvas = drawNumberedBoxes(source, candidate, DEBUG);
  const ctx = canvas.getContext("2d");
  const k = Math.max(0.75, Math.min(2.5, Math.max(source.width, source.height) / 1400));

  ctx.lineWidth = 2 * k;
  ctx.strokeStyle = "rgba(0, 128, 255, 0.9)";
  ctx.setLineDash([8 * k, 6 * k]);
  for (const b of baseline) {
    ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  }
  ctx.setLineDash([]);
  return canvas;
}
