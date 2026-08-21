# Yomi

Reads Japanese manga in the browser: finds the text on a page, translates it,
and draws the English back over the artwork. One Chrome extension, no servers.

**v0.4.** Load it unpacked, add an API key, click the toolbar button.

## What changed in v0.4

v0.3 was three processes: a Python sidecar for detection and OCR, an ASP.NET
backend for orchestration and the model call, and the extension. It worked, and
it required starting two servers before opening a manga page — fine for
development, unacceptable as a thing to actually use.

**The change that collapsed it: the translation model transcribes the Japanese
itself.** It was caught doing so unprompted. That removed `manga-ocr` from the
pipeline, which was the single hardest component to port — it decodes
autoregressively, one forward pass per character, and is brutally slow without
hardware acceleration. With OCR gone, detection was the only remaining native
dependency, and a 4.7MB ONNX model replaced it.

Licensing simplified as a side effect. The whole three-way split existed because
`comic-text-detector` is GPL-3.0, so anything linking it inherited the licence
and had to live in its own process. The rewrite replaced it with an Apache-2.0
detector and collapsed the three processes into one extension.

**`comic-text-detector` is back, and the licence question with it.** Not the
architecture: v0.3 needed a separate process because Python code *linked* a GPL
library, and the extension links nothing — the weights are fetched at install
time and read by ONNX Runtime, the same as any other model. What brought it back
is a head no permissive detector has: a per-pixel text mask, which is what
erasing the Japanese needs rather than covering it. The repository's own code
stays MIT; a build with the model installed carries GPL-3.0 obligations for that
file. The trade was made deliberately — see `extension/lib/detect.js` and
`tools/bakeoff/fetch-models.mjs`.

The v0.3 architecture is preserved at the tag **`v0.3-server-architecture`** —
Python sidecar, .NET backend, contract tests, and READMEs describing all three:

```bash
git checkout v0.3-server-architecture
```

## Pipeline

```
toolbar click
  → find page images                     content script
  → retrieval ladder                     service worker
      direct fetch → Referer spoof → screenshot
  → cache lookup (content hash + model)  IndexedDB
  → detect → group → order → number      offscreen document, ONNX + WebGPU
  → transcribe + translate               one API call
  → merge onto local geometry → overlay
```

**Geometry never comes from the model.** It returns text keyed by region id;
polygons and reading order come from local detection. Vision models are bad at
coordinates, and the overlay depends on real ones.

## Layout

```
Yomi/
├── extension/     the whole product                     MIT
│   ├── lib/       detection, grouping, ordering, prompt, cache
│   ├── models/    PaddleOCR detection model    (fetched, gitignored)
│   └── vendor/    ONNX Runtime Web             (fetched, gitignored)
├── tools/bakeoff/ detector comparison harness, tests
├── fixtures/      test pages + comic-text-detector baseline
└── weights/       bake-off candidate models    (fetched, gitignored)
```

## Setup

Needs Node only for the tooling; the extension itself has no build step and no
npm dependencies.

```bash
cd tools/bakeoff
npm install
node fetch-models.mjs ctd
node install-extension-assets.mjs
```

That puts ~27MB of ONNX Runtime and the 91MB detection model into `extension/`.
Neither is committed — both are reproducible from npm and a pinned URL, and the
model is GPL-3.0, which is a second reason it stays out of an MIT tree.

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
select the `extension/` folder (a directory on your Mac, not a URL). Open the
extension's options page and paste an API key.

Full details, including the retrieval ladder and rendering rules, are in
[`extension/README.md`](extension/README.md).

## Tests

```bash
cd tools/bakeoff && npm test        # 34 passing
```

Covers reading order against the v0.3 Python implementation on real pages,
`seriesId` derivation, and a regression guard for the IndexedDB hang. The
detector comparison harness and its methodology are in
[`tools/bakeoff/README.md`](tools/bakeoff/README.md).

## Status

| | |
|---|---|
| Detection | comic-text-detector, GPL-3.0, 91MB — 100% recall vs the v0.3 baseline, which it produced |
| Erasing | per-pixel mask from the same forward pass, diffusion-inpainted into a clean plate |
| Speed | ~850ms detection + ~500ms inpainting on WebGPU; a page is dominated by the model call |
| Grouping | lines → blocks via panels + bubble enclosure, 95.7% exact |
| Reading order | panel-major, ported from v0.3 and verified identical on the test pages |
| Translation | `gpt-5.6-luna` via the Responses API, transcribing and translating in one call |
| Cost | ~$0.0027 per page, dominated by image tokens |
| Cache | IndexedDB, keyed by content hash + model id |
| Glossary | not started — `glossaryVersion` is always 0 |
| Auto-trigger on scroll | not started; the button is manual |
| Safari | not started |

## Known trade-offs

**Transcription is better on marginalia and worse on short stylised dialect.**
The model reads dense margin commentary that manga-ocr rendered as noise, and it
misread シゴロ (a 4-5-6 dice roll) as ジゴロ, producing a confident, wrong line at
0.82 confidence. Accepted deliberately: re-reading low-confidence regions costs
a second call per page, and speed won.

**Stylised logos and heavy SFX ghost rather than erase.** The clean plate
repaints glyph strokes from the pixels around them, which works when there are
pixels around them to use: bubbles, narration boxes, and vertical text over
artwork all come out clean. A `394mg` logo the width of a panel, or SFX drawn as
white-on-black outlines, leaves a visible smear or a ghost outline — nothing can
invent the linework that was never drawn underneath. The English lands on top of
it, so the region still reads; it is the plate that is imperfect, not the page.

**Detection no longer misses regions the GPL detector found**, because it is
that detector again: 100% recall against `fixtures/baseline.json` on all three
baselined pages, where the Apache-2.0 replacement measured 92.3%. Read the 100%
as "the port is faithful" rather than as a comparison — the baseline is this
model's own output. See the bake-off README.
