# Yomi extension — v0.4

Chrome MV3, development build, unpacked only. This is the whole product: as of
v0.4 there is no sidecar and no backend, and nothing runs outside the browser
except the translation call.

MIT, like the rest of the repository. Nothing here is GPL, which is the point of
the v0.4 rewrite — see the [root README](../README.md).

## Install

No build step, no bundler, no npm dependencies in the shipped code. The runtime
binaries are fetched rather than committed:

```bash
cd ../tools/bakeoff
npm install
node fetch-models.mjs paddle-v4
node install-extension-assets.mjs
```

Then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder — a directory on your
   Mac, not a URL
4. Open the extension's options page and paste an API key
5. Open a manga page and click the **Yomi** toolbar button

Reload the extension from `chrome://extensions` after editing any file here.
`background.js` and the offscreen document are both cached, so a page reload
alone is not enough — reload the extension *and* hard-reload the tab.

## Files

| File | Runs in | Job |
|---|---|---|
| `manifest.json` | — | MV3 declaration, permissions, CSP |
| `background.js` | service worker | Retrieval ladder, cache, API key, provider call |
| `offscreen.js` | offscreen document | Detection, grouping, ordering, numbered render |
| `content.js` | page (isolated world) | Finds page images, drives the flow |
| `overlay.js` | page (isolated world) | Renders the overlay, toast, toggle key |
| `options.html/js` | extension page | API key, model, cache controls |
| `lib/` | — | Everything reusable; see below |
| `fonts/` | — | Comic Neue, renamed `YomiLetter-*`. SIL OFL, see `fonts/OFL.txt` |

`lib/` in dependency order: `panels.js` and `ordering.js` (ported from the v0.3
Python), `group.js`, `detect.js`, `render.js`, `prompt.js`, `translate.js`,
`cache.js`, `series.js`, plus `imageops.js` / `components.js` /
`db-postprocess.js` / `bytes.js`.

## Why an offscreen document

Detection needs an ONNX session that takes a second or two to build and must
survive between pages. A service worker cannot hold one — it is killed on idle,
routinely, and being terminated mid-inference produces no error, just silence.
So the worker stays a thin router owning the three things a page cannot have
(cross-origin fetches, the API key, the cache), and the offscreen document does
the work.

WebGPU is used where available: **229ms per page** against tens of seconds on
the CPU fallback. The CPU path is single-threaded because multi-threaded WASM
needs `SharedArrayBuffer`, which needs cross-origin isolation, which an offscreen
document does not have — so when it is in use the working resolution drops from
1536 to 960 (91.9% recall against 92.3%, for ~2.5× fewer pixels).

A warm-up inference runs at load. On WebGPU the first run at a given input shape
compiles a compute shader per op, and paying that once at startup keeps the
user's first page as fast as their tenth.

## Image retrieval is a ladder

Manga hosts range from wide open to actively hostile, and the failure is always
the same 403, so the only way to find out which method works is to try them in
order:

| Tier | Method | Fails on |
|---|---|---|
| 1 | `fetch` from the service worker | Referer-based hotlink protection — a worker fetch sends no Referer. Handles `blob:` and `data:` URLs in single-digit ms |
| 2 | Same fetch, with a `declarativeNetRequest` rule rewriting `Referer` and dropping `Origin` | Token-signed or cookie-gated CDNs |
| 3 | `captureVisibleTab`, cropped to the image | Nothing — but see below |

A content-script fetch would send the page's Referer naturally, but since Chrome
85 content scripts are subject to CORS and image CDNs do not send
`Access-Control-Allow-Origin`. Each approach fails on exactly what the other
solves; hence tier 2.

**Rule ids are allocated from a range, not fixed.** Pages are translated
concurrently, and a shared id means the second request's rule replaces the
first's before it has fetched, while the first's teardown removes the second's —
so both fall through to screenshot with a 403 on hosts where tier 2 works
perfectly in isolation.

**Tier 3's costs are real.** It captures only what is on screen, refuses images
that are not fully visible, and rejects captures under 400px — a thumbnail
detects as "no text", which is worse than an error. Resolution is viewport ×
devicePixelRatio, not native, so it degrades reading order quietly.

## Rendering

Unchanged from v0.3, deliberately — it was tuned and works.

**Isolation.** Manga readers have aggressive CSS. Everything lives in a shadow
root under `:host { all: initial }`.

**Fitting.** `fitText` binary-searches the font size (~6 measurements instead of
up to 40, each forcing a reflow). Then a second pass takes the 35th percentile
of the individual maxima and applies one size page-wide, letting only genuinely
tight boxes drop below it — fitting each box to its own maximum is what makes a
page look amateur.

**Repositioning.** Polygons are normalised 0–1, so zoom and resize are a
multiply rather than a re-request.

Per-kind styling (`bubble`/`thought` radial white fade, `narration` vertical
fade, `sfx` outlined, `on-art` from measured pixels, `untranslated` dimmed) is
described in the v0.3 history and unchanged.

Fonts load via the CSS Font Loading API, **not** `@font-face`: a `@font-face`
rule declared inside a shadow root never registers, because font faces are
document-scoped, and it fails silently. This needs `fonts/*.ttf` in
`web_accessible_resources`; without it the overlay quietly falls back to the
system stack, which is what v0.3 shipped doing.

## Controls

| | |
|---|---|
| Toolbar button | Translate every page image currently on screen |
| `t` | Toggle all overlays — the fastest way to check a translation against the Japanese |

Pages translate three at a time. Sequentially, a four-image screen cost four
~15s calls end to end; detection is serialised on the offscreen side (one ORT
session), which costs nothing since 229ms against a 15s call is noise.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the two scripts on click, and nothing before |
| `declarativeNetRequestWithHostAccess` | Retrieval tier 2 |
| `storage` | API key and settings |
| `offscreen` | The detection document |
| `<all_urls>` | Manga is hosted everywhere |
| `https://api.openai.com/*` | The provider |

The API key lives in `chrome.storage.local` — extension-scoped, not synced, and
never read by a content script. Only the service worker touches it, and only to
set an `Authorization` header.

## Known gaps

- Only `<img>` elements are found. `<canvas>` readers produce "No manga page
  found here"; tier 3 could handle them but nothing points it there yet.
- The size heuristic (≥400px each side, height/width > 0.8) is loose and will
  need per-site tuning.
- Chrome only. Safari has no `declarativeNetRequest` `modifyHeaders`, so tier 2
  is absent there — the ladder is structured so it degrades rather than breaks.
- No glossary yet; `glossaryVersion` is always 0.

## Debugging

Two consoles, and the distinction matters:

- **Page console** — `[yomi]` lines from `content.js`: regions, timings, the
  backend used, per-stage marks, and a table of the first 10 regions.
- **Offscreen console** — `chrome://extensions` → the Yomi card → *Inspect
  views: offscreen.html*. Detector load, backend selection, and per-inference
  timings live here. A warning written here is invisible from the page, so
  anything worth acting on is propagated back to the page console instead.

`globalThis.__yomi` in the offscreen document exposes the detector for poking at
directly.

If a page is stuck showing a wrong or empty result, clear the cache from the
options page — a screenshot-tier capture hashes consistently, so a bad one would
otherwise pin that page permanently.
