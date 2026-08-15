// Candidate: PaddleOCR text detection (DB head). Apache-2.0.
//
// Model signature, confirmed against the file rather than assumed:
//   in   x                NCHW float32, all spatial dims dynamic
//   out  sigmoid_0.tmp_0  N,1,H,W float32 -- already through a sigmoid, so the
//                         output is a probability map, not logits
//
// THE PARAMETER THAT MATTERS IS maxSide. PaddleOCR's own default caps the long
// edge at 960px, which is tuned for photographs of signs and receipts. A manga
// page is 2000-3000px of small vertical text; downscaling it to 960 shrinks a
// glyph below the resolution the model can resolve at all. Expect the 960 run
// to look like a failure of the model when it is a failure of the setting --
// which is exactly why run.mjs sweeps it.

import { resizeRGBA, toTensor, padTo } from "../lib/image.mjs";
import { probabilityMapToBoxes } from "../lib/db-postprocess.mjs";
import { modelPath } from "../fetch-models.mjs";

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export function paddleCandidate({
  key = "paddle-v4",
  maxSide = 1536,
  binaryThreshold = 0.3,
  boxThreshold = 0.5,
  unclipRatio = 1.8,
  label
} = {}) {
  let session = null;
  let ort = null;

  return {
    name: label ?? `${key}@${maxSide}`,
    licence: "Apache-2.0",
    source: "PaddleOCR DB detection head",

    async init() {
      ort = (await import("onnxruntime-node")).default;
      session = await ort.InferenceSession.create(modelPath(key));
    },

    async detect(raster) {
      const { width, height } = raster;

      // Long edge to maxSide, then both edges up to a multiple of 32 -- the
      // model's downsampling stack requires it, and a non-conforming shape
      // fails deep inside the graph with a shape-mismatch that names an
      // internal node rather than the input.
      const ratio = Math.min(1, maxSide / Math.max(width, height));
      const inW = padTo(Math.round(width * ratio), 32);
      const inH = padTo(Math.round(height * ratio), 32);

      const resized = resizeRGBA(raster, inW, inH);
      const tensor = new ort.Tensor(
        "float32", toTensor(resized, { mean: MEAN, std: STD }), [1, 3, inH, inW]);

      const result = await session.run({ [session.inputNames[0]]: tensor });
      const prob = result[session.outputNames[0]].data;

      return probabilityMapToBoxes(prob, {
        width: inW,
        height: inH,
        binaryThreshold,
        boxThreshold,
        unclipRatio,
        // Boxes come back in the resized frame; the caller works in original
        // pixels throughout, so undo the resize here and nowhere else.
        scaleX: width / inW,
        scaleY: height / inH,
        imageWidth: width,
        imageHeight: height
      });
    }
  };
}

export default paddleCandidate();
