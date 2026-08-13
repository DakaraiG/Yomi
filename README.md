# Yomi

Reads Japanese manga in the browser: detects the text on a page, OCRs it,
translates it with a vision model, and hands back positioned English for an
overlay to draw.

**v0.2.** Detection, OCR, and translation work end to end. There is no browser
extension yet, and no rendering — the backend returns coordinates, and drawing
them is a later milestone.

## Layout

```
Yomi/
├── sidecar/     Python + FastAPI. Detection + OCR.        GPL-3.0
├── backend/     ASP.NET Core. Orchestration + LLM call.   AGPL-3.0
├── vendor/      GPL checkout of comic-text-detector       (gitignored)
├── weights/     Model weights, ~700MB                     (gitignored)
├── .venv/       Python env for the sidecar                (gitignored)
└── try_page.py  Poke the sidecar with one page
```

`vendor/`, `weights/`, and `.venv/` are **not in the repo** and are re-created by
setup. They sit at the root rather than inside `sidecar/` because they are large,
licence-encumbered, or both. Anything that needs them resolves upward from its
own location — see `sidecar/run.sh`.

## The two processes

Two programs, two ports, deliberately never merged:

```
extension (future)          browser
       │  POST /v1/translate
       ▼
backend  :5080   ASP.NET Core   AGPL-3.0   caching, prompt, OpenAI call
       │  POST /detect
       ▼
sidecar  :8001   FastAPI        GPL-3.0    comic-text-detector + manga-ocr
```

The backend calls the sidecar over HTTP. **Do not add a project reference
between them, and do not merge them.**

That seam is a licence boundary. `comic-text-detector` is GPL-3.0, so anything
linking it is too — which is why detection lives in its own process. The backend
links nothing GPL. The browser extension, the one artefact that would ever touch
an Apple developer account, must contain no GPL or AGPL code at all.

Note the two sides are **not** under the same licence: the sidecar is GPL-3.0
(forced), the backend AGPL-3.0 (chosen). AGPL triggers on network use, not just
distribution, which matters if the backend is ever hosted rather than run on
localhost. Details in [`backend/README.md`](backend/README.md).

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

**Try a page.** Detection and OCR only, with an annotated render:

```bash
./try_page.py ~/Downloads/page.jpg      # a file on your Mac, not a URL
```

Full translation goes through the backend — see
[`backend/README.md`](backend/README.md#trying-it).

## Tests

```bash
cd sidecar && pytest -q      # 16 passed, 1 skipped
```

The skipped one covers the vendored import chain and needs the detector env
vars; `sidecar/README.md` has the invocation that takes it to 17 passed.

The backend has no test suite yet.

## Status

| | |
|---|---|
| Detection + OCR | working, real weights |
| Translation | working, `gpt-5.6-luna` via the Responses API |
| Cost | ~$0.0022–0.0025 per page, dominated by image tokens |
| Caching | in-memory, 24h, lost on restart |
| Glossary | v0.4, not started — `glossaryVersion` is always 0 |
| Browser extension | not started |
| Rendering / overlay | not started |

`POST /v1/translate`'s request and response bodies are **frozen as of v0.2**.
Additive header changes are fine; body changes are not.
