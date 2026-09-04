// Candidate: classical CV. No model, no weights, no licence question at all.
//
// Rests on a speech bubble being a closed light region bounded by a dark
// contour, which makes it findable without learning anything: flood the light
// pixels and the drawn outline severs each bubble interior from the page margin,
// which is the component touching the image edge.
//
// Crude, but if it lands near the learned detectors it wins on every other axis
// -- nothing to download and no ONNX runtime in the extension at all.
//
// What it cannot do, so the numbers are read correctly: on-art SFX (no bubble to
// find), bubbles that bleed off the panel edge, bubbles over dark screentone.

import { toGray } from "../lib/image.mjs";
import { connectedComponents } from "../lib/components.mjs";

const WHITE_LEVEL = 235;      // same threshold as panels.py's white test
const INK_LEVEL = 128;        // below this is glyph ink rather than paper
const MIN_AREA_FRACTION = 0.0004;
const MAX_AREA_FRACTION = 0.25;
const MIN_FILL_RATIO = 0.55;  // blob area / bbox area -- bubbles are convex-ish
const MIN_INK_FRACTION = 0.01; // an empty bubble is not a text region
const TEXT_PADDING = 2;

export default {
  name: "classical",
  licence: "none",
  source: "built in — no model, no download",

  async init() {},

  /** @param {{width:number,height:number,data:Uint8ClampedArray}} raster */
  async detect(raster) {
    const { width, height } = raster;
    const gray = toGray(raster);

    const light = new Uint8Array(width * height);
    for (let i = 0; i < light.length; i++) light[i] = gray[i] >= WHITE_LEVEL ? 1 : 0;

    const { labels, boxes } = connectedComponents(light, width, height);
    const pageArea = width * height;
    const out = [];

    for (let i = 0; i < boxes.length; i++) {
      const blob = boxes[i];
      if (blob.touchesEdge) continue;   // the page margin, and anything bleeding off it

      const areaFraction = blob.area / pageArea;
      if (areaFraction < MIN_AREA_FRACTION || areaFraction > MAX_AREA_FRACTION) continue;

      const bw = blob.x1 - blob.x0;
      const bh = blob.y1 - blob.y0;
      if (blob.area / (bw * bh) < MIN_FILL_RATIO) continue;

      // The component is the bubble interior; report the extent of the ink
      // inside it, which is what the baseline reports and the overlay expects.
      const id = i + 1;
      let tx0 = blob.x1, ty0 = blob.y1, tx1 = blob.x0, ty1 = blob.y0, ink = 0;

      // Ink pixels are holes in the light component, so they carry label 0 --
      // but so does the bubble's own outline, and counting that gives a box the
      // size of the bubble. Scanning strictly between the component's first and
      // last pixel on each row excludes it, the outline being what terminates
      // the span.
      for (let y = blob.y0; y < blob.y1; y++) {
        const row = y * width;

        let first = -1, last = -1;
        for (let x = blob.x0; x < blob.x1; x++) {
          if (labels[row + x] !== id) continue;
          if (first === -1) first = x;
          last = x;
        }
        if (first === -1) continue;

        for (let x = first + 1; x < last; x++) {
          const p = row + x;
          if (gray[p] >= INK_LEVEL) continue;
          ink++;
          if (x < tx0) tx0 = x;
          if (y < ty0) ty0 = y;
          if (x >= tx1) tx1 = x + 1;
          if (y >= ty1) ty1 = y + 1;
        }
      }

      if (ink / blob.area < MIN_INK_FRACTION) continue;
      if (tx1 <= tx0 || ty1 <= ty0) continue;

      out.push({
        x0: Math.max(0, tx0 - TEXT_PADDING),
        y0: Math.max(0, ty0 - TEXT_PADDING),
        x1: Math.min(width, tx1 + TEXT_PADDING),
        y1: Math.min(height, ty1 + TEXT_PADDING),
        score: Math.min(1, ink / blob.area * 10)
      });
    }

    return out;
  }
};
