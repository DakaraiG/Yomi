// Yomi service worker.
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

const BACKEND = "http://localhost:5080";
const DNR_RULE_ID = 8801;

// --- tier 1: direct fetch --------------------------------------------------
// Works on: permissive hosts, blob: and data: URLs (some readers build object
// URLs in JS, which are already in memory -- these come back in single-digit ms).
async function fetchDirect({ imageUrl }) {
  const r = await fetch(imageUrl);
  if (!r.ok) throw new Error(`direct ${r.status}`);
  return await r.arrayBuffer();
}

// --- tier 2: fetch with a spoofed Referer ----------------------------------
// Rewrites our own request headers so it looks like an ordinary in-page image
// load. Handles the common case: CDNs that check Referer.
async function fetchWithReferer({ imageUrl, pageUrl }) {
  if (imageUrl.startsWith("blob:") || imageUrl.startsWith("data:")) {
    throw new Error("not applicable to blob/data URLs");
  }
  const origin = new URL(pageUrl).origin;

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [{
      id: DNR_RULE_ID,
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
    return await r.arrayBuffer();
  } finally {
    // Always tear the rule down. A lingering rule that rewrites Referer on
    // unrelated requests is a genuinely nasty bug to track down later.
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [DNR_RULE_ID]
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
//     Panel gutters are 3-5px at native, so this degrades detection quietly.
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
  return await blob.arrayBuffer();
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
      const buffer = await fn(ctx);
      return { buffer, strategy: name, tried };
    } catch (err) {
      tried.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`all retrieval strategies failed — ${tried.join(" | ")}`);
}

// --- helpers ---------------------------------------------------------------

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function deriveSeriesId(pageUrl) {
  try {
    const u = new URL(pageUrl);
    const seg = u.pathname.split("/").filter(Boolean)[0] ?? "unknown";
    return `${u.hostname}/${seg}`;
  } catch {
    return "unknown";
  }
}

async function translate(ctx) {
  const started = performance.now();
  const { buffer, strategy, tried } = await getImageBytes(ctx);
  const fetchedAt = performance.now();

  const apiResponse = await fetch(`${BACKEND}/v1/translate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      imageB64: bytesToBase64(buffer),
      seriesId: deriveSeriesId(ctx.pageUrl),
      targetLang: "en"
    })
  });

  if (!apiResponse.ok) {
    const body = await apiResponse.text();
    throw new Error(`Backend ${apiResponse.status}: ${body.slice(0, 200)}`);
  }

  return {
    page: await apiResponse.json(),
    strategy,
    tried,
    timing: {
      bytes: buffer.byteLength,
      fetchMs: Math.round(fetchedAt - started),
      totalMs: Math.round(performance.now() - started)
    }
  };
}

// --- wiring ----------------------------------------------------------------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "YOMI_TRANSLATE") return;

  translate({ ...msg, tabId: sender.tab?.id })
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true;   // keeps the channel open for the async reply
});
