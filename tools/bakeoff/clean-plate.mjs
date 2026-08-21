// Build a clean plate from a page and look at it.
//
//   node clean-plate.mjs                 every fixture page
//   node clean-plate.mjs ynko.jpg
//
// Writes, per page, into fixtures/out/:
//   <page>.plate.png     the page with the Japanese erased
//   <page>.mask.png      the erase mask, white on black
//
// LOOK AT THE OUTPUT. Four metrics on this task have scored a visibly broken
// result as a large improvement -- near-white fraction, ink-vs-row-median,
// local contrast ratio, texture ratio -- because each derives its reference
// from the result, so a confidently wrong UNIFORM output scores as clean. This
// tool therefore prints coverage numbers and draws pictures, and does not
// pretend to grade anything.
//
// It runs the SHIPPING code: extension/lib/inpaint.js and ctd-postprocess.js.

import { createCanvas } from "@napi-rs/canvas";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRaster } from "./lib/image.mjs";
import { modelPath } from "./fetch-models.mjs";
import {
  CTD_SIZE, letterbox, cropChannel, resizeMap
} from "../../extension/lib/ctd-postprocess.js";
import { toTensor } from "../../extension/lib/imageops.js";
import {
  textMask, diffusionInpaint, maskCoverage
} from "../../extension/lib/inpaint.js";
import { groupIntoBlocks } from "../../extension/lib/group.js";
import { probabilityMapToBoxes } from "./lib/db-postprocess.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");
const OUT_DIR = join(FIXTURES, "out");
const PAGES_DIR = join(FIXTURES, "pages");

function rasterToPng(raster) {
  const canvas = createCanvas(raster.width, raster.height);
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(raster.width, raster.height);
  img.data.set(raster.data);
  ctx.putImageData(img, 0, 0);
  return canvas.toBuffer("image/png");
}

function maskToPng(mask, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  return rasterToPng({ width, height, data });
}

async function main() {
  const ort = (await import("onnxruntime-node")).default;
  const session = await ort.InferenceSession.create(modelPath("ctd"));
  const [blkName, segName, detName] = session.outputNames;
  void blkName;

  await mkdir(OUT_DIR, { recursive: true });
  const wanted = process.argv.slice(2);
  const pages = (await readdir(PAGES_DIR))
    .filter((f) => [".jpg", ".jpeg", ".png", ".webp"].includes(extname(f).toLowerCase()))
    .filter((f) => !wanted.length || wanted.includes(f) || wanted.includes(basename(f, extname(f))))
    .sort();

  for (const page of pages) {
    const raster = await loadRaster(join(PAGES_DIR, page));
    const { width, height } = raster;
    const { raster: lb, nw, nh } = letterbox(raster);

    const tensor = new ort.Tensor("float32", toTensor(lb), [1, 3, CTD_SIZE, CTD_SIZE]);
    const result = await session.run({ [session.inputNames[0]]: tensor });

    const seg = resizeMap(
      cropChannel(result[segName].data, { size: CTD_SIZE, nw, nh }), nw, nh, width, height);

    const t0 = performance.now();
    const mask = textMask(seg, width, height);
    const maskMs = Math.round(performance.now() - t0);

    let on = 0;
    for (let i = 0; i < mask.length; i++) on += mask[i];

    const t1 = performance.now();
    const plate = diffusionInpaint(raster, mask);
    const inpaintMs = Math.round(performance.now() - t1);

    // Per-region coverage, which is the number the ".outlined fallback for
    // regions the mask swallows" decision hangs on.
    const lineMap = cropChannel(result[detName].data, { size: CTD_SIZE, nw, nh, channel: 0 });
    const lines = probabilityMapToBoxes(lineMap, {
      width: nw, height: nh, scaleX: width / nw, scaleY: height / nh,
      imageWidth: width, imageHeight: height
    });
    const blocks = groupIntoBlocks(raster, lines);
    const coverage = blocks
      .map((b) => ({ cov: maskCoverage(mask, width, b), b }))
      .sort((a, z) => z.cov - a.cov);

    const stem = basename(page, extname(page));
    await writeFile(join(OUT_DIR, `${stem}.plate.png`), rasterToPng(plate));
    await writeFile(join(OUT_DIR, `${stem}.mask.png`), maskToPng(mask, width, height));

    console.log(
      `${page.padEnd(12)} ${width}x${height}  mask ${(on / mask.length * 100).toFixed(1)}% ` +
      `(${maskMs}ms)  inpaint ${inpaintMs}ms  ${blocks.length} regions`);
    console.log(
      `  region mask coverage, highest first: ` +
      coverage.slice(0, 6).map((c) => c.cov.toFixed(2)).join(" ") +
      `  ... median ${coverage[Math.floor(coverage.length / 2)].cov.toFixed(2)}`);
  }
  console.log(`\nplates + masks in ${OUT_DIR}\nNOW LOOK AT THEM.`);
}

await main();
