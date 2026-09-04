// Capture the comic-text-detector baseline.
//
// The committed artefact is fixtures/baseline.json, not this script: it holds
// the boxes every recall number is measured against.
//
// Regenerating it requires the v0.3 Python sidecar, which is no longer in this
// tree:
//   git checkout v0.3-server-architecture
//   terminal 1:  cd sidecar && ./run.sh
//   terminal 2:  cd tools/bakeoff && node baseline.mjs
//
// Writes pixel-space boxes per page, plus a numbered render per page so the
// yardstick itself can be confirmed straight before anything is measured
// against it.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRaster } from "./lib/image.mjs";
import { drawNumberedBoxes } from "./lib/render.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");
const OUT_DIR = join(FIXTURES, "out");

const dirArg = process.argv.indexOf("--dir");
const PAGES_DIR = dirArg === -1 ? join(FIXTURES, "pages") : process.argv[dirArg + 1];
const SIDECAR = process.env.YOMI_SIDECAR ?? "http://127.0.0.1:8001";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

async function detect(imageB64) {
  const response = await fetch(`${SIDECAR}/detect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ imageB64 })
  });
  if (!response.ok) {
    throw new Error(`sidecar ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

async function main() {
  let health;
  try {
    health = await (await fetch(`${SIDECAR}/health`)).json();
  } catch {
    console.error(
      `cannot reach the sidecar at ${SIDECAR}\n` +
      "  Start it first: cd sidecar && ./run.sh");
    process.exit(1);
  }

  // A stub run would write a baseline of fixed boxes and every candidate would
  // then be measured against nothing. Worth one check.
  if (health.detector !== "comic-text-detector" || health.ocr === "stub") {
    console.error(
      `sidecar is running with detector='${health.detector}' ocr='${health.ocr}'.\n` +
      "  The baseline is only meaningful from the real detector. Use ./run.sh,\n" +
      "  which sets YOMI_CTD_PATH and YOMI_CTD_MODEL for you.");
    process.exit(1);
  }

  const pages = (await readdir(PAGES_DIR))
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    .sort();

  if (!pages.length) {
    console.error(`no fixture pages in ${PAGES_DIR}`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const baseline = {};

  for (const page of pages) {
    const path = join(PAGES_DIR, page);
    const b64 = (await readFile(path)).toString("base64");

    const t0 = performance.now();
    const detected = await detect(b64);
    const ms = Math.round(performance.now() - t0);

    const { naturalWidth: w, naturalHeight: h } = detected;

    // The sidecar speaks normalised 0-1 polygons; the harness works in pixels
    // throughout. Convert once, here, at the boundary.
    const boxes = detected.regions.map((r) => {
      const xs = r.polygon.map((p) => p[0] * w);
      const ys = r.polygon.map((p) => p[1] * h);
      return {
        id: r.id,
        order: r.order,
        x0: Math.min(...xs), y0: Math.min(...ys),
        x1: Math.max(...xs), y1: Math.max(...ys),
        vertical: r.vertical,
        japanese: r.japanese     // kept: it is the only OCR ground truth we will ever have
      };
    });

    baseline[page] = { width: w, height: h, boxes };

    const raster = await loadRaster(path);
    const stem = basename(page, extname(page));
    await writeFile(
      join(OUT_DIR, `${stem}.baseline.png`),
      drawNumberedBoxes(raster.canvas, boxes).toBuffer("image/png"));

    console.log(`  ${page.padEnd(22)} ${String(boxes.length).padStart(3)} regions  ${String(ms).padStart(6)}ms`);
  }

  const target = join(FIXTURES, "baseline.json");
  await writeFile(target, JSON.stringify({
    detector: health.detector,
    ocr: health.ocr,
    device: health.device,
    capturedAt: new Date().toISOString(),
    note: "comic-text-detector (GPL-3.0) reference boxes, captured before the " +
          "v0.4 rewrite removed the sidecar. Boxes are pixel-space, order is " +
          "the sidecar's panel-major reading order.",
    pages: baseline
  }, null, 2));

  console.log(`\nbaseline -> ${target}`);
  console.log(`renders  -> ${OUT_DIR}/*.baseline.png`);
}

await main();
