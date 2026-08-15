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

import { bytesToBase64 } from "./lib/bytes.js";
import { contentHash, get as cacheGet, set as cacheSet } from "./lib/cache.js";
import { translatePage, mergeRegions, cacheKey, DEFAULTS } from "./lib/translate.js";
import { deriveSeriesId } from "./lib/series.js";
import { measureBackground } from "./lib/surface.js";

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
// THESE TWO NUMBERS ARE THE TUNING SURFACE. Both are bracketed by synthetic
// cases, not yet by real pages -- every region's lum/sd/share is logged to the
// console by content.js precisely so they can be set from real values.
//
//   BUSY_STD  sits above a grey gradient panel (sd ~0.05, the case this whole
//             change exists to fix -- it must FILL) and at continuous artwork
//             (sd ~0.11, which must not). It is the tighter of the two.
//   MIN_SHARE catches artwork that is uniform on both sides of the split, like
//             hard screentone, where sd sees nothing. Deliberately low: dense
//             bold text in a tight box reaches ~0.60, so anything nearer that
//             starts outlining perfectly good bubbles.
const BUSY_STD = 0.10;      // luminance sd above which a region is artwork
const MIN_SHARE = 0.5;      // bg share below which the split found no surface
const DARK_BG = 0.5;        // bg luminance below which text flips to light ink

/**
 * Attach fill colour, background luminance and busyness to every region.
 *
 * Run on every page including cache hits, not stored as a property of the
 * translation: it is a rendering decision measured from bytes we already hold,
 * so tuning a threshold should take effect immediately rather than needing the
 * cache thrown away.
 */
async function annotateBackgrounds(buffer, page) {
  // Fall back to the old assumption -- a white bubble with dark text -- only if
  // the pixels are genuinely unavailable.
  const UNKNOWN = {
    fill: [255, 255, 255], bgLum: 1, bgStd: 0, bgShare: 1,
    busy: false, darkBg: false
  };

  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([buffer]));
  } catch {
    page.regions.forEach((r) => Object.assign(r, UNKNOWN));
    return page;
  }

  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);

  for (const r of page.regions) {
    const xs = r.polygon.map((p) => p[0]);
    const ys = r.polygon.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) * bmp.width));
    const x1 = Math.min(bmp.width, Math.ceil(Math.max(...xs) * bmp.width));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) * bmp.height));
    const y1 = Math.min(bmp.height, Math.ceil(Math.max(...ys) * bmp.height));
    const w = x1 - x0, h = y1 - y0;

    if (w < 2 || h < 2) { Object.assign(r, UNKNOWN); continue; }

    const measured = measureBackground(ctx.getImageData(x0, y0, w, h).data);
    Object.assign(r, measured ?? UNKNOWN);
    // No single surface to fill with: this is artwork, and painting over it
    // would cost more than the readability it buys. Outlined text instead.
    r.busy = r.bgStd > BUSY_STD || r.bgShare < MIN_SHARE;
    r.darkBg = r.bgLum < DARK_BG;
  }

  bmp.close?.();
  return page;
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
    // Re-measured rather than trusted from the cache -- see annotateBackgrounds.
    await annotateBackgrounds(buffer, cached);
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

  const translated = await translatePage({
    imageB64: prepared.numbered,
    regionCount: prepared.regions.length,
    seriesId,
    apiKey: settings.apiKey,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort
  });

  const page = {
    contentHash: hash,
    naturalWidth: prepared.naturalWidth,
    naturalHeight: prepared.naturalHeight,
    // Geometry and reading order come from local detection; only the language
    // fields come from the model.
    regions: mergeRegions(prepared.regions, translated.regions),
    glossaryVersion: 0
  };

  await annotateBackgrounds(buffer, page);

  // Fire and forget. Caching is a side effect of translating, not part of
  // delivering the result, and awaiting it once made a cache bug indistinguish-
  // able from the whole pipeline hanging.
  void cacheSet(key, page).catch(() => {});

  return {
    page, strategy, tried, cached: false,
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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "YOMI_TRANSLATE") return;

  translate({ ...msg, tabId: sender.tab?.id })
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));

  return true;   // keeps the channel open for the async reply
});
