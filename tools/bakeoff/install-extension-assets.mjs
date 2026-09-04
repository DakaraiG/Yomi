// Put the extension's runtime binaries in place.
//
//   node install-extension-assets.mjs
//
// ~18MB of ONNX Runtime and one 91MB detection model, both reproducible -- the
// runtime from npm, the model from the pinned URL in fetch-models.mjs -- so they
// are fetched rather than committed. The model being GPL-3.0 is a second reason
// not to commit it.
//
// The extension does not start without them: the offscreen document fails on its
// first import with a module-not-found.

import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { MODELS, WEIGHTS_DIR, modelPath } from "./fetch-models.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION = join(HERE, "..", "..", "extension");
const ORT_DIST = join(HERE, "node_modules", "onnxruntime-web", "dist");

// The general bundle: WASM and WebGPU from one binary. "threaded" in the
// companion filenames is the build's name, not a request for threads --
// multi-threaded WASM needs SharedArrayBuffer, which needs cross-origin
// isolation, which an offscreen document does not have.
//
// All three files are required, which the naming hides: "bundle" does not mean
// the WASM glue is inlined, and the entry still dynamically imports its .mjs
// companion at load time. Shipping only the .wasm fails as "no available backend
// found ... Failed to fetch dynamically imported module", which reads like a
// WASM or CSP problem rather than a missing 24KB file.
//
// Must match the import in extension/lib/detect.js.
const ORT_ENTRY = "ort.bundle.min.mjs";

/**
 * Which companion files this entry point needs, read from it rather than
 * hardcoded, so changing ORT_ENTRY cannot desynchronise from what it loads.
 *
 * ORT ships four interchangeable WASM variants (plain, jsep, asyncify, jspi) and
 * each entry point imports exactly one pair, with no relationship to its own
 * name. The wrong pair fails at runtime as "no available backend found", naming
 * neither the file nor the variant.
 */
async function companionsOf(entry) {
  const source = await readFile(join(ORT_DIST, entry), "utf8");
  const found = source.match(/ort-wasm-simd-threaded[a-z.]*\.(?:mjs|wasm)/g) ?? [];
  return [...new Set(found)];
}

// comic-text-detector: GPL-3.0, 91MB, and the only candidate returning the
// per-pixel text mask lib/inpaint.js needs to erase the Japanese rather than
// cover it.
const MODEL = "ctd";

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

  // Clear variants left by a previous entry point, so a switch does not leave
  // 25MB of the old one behind looking authoritative.
  for (const stale of await readdir(join(EXTENSION, "vendor", "ort"))) {
    if (/^ort/.test(stale)) await rm(join(EXTENSION, "vendor", "ort", stale));
  }

  // Same for models: the extension loads exactly one by name, so a leftover from
  // a previous detector is dead weight that looks like it is in use.
  for (const stale of await readdir(join(EXTENSION, "models"))) {
    if (stale !== MODELS[MODEL].file && /\.onnx$/.test(stale)) {
      await rm(join(EXTENSION, "models", stale));
      console.log(`  model  removed stale ${stale}`);
    }
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
