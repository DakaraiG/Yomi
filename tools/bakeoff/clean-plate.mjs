// Build a clean plate from a page and look at it.
//
//   node clean-plate.mjs                 every fixture page
//   node clean-plate.mjs ynko.jpg
//
// Writes, per page, into fixtures/out/:
//   <page>.plate.png     the page with the Japanese erased
//   <page>.mask.png      the erase mask, white on black
//
// This prints coverage numbers and draws pictures rather than grading anything.
// Every automatic metric tried on this task derives its reference from the
// result, so a confidently wrong uniform output scores as clean -- the output
// has to be looked at.
//
// Runs the shipping code: extension/lib/inpaint.js and ctd-postprocess.js.

import { createCanvas } from "@napi-rs/canvas";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRaster } from "./lib/image.mjs";
import { modelPath } from "./fetch-models.mjs";
import {
  CTD_SIZE, letterbox, cropChannel, resizeMap, decodeBlocks, fuse
} from "../../extension/lib/ctd-postprocess.js";
import { toTensor } from "../../extension/lib/imageops.js";
import {
  textMask, restrictToBoxes, diffusionInpaint, maskCoverage,
  backgroundStructure, STRUCTURE_THRESHOLD, clearBox
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

  await mkdir(OUT_DIR, { recursive: true });
  const wanted = process.argv.slice(2);
  const pages = (await readdir(PAGES_DIR))
    .filter((f) => [".jpg", ".jpeg", ".png", ".webp"].includes(extname(f).toLowerCase()))
    .filter((f) => !wanted.length || wanted.includes(f) || wanted.includes(basename(f, extname(f))))
    .sort();

  for (const page of pages) {
    const raster = await loadRaster(join(PAGES_DIR, page));
    const { width, height } = raster;
    const { raster: lb, r, nw, nh } = letterbox(raster);

    const tensor = new ort.Tensor("float32", toTensor(lb), [1, 3, CTD_SIZE, CTD_SIZE]);
    const result = await session.run({ [session.inputNames[0]]: tensor });

    const seg = resizeMap(
      cropChannel(result[segName].data, { size: CTD_SIZE, nw, nh }), nw, nh, width, height);

    // Regions first: the mask is confined to them.
    const lineMap = cropChannel(result[detName].data, { size: CTD_SIZE, nw, nh, channel: 0 });
    const lines = probabilityMapToBoxes(lineMap, {
      width: nw, height: nh, scaleX: width / nw, scaleY: height / nh,
      imageWidth: width, imageHeight: height
    });
    // Fused, exactly as lib/detect.js returns it. Grouping the det lines alone
    // misses whatever only the YOLO head found, which would draw a plate the
    // extension never produces.
    const blk = result[blkName];
    const blocks = groupIntoBlocks(raster, fuse(lines, decodeBlocks(blk.data, {
      stride: blk.dims[2], count: blk.dims[1], r, width, height
    })));

    const t0 = performance.now();
    const full = textMask(seg, width, height);
    let everything = 0;
    for (let i = 0; i < full.length; i++) everything += full[i];
    const mask = restrictToBoxes(full, width, height, blocks);
    const maskMs = Math.round(performance.now() - t0);

    let on = 0;
    for (let i = 0; i < mask.length; i++) on += mask[i];

    // Structure decides whether erasing a region repairs it or rubs the drawing
    // out. Printed rather than acted on: the threshold is chosen by looking at
    // the number and the picture together.
    const measured = blocks.map((b) => ({
      b,
      cov: maskCoverage(mask, width, b),
      structure: backgroundStructure(raster, mask, b),
      inBubble: b.inBubble === true
    })).sort((a, z) => z.structure - a.structure);

    // Half the exclusion the service worker applies: its length test needs the
    // translation, and there is no model call here. So this spares more than the
    // extension does -- a long narration block on a busy panel is kept here and
    // erased in the product.
    let kept = 0;
    for (const m of measured) {
      if (m.structure < STRUCTURE_THRESHOLD) continue;
      clearBox(mask, width, height, m.b);
      kept++;
    }

    const t1 = performance.now();
    const plate = diffusionInpaint(raster, mask);
    const inpaintMs = Math.round(performance.now() - t1);


    const stem = basename(page, extname(page));
    await writeFile(join(OUT_DIR, `${stem}.plate.png`), rasterToPng(plate));
    await writeFile(join(OUT_DIR, `${stem}.mask.png`), maskToPng(mask, width, height));

    console.log(
      `${page.padEnd(12)} ${width}x${height}  mask ${(on / mask.length * 100).toFixed(1)}% ` +
      `of the page, ${(on / everything * 100).toFixed(0)}% of the text found ` +
      `(${maskMs}ms)  inpaint ${inpaintMs}ms  ${blocks.length} regions, ` +
      `${kept} left alone`);
    for (const m of measured) {
      console.log(
        `    ${m.structure >= STRUCTURE_THRESHOLD ? "KEPT " : "erase"} ` +
        `${m.structure.toFixed(3)} structure  ${m.cov.toFixed(2)} covered  ` +
        `${m.inBubble ? "in bubble    " : "no bubble    "}` +
        `${Math.round(m.b.x0)},${Math.round(m.b.y0)} ` +
        `${Math.round(m.b.x1 - m.b.x0)}x${Math.round(m.b.y1 - m.b.y0)}`);
    }
  }
  console.log(`\nplates + masks in ${OUT_DIR}\nNOW LOOK AT THEM.`);
}

await main();
