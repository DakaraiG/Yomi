// Candidate: CRAFT — Character Region Awareness for Text Detection. MIT.
//
// Model signature, confirmed against the file:
//   in   input    NCHW float32, spatial dims dynamic
//   out  output   N, H/2, W/2, 2  -- NHWC, channel 0 = region score,
//                                   channel 1 = affinity score
//   out  relu_18  intermediate features, unused
//
// Note the output is HALF resolution and channels-LAST, which is the opposite
// layout to the input. Both are easy to get wrong and both fail quietly, as
// boxes that are half-size or transposed rather than as an error.
//
// Why CRAFT is in the bake-off despite being the heavier model: it scores
// CHARACTERS and then their affinity to neighbours, instead of assuming text
// runs in horizontal lines. Japanese manga is mostly vertical, and a line-based
// detector has to be talked out of merging adjacent columns. CRAFT's affinity
// map is in principle the right tool. Whether that survives screentone and
// stylised lettering is what the bake-off measures.

import { resizeRGBA, toTensor, padTo } from "../lib/image.mjs";
import { connectedComponents } from "../lib/components.mjs";
import { modelPath } from "../fetch-models.mjs";

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export function craftCandidate({
  maxSide = 1536,
  textThreshold = 0.7,   // a component needs one pixel this confident to count
  lowText = 0.4,         // ...but grows out to pixels only this confident
  linkThreshold = 0.4,   // affinity above this glues neighbouring characters
  minArea = 10,
  padding = 2,
  label
} = {}) {
  let session = null;
  let ort = null;

  return {
    name: label ?? `craft@${maxSide}`,
    licence: "MIT",
    source: "clovaai/CRAFT-pytorch",

    async init() {
      ort = (await import("onnxruntime-node")).default;
      session = await ort.InferenceSession.create(modelPath("craft"));
    },

    async detect(raster) {
      const { width, height } = raster;

      const ratio = Math.min(1, maxSide / Math.max(width, height));
      const inW = padTo(Math.round(width * ratio), 32);
      const inH = padTo(Math.round(height * ratio), 32);

      const resized = resizeRGBA(raster, inW, inH);
      const tensor = new ort.Tensor(
        "float32", toTensor(resized, { mean: MEAN, std: STD }), [1, 3, inH, inW]);

      const result = await session.run({ [session.inputNames[0]]: tensor });
      const out = result.output ?? result[session.outputNames[0]];
      const [, mapH, mapW] = out.dims;   // N, H/2, W/2, 2
      const data = out.data;

      // Grow from confident text pixels, but let the affinity map bridge the
      // gaps between characters -- that union is what makes a column of kana
      // one region instead of eight.
      const mask = new Uint8Array(mapW * mapH);
      const region = new Float32Array(mapW * mapH);
      for (let p = 0; p < mask.length; p++) {
        const r = data[p * 2];
        const a = data[p * 2 + 1];
        region[p] = r;
        mask[p] = r >= lowText || a >= linkThreshold ? 1 : 0;
      }

      const { labels, boxes } = connectedComponents(mask, mapW, mapH, { eightWay: true });

      // Peak region score per component, in one pass over the labels rather
      // than one pass per box.
      const peak = new Float32Array(boxes.length);
      for (let p = 0; p < labels.length; p++) {
        const id = labels[p];
        if (id && region[p] > peak[id - 1]) peak[id - 1] = region[p];
      }

      const scaleX = (width / inW) * 2;   // *2 undoes the half-resolution output
      const scaleY = (height / inH) * 2;
      const out2 = [];

      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.area < minArea) continue;
        if (peak[i] < textThreshold) continue;

        out2.push({
          x0: Math.max(0, Math.round(b.x0 * scaleX) - padding),
          y0: Math.max(0, Math.round(b.y0 * scaleY) - padding),
          x1: Math.min(width, Math.round(b.x1 * scaleX) + padding),
          y1: Math.min(height, Math.round(b.y1 * scaleY) + padding),
          score: peak[i]
        });
      }

      return out2;
    }
  };
}

export default craftCandidate();
