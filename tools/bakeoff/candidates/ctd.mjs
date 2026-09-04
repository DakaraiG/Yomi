// Candidate: comic-text-detector. GPL-3.0.
//
// On the roster for the head the others do not have: a per-pixel text mask,
// which is what erasing the Japanese needs rather than covering it. See
// fetch-models.mjs for why a GPL model is here at all.
//
// The letterboxing and the decode live in extension/lib/ctd-postprocess.js, so
// this measures the code that ships.
//
// Scoring it against fixtures/baseline.json is partly circular -- the baseline is
// this model's own output -- so a number near 100% says the port is faithful,
// not that the model is good. The grouping columns are the real comparison.

import {
  CTD_SIZE, letterbox, decodeBlocks, cropChannel, fuse
} from "../../../extension/lib/ctd-postprocess.js";
import { toTensor } from "../../../extension/lib/imageops.js";
import { probabilityMapToBoxes } from "../lib/db-postprocess.mjs";
import { modelPath } from "../fetch-models.mjs";

/**
 * @param {"blk"|"det"|"union"|"fused"} head  which output becomes boxes.
 *   blk    the YOLO head, BLOCK-level boxes -- the baseline's own granularity
 *   det    the DBNet-ish line head, LINE-level like every other candidate
 *   union  both, concatenated. Recovers the baseline exactly, and hands
 *          groupIntoBlocks a region box stacked on the lines inside it.
 *   fused  det lines plus only the blk boxes no line landed in. Same recall,
 *          line-shaped geometry. This is what lib/detect.js ships.
 */
export function ctdCandidate({
  head = "fused",
  confThreshold = 0.4,
  nmsThreshold = 0.35,
  detChannel = 0,
  binaryThreshold = 0.3,
  boxThreshold = 0.5,
  unclipRatio = 1.8,
  label
} = {}) {
  let session = null;
  let ort = null;

  return {
    name: label ?? `ctd-${head}`,
    licence: "GPL-3.0",
    source: "dmMaze/comic-text-detector",

    async init() {
      ort = (await import("onnxruntime-node")).default;
      session = await ort.InferenceSession.create(modelPath("ctd"));
    },

    async detect(raster) {
      const { width, height } = raster;
      const { raster: lb, r, nw, nh } = letterbox(raster);

      const tensor = new ort.Tensor(
        "float32", toTensor(lb), [1, 3, CTD_SIZE, CTD_SIZE]);
      const result = await session.run({ [session.inputNames[0]]: tensor });
      const [blkName, , detName] = session.outputNames;

      let lines = [];
      if (head !== "blk") {
        const cropped = cropChannel(result[detName].data,
          { size: CTD_SIZE, nw, nh, channel: detChannel });
        lines = probabilityMapToBoxes(cropped, {
          width: nw, height: nh,
          binaryThreshold, boxThreshold, unclipRatio,
          scaleX: width / nw, scaleY: height / nh,
          imageWidth: width, imageHeight: height
        });
        if (head === "det") return lines;
      }

      const blk = result[blkName];
      const blocks = decodeBlocks(blk.data, {
        stride: blk.dims[2], count: blk.dims[1],
        r, width, height, confThreshold, nmsThreshold
      });

      if (head === "blk") return blocks;
      if (head === "union") return [...blocks, ...lines];
      return fuse(lines, blocks);
    }
  };
}

export default ctdCandidate();
