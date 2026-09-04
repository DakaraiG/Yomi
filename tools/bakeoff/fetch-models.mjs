// Download the bake-off's candidate models into weights/bakeoff/.
//
// Every entry records its licence, and the roster is MIT/Apache-2.0/BSD with one
// deliberate exception: `ctd`, which is GPL-3.0. The extension ships weights
// fetched at install time and never links GPL code, and no permissive model
// produces the per-pixel glyph mask that erasing the Japanese needs. The
// obligation is still real -- see README.md.
//
// A one-off, not a policy change. Any other non-permissive candidate needs the
// same argument made again.
//
//   node fetch-models.mjs            download everything missing
//   node fetch-models.mjs paddle-v4  download one

import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEIGHTS_DIR = join(HERE, "..", "..", "weights", "bakeoff");

export const MODELS = {
  "paddle-v4": {
    file: "ch_PP-OCRv4_det_infer.onnx",
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx",
    licence: "Apache-2.0",
    upstream: "PaddlePaddle/PaddleOCR, ONNX conversion published by RapidAI/RapidOCR",
    note: "The mobile variant the brief names. ~4.7MB, the shippable one."
  },
  "paddle-v4-server": {
    file: "ch_PP-OCRv4_det_server_infer.onnx",
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_server_infer.onnx",
    licence: "Apache-2.0",
    upstream: "PaddlePaddle/PaddleOCR, ONNX conversion published by RapidAI/RapidOCR",
    note: "Too big to ship. Included as an upper bound: if the server model " +
          "also misses a bubble, the mobile model's miss is the architecture, " +
          "not the capacity."
  },
  ctd: {
    file: "comictextdetector.pt.onnx",
    url: "https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.3/comictextdetector.pt.onnx",
    licence: "GPL-3.0",
    upstream: "dmMaze/comic-text-detector, ONNX export published in the beta-0.3 release of zyddnys/manga-image-translator",
    note: "91MB, and the only candidate with a per-pixel text mask -- a UNet " +
          "segmentation head alongside the detection heads. It is also what " +
          "produced fixtures/baseline.json, so scoring it against that " +
          "baseline tests THIS PORT, not the model: a low number means the " +
          "letterbox or the YOLO decode below is wrong."
  },

  craft: {
    file: "craft.onnx",
    url: "https://huggingface.co/KvaytG/craft-mlt-25k-onnx/resolve/main/craft.onnx",
    licence: "MIT",
    upstream: "clovaai/CRAFT-pytorch (MIT), community ONNX conversion",
    note: "Character-level detector. In principle the better fit for vertical " +
          "Japanese, since it links characters into regions rather than " +
          "assuming horizontal lines."
  }
};

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function download(key) {
  const model = MODELS[key];
  const target = join(WEIGHTS_DIR, model.file);

  if (await exists(target)) {
    console.log(`  ${key}: already present`);
    return target;
  }

  console.log(`  ${key}: downloading ${model.file} (${model.licence})`);
  const response = await fetch(model.url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `${key}: ${response.status} from ${model.url}\n` +
      "  Hosted models move. Check the URL in fetch-models.mjs before assuming " +
      "the harness is broken."
    );
  }
  await pipeline(response.body, createWriteStream(target));
  const { size } = await stat(target);
  console.log(`  ${key}: ${(size / 1e6).toFixed(1)}MB -> ${target}`);
  return target;
}

export function modelPath(key) {
  return join(WEIGHTS_DIR, MODELS[key].file);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await mkdir(WEIGHTS_DIR, { recursive: true });
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODELS);

  for (const key of wanted) {
    if (!MODELS[key]) {
      console.error(`unknown model '${key}'. Known: ${Object.keys(MODELS).join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    try {
      await download(key);
    } catch (err) {
      console.error(`  ${err.message}`);
      process.exitCode = 1;
    }
  }
}
