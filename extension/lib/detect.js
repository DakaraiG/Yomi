// Text detection: PaddleOCR DB head, ONNX Runtime Web, WASM backend.
//
// Chosen in the Phase 1 bake-off. Apache-2.0, 4.7MB, 92.3% recall against
// comic-text-detector across the fixture pages at ~250ms a page -- the best of
// seven candidates and, usefully, also the smallest of the learned ones. The
// numbers and the runners-up are in tools/bakeoff/README.md.
//
// Model signature, confirmed against the file rather than assumed:
//   in   x                NCHW float32, all spatial dims dynamic
//   out  sigmoid_0.tmp_0  N,1,H,W float32 -- already through a sigmoid, so the
//                         output is a probability map, not logits
//
// maxSide is the parameter that matters and 1536 is not arbitrary. PaddleOCR's
// own default caps the long edge at 960px, tuned for photographs of signs; a
// manga page is 2000-3000px of small vertical kana and 960 shrinks a glyph
// below what the model can resolve. Above 1536 it gets worse again -- DB has a
// sweet spot relative to text size and past it strokes fragment. Measured:
// 960 -> 91.9%, 1536 -> 92.3%, 2048 -> 85.7%.

import { resizeRGBA, toTensor, padTo } from "./imageops.js";
import { probabilityMapToBoxes } from "./db-postprocess.js";

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export const MODEL_PATH = "models/ch_PP-OCRv4_det_infer.onnx";

export class Detector {
  #session = null;
  #ort = null;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxSide=1536]     long edge on WebGPU
   * @param {number} [opts.cpuMaxSide=960]   long edge on the CPU fallback
   */
  constructor({ maxSide = 1536, cpuMaxSide = 960, binaryThreshold = 0.3,
                boxThreshold = 0.5, unclipRatio = 1.8 } = {}) {
    this.options = { maxSide, binaryThreshold, boxThreshold, unclipRatio };
    // Resolution is the only lever that works on the CPU path, and it is a
    // cheap one: 960 measured 91.9% recall against 1536's 92.3%, for ~2.5x
    // fewer pixels. Losing 0.4 points of recall beats a page taking a minute.
    this.cpuMaxSide = cpuMaxSide;
    /** Which execution provider actually loaded: "webgpu" or "wasm". */
    this.backend = null;
  }

  get ready() { return this.#session !== null; }

  /**
   * Load the runtime and the model.
   *
   * wasmPaths must point INSIDE the extension. ORT otherwise resolves its .wasm
   * from a CDN, which an extension cannot load at all -- MV3 forbids remote
   * code, and the failure surfaces as a fetch error naming a jsdelivr URL,
   * which reads like a network problem rather than a configuration one.
   *
   * WEBGPU FIRST, WASM AS FALLBACK, and the fallback is tried explicitly rather
   * than by listing both providers, so `backend` records what actually ran.
   * That distinction is worth the extra few lines: the CPU path is roughly two
   * orders of magnitude slower here, so "it works but takes a minute a page"
   * and "it works" are the same log line otherwise.
   *
   * numThreads is 1 because multi-threaded WASM needs SharedArrayBuffer, which
   * needs cross-origin isolation, which an offscreen document does not have.
   * That is precisely why the CPU path is slow, and why WebGPU matters.
   */
  async init() {
    if (this.#session) return;

    const modelUrl = chrome.runtime.getURL(MODEL_PATH);

    // Ask the hardware BEFORE asking ORT.
    //
    // A failed WebGPU session leaves the ORT module poisoned: its WASM runtime
    // is half-initialised, and every later attempt -- including the CPU
    // fallback -- fails with "previous call to 'initWasm()' failed", which
    // reports the corpse rather than the cause. Probing the adapter first means
    // the common case (no WebGPU) never touches ORT at all.
    //
    // navigator.gpu merely EXISTING is not enough; requestAdapter can still
    // return null, and does inside contexts without GPU access.
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
        console.info(
          `[yomi] detector ready on webgpu, maxSide ${this.options.maxSide}`);
        return;
      } catch (err) {
        this.initWarning = `WebGPU failed, using CPU: ${err.message}`;
        console.warn("[yomi]", this.initWarning);
      }
    }

    // A FRESH module instance for the fallback. Re-importing with a different
    // query string bypasses the module cache, which is the only way to get an
    // ORT whose initWasm has not already failed.
    const ort = await this.#loadOrt(adapter ? "?retry=cpu" : "");
    this.#session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all"
    });
    this.backend = "wasm";

    // Single-threaded CPU cannot carry 1536. Drop the working resolution rather
    // than let a page take a minute -- see cpuMaxSide.
    this.options.maxSide = this.cpuMaxSide;
    if (!this.initWarning) {
      this.initWarning = navigator.gpu
        ? "WebGPU present but no adapter — running on CPU at reduced resolution"
        : "No WebGPU in this browser — running on CPU at reduced resolution";
    }
    console.info(
      `[yomi] detector ready on ${this.backend}, maxSide ${this.options.maxSide}`);
  }

  /**
   * Run one throwaway inference at the shape real pages will use.
   *
   * On WebGPU the first run at a given input shape compiles a compute shader
   * for every op in the graph, and for this model that dominates -- the cost
   * lands on whoever calls first. Paying it at load time means the user's first
   * page is as fast as their tenth, and it turns "the extension hangs" into "the
   * extension takes a moment to start", which is a far better failure to have.
   *
   * Shape must MATCH what detect() will produce or the shaders are compiled for
   * nothing; see the padTo() call there.
   */
  async warmUp(width = 1125, height = 1600) {
    if (!this.#session) return;
    const ratio = Math.min(1, this.options.maxSide / Math.max(width, height));
    const inW = padTo(Math.round(width * ratio), 32);
    const inH = padTo(Math.round(height * ratio), 32);

    const label = `[yomi] warm-up ${inW}x${inH} on ${this.backend}`;
    console.time(label);
    try {
      const tensor = new this.#ort.Tensor(
        "float32", new Float32Array(3 * inW * inH), [1, 3, inH, inW]);
      await this.#session.run({ [this.#session.inputNames[0]]: tensor });
    } catch (err) {
      console.warn("[yomi] warm-up failed (not fatal):", err.message);
    }
    console.timeEnd(label);
  }

  async #loadOrt(cacheBust = "") {
    // MUST MATCH ORT_ENTRY in tools/bakeoff/install-extension-assets.mjs, which
    // derives the companion .mjs/.wasm variants by reading this exact file.
    const ort = await import(`../vendor/ort/ort.bundle.min.mjs${cacheBust}`);
    // wasmPaths must point INSIDE the extension. ORT otherwise resolves its
    // .wasm from a CDN, which MV3 forbids outright, and the failure surfaces as
    // a fetch error naming a jsdelivr URL -- which reads like a network problem
    // rather than a configuration one.
    ort.env.wasm.wasmPaths = chrome.runtime.getURL("vendor/ort/");
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.logLevel = "error";
    this.#ort = ort;
    return ort;
  }

  /**
   * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
   * @returns {Promise<Array<{x0,y0,x1,y1,score}>>} one box per text LINE, in
   *   original pixel coordinates. Grouping into blocks is lib/group.js's job.
   */
  async detect(raster) {
    if (!this.#session) throw new Error("Detector.init() has not been awaited");
    const { width, height } = raster;
    const { maxSide, binaryThreshold, boxThreshold, unclipRatio } = this.options;

    const ratio = Math.min(1, maxSide / Math.max(width, height));
    const inW = padTo(Math.round(width * ratio), 32);
    const inH = padTo(Math.round(height * ratio), 32);

    const resized = resizeRGBA(raster, inW, inH);
    const tensor = new this.#ort.Tensor(
      "float32", toTensor(resized, { mean: MEAN, std: STD }), [1, 3, inH, inW]);

    // Timed out loud, because this is the one stage whose cost is invisible
    // otherwise and the one that has actually been slow. On WebGPU the FIRST
    // run at a given input shape also compiles a compute shader per op, so a
    // first call costing tens of seconds and later ones costing a few hundred
    // ms is expected -- and is a completely different problem from every call
    // being slow. The label carries the shape so the two are distinguishable.
    const label = `[yomi] inference ${inW}x${inH} on ${this.backend}`;
    console.time(label);
    const result = await this.#session.run({ [this.#session.inputNames[0]]: tensor });
    const prob = result[this.#session.outputNames[0]].data;
    console.timeEnd(label);

    return probabilityMapToBoxes(prob, {
      width: inW,
      height: inH,
      binaryThreshold,
      boxThreshold,
      unclipRatio,
      // Boxes come back in the resized frame; everything downstream works in
      // original pixels, so undo the resize here and nowhere else.
      scaleX: width / inW,
      scaleY: height / inH,
      imageWidth: width,
      imageHeight: height
    });
  }
}
