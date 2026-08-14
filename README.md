# Yomi

Reads Japanese manga in the browser: detects the text on a page, OCRs it,
translates it with a vision model, and draws the English back over the artwork.

**v0.3.1.** End to end and usable. Click the toolbar button on a manga page and
the translation appears in place, fitted to the original bubbles. Chrome only,
manual trigger, everything on localhost. Glossary, prefetch, and Safari are
later milestones.

## Layout

```
Yomi/
├── sidecar/     Python + FastAPI. Detection + OCR.        GPL-3.0
├── backend/     ASP.NET Core. Orchestration + LLM call.   MIT
├── extension/   Chrome MV3. Retrieval + overlay.          MIT
├── vendor/      GPL checkout of comic-text-detector       (gitignored)
├── weights/     Model weights, ~700MB                     (gitignored)
├── .venv/       Python env for the sidecar                (gitignored)
└── try_page.py  Poke the sidecar with one page
```

`vendor/`, `weights/`, and `.venv/` are **not in the repo** and are re-created by
setup. They sit at the root rather than inside `sidecar/` because they are large,
licence-encumbered, or both. Anything that needs them resolves upward from its
own location — see `sidecar/run.sh`.

## The three processes

Three programs, two ports, deliberately never merged:

```
extension        Chrome MV3      MIT       image retrieval, overlay rendering
       │  POST /v1/translate
       ▼
backend  :5080   ASP.NET Core    MIT       caching, prompt, provider call
       │  POST /detect
       ▼
sidecar  :8001   FastAPI         GPL-3.0   comic-text-detector + manga-ocr
```

The backend calls the sidecar over HTTP. **Do not add a project reference
between them, and do not merge them.**

That seam is a licence boundary. `comic-text-detector` is GPL-3.0, so anything
linking it is too — which is why detection lives in its own process. The backend
links nothing GPL and is MIT, as is the extension. The extension in particular
is the one artefact that would ever go through a store review or an Apple
developer account, so it must contain no GPL code at all.

Division of labour, which the licence split happens to match exactly:

| | |
|---|---|
| extension | Finds the page image, gets its bytes, measures what is under each region, draws the result |
| backend | Hashes, caches, builds the prompt, calls the model, merges model text onto sidecar geometry |
| sidecar | Finds the boxes, reads them, puts them in reading order |

Geometry and reading order come from the sidecar and are never asked of the
model. Coordinates are normalised 0–1 the whole way through; nothing outside the
sidecar sees a pixel coordinate.

## Quickstart

Full setup is in each component's README — this is the short version, assuming
`vendor/`, `weights/`, and `.venv/` already exist.

**Terminal 1 — sidecar.** Takes ~8s to load models.

```bash
cd sidecar && ./run.sh
curl -s localhost:8001/health
# {"status":"ok","detector":"comic-text-detector","ocr":"manga-ocr","device":"cpu"}
```

If `detector` or `ocr` reads `stub`, the env vars aren't reaching it — fix that
rather than working around it. `run.sh` sets them for you.

**Terminal 2 — backend.** Needs an API key set once, see
[`backend/README.md`](backend/README.md).

```bash
cd backend/Yomi.Api && dotnet run --launch-profile http
curl -s localhost:5080/health
```

Port **5080**, not 5000 — macOS binds 5000 for AirPlay Receiver.

**Chrome — extension.** Load `extension/` unpacked at `chrome://extensions`
(Developer mode on → *Load unpacked* → pick the `extension/` folder, a directory
on your Mac, not a URL). Then open a manga page and click the Yomi toolbar
button. Details and troubleshooting in
[`extension/README.md`](extension/README.md).

**Try a page without the browser.** Detection and OCR only, with an annotated
render:

```bash
./try_page.py ~/Downloads/page.jpg      # a file on your Mac, not a URL
```

Full translation through the backend, still without the browser — see
[`backend/README.md`](backend/README.md#trying-it).

## Tests

```bash
cd sidecar && pytest -q                    # 16 passed, 1 skipped
cd backend/Yomi.Api.Tests && dotnet test   # 14 passed
```

The skipped Python test covers the vendored import chain and needs the detector
env vars; `sidecar/README.md` has the invocation that takes it to 17 passed.

The .NET suite boots the real API in memory and fakes only the two network
edges (sidecar, provider), so routing, JSON serialisation, merge logic, and
caching are all exercised for real. `dotnet test` must be run from
`backend/Yomi.Api.Tests/` — there is no solution file at `backend/`, so running
it a directory up fails with "Specify a project or solution file".

The extension has no automated tests; it is checked by using it, with the
console log and the toast as the instrumentation.

## Status

| | |
|---|---|
| Detection + OCR | working, real weights |
| Panel-aware reading order | working, thresholds validated on two pages |
| Translation | working, `gpt-5.6-luna` via the Responses API |
| Overlay rendering | working — fitted, uniform-size, shadow-DOM isolated |
| Image retrieval | three tiers: direct fetch → spoofed Referer → screenshot |
| Cost | ~$0.0022–0.0025 per page, dominated by image tokens |
| Caching | in-memory, 24h, lost on restart |
| Glossary | v0.4, not started — `glossaryVersion` is always 0 |
| Auto-trigger on scroll | v0.5, not started — the button is manual |
| Safari | not started |

`POST /v1/translate`'s request and response bodies are **frozen as of v0.2** and
unchanged in v0.3.1. Additive header changes are fine; body changes are not.
