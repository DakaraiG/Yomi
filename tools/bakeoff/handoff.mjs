// Build the Phase 3 handoff image for a page: detect, group, order, number.
//
// This is the exact pipeline the extension will run, minus the API call, so the
// PNG it writes is the image the model will actually be shown. That matters --
// the whole question in Phase 3 is whether the model can read these labels
// without the boxes hiding the Japanese it has to transcribe, and the only way
// to judge it is to look at the real thing.
//
//   node handoff.mjs                    every fixture page
//   node handoff.mjs --page ynko.jpg
//   node handoff.mjs --scale 0.6        emulate a downscaled upload

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

import { loadRaster } from "./lib/image.mjs";
import { drawNumberedBoxes, HANDOFF } from "./lib/render.mjs";
import { paddleCandidate } from "./candidates/paddle-db.mjs";
import { groupIntoBlocks } from "../../extension/lib/group.js";
import { panelReadingOrder } from "../../extension/lib/ordering.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");
const PAGES_DIR = join(FIXTURES, "pages");
const OUT_DIR = join(FIXTURES, "out");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

/**
 * Detect -> group -> order. The regions the model will be asked about.
 *
 * Ordering before numbering is not cosmetic: the label IS the id the model
 * answers with, and the overlay looks them up by that id. Number in detection
 * order and every translation lands in the wrong bubble.
 */
export async function buildRegions(raster, detector) {
  const lines = await detector.detect(raster);
  const blocks = groupIntoBlocks(raster, lines);
  const order = panelReadingOrder(raster, blocks.map((b) => [b.x0, b.y0, b.x1, b.y1]));
  return order.map((i) => blocks[i]);
}

async function main() {
  const detector = paddleCandidate({ maxSide: 1536 });
  await detector.init();

  const scale = Number(arg("scale", "1"));
  const only = arg("page");
  let pages = (await readdir(PAGES_DIR)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
  if (only) pages = pages.filter((p) => p === only || basename(p, extname(p)) === only);

  await mkdir(OUT_DIR, { recursive: true });

  for (const page of pages) {
    const raster = await loadRaster(join(PAGES_DIR, page));
    const regions = await buildRegions(raster, detector);

    let source = raster.canvas;
    let boxes = regions;

    if (scale !== 1) {
      // Downscaling before upload is the lever on cost -- image tokens dominate
      // and scale with resolution. Detection still runs at full size; only what
      // the model SEES shrinks, which is also the thing that decides whether
      // the labels are still legible.
      const w = Math.round(raster.width * scale);
      const h = Math.round(raster.height * scale);
      const small = createCanvas(w, h);
      small.getContext("2d").drawImage(raster.canvas, 0, 0, w, h);
      source = small;
      boxes = regions.map((b) => ({
        x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale
      }));
    }

    const canvas = drawNumberedBoxes(source, boxes, HANDOFF);
    const stem = basename(page, extname(page));
    const suffix = scale === 1 ? "" : `.${scale}x`;
    const target = join(OUT_DIR, `${stem}.handoff${suffix}.png`);
    await writeFile(target, canvas.toBuffer("image/png"));

    console.log(`  ${page.padEnd(22)} ${String(regions.length).padStart(3)} regions  ` +
                `${source.width}x${source.height}  -> ${basename(target)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
