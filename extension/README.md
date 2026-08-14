# Yomi extension — v0.3.1

Chrome MV3, development build, unpacked only. Finds the manga page you are
looking at, gets its pixels to the backend, and draws the English back over the
artwork.

MIT, like the backend. **No GPL code may ever enter this directory** — this is
the one artefact that would go through a store review or an Apple developer
account, and the sidecar's GPL obligations must stay on the other side of the
HTTP seam. See [`../README.md`](../README.md) for the boundary.

## Install

Nothing to build; there is no bundler, no npm, no dependencies.

1. Start the sidecar and the backend first — see the [root
   README](../README.md#quickstart). Without them the extension shows an error
   toast and nothing else.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. **Load unpacked** → select this `extension/` folder. That is a directory on
   your Mac, not a URL.
5. Open a manga page and click the **Yomi** toolbar button.

Reload the extension from `chrome://extensions` after editing any file here.
Editing `background.js` in particular needs a reload — the service worker is
cached.

## Files

| File | Runs in | Job |
|---|---|---|
| `manifest.json` | — | MV3 declaration, permissions |
| `background.js` | service worker | Image retrieval, backend call, background sampling |
| `content.js` | page (isolated world) | Finds page images, drives the flow, logs the result |
| `overlay.js` | page (isolated world) | Renders the overlay, the toast, and the toggle key |
| `fonts/` | — | Comic Neue, renamed `YomiLetter-*`. SIL OFL, see `fonts/OFL.txt` |

`content.js` and `overlay.js` are injected **on demand** by
`chrome.scripting.executeScript` when the toolbar button is clicked, in that
order — `overlay.js` first, because it defines the `window.__yomiRender` and
`window.__yomiToast` hooks that `content.js` calls. There are no declared
content scripts, so nothing runs on any page until you ask for it.

## Flow

```
toolbar click
  → inject overlay.js + content.js
  → content.js: findPageImages()          big, roughly portrait, on screen, deduped
  → sendMessage YOMI_TRANSLATE            per image
      → background.js: retrieval ladder   direct → referer → screenshot
      → POST localhost:5080/v1/translate
      → annotateBackgrounds()             measure the pixels under each region
  → overlay.js: __yomiRender(img, page)   shadow root, fit, position
```

Manual trigger is deliberate for v0.3. Automatic firing on scroll is v0.5, and
`findPageImages` already filters to what is on screen so a long-strip reader
does not launch fifty paid requests at once.

## Image retrieval is a ladder

Manga hosts range from wide open to actively hostile, and the failure is always
the same 403, so the only way to find out which method works is to try them in
order. Each tier exists because the one before it fails on something real:

| Tier | Method | Fails on |
|---|---|---|
| 1 | `fetch(imageUrl)` from the service worker | Referer-based hotlink protection — a worker fetch sends no Referer. Handles `blob:` and `data:` URLs in single-digit ms, since those are already in memory |
| 2 | Same fetch, with a `declarativeNetRequest` session rule rewriting `Referer` to the page URL and dropping `Origin` | Token-signed or cookie-gated CDNs |
| 3 | `chrome.tabs.captureVisibleTab`, cropped to the image's bounding box | Nothing — but see the costs below |

A content-script fetch would send the page's Referer naturally and pass tier 2's
case, but since Chrome 85 content scripts are subject to CORS and image CDNs do
not send `Access-Control-Allow-Origin`. Each approach fails on exactly what the
other solves; hence tier 2 rather than "just fetch from the page".

The tier 2 rule is torn down in a `finally`. A session rule left rewriting
`Referer` on unrelated requests is a genuinely nasty bug to track down later.

**Tier 3's costs are real.** It captures only what is on screen — a page
scrolled halfway gives you half a page, so it refuses outright if the image is
not fully visible. Resolution is viewport × devicePixelRatio, not native: often
~2× and adequate on a retina display, possibly not on an external 1080p monitor.
Panel gutters are 3–5px at native, and the sidecar's panel detection reads
drawn borders, so this degrades reading order quietly rather than loudly.

Which tier fired is logged (`via screenshot`), along with what the earlier tiers
said when they failed.

## Background sampling

The backend's `kind` does not tell you whether a white fill is safe. Narration
inside a white box is fine; narration set over artwork is the same `kind`, and
covering it destroys the panel. The text cannot answer this. The pixels can —
and the service worker is already holding the image bytes, in extension origin,
so nothing is tainted.

`annotateBackgrounds` samples every 4th pixel of each region's bounding box and
measures what fraction is near-white (luminance > 0.85). Above 55% it is a
bubble interior; below, it is artwork. The result is attached to each region as
`onWhite` (plus `whiteFraction` for debugging).

`onWhite` is **added client-side** and is not part of the frozen
`/v1/translate` contract. If image decoding fails the whole page defaults to
`onWhite: true`, which is the pre-v0.3.1 behaviour.

## Rendering

Three problems drive `overlay.js`:

**Isolation.** Manga readers have aggressive CSS. Everything lives in a shadow
root under `:host { all: initial }`, so the host page cannot restyle the boxes
and Yomi cannot restyle the page.

**Fitting.** Japanese is vertical and compact; English is horizontal and long. A
bubble that comfortably held 8 kana has to hold "You'll get a stomach ache
sleeping like that". `fitText` binary-searches the font size — ~6 measurements
instead of up to 40, and each measurement forces a reflow, so on a 20-region
page the difference is real.

Then layout runs a **second pass**. Fitting every box to its own maximum is what
makes a page look amateur: a two-word bubble renders huge next to a dense one
and the eye reads the variation as sloppiness. So pass 2 takes a low percentile
(35th) of the individual maxima, applies that one size everywhere, and lets only
genuinely tight boxes drop below it. Real lettering works the same way.

**Repositioning.** Zoom, window resize and responsive reflow all change the
image's rendered size. Polygons are normalised 0–1 precisely so this is a
multiply, not a re-request — a `ResizeObserver` on the image plus a window
`resize` listener re-run layout, and both are torn down in `__yomiCleanup`.

Styling per region:

| Class | Look | Why |
|---|---|---|
| `.bubble`, `.thought` | White radial gradient, opaque to 72% then fading out | The bubble interior is already white, so a fill that fades before the edge is invisible against it — no hard rectangle, and no need to know the bubble's real outline |
| `.narration` | White, fading on the vertical axis only | Narration boxes are rectangular and usually sit flush to a border |
| `.sfx` | Transparent, white text with a black stroke | SFX sits on artwork; a white box would destroy the panel |
| `.on-art` | Black text, white stroke, no fill. Overrides the above | Applied when `onWhite === false`, i.e. measured from the pixels, not inferred from `kind` |
| `.untranslated` | Dimmed italic Japanese | A region the model dropped renders visibly rather than silently, per v0.6 |

Boxes are expanded 8% (`BOX_EXPAND`) because the detector returns the *text*
region, not the bubble, and bubbles have margin to spend. Too much and boxes
collide with neighbouring art.

Hovering a region shows its original Japanese in a tooltip.

## Controls

| | |
|---|---|
| Toolbar button | Translate every page image currently on screen |
| `t` | Toggle all overlays — the fastest way to check a translation against the Japanese. Ignored while typing in an input |

A toast in the bottom-right reports progress (`2/3 translated · 19 regions`),
because clicking the button used to produce nothing visible for ten seconds,
which is indistinguishable from being broken. Error toasts translate backend
status codes into something actionable: 503 → "Detection sidecar isn't
running", 502 → "Translation failed — check your API key".

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Inject the two scripts on click, and nothing before that |
| `declarativeNetRequestWithHostAccess` | Retrieval tier 2's Referer rewrite |
| `<all_urls>` | Manga is hosted everywhere; a host list would be a list of sites to maintain forever |
| `http://localhost:5080/*`, `http://127.0.0.1:5080/*` | The backend |

The backend URL is hardcoded as `BACKEND` at the top of `background.js`. There
is no options page; change it there and reload if you move the port.

## Known gaps

- **Fonts may not load.** `manifest.json` declares no `web_accessible_resources`,
  and the font files are fetched from the extension origin by the CSS Font
  Loading API. If the console shows `[yomi] no fonts loaded`, that is the cause,
  and the overlay falls back to the system comic stack — legible, less
  characterful. Note the related trap the code already works around: a
  `@font-face` rule declared *inside* a shadow root never registers, because
  font faces are document-scoped. That is why `FontFace` + `document.fonts.add`
  is used instead.
- `manifest.json` still reads `"version": "0.3.0"` while the repo is at v0.3.1.
  Nothing depends on it, and Chrome only cares on update.
- Only `<img>` elements are found. Readers that paint to `<canvas>` or use CSS
  background images produce "No manga page found here"; the retrieval ladder can
  handle them via tier 3, but nothing points it at them yet.
- The size heuristic (≥400px each side, height/width > 0.8) is deliberately
  loose for the spike and will need per-site tuning.
- No automated tests. The console log and the toast are the instrumentation.
- Chrome only. Safari is a later milestone, and the frozen `/v1/translate` body
  is what makes that port a rewrite of this directory alone.

## Debugging

`content.js` logs a `console.table` of the first 10 regions, the retrieval
strategy used, byte count and timings, and checks two things the C# tests cannot
— that `kind` really arrived as a string, and that `naturalWidth` from the
backend matches the DOM. A size mismatch means polygons will be misplaced; it is
expected and harmless on the screenshot tier, since that crops at
devicePixelRatio while the framing stays identical and the polygons are
normalised anyway.

Service worker logs live behind the **service worker** link on the extension's
card at `chrome://extensions`, not in the page console.
