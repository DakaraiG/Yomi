// Download the bake-off's candidate models into weights/bakeoff/.
//
// LICENCE IS A HARD GATE, not a footnote. The entire point of the v0.4 rewrite
// is that comic-text-detector's GPL-3.0 forced a three-process architecture. A
// GPL replacement would rebuild the same wall, so every entry below records its
// licence and anything that is not MIT/Apache-2.0/BSD does not get added --
// however good it looks.
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
