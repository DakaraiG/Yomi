# Yomi sidecar — v0.3.1

Detection, reading order, and OCR only. Thin, stateless, one endpoint that
matters.

Everything interesting — orchestration, caching, glossary state, LLM calls —
lives in ASP.NET Core and is deliberately not here. See `../backend/README.md`.
Rendering is the Chrome extension's job; see `../extension/README.md`.

## Where things live

This directory holds the sidecar's own code. The heavy shared assets stay at
the **repo root**, one level up, and are shared with nothing else — they are
simply too large and too licence-encumbered to sit inside a source tree:

```
Yomi/
├── .venv/      <- Python env      (repo root, NOT sidecar/.venv)
├── vendor/     <- GPL checkout    (repo root)
├── weights/    <- model weights   (repo root)
├── sidecar/    <- you are here
├── backend/    <- ASP.NET Core
└── extension/  <- Chrome MV3
```

Commands below are written to be run **from this directory** (`sidecar/`), and
say `../` where they reach up to the root. `run.sh` resolves all of this
itself, so `./run.sh` works from anywhere.

## Licence note

`comic-text-detector` and its weights are **GPL-3.0**. This sidecar therefore
is too. That is fine and in fact load-bearing: GPL obligations trigger on
distribution, and this process runs only on your machine. The browser
extension — the one artefact that ever touches a store review or an Apple
developer account — contains no GPL code. Keep it that way.

`manga-ocr` is Apache-2.0.

The backend and the extension are both **MIT**, which they can only stay
because nothing on either side links anything from here. The GPL stops at the
HTTP seam — see `../README.md` for why the boundary sits there and what each
side may and may not link against.

## Setup

The venv lives at the repo root, so create it there — not in `sidecar/`:

```bash
cd ..                                               # repo root
python -m venv .venv && source .venv/bin/activate   # Python 3.10+
pip install -r sidecar/requirements.txt
```

### Detector weights

`comic-text-detector` is dormant (last commit Aug 2023) and not packaged.
Vendor it **into the repo root**:

```bash
cd ..                                               # repo root
git clone https://github.com/dmMaze/comic-text-detector vendor/comic-text-detector
```

Weights are **not** in that repo. Pull `comictextdetector.pt` from the
`manga-image-translator` release tag `beta-0.2.1`, or the Google Drive
mirror linked in the detector README, into `weights/` at the repo root.

You do not need to export anything if you start via `./run.sh` — it sets both
variables for you. To set them by hand, from `sidecar/`:

```bash
export YOMI_CTD_PATH=$PWD/../vendor/comic-text-detector
export YOMI_CTD_MODEL=$PWD/../weights/comictextdetector.pt
```

Both are **directory/file paths on your machine**, not URLs.

### OCR weights

Downloaded automatically on first run from `kha-white/manga-ocr-base`
(444 MB, several minutes). Nothing to do.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `YOMI_CTD_PATH` | **yes** (real detector) | — | Directory of the vendored `comic-text-detector` checkout. Prepended to `sys.path` so `inference.py` is importable. |
| `YOMI_CTD_MODEL` | **yes** in practice | `weights/comictextdetector.pt` | Path to the detector weights file. The default is relative, so it only resolves when the process starts from the repo root — which it no longer does. Use `run.sh`, which passes an absolute path. |
| `YOMI_DETECTOR` | no | `comic-text-detector` | `stub` for fixed boxes and no weights. |
| `YOMI_OCR` | no | `manga-ocr` | `stub` for fixed text and no download. |
| `YOMI_DEVICE` | no | `cpu` | `cuda`, or `mps` on Apple silicon. |

`app/detector.py` validates both `YOMI_CTD_*` variables before importing
anything from the vendored repo, and raises a `RuntimeError` naming the
variable and the path it tried. It covers four cases: `YOMI_CTD_PATH` unset,
that directory not existing, `inference.py` missing from inside it, and the
`YOMI_CTD_MODEL` file not existing.

This exists because all four used to surface identically, as
`ModuleNotFoundError: No module named 'inference'` raised three frames deep
inside the adapter's constructor — an error that points at the vendored
repo's internals and says nothing about the unset variable that caused it.

## The `_ctd_compat.py` shim

**`app/_ctd_compat.py` is load-bearing.** `ComicTextDetector.__init__` calls
its `apply()` immediately before the first vendored import, and without it
that import chain does not survive a 2026 virtualenv. It is not dead code and
it is not optional.

The vendored repo targets roughly Python 3.9 / NumPy 1.x / setuptools <81.
The fixes live here rather than in `vendor/` for two reasons: edits to a GPL
checkout are lost the moment anyone re-clones it (which is a routine thing to
do, and nothing warns you that it reverted a fix), and keeping the vendored
tree pristine keeps the licence story simple.

What it patches, all four being straight restorations of something upstream
removed:

| Shim | Why |
|---|---|
| `pkg_resources` | setuptools ≥81 dropped it. `utils/yolov5_utils.py` imports it only for `parse_version`, used by a `torch >= 1.10` meshgrid check. Backed by `packaging.version.parse`, the documented successor. |
| `torchsummary` | `basemodel.py` imports `summary` at module scope but calls it only under `if __name__ == '__main__'` — the training entry point, which Yomi never runs. Unmaintained since 2018, so the import is satisfied rather than installed. |
| `wandb` | `utils/general.py` imports it at module scope, and `basemodel.py` pulls `CUDA`/`DEVICE` from that module — so an unimportable `wandb` takes down the whole detector. Only ever referenced by the training `Loggers` class. |
| NumPy 2 aliases | `np.bool8` → `np.bool_`, `np.float_` → `np.float64`, `np.int0` → `np.intp`. Each maps to the exact type the alias stood for, so behaviour is unchanged. |

`requirements.txt` also pins `setuptools<81`, which makes the `pkg_resources`
shim redundant on a clean install. The shim stays because the pin does not
bind everywhere — a pre-existing venv, or a newer setuptools pulled in as a
build dependency, both put you back on the shim.

`apply()` is idempotent and safe to call before every vendored import. If a
shim ever needs to do more than restore something upstream deleted, that is
the signal to swap the detector backend instead — see the module docstring in
`app/detector.py`.

## Run

```bash
./run.sh
```

Resolves its own location, walks one level up to the repo root, and sets
`YOMI_CTD_PATH` / `YOMI_CTD_MODEL` to absolute paths under it — so it works
from any cwd. Then starts uvicorn on port 8001. Any variable already exported
in your shell wins, and `YOMI_PORT` overrides the port.

Startup takes ~8s (model loading) and prints
`models ready in Ns (detector=comic-text-detector ocr=manga-ocr)` when live.

Equivalently, by hand — note this must run from `sidecar/`, and needs the two
variables above already exported:

```bash
../.venv/bin/uvicorn app.main:app --reload --port 8001
```

Set `YOMI_DEVICE=cuda` (or `mps` on Apple silicon) if you have it. CPU works;
it is just slow enough to be annoying during the spike.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Which backends actually loaded |
| `POST` | `/detect` | `{imageB64}` → ordered regions |
| `POST` | `/detect/debug` | Same, returns a PNG with boxes + order numbers |

Polygons are normalised 0–1 against natural dimensions. Nothing downstream
should ever see a pixel coordinate.

### Easiest way to poke it

`try_page.py`, at the repo root, wraps both endpoints. Its argument is an
image file on your machine, not a URL:

```bash
../try_page.py ~/Downloads/page.jpg
```

It prints reading order + OCR text, writes the annotated render alongside the
input as `<name>.debug.png`, and opens it. `--no-open` suppresses that.
Judge reading order from this PNG, not from the JSON.

### By hand

```bash
python -c "import base64,sys;print(base64.b64encode(open(sys.argv[1],'rb').read()).decode())" page.jpg > /tmp/p.b64
curl -s -X POST localhost:8001/detect \
  -H 'content-type: application/json' \
  -d "{\"imageB64\":\"$(cat /tmp/p.b64)\"}" | jq

curl -s -X POST localhost:8001/detect/debug \
  -H 'content-type: application/json' \
  -d "{\"imageB64\":\"$(cat /tmp/p.b64)\"}" --output /tmp/debug.png
```

## Reading order

Reading order is **panel-major**: you finish one panel before starting the next,
panels run right-to-left within a row, rows top-to-bottom. That needs panel
boundaries, and panel boundaries are not recoverable from box geometry. On the
`ynko` test page the widest gap between boxes (113px) is not a border, the real
gutter between rows is 28px, and a 61px gap *inside* row 1 exceeds the 49px gap
that actually separates rows 1 and 2. Any "big gap = panel edge" rule gets that
page wrong.

So `app/panels.py` goes to the image and finds the drawn borders:

1. Split a double-page spread down its central gutter, **right page first**.
   Both a landscape aspect and a wide full-height white column are required — an
   aligned single-page panel grid produces the column on its own, and splitting
   on it would order the page column-major.
2. Split each page into vertical strips on full-height white columns. A strip
   with no drawn border in it is *furniture* — margin commentary, character
   sidebars — not panels.
3. Split the panel-bearing strips into rows on scanlines that are >98% white.
4. Split each row into panels on columns that are >99% white **and flanked
   within ~6px by a <25%-white column**, i.e. by a drawn border.

Step 4's flanking test is what makes this work. Artwork whitespace produces
plenty of white columns — 9 in row 3 of the single-page test — and none are
flanked by borders, so all 9 are correctly rejected. Without it every one
becomes a false gutter.

`app/ordering.py` then sorts, with two entry points kept deliberately separate:

| | |
|---|---|
| `reading_order()` | Pure geometry, no image. Bands regions into rows and sorts each row right-to-left. Used *inside* a panel, and as the fallback when panel detection comes up empty (borderless or blank page) |
| `panel_reading_order()` | The real thing. Needs the page image |

Furniture is placed by where it falls: above the panel block (a page title)
reads first, beside or below it reads last.

**Every threshold in `panels.py` is provisional**, validated against two images
— one page (17/17 regions correctly ordered) and one spread. Two of them have
non-obvious floors worth knowing before tuning: borders sit hard against the
gutters, so the surviving pure-white run is only 3–5px even where the gutter
looks wide (`MIN_GUTTER_PX` must stay ≤2), and scans carry a dark strip along
the sheet edges that caps *every* column at ~0.994 white (a literal full-height
test finds nothing at all on a real page).

## Running without weights

```bash
YOMI_DETECTOR=stub YOMI_OCR=stub ../.venv/bin/uvicorn app.main:app --port 8001
```

Fixed boxes, fixed text, no downloads. For wiring up the extension or .NET
layer without waiting on models. Neither `YOMI_CTD_*` variable is read on this
path, so the validation above does not fire.

## Tests

From `sidecar/`:

```bash
pytest -q
```

17 tests: 6 on geometric banding (including the cases a naive `(y, -x)` sort
gets wrong), 8 on panel segmentation and panel-major order (artwork whitespace
is not a gutter, sidebars are furniture and read last, a spread orders the right
page first, a single-page grid is not mistaken for a spread, a blank page falls
back to geometry), 2 on the response contract, and 1 on the real detector.

`conftest.py` in this directory is empty on purpose: its presence is what puts
`sidecar/` on `sys.path`, so `import app` resolves under a bare `pytest`. Without
it pytest prepends `sidecar/tests/` instead and collection dies with
`ModuleNotFoundError: No module named 'app'`. Deleting it means every invocation
has to be `python -m pytest` instead.

Everything above runs on stubs, which is the point — but it means the suite
stays green while the real backend cannot even be imported. The one test that
covers the vendored import chain is skipped unless `YOMI_CTD_PATH` is set:

```bash
YOMI_CTD_PATH=$PWD/../vendor/comic-text-detector \
YOMI_CTD_MODEL=$PWD/../weights/comictextdetector.pt \
pytest -q
```

That takes the suite from 16 passed / 1 skipped to **17 passed**.

## Exit criteria

On 10 varied pages: ≥90% of speech bubbles detected, OCR visually correct on a
manual read-through of `/detect/debug` output.

Judge reading order from the numbered debug PNGs, not from JSON. Scrambled
numbering on multi-panel rows is now a `panels.py` problem rather than a
banding one: check whether the page's borders were found at all before reaching
for `BAND_THRESHOLD` in `ordering.py`. A page whose panels are not detected
falls back to pure geometry silently and correctly — it just reads in the wrong
order.

**If OCR accuracy is poor here, the project is dead.** That was why v0.1 was
this and nothing else.

That gate has since been cleared well enough to build on — v0.2 added the
backend and a working end-to-end translation, v0.3 the extension and the
overlay — but it has **not** been formally signed off against the 10-page
criterion above. Spot checks on real pages show
clean OCR inside speech bubbles and degraded OCR on dense handwritten
marginalia, which the model then reports as low confidence rather than
inventing text. Running the full 10 pages is still outstanding.
