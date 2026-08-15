// Put the extension's runtime binaries in place.
//
//   node install-extension-assets.mjs
//
// ~18MB of ONNX Runtime and one detection model. Both are reproducible -- the
// runtime from npm, the model from the pinned URL in fetch-models.mjs -- so
// they are fetched rather than committed, the same way the v0.3 detector
// weights always were.
//
// The extension does not start without them: the offscreen document fails on
// its first import with a module-not-found for ort.wasm.bundle.min.mjs.

import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, WEIGHTS_DIR, modelPath } from "./fetch-models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "..", "extension");
const ORT_DIST = join(HERE, "node_modules", "onnxruntime-web", "dist");

// The single-threaded SIMD build. Multi-threaded WASM needs SharedArrayBuffer,
// which needs cross-origin isolation, which an offscreen document does not have
// -- the "threaded" in the filename is the build's name, not a request for
// threads; numThreads is pinned to 1 in lib/detect.js.
//
// ALL THREE FILES ARE REQUIRED, which the naming actively hides. "bundle" does
// not mean the WASM glue is inlined: ort.wasm.bundle.min.mjs still dynamically
// imports ort-wasm-simd-threaded.mjs at load time, and shipping only the .wasm
// fails as "no available backend found. ERR: [wasm] TypeError: Failed to fetch
// dynamically imported module" -- which reads like a WASM or CSP problem rather
// than a missing 24KB file.
//
// The general bundle: WASM and WebGPU from one binary. WebGPU matters because
// the CPU path is single-threaded, and single-threaded inference on a 1536px
// page takes tens of seconds.
//
// MUST MATCH the import in extension/lib/detect.js.
const ORT_ENTRY = "ort.bundle.min.mjs";

/**
 * Which companion files this entry point needs -- READ FROM IT, not hardcoded.
 *
 * Hardcoding cost two rounds of the same bug. ORT ships four interchangeable
 * WASM variants (plain, jsep, asyncify, jspi) and each entry point dynamically
 * imports exactly one pair, with no relationship to its own name:
 * ort.bundle.min.mjs wants jsep, ort.webgpu.bundle.min.mjs wants asyncify.
 * Ship the wrong pair and it fails at runtime as "no available backend found",
 * naming neither the file nor the variant.
 *
 * Deriving them means changing ORT_ENTRY can never desynchronise from the files
 * that entry point actually loads.
 */
async function companionsOf(entry) {
  const source = await readFile(join(ORT_DIST, entry), "utf8");
  const found = source.match(/ort-wasm-simd-threaded[a-z.]*\.(?:mjs|wasm)/g) ?? [];
  return [...new Set(found)];
}

// The Phase 1 winner: PaddleOCR DB mobile, Apache-2.0, 4.7MB, 92.3% recall.
const MODEL = "paddle-v4";

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function main() {
  await mkdir(join(EXTENSION, "vendor", "ort"), { recursive: true });
  await mkdir(join(EXTENSION, "models"), { recursive: true });

  if (!await exists(ORT_DIST)) {
    console.error(
      "onnxruntime-web is not installed.\n" +
      "  npm install onnxruntime-web   (from tools/bakeoff)");
    process.exit(1);
  }

  // Clear out variants left by a previous entry point, so a switch does not
  // leave 25MB of the old one behind looking authoritative.
  for (const stale of await readdir(join(EXTENSION, "vendor", "ort"))) {
    if (/^ort/.test(stale)) await rm(join(EXTENSION, "vendor", "ort", stale));
  }

  const ortFiles = [ORT_ENTRY, ...await companionsOf(ORT_ENTRY)];
  for (const file of ortFiles) {
    const from = join(ORT_DIST, file);
    if (!await exists(from)) {
      console.error(`missing ${file} in ${ORT_DIST} — has onnxruntime-web changed its dist layout?`);
      process.exit(1);
    }
    const to = join(EXTENSION, "vendor", "ort", file);
    await copyFile(from, to);
    const { size } = await stat(to);
    console.log(`  ort    ${file.padEnd(34)} ${(size / 1e6).toFixed(1)}MB`);
  }

  const model = modelPath(MODEL);
  if (!await exists(model)) {
    console.error(
      `model not downloaded yet: ${model}\n` +
      `  node fetch-models.mjs ${MODEL}`);
    process.exit(1);
  }
  const to = join(EXTENSION, "models", MODELS[MODEL].file);
  await copyFile(model, to);
  const { size } = await stat(to);
  console.log(`  model  ${MODELS[MODEL].file.padEnd(34)} ${(size / 1e6).toFixed(1)}MB  ` +
              `(${MODELS[MODEL].licence})`);

  console.log(`\nextension assets installed under ${EXTENSION}`);
  void WEIGHTS_DIR;
}

await main();
