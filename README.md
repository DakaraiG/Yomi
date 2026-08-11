# Yomi sidecar — v0.1

Detection + OCR only. Thin, stateless, one endpoint that matters.

Everything interesting — orchestration, caching, glossary state, LLM calls —
lives in ASP.NET Core and is deliberately not here.

## Licence note

`comic-text-detector` and its weights are **GPL-3.0**. This sidecar therefore
is too. That is fine and in fact load-bearing: GPL obligations trigger on
distribution, and this process runs only on your machine. The browser
extension — the one artefact that ever touches an Apple developer account —
contains no GPL code. Keep it that way.

`manga-ocr` is Apache-2.0.

## Setup

```bash
python -m venv .venv && source .venv/bin/activate   # Python 3.10+
pip install -r requirements.txt
```

### Detector weights

`comic-text-detector` is dormant (last commit Aug 2023) and not packaged.
Vendor it:

```bash
git clone https://github.com/dmMaze/comic-text-detector vendor/comic-text-detector
```

Weights are **not** in that repo. Pull `comictextdetector.pt` from the
`manga-image-translator` release tag `beta-0.2.1`, or the Google Drive
mirror linked in the detector README, into `weights/`.

```bash
export YOMI_CTD_PATH=$PWD/vendor/comic-text-detector
export YOMI_CTD_MODEL=$PWD/weights/comictextdetector.pt
```

### OCR weights

Downloaded automatically on first run from `kha-white/manga-ocr-base`
(444 MB, several minutes). Nothing to do.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `YOMI_CTD_PATH` | **yes** (real detector) | — | Directory of the vendored `comic-text-detector` checkout. Prepended to `sys.path` so `inference.py` is importable. |
| `YOMI_CTD_MODEL` | **yes** in practice | `weights/comictextdetector.pt` | Path to the detector weights file. The default is relative, so it only resolves when the process starts from the repo root. |
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

Sets `YOMI_CTD_PATH` and `YOMI_CTD_MODEL` relative to the repo root (so it
works from any cwd), then starts uvicorn on port 8001. Any variable already
exported in your shell wins, and `YOMI_PORT` overrides the port.

Equivalently, by hand:

```bash
uvicorn app.main:app --reload --port 8001
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

```bash
python -c "import base64,sys;print(base64.b64encode(open(sys.argv[1],'rb').read()).decode())" page.jpg > /tmp/p.b64
curl -s -X POST localhost:8001/detect \
  -H 'content-type: application/json' \
  -d "{\"imageB64\":\"$(cat /tmp/p.b64)\"}" | jq

curl -s -X POST localhost:8001/detect/debug \
  -H 'content-type: application/json' \
  -d "{\"imageB64\":\"$(cat /tmp/p.b64)\"}" --output /tmp/debug.png
```

## Running without weights

```bash
YOMI_DETECTOR=stub YOMI_OCR=stub uvicorn app.main:app --port 8001
```

Fixed boxes, fixed text, no downloads. For wiring up the extension or .NET
layer without waiting on models. Neither `YOMI_CTD_*` variable is read on this
path, so the validation above does not fire.

## Tests

```bash
pytest -q
```

Covers reading-order banding (including the cases a naive `(y, -x)` sort gets
wrong) and the response contract.

Everything above runs on stubs, which is the point — but it means the suite
stays green while the real backend cannot even be imported. The one test that
covers the vendored import chain is skipped unless `YOMI_CTD_PATH` is set:

```bash
YOMI_CTD_PATH=$PWD/vendor/comic-text-detector \
YOMI_CTD_MODEL=$PWD/weights/comictextdetector.pt \
pytest -q
```

That takes the suite from 7 passed / 1 skipped to 8 passed.

## Exit criteria

On 10 varied pages: ≥90% of speech bubbles detected, OCR visually correct on a
manual read-through of `/detect/debug` output.

Judge reading order from the numbered debug PNGs, not from JSON. If the
numbering is scrambled on multi-panel rows, that is the panel-segmentation
[OPEN] question arriving early — tune `band_threshold` in `ordering.py`
first before reaching for real segmentation.

**If OCR accuracy is poor here, the project is dead.** That is why this is
v0.1 and why nothing else has been built yet.
