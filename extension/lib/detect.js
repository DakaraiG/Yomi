// Text detection: comic-text-detector, ONNX Runtime Web, WebGPU or WASM.
//
// REPLACED PaddleOCR, which won the Phase 1 bake-off on boxes alone. The
// question changed: the overlay stopped covering the Japanese and started
// erasing it, and erasing needs a per-pixel glyph mask that DB cannot give --
// its probability map is region-level by construction, which is why unclip()
// exists. CTD carries a UNet segmentation head next to its detection heads,
// so one forward pass yields boxes and mask together.
//
// Measured on the fixture pages (tools/bakeoff, `--only ctd-fused,paddle-1536`):
//
//                 recall   exact grouping   ms
//   paddle-1536    92.3%   87.5/92.3/86.4   260
//   ctd-fused     100.0%   94.1/92.9/86.4   862
//
// Recall against fixtures/baseline.json is partly circular -- the baseline is
// this model's own output from the v0.3 sidecar -- so read 100% as "the port is
// faithful". The grouping columns are the honest comparison, and they are level
// or better. The 600ms costs nothing next to a 12-18s translate call.
//
// GPL-3.0, which is the licence the v0.4 rewrite existed to get out of. It is
// back deliberately and narrowly: weights are fetched at install time and no
// GPL code is linked, so the three-process wall does not come back. See
// README.md and tools/bakeoff/fetch-models.mjs.
//
// Model signature, confirmed against the file rather than assumed:
//   in   images   [1,3,1024,1024] float32, RGB, 0-1, letterboxed, pad 114
//   out  blk      [1,64512,7]     YOLOv5 detections, anchor-decoded
//   out  seg      [1,1,1024,1024] per-pixel text mask
//   out  det      [1,2,1024,1024] DBNet-style line head, channel 0 = probability
//
// THE INPUT DIMS ARE STATIC. There is no maxSide here and nothing to sweep:
// every page is squashed to 1024 on its long edge, on every backend. That
// removes the tuning that mattered most on the DB path and removes the CPU
// path's only lever with it -- see init().

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
        console.info(`[yomi] detector ready on webgpu, ${CTD_SIZE}px input`);
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

    // THE CPU PATH LOST ITS ESCAPE HATCH with the move off PaddleOCR. That
    // path used to drop the working resolution to 960 and take the 0.4 points
    // of recall it cost; this model's input dims are static, so a page on
    // single-threaded WASM is a full 1024x1024 pass through a UNet and there is
    // no smaller version of it to run. Expect tens of seconds. The warning says
    // "slow" rather than "reduced resolution" because that is now the truth.
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
   * On WebGPU the first run at a given input shape compiles a compute shader
   * for every op in the graph, and for this model that dominates -- the cost
   * lands on whoever calls first. Paying it at load time means the user's first
   * page is as fast as their tenth, and it turns "the extension hangs" into "the
   * extension takes a moment to start", which is a far better failure to have.
   *
   * Shape is fixed by the model, so unlike the DB path there is no way for the
   * warm-up shape to disagree with the one real pages use.
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
   * One forward pass, three answers: block boxes, line boxes, and the mask.
   *
   * @param {{width:number,height:number,data:Uint8ClampedArray}} raster
   * @returns {Promise<{lines:Array<{x0,y0,x1,y1,score}>, seg:Float32Array}>}
   *   `lines` is one box per text LINE in original pixel coordinates, plus any
   *   block the line head missed entirely -- grouping them is lib/group.js's
   *   job. `seg` is the per-pixel text probability at PAGE resolution, one
   *   float per pixel, row-major.
   *
   * SEG STAYS INSIDE THE OFFSCREEN DOCUMENT. A page-resolution float map is
   * several megabytes; sending it through chrome.runtime means structured-clone
   * copies on both sides of a message port for something only buildCleanPlate
   * ever reads. It is returned here, consumed there, and never serialised.
   */
  async detect(raster) {
    if (!this.#session) throw new Error("Detector.init() has not been awaited");
    const { width, height } = raster;
    const {
      confThreshold, nmsThreshold, binaryThreshold, boxThreshold, unclipRatio
    } = this.options;

    const { raster: lb, r, nw, nh } = letterbox(raster);
    // No mean/std: this model takes plain 0-1 RGB, unlike the ImageNet-
    // normalised DB path it replaced. Normalising anyway costs nothing visible
    // and quietly halves recall.
    const tensor = new this.#ort.Tensor(
      "float32", toTensor(lb), [1, 3, CTD_SIZE, CTD_SIZE]);

    // Timed out loud, because this is the one stage whose cost is invisible
    // otherwise and the one that has actually been slow. On WebGPU the FIRST
    // run compiles a compute shader per op, so a first call costing tens of
    // seconds and later ones costing under a second is expected -- and is a
    // completely different problem from every call being slow.
    const label = `[yomi] inference ${CTD_SIZE}x${CTD_SIZE} on ${this.backend}`;
    console.time(label);
    const result = await this.#session.run({ [this.#session.inputNames[0]]: tensor });
    console.timeEnd(label);

    const [blkName, segName, detName] = this.#session.outputNames;

    // Line boxes from the DB-style head, through the same post-processing the
    // PaddleOCR path used -- the head is the same shape of thing, so the
    // threshold/unclip machinery ports over unchanged.
    const lineMap = cropChannel(result[detName].data,
      { size: CTD_SIZE, nw, nh, channel: 0 });
    const lines = probabilityMapToBoxes(lineMap, {
      width: nw,
      height: nh,
      binaryThreshold,
      boxThreshold,
      unclipRatio,
      // Boxes come back in the letterboxed frame; everything downstream works
      // in original pixels, so undo the resize here and nowhere else.
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

    // Crop the pad off BEFORE scaling to page size, or the mask lands offset by
    // the padding's share of the edge -- which looks like a plausible small
    // misalignment rather than like a bug, and erases the wrong pixels.
    const seg = resizeMap(
      cropChannel(result[segName].data, { size: CTD_SIZE, nw, nh }),
      nw, nh, width, height);

    return { lines: fuse(lines, blocks), seg };
  }
}
