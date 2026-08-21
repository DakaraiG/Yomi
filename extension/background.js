// Yomi service worker.
//
// v0.4: a thin router. It owns three things a page cannot -- cross-origin
// fetches, the API key, and the cache -- and delegates everything else. The
// heavy work (detection, grouping, ordering, the numbered render) lives in the
// offscreen document, because the model session takes seconds to build and this
// worker gets killed on idle.
//
//   retrieval ladder  -> offscreen: detect + group + order + number
//                     -> provider: transcribe + translate
//                     -> merge onto local geometry -> overlay
//
// IMAGE RETRIEVAL IS A LADDER, not a single method. Manga hosts vary from
// wide-open to actively hostile, and the failure is always the same 403, so the
// only way to know which method works is to try them in order.
//
// Why no single method suffices:
//   - A service-worker fetch bypasses CORS (host_permissions) but sends no
//     Referer, so Referer-based hotlink protection rejects it.
//   - A content-script fetch sends the page's Referer and would pass, but since
//     Chrome 85 content scripts are subject to CORS, and image CDNs don't send
//     Access-Control-Allow-Origin.
// Each approach fails on exactly what the other solves. Hence tier 2.

import { base64ToBytes, bytesToBase64 } from "./lib/bytes.js";
import { contentHash, get as cacheGet, set as cacheSet } from "./lib/cache.js";
import { translatePage, mergeRegions, cacheKey, DEFAULTS } from "./lib/translate.js";
import { deriveSeriesId } from "./lib/series.js";
import { measureBackground, stripStats, snapFill } from "./lib/surface.js";
import { shapeBox } from "./lib/layout.js";
import { createBudget, DEFAULT_LIMIT } from "./lib/budget.js";
import { diffusionInpaint } from "./lib/inpaint.js";

// A RANGE, not a single id.
//
// Concurrent translations each need their own Referer rule. Sharing one id
// means the second request's rule replaces the first's before the first has
// fetched, and the first's teardown then removes the second's -- so BOTH fall
// through to the screenshot tier with a 403, on hosts where tier 2 works
// perfectly in isolation. The bug only appears once pages are translated in
// parallel, and it looks like the CDN getting stricter.
const DNR_RULE_BASE = 8801;
const DNR_RULE_SLOTS = 16;
let dnrCursor = 0;

function nextRuleId() {
  dnrCursor = (dnrCursor + 1) % DNR_RULE_SLOTS;
  return DNR_RULE_BASE + dnrCursor;
}

// --- tier 1: direct fetch --------------------------------------------------
// Works on: permissive hosts, blob: and data: URLs (some readers build object
// URLs in JS, which are already in memory -- these come back in single-digit ms).
async function fetchDirect({ imageUrl }) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error(`direct ${r.status}`);
  return { buffer: await r.arrayBuffer(), mimeType: r.headers.get("content-type") };
}

// --- tier 2: fetch with a spoofed Referer ----------------------------------
// Rewrites our own request headers so it looks like an ordinary in-page image
// load. Handles the common case: CDNs that check Referer.
//
// SAFARI HAS NO declarativeNetRequest modifyHeaders, so this tier is simply
// absent there rather than broken -- hence the capability check rather than a
// hard dependency. On Safari the ladder is tier 1 then tier 3.
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
    // Always tear our OWN rule down. A lingering rule that rewrites Referer on
    // unrelated requests is a genuinely nasty bug to track down later.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [ruleId]
    });
  }
}

// --- tier 3: screenshot the rendered page ----------------------------------
// The nuclear option. No fetch at all, so nothing to block -- we read the pixels
// Chrome already painted. Works everywhere, including <canvas> readers with no
// <img> to point at.
//
// COSTS, which are real:
//   - Only what is on screen. A tall page scrolled halfway gives you half a page.
//   - Resolution is viewport x devicePixelRatio, not native. On a retina display
//     that is often ~2x and adequate; on an external 1080p monitor it may not be.
//     Panel gutters are 3-5px at native, and panel detection reads drawn borders,
//     so this degrades reading order quietly rather than loudly.
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

  // A capture far smaller than a manga page is not a page. Zoomed-out readers
  // and partially-scrolled images both produce one, and it detects as zero
  // regions -- which reads as "this page has no text" rather than "we
  // photographed a thumbnail".
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
 * Guarded by a shared promise: two pages translated in quick succession both
 * reach here, and createDocument throws if one already exists. The check-then-
 * create is not atomic, so the promise is what actually prevents the race.
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
 * Bytes cross as base64 rather than as an ArrayBuffer: extension messages are
 * serialised, and a buffer arrives at the other end as an empty object with no
 * error raised. It costs a copy and about 33% in size, which is the price of
 * the boundary.
 *
 * The retry is for a real race. createDocument resolves once the document
 * EXISTS, not once its module script has run, so the first message can arrive
 * before the listener is registered and comes back as "Could not establish
 * connection" -- which looks like a missing offscreen document rather than a
 * timing problem, and only on the first translation after the worker restarts.
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
// The measurement itself lives in lib/surface.js; this is the part that needs
// the image bytes, which we already hold here in extension origin, so nothing
// is tainted.
//
// The fill decision used to hang on the SPREAD of the background (BUSY_STD)
// and how much of the region it accounted for (MIN_SHARE). Both are gone: on
// ynko4 the spread runs 0.06-0.134 as a continuum with no gap anywhere in it,
// because that number is inflated by the text's own antialiasing rather than by
// anything behind the text. It was measuring text density and being read as
// artwork detection.
//
// NONE OF THAT DECIDES A BACKGROUND ANY MORE. There used to be a rule here --
// inside a drawn bubble, paint a rectangle; anywhere else paint nothing and let
// a heavy halo carry the text -- and the rule was right for as long as a
// rectangle was the only fill shape available. The clean plate erases the
// glyph strokes themselves, so every region now sits on repaired background
// whether or not anyone drew a bubble around it, and the split is gone.
//
// What survives is the part that was never about covering anything: WHAT
// COLOUR THE TEXT SHOULD BE. That is still measured from the original pixels,
// through surface.js's block-averaged sampler, which is what makes it correct
// on screentone rather than fooled by it.
const DARK_BG = 0.5;        // bg luminance below which text flips to light ink

/**
 * Decode the page once, for everything in this worker that needs pixels.
 *
 * Both consumers -- the colour measurement and the clean plate -- want the same
 * full-page ImageData, and decoding a two-megabyte JPEG twice per page is the
 * kind of cost that never shows up in a profile because it is spread across two
 * functions that each look cheap.
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
  // Dimensions read BEFORE close(). Closing an ImageBitmap sets its width and
  // height to zero, so returning them from the closed object hands every caller
  // a zero-sized page -- and the failure is a silent one: no region matches, no
  // error is thrown, the overlay simply comes back empty.
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
 * Run on every page including cache hits, not stored as a property of the
 * translation: these are rendering decisions measured from bytes we already
 * hold, so tuning a threshold should take effect immediately rather than
 * needing the cache thrown away.
 */
function annotateBackgrounds(surface, page) {
  // Fall back to the old assumption -- a white bubble with dark text -- only if
  // the pixels are genuinely unavailable.
  const UNKNOWN = {
    fill: [255, 255, 255], bgLum: 1, bgStd: 0, bgShare: 1, bgPeak: 1,
    darkBg: false
  };

  if (!surface) {
    page.regions.forEach((r) => Object.assign(r, UNKNOWN));
    return page;
  }

  const { ctx, width: pageW, height: pageH } = surface;

  // Pixel boxes for every region first: shaping one needs to know where the
  // others are.
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

    // Snapped before it is read for luminance: a bubble that measures 252 is
    // white, and treating it as almost-white puts the ink/halo decision on the
    // wrong side of a threshold for regions that are plainly one thing or the
    // other. Nothing paints this colour any more -- it exists to be measured.
    r.fill = snapFill(r.fill);
    r.darkBg = (r.fill[0] * 0.299 + r.fill[1] * 0.587 + r.fill[2] * 0.114) / 255
               < DARK_BG;

    // Vertical Japanese leaves a box English cannot be set in. Widen it as far
    // as the pixels allow -- see lib/layout.js.
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

    // The per-side `rim` fractions went with the fill. They existed to say how
    // far a rectangle's soft edge could fade before it started fading over
    // Japanese, which is not a question anyone asks about a background that no
    // longer has any Japanese in it.
  });

  return page;
}

/**
 * Attach the clean plate: the page with the glyph strokes repainted.
 *
 * The plate is built in the offscreen document on the miss path, because that
 * is where the mask comes from. This is the CACHE HIT path, and it exists
 * because a cache hit skips the offscreen document entirely.
 *
 * WHAT IS CACHED IS THE MASK, NOT THE PLATE. A plate is a full-page PNG, a few
 * hundred KB to a megabyte; the mask is one bit per pixel and mostly empty, so
 * PNG takes it down to a few tens of KB, and 500 cached pages is the difference
 * between tens of megabytes of IndexedDB and hundreds. Re-running diffusion
 * costs a few hundred ms against a cached page that already costs nothing, and
 * it keeps the same shape as annotateBackgrounds: re-derive from the bytes we
 * hold rather than trust a stored rendering.
 *
 * A page cached before plates existed has no mask. It renders on the original
 * background, which is what it did before this change -- worse, not broken.
 */
async function attachCleanPlate(surface, page) {
  if (page.plate || !page.mask || !surface) return page;

  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([base64ToBytes(page.mask)], { type: "image/png" }));
  } catch {
    return page;
  }

  const { width, height } = surface;
  // A mask from a differently-sized decode cannot be trusted to line up, and a
  // misaligned mask erases the wrong pixels -- which looks like a plausible
  // rendering artefact rather than like a bug.
  if (bmp.width !== width || bmp.height !== height) {
    bmp.close?.();
    return page;
  }

  const maskCanvas = new OffscreenCanvas(width, height);
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  maskCtx.drawImage(bmp, 0, 0);
  bmp.close?.();

  const maskData = maskCtx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0, q = 0; q < mask.length; i += 4, q++) mask[q] = maskData[i] > 127 ? 1 : 0;

  const raster = { width, height, data: surface.ctx.getImageData(0, 0, width, height).data };
  const clean = diffusionInpaint(raster, mask);

  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").putImageData(new ImageData(clean.data, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  page.plate = bytesToBase64(await blob.arrayBuffer());
  return page;
}

// --- the spend ceiling -----------------------------------------------------
//
// See lib/budget.js. Lives here because this worker is the only thing that
// knows whether a page actually cost anything: the content script cannot tell a
// cache hit from a paid call, and counting pages rather than calls would stop a
// re-read of an already-translated chapter for no reason.
//
// Held in storage.session, so it survives this worker being killed on idle --
// which happens constantly -- and clears when the browser closes. A ceiling
// that resets every few minutes because the worker was recycled is not a
// ceiling.

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

  // Hashed from the ORIGINAL bytes, never the numbered render -- the render
  // depends on detection, so keying on it would defeat the point of the cache.
  const hash = await contentHash(buffer);
  const seriesId = deriveSeriesId(ctx.pageUrl, { title: ctx.pageTitle });
  const key = cacheKey({
    contentHash: hash, seriesId, targetLang: "en", model: settings.model
  });

  const cached = await cacheGet(key);
  if (cached) {
    // Re-measured and re-inpainted rather than trusted from the cache -- see
    // annotateBackgrounds and attachCleanPlate.
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
    // Not an error. A page with no text is a legitimate outcome, and the overlay
    // needs to be able to say "nothing here" rather than hang.
    //
    // DELIBERATELY NOT CACHED. An empty result is far more often a degraded
    // retrieval than a genuinely blank page -- a screenshot fallback that
    // captured a partly-scrolled or tiny region hashes consistently, so caching
    // it pins that page to zero regions permanently and no amount of retrying
    // recovers it. Re-running detection costs ~230ms; getting this wrong costs
    // the page.
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

  // THE ONLY LINE THAT SPENDS MONEY IS BELOW THIS ONE. Everything up to here --
  // retrieval, hashing, the cache lookup, detection -- is free, so the ceiling
  // is checked as late as possible and a cached page never touches it.
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
    // A call that never produced anything should not be charged against the
    // ceiling -- otherwise a flaky network quietly eats the session's budget.
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
    // The mask that erased the Japanese, kept so a cache hit can rebuild the
    // plate without re-running detection.
    mask: prepared.mask,
    glossaryVersion: 0
  };

  annotateBackgrounds(await decodePage(buffer), page);

  // Fire and forget. Caching is a side effect of translating, not part of
  // delivering the result, and awaiting it once made a cache bug indistinguish-
  // able from the whole pipeline hanging.
  //
  // A SNAPSHOT, not the live object. The plate is deliberately not cached -- a
  // full-page PNG in every entry costs hundreds of megabytes across a 500-entry
  // cache, and it is recoverable from the mask in a few hundred ms -- but
  // "attach it after the write" does not achieve that: cacheSet awaits openDb()
  // before it puts anything, so the structured clone happens a tick later and
  // would pick up whatever the object holds by then. Copying here pins what
  // gets stored to what exists now.
  void cacheSet(key, { ...page }).catch(() => {});
  page.plate = prepared.plate;

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

// Without this, changing the ceiling in options does nothing until the worker
// happens to be recycled -- which looks like the setting being ignored.
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
      // Flagged rather than pattern-matched on the message: the content script
      // has to stop asking entirely when the ceiling is reached, and inferring
      // that from error text would break the moment the wording changed.
      budgetExceeded: err instanceof BudgetExceededError
    }));

  return true;   // keeps the channel open for the async reply
});
