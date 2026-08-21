// Offscreen document: detection, grouping, ordering, and the numbered render.
//
// Everything from image bytes to "the picture we send the model" happens here,
// in one place, for one reason: it all needs the model session, and the model
// session is expensive to create (a second or two) and must survive between
// pages. The service worker cannot hold it -- it gets killed on idle -- so the
// worker stays a thin router and this document does the work.
//
// It returns the numbered PNG, the clean plate, and the regions' geometry. The
// service worker owns the network call, because it owns the API key and keys
// should live in as few places as possible.

import { Detector } from "./lib/detect.js";
import { rasterFromBlob } from "./lib/imageops.js";
import { textMask, diffusionInpaint } from "./lib/inpaint.js";
import { groupIntoBlocks } from "./lib/group.js";
import { panelReadingOrder } from "./lib/ordering.js";
import { drawNumberedBoxes, HANDOFF } from "./lib/render.js";
import { base64ToBytes, bytesToBase64 } from "./lib/bytes.js";

const detector = new Detector();
let ready = null;

// Model load is a one-off but not a small one: a 26MB WASM binary to compile
// plus a 91MB model to parse. Generous, but bounded -- an unbounded wait is
// indistinguishable from a hang, and that ambiguity has cost several rounds of
// debugging already.
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

// Debug hook. The offscreen document is otherwise unreachable from a console --
// its DevTools window has no handle on any of this, which made every question
// about the detector a code change and a reload.
globalThis.__yomi = { detector, prepare: (...args) => prepare(...args) };

/**
 * The page with the Japanese erased, plus the mask that erased it.
 *
 * This is what replaced painting a rectangle over each region. A rectangle is
 * only safe inside a drawn bubble, where the interior is flat by construction;
 * anywhere else it punches a hole in the artwork, which is why non-bubble text
 * used to be left visible under a heavy halo instead. A per-pixel mask touches
 * only glyph strokes, so the drawing survives and every region gets a clean
 * background regardless of what it sits on.
 *
 * BOTH are returned. The plate is what the overlay draws; the mask is what the
 * service worker caches, because it is 1-bit and mostly empty where the plate
 * is a full-page PNG, and re-running diffusion on a cache hit costs less than
 * a megabyte of IndexedDB per page. See background.js.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
 * @param {Float32Array} seg  page-resolution text probability
 */
async function buildCleanPlate(raster, seg) {
  const { width, height } = raster;
  const mask = textMask(seg, width, height);
  const clean = diffusionInpaint(raster, mask);

  const toPng = async (data) => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const image = new ImageData(data, width, height);
    ctx.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return bytesToBase64(await blob.arrayBuffer());
  };

  // Black and white RGBA rather than a packed bitset: PNG's filters flatten a
  // page of solid black with thin white strokes to a few tens of KB, where the
  // raw bits are 1 byte per 8 pixels before base64 makes them a third bigger.
  const maskRgba = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 255 : 0;
    maskRgba[i] = maskRgba[i + 1] = maskRgba[i + 2] = v;
    maskRgba[i + 3] = 255;
  }

  const [plate, maskPng] = await Promise.all([toPng(clean.data), toPng(maskRgba)]);
  return { plate, mask: maskPng };
}

/**
 * Bytes in, numbered page and clean plate out.
 *
 * The pipeline order is load-bearing: detect gives lines, group gives regions,
 * ORDER gives them their numbers, and only then are they drawn. The label IS
 * the id the model answers with and the overlay looks regions up by it, so
 * numbering before ordering would put every translation in the wrong bubble.
 *
 * The plate comes last and depends on nothing but the raster and the mask, so
 * it could equally run first; it is here so the numbered render -- the thing
 * the model is waiting on -- is not held up behind half a second of diffusion.
 */
async function prepare({ imageB64, mimeType }) {
  // Stage timings, because "slow" is not a diagnosis. Detection on the CPU
  // backend is two orders of magnitude slower than on WebGPU, and without a
  // per-stage breakdown that is indistinguishable from a hang, a huge image, or
  // a stuck message channel.
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

  const { plate, mask } = await buildCleanPlate(raster, seg);
  mark("plate");

  return {
    numbered,
    plate,
    mask,
    backend: detector.backend,
    // Propagated rather than only logged: this document has its own console,
    // reachable only through the extension's card in chrome://extensions, so a
    // warning left here is a warning nobody reads.
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
      // Whether a bubble was actually drawn around this text. No longer decides
      // whether the background can be repaired -- the plate repairs it either
      // way -- but still the right signal for how much room a box has to grow
      // into, which is lib/layout.js's question.
      inBubble: b.inBubble === true
    }))
  };
}

/**
 * One detection at a time.
 *
 * There is a single ORT session and concurrent run() calls on it are not safe.
 * Now that the content script translates several pages at once, requests do
 * arrive together, so they are chained rather than left to interleave. The
 * serialisation costs nothing: detection is ~230ms against a ~15s model call,
 * so the calls still overlap where the time actually goes.
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
