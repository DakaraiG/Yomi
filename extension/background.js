// Yomi service worker: owns what a page cannot -- cross-origin fetches, the API
// key, the cache -- and routes everything else.
//
//   retrieval ladder  -> offscreen: detect + group + order + number
//                     -> provider: transcribe + translate
//                     -> merge onto local geometry -> overlay
//
// Detection lives in the offscreen document because the model session takes
// seconds to build and this worker is killed on idle.
//
// Retrieval is a ladder because no single method covers every host: a worker
// fetch bypasses CORS but sends no Referer, so hotlink protection rejects it;
// a content-script fetch carries the page's Referer but is subject to CORS,
// which image CDNs do not answer. Both failures look like the same 403, so the
// tiers are tried in order.

import { base64ToBytes, bytesToBase64 } from "./lib/bytes.js";
import { contentHash, get as cacheGet, set as cacheSet } from "./lib/cache.js";
import { translatePage, mergeRegions, cacheKey, DEFAULTS } from "./lib/translate.js";
import { deriveSeriesId } from "./lib/series.js";
import { measureBackground, stripStats, snapFill } from "./lib/surface.js";
import { shapeBox } from "./lib/layout.js";
import { createBudget, DEFAULT_LIMIT } from "./lib/budget.js";
import {
  clearBox, diffusionInpaint, backgroundStructure, STRUCTURE_THRESHOLD
} from "./lib/inpaint.js";

// A range, not a single id: concurrent translations each need their own Referer
// rule, and on a shared id each translation's teardown removes the other's, so
// both fall through to the screenshot tier with a 403.
const DNR_RULE_BASE = 8801;
const DNR_RULE_SLOTS = 16;
let dnrCursor = 0;

function nextRuleId() {
  dnrCursor = (dnrCursor + 1) % DNR_RULE_SLOTS;
  return DNR_RULE_BASE + dnrCursor;
}

/** Tier 1: plain fetch. Covers permissive hosts, plus blob: and data: URLs. */
async function fetchDirect({ imageUrl }) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error(`direct ${r.status}`);
  return { buffer: await r.arrayBuffer(), mimeType: r.headers.get("content-type") };
}

/**
 * Tier 2: fetch disguised as an in-page image load, for CDNs that check Referer.
 *
 * Safari has no declarativeNetRequest modifyHeaders, so the capability check
 * makes this tier absent there rather than broken.
 */
async function fetchWithReferer({ imageUrl, pageUrl }) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    throw new Error("declarativeNetRequest unavailable on this browser");
  }
  if (imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")) {
    throw new Error("not applicable to blob/data URLs");
  }

  const ruleId = nextRuleId();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "referer", operation: "set", value: pageUrl },
          { header: "origin", operation: "remove" }
        ]
      },
      condition: {
        urlFilter: imageUrl,
        resourceTypes: ["xmlhttprequest", "image", "other"]
      }
    }]
  });

  try {
    const r = await fetch(imageUrl, { headers: { "x-yomi-retry": "1" } });
    if (!r.ok) throw new Error(`referer ${r.status}`);
    return { buffer: await r.arrayBuffer(), mimeType: r.headers.get("content-type") };
  } finally {
    // A lingering rule rewrites Referer on unrelated requests.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    });
  }
}

/**
 * Tier 3: read the pixels Chrome already painted -- no fetch, so nothing to
 * block, and it works on <canvas> readers with no <img> to point at.
 *
 * Costs: only what is on screen, at viewport x devicePixelRatio rather than
 * native resolution. Panel gutters are 3-5px at native, and panel detection
 * reads drawn borders, so below native this degrades reading order quietly.
 */
async function captureFromScreen({ tabId, rect, dpr }) {
  if (!rect) throw new Error("no rect supplied");
  if (rect.top < 0 || rect.bottom > rect.viewportHeight) {
    throw new Error("image not fully visible; scroll it into view");
  }

  const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
  const shot = await createImageBitmap(await (await fetch(dataUrl)).blob());

  const sx = Math.round(rect.left * dpr);
  const sy = Math.round(rect.top * dpr);
  const sw = Math.round(rect.width * dpr);
  const sh = Math.round(rect.height * dpr);

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);

  // Extension-origin pixels, so nothing is tainted.
  const blob = await canvas.convertToBlob({ type: "image/png" });

  // A thumbnail-sized capture detects as zero regions, which reads as "this
  // page has no text" rather than as a bad capture.
  if (sw < 400 || sh < 400) {
    throw new Error(
      `screenshot too small (${sw}x${sh}) — zoom in or scroll the page into view`);
  }

  return { buffer: await blob.arrayBuffer(), mimeType: "image/png" };
}

const STRATEGIES = [
  ["direct", fetchDirect],
  ["referer", fetchWithReferer],
  ["screenshot", captureFromScreen]
];

async function getImageBytes(ctx) {
  const tried = [];
  for (const [name, fn] of STRATEGIES) {
    try {
      const { buffer, mimeType } = await fn(ctx);
      return { buffer, mimeType: mimeType || "image/png", strategy: name, tried };
    } catch (err) {
      tried.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`all retrieval strategies failed — ${tried.join(" | ")}`);
}

// --- offscreen document ----------------------------------------------------

let offscreenReady = null;

/**
 * Create the offscreen document once.
 *
 * The check-then-create is not atomic, so the shared promise -- not the
 * existence check -- is what stops two concurrent translations from both
 * calling createDocument, which throws if a document already exists.
 */
function ensureOffscreen() {
  offscreenReady ??= (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    });
    if (existing.length) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification:
        "Runs the ONNX text detector. The service worker is terminated on idle, " +
        "which would kill an in-flight inference and discard the loaded model."
    });
  })().catch((err) => {
    offscreenReady = null;             // a failed creation must be retryable
    throw err;
  });
  return offscreenReady;
}

/**
 * Hand the bytes to the offscreen document and get the numbered page back.
 *
 * Bytes cross as base64, not as an ArrayBuffer: extension messages are
 * serialised, and a buffer arrives as an empty object with no error raised.
 *
 * The retry covers createDocument resolving once the document exists but before
 * its module script has registered the listener, which surfaces as "Could not
 * establish connection" on the first translation after a worker restart.
 */
async function preparePage(buffer, mimeType) {
  const message = {
    target: "yomi-offscreen",
    imageB64: bytesToBase64(buffer),
    mimeType
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureOffscreen();
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response) throw new Error("offscreen document did not reply");
      if (!response.ok) throw new Error(response.error);
      return response;
    } catch (err) {
      const connecting = /Could not establish connection|Receiving end does not exist/
        .test(String(err?.message ?? err));
      if (!connecting || attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
}

// --- background sampling ---------------------------------------------------
//
// The measurement lives in lib/surface.js; this is the part that needs the image
// bytes, which are held here in extension origin so nothing is tainted.
//
// Nothing measured here decides whether to paint a background: the clean plate
// erases the glyph strokes, so every region sits on repaired artwork. What is
// measured is the text colour, block-averaged so screentone does not fool it.
const DARK_BG = 0.5;        // bg luminance below which text flips to light ink

/**
 * Decode the page once, for everything in this worker that needs pixels.
 *
 * @returns {Promise<{ctx:OffscreenCanvasRenderingContext2D,width:number,height:number}|null>}
 *   null when the bytes cannot be decoded at all.
 */
async function decodePage(buffer) {
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([buffer]));
  } catch {
    return null;
  }
  // Read before close(), which zeroes an ImageBitmap's width and height. A
  // zero-sized page matches no region and throws nothing: the overlay just
  // comes back empty.
  const { width, height } = bmp;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { ctx, width, height };
}

/**
 * Attach ink colour, background luminance and a layout box to every region.
 *
 * Runs on cache hits too, and is never stored with the translation: these are
 * rendering decisions re-measured from the bytes, so tuning a threshold takes
 * effect without discarding the cache.
 */
function annotateBackgrounds(surface, page) {
  // A white bubble with dark text, for when the pixels are unavailable.
  const UNKNOWN = {
    fill: [255, 255, 255], bgLum: 1, bgStd: 0, bgShare: 1, bgPeak: 1,
    darkBg: false
  };

  if (!surface) {
    page.regions.forEach((r) => Object.assign(r, UNKNOWN));
    return page;
  }

  const { ctx, width: pageW, height: pageH } = surface;

  // Every pixel box first: shaping one needs to know where the others are.
  const boxes = page.regions.map((r) => {
    const xs = r.polygon.map((p) => p[0]);
    const ys = r.polygon.map((p) => p[1]);
    return {
      x0: Math.max(0, Math.floor(Math.min(...xs) * pageW)),
      x1: Math.min(pageW, Math.ceil(Math.max(...xs) * pageW)),
      y0: Math.max(0, Math.floor(Math.min(...ys) * pageH)),
      y1: Math.min(pageH, Math.ceil(Math.max(...ys) * pageH))
    };
  });

  const probe = (x, y, w, h) =>
    (w >= 1 && h >= 1 && x >= 0 && y >= 0 && x + w <= pageW && y + h <= pageH)
      ? stripStats(ctx.getImageData(x, y, Math.round(w), Math.round(h)).data)
      : null;

  page.regions.forEach((r, i) => {
    const box = boxes[i];
    const w = box.x1 - box.x0, h = box.y1 - box.y0;

    if (w < 2 || h < 2) { Object.assign(r, UNKNOWN); return; }

    const measured = measureBackground(ctx.getImageData(box.x0, box.y0, w, h).data);
    Object.assign(r, measured ?? UNKNOWN);

    // Snapped before it is read for luminance: a bubble measuring 252 is white,
    // and almost-white puts the ink decision on the wrong side of DARK_BG.
    // Nothing paints this colour -- it exists to be measured.
    r.fill = snapFill(r.fill);
    r.darkBg = (r.fill[0] * 0.299 + r.fill[1] * 0.587 + r.fill[2] * 0.114) / 255
               < DARK_BG;

    // Vertical Japanese leaves a box English cannot be set in; widen it as far
    // as the pixels allow.
    const shaped = shapeBox(box, {
      vertical: r.vertical,
      base: r,
      neighbours: boxes,
      imageW: pageW,
      imageH: pageH,
      probe
    });
    r.box = {
      x: shaped.x0 / pageW,
      y: shaped.y0 / pageH,
      w: (shaped.x1 - shaped.x0) / pageW,
      h: (shaped.y1 - shaped.y0) / pageH
    };
    r.widenedBy = +((shaped.x1 - shaped.x0) / w).toFixed(2);
  });

  return page;
}

// Length is what separates onomatopoeia from narration set across a textured
// panel; structure alone (below) sees drawing behind both, and sparing a
// narration block leaves a paragraph of Japanese on the page with the English
// shrunk into a strip beside it. Measured on the source, since the English
// varies with how verbose a translation happens to be.
const SFX_MAX_CHARS = 12;

/** Short enough, and stylised enough, to be treated as part of the drawing. */
function isStylised(region) {
  if (region.kind === "sfx" && region.inBubble !== true) return true;
  const source = region.japanese ?? "";
  return source.length > 0 && source.length <= SFX_MAX_CHARS;
}

/**
 * Attach the clean plate: the page with the glyph strokes repainted.
 *
 * The only place a plate is built, on both the cache hit and miss paths. It
 * lives here rather than beside the mask in the offscreen document because what
 * may be erased depends on `kind`, which arrives with the translation.
 *
 * The cache holds the mask, not the plate: a plate is a full-page PNG, while the
 * mask is one mostly-empty bit per pixel, which is tens rather than hundreds of
 * megabytes across a full cache. Re-running diffusion costs a few hundred ms and
 * lets the rule below be re-tuned against already-cached pages. A page cached
 * before masks existed has none, and simply erases nothing.
 */
async function attachCleanPlate(surface, page) {
  const giveUp = () => {
    page.regions.forEach((r) => { r.erased = false; });
    return page;
  };

  if (!page.mask || !surface) return giveUp();

  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([base64ToBytes(page.mask)], { type: "image/png" }));
  } catch {
    return giveUp();
  }

  const { width, height } = surface;
  // A mask from a differently-sized decode erases the wrong pixels, which reads
  // as a plausible rendering artefact rather than as a bug.
  if (bmp.width !== width || bmp.height !== height) {
    bmp.close?.();
    return giveUp();
  }

  const maskCanvas = new OffscreenCanvas(width, height);
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  maskCtx.drawImage(bmp, 0, 0);
  bmp.close?.();

  const maskData = maskCtx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0, q = 0; q < mask.length; i += 4, q++) mask[q] = maskData[i] > 127 ? 1 : 0;

  const raster = { width, height, data: surface.ctx.getImageData(0, 0, width, height).data };

  // What may be erased, decided per region.
  //
  // Diffusion fills a masked pixel from its unmasked neighbours, so it tells the
  // truth only where those neighbours are flat -- a bubble interior, a tone, a
  // gradient. Hand-drawn onomatopoeia is the opposite: strokes that ARE the
  // drawing, with no "behind" to recover, and the English that replaces them is
  // far too small to cover the smear.
  //
  // A region is spared only if it is both short enough to be onomatopoeia and
  // has real structure behind it. Either test alone over-fires. `kind === "sfx"`
  // cannot be the primary signal: mergeRegions defaults kind to "bubble" for
  // every region the model did not answer for, and whole pages of SFX arrive
  // labelled that way.
  //
  // Punched out of the mask here rather than left out of it during detection, so
  // the rule can be re-tuned without re-running detection.
  page.regions.forEach((r) => {
    const b = r.box ?? boundsOf(r.polygon);
    const box = {
      x0: b.x * width, y0: b.y * height,
      x1: (b.x + b.w) * width, y1: (b.y + b.h) * height
    };
    const structure = backgroundStructure(raster, mask, box);
    r.structure = +structure.toFixed(3);        // surfaced in the debug table
    r.erased = !(isStylised(r) && structure >= STRUCTURE_THRESHOLD);
    if (!r.erased) clearBox(mask, width, height, box);
  });

  const clean = diffusionInpaint(raster, mask);

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(clean.data, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  page.plate = bytesToBase64(await blob.arrayBuffer());
  return page;
}

/** Normalised bounding box of a polygon, for regions with no shaped box. */
function boundsOf(polygon) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// --- the spend ceiling -----------------------------------------------------
//
// Lives here because this worker is the only thing that can tell a cache hit
// from a paid call. Held in storage.session so it survives the worker being
// killed on idle -- a ceiling that resets every few minutes is not a ceiling --
// and clears when the browser closes.

export class BudgetExceededError extends Error {}

const budget = createBudget(DEFAULT_LIMIT);
let budgetReady = null;

function ensureBudget() {
  budgetReady ??= (async () => {
    const [session, local] = await Promise.all([
      chrome.storage.session.get("autoSpent"),
      chrome.storage.local.get("autoLimit")
    ]);
    budget.restore(session.autoSpent ?? 0);
    budget.setLimit(local.autoLimit ?? DEFAULT_LIMIT);
  })();
  return budgetReady;
}

function persistBudget() {
  void chrome.storage.session.set({ autoSpent: budget.spent }).catch(() => {});
}

// --- settings --------------------------------------------------------------

async function loadSettings() {
  const stored = await chrome.storage.local.get(["apiKey", "model", "reasoningEffort"]);
  if (!stored.apiKey) {
    throw new Error("No API key set. Open the extension's options page and add one.");
  }
  return {
    apiKey: stored.apiKey,
    model: stored.model || DEFAULTS.model,
    reasoningEffort: stored.reasoningEffort || DEFAULTS.reasoningEffort
  };
}

// --- the pipeline ----------------------------------------------------------

async function translate(ctx) {
  const started = performance.now();
  const settings = await loadSettings();

  const { buffer, mimeType, strategy, tried } = await getImageBytes(ctx);
  const fetchedAt = performance.now();

  // Hashed from the original bytes, never the numbered render, which depends on
  // detection and would make the key vary with it.
  const hash = await contentHash(buffer);
  const seriesId = deriveSeriesId(ctx.pageUrl, { title: ctx.pageTitle });
  const key = cacheKey({
    contentHash: hash, seriesId, targetLang: "en", model: settings.model
  });

  const cached = await cacheGet(key);
  if (cached) {
    // Re-measured and re-inpainted rather than trusted from the cache.
    const surface = await decodePage(buffer);
    annotateBackgrounds(surface, cached);
    await attachCleanPlate(surface, cached);
    return {
      page: cached, strategy, tried, cached: true,
      timing: {
        bytes: buffer.byteLength,
        fetchMs: Math.round(fetchedAt - started),
        totalMs: Math.round(performance.now() - started)
      }
    };
  }

  const prepared = await preparePage(buffer, mimeType);
  const preparedAt = performance.now();

  if (prepared.regions.length === 0) {
    // A page with no text is a legitimate outcome, not an error.
    //
    // Deliberately not cached: an empty result is far more often a degraded
    // retrieval than a blank page, and a partly-scrolled screenshot hashes
    // consistently, so caching it would pin that page to zero regions
    // permanently. Re-running detection costs ~230ms.
    const empty = {
      contentHash: hash,
      naturalWidth: prepared.naturalWidth,
      naturalHeight: prepared.naturalHeight,
      regions: [],
      glossaryVersion: 0
    };
    return {
      page: empty, strategy, tried, backend: prepared.backend,
      timing: { bytes: buffer.byteLength, totalMs: Math.round(performance.now() - started) }
    };
  }

  // Everything above is free -- retrieval, hashing, the cache lookup, detection
  // -- so the ceiling is checked as late as possible and a cached page never
  // touches it.
  if (ctx.auto) {
    await ensureBudget();
    if (!budget.reserve()) {
      throw new BudgetExceededError(
        `Auto-translate has reached its ceiling of ${budget.limit} paid ` +
        `page(s) for this browser session. Raise it in options (it takes ` +
        `effect immediately), or restart the browser to reset the count. ` +
        `Pages already translated stay free to re-read.`);
    }
    persistBudget();
  }

  let translated;
  try {
    translated = await translatePage({
      imageB64: prepared.numbered,
      regionCount: prepared.regions.length,
      seriesId,
      apiKey: settings.apiKey,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort
    });
  } catch (err) {
    // A call that produced nothing must not be charged, or a flaky network
    // quietly eats the session's budget.
    if (ctx.auto) { budget.release(); persistBudget(); }
    throw err;
  }

  const page = {
    contentHash: hash,
    naturalWidth: prepared.naturalWidth,
    naturalHeight: prepared.naturalHeight,
    // Geometry and reading order come from local detection; only the language
    // fields come from the model.
    regions: mergeRegions(prepared.regions, translated.regions),
    // Kept so a cache hit can rebuild the plate without re-running detection.
    mask: prepared.mask,
    glossaryVersion: 0
  };

  const surface = await decodePage(buffer);
  annotateBackgrounds(surface, page);

  // Fire and forget: caching is a side effect of translating, not part of
  // delivering the result.
  //
  // A snapshot, not the live object. Attaching the plate after this line is not
  // enough to keep it out of the cache -- cacheSet awaits openDb() before it
  // writes, so the structured clone happens a tick later and would pick up
  // whatever the object holds by then.
  void cacheSet(key, { ...page }).catch(() => {});
  await attachCleanPlate(surface, page);

  return {
    page, strategy, tried, cached: false,
    budget: ctx.auto ? { spent: budget.spent, limit: budget.limit } : undefined,
    backend: prepared.backend,
    backendWarning: prepared.backendWarning,
    marks: prepared.marks,
    usage: {
      inputTokens: translated.inputTokens,
      outputTokens: translated.outputTokens,
      reasoningTokens: translated.reasoningTokens
    },
    timing: {
      bytes: buffer.byteLength,
      fetchMs: Math.round(fetchedAt - started),
      detectMs: Math.round(preparedAt - fetchedAt),
      totalMs: Math.round(performance.now() - started)
    }
  };
}

// --- wiring ----------------------------------------------------------------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["overlay.js", "content.js"]
  });
});

// Without this, a new ceiling set in options does nothing until the worker
// happens to be recycled.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.autoLimit) {
    budget.setLimit(changes.autoLimit.newValue ?? DEFAULT_LIMIT);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "YOMI_BUDGET") {
    ensureBudget().then(() =>
      sendResponse({ ok: true, spent: budget.spent, limit: budget.limit }));
    return true;
  }

  if (msg?.type !== "YOMI_TRANSLATE") return;

  translate({ ...msg, tabId: sender.tab?.id })
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({
      ok: false,
      error: String(err?.message ?? err),
      // Flagged rather than pattern-matched: the content script must stop asking
      // entirely at the ceiling, and error text is not a stable signal.
      budgetExceeded: err instanceof BudgetExceededError
    }));

  return true;   // keeps the channel open for the async reply
});
