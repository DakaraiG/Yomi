// Offscreen document: detection, grouping, ordering, and the numbered render.
//
// Everything from image bytes to "the picture we send the model" lives here
// because it all needs the model session, which takes a second or two to create
// and must survive between pages. The service worker is killed on idle and
// cannot hold it.
//
// Returns the numbered PNG, the erase mask, and the regions' geometry. The
// service worker keeps the network call, because it owns the API key, and the
// inpainting, because what may be erased depends on the answer it gets back.

import { Detector } from "./lib/detect.js";
import { rasterFromBlob } from "./lib/imageops.js";
import { textMask, restrictToBoxes } from "./lib/inpaint.js";
import { groupIntoBlocks } from "./lib/group.js";
import { panelReadingOrder } from "./lib/ordering.js";
import { drawNumberedBoxes, HANDOFF } from "./lib/render.js";
import { base64ToBytes, bytesToBase64 } from "./lib/bytes.js";

const detector = new Detector();
let ready = null;

// Model load is a 26MB WASM binary to compile plus a 91MB model to parse, so
// the bound is generous -- but bounded, because an unbounded wait is
// indistinguishable from a hang.
const LOAD_TIMEOUT_MS = 120_000;
const DETECT_TIMEOUT_MS = 120_000;

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error(
        `${what} exceeded ${ms / 1000}s. If this is the CPU backend, the page is ` +
        `too large for single-threaded WASM; check the offscreen console for ` +
        `which backend loaded.`)), ms))
  ]);
}

/** Load once, and let concurrent callers share the same load. */
function ensureReady() {
  ready ??= withTimeout(
    detector.init().then(() => detector.warmUp()),
    LOAD_TIMEOUT_MS, "model load")
    .catch((err) => {
      ready = null;                     // a failed load must be retryable
      throw err;
    });
  return ready;
}

// Debug hook: without it, every question about the detector is a code change
// and a reload, since this document's DevTools console has no other handle on
// any of this.
globalThis.__yomi = { detector, prepare: (...args) => prepare(...args) };

/**
 * The erase mask: one bit per pixel, 1 where text should be repainted.
 *
 * The plate itself is not built here, though this is the obvious place for it:
 * which regions may be erased depends on `kind`, which comes back from the
 * translation model, so nothing in this document knows it yet.
 *
 * Confined to the regions the overlay will write over -- see restrictToBoxes.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
 * @param {Float32Array} seg  page-resolution text probability
 * @param {Array<{x0:number,y0:number,x1:number,y1:number}>} regions
 * @returns {Promise<string>} base64 PNG, black and white
 */
async function buildTextMask(raster, seg, regions) {
  const { width, height } = raster;
  const mask = restrictToBoxes(textMask(seg, width, height), width, height, regions);

  // Black and white RGBA rather than a packed bitset: PNG's filters flatten a
  // page of solid black with thin white strokes to a few tens of KB, well under
  // what the raw bits cost once base64 has grown them.
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 255 : 0;
    rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
    rgba[i + 3] = 255;
  }

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return bytesToBase64(await blob.arrayBuffer());
}

/**
 * Bytes in, numbered page and erase mask out.
 *
 * The pipeline order is load-bearing: detect gives lines, group gives regions,
 * ordering gives them their numbers, and only then are they drawn. The label is
 * the id the model answers with and the overlay looks regions up by it, so
 * numbering before ordering would put every translation in the wrong bubble.
 *
 * The mask needs only the raster and the regions, and runs last so the numbered
 * render -- what the model is waiting on -- is not held up behind it.
 */
async function prepare({ imageB64, mimeType }) {
  // Stage timings: the CPU backend is two orders of magnitude slower than
  // WebGPU, which without a breakdown is indistinguishable from a hang, a huge
  // image, or a stuck message channel.
  const marks = {};
  const clock = () => performance.now();
  let t = clock();
  const mark = (name) => { marks[name] = Math.round(clock() - t); t = clock(); };

  const loading = !detector.ready;
  await ensureReady();
  if (loading) mark("modelLoad");

  const raster = await rasterFromBlob(
    new Blob([base64ToBytes(imageB64)], { type: mimeType }));
  mark("decode");

  const { lines, seg } = await withTimeout(
    detector.detect(raster), DETECT_TIMEOUT_MS,
    `detection on a ${raster.width}x${raster.height} page`);
  mark("detect");

  const blocks = groupIntoBlocks(raster, lines);
  mark("group");

  const order = panelReadingOrder(raster, blocks.map((b) => [b.x0, b.y0, b.x1, b.y1]));
  const regions = order.map((i) => blocks[i]);
  mark("order");

  const canvas = drawNumberedBoxes({
    canvas: new OffscreenCanvas(raster.width, raster.height),
    image: raster.canvas,
    boxes: regions,
    style: HANDOFF
  });

  const png = await canvas.convertToBlob({ type: "image/png" });
  const numbered = bytesToBase64(await png.arrayBuffer());
  mark("render");

  const mask = await buildTextMask(raster, seg, regions);
  mark("mask");

  return {
    numbered,
    mask,
    backend: detector.backend,
    // Propagated rather than only logged: this document's console is reachable
    // only through chrome://extensions, so a warning left here is unread.
    backendWarning: detector.initWarning ?? null,
    marks,
    naturalWidth: raster.width,
    naturalHeight: raster.height,
    lineCount: lines.length,
    // Normalised 0-1 for the overlay, which is the only coordinate system
    // anything outside detection is allowed to see.
    regions: regions.map((b, i) => ({
      id: String(i),
      order: i,
      polygon: [
        [b.x0 / raster.width, b.y0 / raster.height],
        [b.x1 / raster.width, b.y0 / raster.height],
        [b.x1 / raster.width, b.y1 / raster.height],
        [b.x0 / raster.width, b.y1 / raster.height]
      ],
      vertical: (b.y1 - b.y0) > (b.x1 - b.x0),
      // Whether a bubble was actually drawn around this text, which is how
      // lib/layout.js knows how much room the box has to grow into.
      inBubble: b.inBubble === true
    }))
  };
}

/**
 * One detection at a time: concurrent run() calls on a single ORT session are
 * not safe, and the content script translates several pages at once. Costs
 * nothing, since detection is ~230ms against a ~15s model call.
 */
let queue = Promise.resolve();
function serialise(task) {
  const run = queue.then(task, task);
  queue = run.then(() => {}, () => {});   // never let a rejection break the chain
  return run;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "yomi-offscreen") return;

  const started = performance.now();
  serialise(() => prepare(msg))
    .then((result) => sendResponse({
      ok: true, ...result, prepareMs: Math.round(performance.now() - started)
    }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

  return true;   // keeps the channel open for the async reply
});
