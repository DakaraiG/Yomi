// Text detection: comic-text-detector, ONNX Runtime Web, WebGPU or WASM.
//
// Chosen over PaddleOCR, which won the bake-off on boxes alone, because erasing
// the Japanese needs a per-pixel glyph mask and DB's probability map is
// region-level by construction (which is why unclip() exists). CTD carries a
// UNet segmentation head beside its detection heads, so one forward pass yields
// boxes and mask together, at a cost of ~600ms against a 12-18s translate call.
//
// GPL-3.0, which the v0.4 rewrite existed to get out of. It is back deliberately
// and narrowly: weights are fetched at install time and no GPL code is linked,
// so the three-process wall does not come back. See README.md.
//
// Model signature, confirmed against the file:
//   in   images   [1,3,1024,1024] float32, RGB, 0-1, letterboxed, pad 114
//   out  blk      [1,64512,7]     YOLOv5 detections, anchor-decoded
//   out  seg      [1,1,1024,1024] per-pixel text mask
//   out  det      [1,2,1024,1024] DBNet-style line head, channel 0 = probability
//
// The input dims are static: every page is squashed to 1024 on its long edge on
// every backend, so there is no working-resolution lever here.

import { toTensor } from "./imageops.js";
import { probabilityMapToBoxes } from "./db-postprocess.js";
import {
  CTD_SIZE, letterbox, decodeBlocks, cropChannel, resizeMap, fuse
} from "./ctd-postprocess.js";

export const MODEL_PATH = "models/comictextdetector.pt.onnx";

export class Detector {
  #session = null;
  #ort = null;

  /**
   * @param {object} [opts]
   * @param {number} [opts.confThreshold=0.4]    YOLO objectness x class score
   * @param {number} [opts.nmsThreshold=0.35]    IoU above which blocks merge
   * @param {number} [opts.binaryThreshold=0.3]  det map -> line mask
   */
  constructor({ confThreshold = 0.4, nmsThreshold = 0.35, binaryThreshold = 0.3,
                boxThreshold = 0.5, unclipRatio = 1.8 } = {}) {
    this.options = {
      confThreshold, nmsThreshold, binaryThreshold, boxThreshold, unclipRatio
    };
    /** Which execution provider actually loaded: "webgpu" or "wasm". */
    this.backend = null;
  }

  get ready() { return this.#session !== null; }

  /**
   * Load the runtime and the model, on WebGPU if it is available.
   *
   * The WASM fallback is tried explicitly rather than by listing both providers,
   * so `backend` records what actually ran -- the CPU path is roughly two orders
   * of magnitude slower, and otherwise both produce the same log line.
   *
   * That gap is structural: multi-threaded WASM needs SharedArrayBuffer, which
   * needs cross-origin isolation, which an offscreen document does not have.
   */
  async init() {
    if (this.#session) return;

    const modelUrl = chrome.runtime.getURL(MODEL_PATH);

    // Ask the hardware before asking ORT: a failed WebGPU session leaves the ORT
    // module half-initialised, and every later attempt -- including the CPU
    // fallback -- then fails with "previous call to 'initWasm()' failed", which
    // reports the corpse rather than the cause.
    //
    // navigator.gpu existing is not enough; requestAdapter still returns null in
    // contexts without GPU access.
    let adapter = null;
    if (navigator.gpu) {
      try {
        adapter = await navigator.gpu.requestAdapter();
      } catch { /* treated as no WebGPU */ }
    }

    if (adapter) {
      try {
        const ort = await this.#loadOrt();
        this.#session = await ort.InferenceSession.create(modelUrl, {
          executionProviders: ["webgpu"],
          graphOptimizationLevel: "all"
        });
        this.backend = "webgpu";
        console.info(`[yomi] detector ready on webgpu, ${CTD_SIZE}px input`);
        return;
      } catch (err) {
        this.initWarning = `WebGPU failed, using CPU: ${err.message}`;
        console.warn("[yomi]", this.initWarning);
      }
    }

    // A fresh module instance for the fallback: re-importing with a different
    // query string bypasses the module cache, which is the only way to get an
    // ORT whose initWasm has not already failed.
    const ort = await this.#loadOrt(adapter ? "?retry=cpu" : "");
    this.#session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    this.backend = "wasm";

    // The CPU path has no escape hatch: the model's input dims are static, so a
    // page on single-threaded WASM is a full 1024x1024 UNet pass with no smaller
    // version to fall back to. Expect tens of seconds.
    if (!this.initWarning) {
      this.initWarning = navigator.gpu
        ? "WebGPU present but no adapter — running on CPU, expect a slow page"
        : "No WebGPU in this browser — running on CPU, expect a slow page";
    }
    console.info(
      `[yomi] detector ready on ${this.backend}, ${CTD_SIZE}px input`);
  }

  /**
   * Run one throwaway inference at the shape real pages will use.
   *
   * On WebGPU the first run at a given input shape compiles a compute shader per
   * op, which for this model dominates. Paying it at load time makes the user's
   * first page as fast as their tenth. Shape is fixed by the model, so the
   * warm-up cannot disagree with what real pages use.
   */
  async warmUp() {
    if (!this.#session) return;

    const label = `[yomi] warm-up ${CTD_SIZE}x${CTD_SIZE} on ${this.backend}`;
    console.time(label);
    try {
      const tensor = new this.#ort.Tensor(
        "float32", new Float32Array(3 * CTD_SIZE * CTD_SIZE),
        [1, 3, CTD_SIZE, CTD_SIZE]);
      await this.#session.run({ [this.#session.inputNames[0]]: tensor });
    } catch (err) {
      console.warn("[yomi] warm-up failed (not fatal):", err.message);
    }
    console.timeEnd(label);
  }

  async #loadOrt(cacheBust = "") {
    // Must match ORT_ENTRY in tools/bakeoff/install-extension-assets.mjs, which
    // derives the companion .mjs/.wasm variants by reading this exact file.
    const ort = await import(`../vendor/ort/ort.bundle.min.mjs${cacheBust}`);
    // wasmPaths must point inside the extension: ORT otherwise resolves its
    // .wasm from a CDN, which MV3 forbids outright, and the failure surfaces as
    // a fetch error naming a jsdelivr URL.
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.logLevel = "error";
    this.#ort = ort;
    return ort;
  }

  /**
   * One forward pass, three answers: block boxes, line boxes, and the mask.
   *
   * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
   * @returns {Promise<{lines:Array<{x0,y0,x1,y1,score}>, seg:Float32Array}>}
   *   `lines` is one box per text line in original pixel coordinates, plus any
   *   block the line head missed entirely; grouping them is lib/group.js's job.
   *   `seg` is the per-pixel text probability at page resolution, row-major.
   *
   * `seg` must stay inside the offscreen document: a page-resolution float map
   * is several megabytes, and sending it through chrome.runtime costs a
   * structured-clone copy on both sides for something only the mask ever reads.
   */
  async detect(raster) {
    if (!this.#session) throw new Error("Detector.init() has not been awaited");
    const { width, height } = raster;
    const {
      confThreshold, nmsThreshold, binaryThreshold, boxThreshold, unclipRatio
    } = this.options;

    const { raster: lb, r, nw, nh } = letterbox(raster);
    // No mean/std: this model takes plain 0-1 RGB, and ImageNet normalisation
    // quietly halves recall rather than failing.
    const tensor = new this.#ort.Tensor(
      "float32", toTensor(lb), [1, 3, CTD_SIZE, CTD_SIZE]);

    // Timed out loud: a slow first call is shader compilation and expected,
    // while every call being slow is a different problem entirely.
    const label = `[yomi] inference ${CTD_SIZE}x${CTD_SIZE} on ${this.backend}`;
    console.time(label);
    const result = await this.#session.run({ [this.#session.inputNames[0]]: tensor });
    console.timeEnd(label);

    const [blkName, segName, detName] = this.#session.outputNames;

    // The line head is DB-style, so the PaddleOCR path's threshold/unclip
    // post-processing applies unchanged.
    const lineMap = cropChannel(result[detName].data,
      { size: CTD_SIZE, nw, nh, channel: 0 });
    const lines = probabilityMapToBoxes(lineMap, {
      width: nw,
      height: nh,
      binaryThreshold,
      boxThreshold,
      unclipRatio,
      // Boxes come back in the letterboxed frame and everything downstream works
      // in original pixels, so the resize is undone here and nowhere else.
      scaleX: width / nw,
      scaleY: height / nh,
      imageWidth: width,
      imageHeight: height
    });

    const blocks = decodeBlocks(result[blkName].data, {
      stride: result[blkName].dims[2],
      count: result[blkName].dims[1],
      r, width, height, confThreshold, nmsThreshold
    });

    // Crop the pad off before scaling to page size, or the mask lands offset by
    // the padding's share of the edge and erases the wrong pixels.
    const seg = resizeMap(
      cropChannel(result[segName].data, { size: CTD_SIZE, nw, nh }),
      nw, nh, width, height);

    return { lines: fuse(lines, blocks), seg };
  }
}
