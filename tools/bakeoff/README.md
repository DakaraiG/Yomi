# Detector bake-off — v0.4 Phase 1

Compares replacements for `comic-text-detector` on real manga pages, so the
choice can be made by looking at renders rather than by trusting a number.

**This harness does not pick a winner.** It measures and it draws. "Good enough"
for an overlay is a judgement about *which* misses matter — a missed on-art SFX
is nothing, a missed speech bubble is a hole in the page — and that judgement is
Dak's.

## Why there is a bake-off at all

`comic-text-detector` is GPL-3.0. That single fact is what forced v0.3's
three-process architecture: anything linking it inherits the licence, so
detection had to live in its own process behind an HTTP seam. Replacing it with
an MIT/Apache-2.0/BSD detector collapses the whole thing into one extension.

**Licence is a hard gate.** A GPL candidate is disqualified regardless of
quality — it rebuilds the wall the rewrite exists to remove.

## Setup

```bash
cd tools/bakeoff
npm install          # onnxruntime-node + @napi-rs/canvas, dev-only
node fetch-models.mjs
```

Models land in `weights/bakeoff/` (gitignored, ~200MB total). The shipped
extension keeps no npm dependencies; nothing here goes into it.

## The three steps

### 1. The baseline — already captured, and not cheaply recreated

`fixtures/baseline.json` holds what `comic-text-detector` found on the fixture
pages: pixel-space boxes in the sidecar's own reading order, plus its manga-ocr
transcription — the only ground truth for the Japanese this project will ever
have. Every recall number here is measured against it, and it is committed.

**`sidecar/` was removed in v0.4, so `baseline.mjs` cannot just be re-run.**
Regenerating means going back to the tag and rebuilding a Python environment
with a GPL detector in it:

```bash
git checkout v0.3-server-architecture
cd sidecar && ./run.sh                     # terminal 1
cd tools/bakeoff && node baseline.mjs      # terminal 2
```

`baseline.mjs` is kept for exactly that path, and for adding fixture pages
later. Day to day, treat the committed `baseline.json` as the artefact.

### 2. Run the candidates

```bash
node run.mjs                                  # everything
node run.mjs --only paddle-1536,craft-1536
node run.mjs --page ynko-01.jpg
```

### 3. Look at the renders

`fixtures/out/`:

| File | What |
|---|---|
| `<page>.<candidate>.png` | Numbered boxes, red — as `/detect/debug` drew them |
| `<page>.<candidate>.cmp.png` | The same, plus the baseline in dashed blue |
| `results.json` | Every number behind the summary table |

## Candidates

Measured recall, after the coverage bug below was fixed (mean over the three
fixture pages, 0.5 coverage threshold):

| Candidate | Recall | Blocks | ms |
|---|---|---|---|
| `paddle-1536` | **92.3%** | 24 | 253 |
| `paddle-960` | 91.9% | 26 | 138 |
| `paddle-server-1536` | 88.5% | 26 | 4767 |
| `paddle-2048` | 85.7% | 24 | 400 |
| `classical` | 74.9% | 27 | 91 |
| `craft-1536` | 74.7% | 25 | 4245 |
| `craft-2048` | 73.4% | 24 | 7057 |

> **These numbers were once much higher, and wrong.** `coverageOf` clamped only
> one end of each axis, so a candidate box lying entirely to the LEFT of a
> baseline box produced a negative `x1` — and `TypedArray.fill` treats a
> negative `end` as an offset from the end of the array, not as an empty range.
> The row fill then ran across most of the grid and scored ~100% coverage of a
> region the box does not touch. Non-overlap in `y` escaped it, because that
> produced an empty *loop* rather than an empty *fill*, which is why it survived
> visual checks: the renders looked right, and only the numbers lied. It was
> caught by an assertion that could not be true — a region with 0.999 coverage
> and zero overlapping boxes.
>
> Grouping metrics were never affected; `scoreGrouping` computes overlap
> directly.

| Name | Licence | Notes |
|---|---|---|
| `classical` | none | No model at all. A bubble is a closed light region bounded by a dark contour; flood the light pixels and the page margin is the one component touching the edge. Cannot see on-art SFX or bubbles that bleed off a panel |
| `paddle-960` / `-1536` / `-2048` | Apache-2.0 | PaddleOCR DB head, mobile. 4.7MB, the shippable one |
| `paddle-server-1536` | Apache-2.0 | Same architecture, 113MB. Not shippable — it is here to separate "the mobile model is too small" from "DB is wrong for manga" |
| `craft-1536` / `-2048` | MIT | Scores characters and their affinity rather than assuming horizontal lines, which is in principle the right shape for vertical Japanese |
| `ctd-blk` / `-det` / `-union` / `-fused` | GPL-3.0 | comic-text-detector, the model that produced the baseline. Four entries because it has two box heads: `blk` gives blocks, `det` gives lines, `union` is both, `fused` is lines plus the blocks no line landed in. `fused` is what ships |

**The GPL gate was lifted once, for `ctd`, deliberately.** Everything above it
was chosen under a hard rule — a GPL candidate is disqualified regardless of
quality, because it rebuilds the wall the v0.4 rewrite exists to remove. The
rule was written about *boxes*, and it held: PaddleOCR won that comparison and
shipped. What reopened it is that the overlay stopped covering the Japanese and
started erasing it, which needs a per-pixel glyph mask, and no permissive
detector has one. The wall does not come back — no GPL code is linked, the
weights are fetched at install time — but the obligation is real. The rule still
stands for every future candidate.

### Scoring `ctd` against a baseline `ctd` produced

`fixtures/baseline.json` is comic-text-detector's own output from the v0.3
sidecar, so its recall column is **partly circular** and 100% means "the ONNX
port is faithful", not "the model is better". Read the grouping columns instead,
which are a real measurement of box geometry through `group.js`:

| | recall | exact grouping, per page | ms |
|---|---|---|---|
| `paddle-1536` | 92.3% | 87.5 / 92.3 / 86.4 | 260 |
| `ctd-blk` | 85.7% | 100 / 100 / 100 — but 3 regions short on ynko | 862 |
| `ctd-det` | 90.8% | 93.8 / 91.3 / 85.7 | 861 |
| `ctd-union` | 100% | 94.1 / 92.9 / 77.3 | 864 |
| `ctd-fused` | 100% | 94.1 / 92.9 / 86.4 | 852 |

`union` and `fused` find the same text; the difference is what they hand
`groupIntoBlocks`. `union` includes a whole-region box stacked on top of the
lines inside it, which is geometry that grouper has never been shown, and ynko3
splits three regions instead of one. `fused` adds a block box only where no line
was found at all.

`maxSide` is swept because it is the setting most often mistaken for the model.
PaddleOCR's own default caps the long edge at 960px — tuned for photographs of
signs, not for a 3000px page of small vertical kana. A candidate that looks
hopeless at 960 and fine at 2048 has told you about resolution, not architecture.

## The metric, and why it is not IoU

The obvious metric — match each baseline box to a candidate box by IoU — is
wrong here and would sink good candidates.

`comic-text-detector` returns one box per text **block**. PaddleOCR and CRAFT
return one per **line**. A bubble holding three vertical columns is one baseline
box and three candidate boxes, each scoring an IoU around 0.3 against it. By IoU
that bubble reads as missed. It was found perfectly.

So recall is measured by **coverage**: how much of each baseline box is covered
by the union of all candidate boxes, with 50% counting as found. That is
independent of how well the crude line→block merge happens to work, which keeps
the metric about detection rather than about a heuristic.

`offBaselineCount` — candidate boxes overlapping nothing in the baseline — is a
smell test, not a verdict. The baseline misses on-art SFX itself, so finding
text there is a bonus that shows up in this column.

## Fixtures

`fixtures/pages/` holds the test pages. They come from Dak and are committed so
comparisons are reproducible; `fixtures/out/` is generated and ignored.

`synthetic-01.png` is generated by `node make-synthetic.mjs` and is **not** a
substitute for real pages — it has none of what makes manga hard: screentone,
stylised lettering, artwork that looks like text. It exists so a break in the
plumbing is distinguishable from a regression in a detector. Both `classical`
and `paddle-1536` find 8/8 bubbles on it, which says the harness runs, and
nothing about manga.

## Tests

```bash
npm test        # 34 passing
```

Reading order, seriesId derivation, and a regression guard for the IndexedDB
hang that cost most of a debugging session. The synthetic ordering cases are
ported verbatim from
`sidecar/tests/test_pipeline.py` — copy the coordinates rather than
reconstructing them, or the fixture stops testing what it tested.

The one that matters is **real-page parity**: for each fixture page, the boxes
from `baseline.json` are shuffled deterministically, run through
`panelReadingOrder`, and must come back in the original order. That works
because the baseline stores regions in the sidecar's own reading order, so
recovering the identity permutation *is* agreement with the Python. All three
pages pass, which is what licensed deleting `sidecar/` in v0.4.

Note `pilRect` in the test file: PIL takes inclusive corners and draws its
outline inward, Canvas2D takes width/height and strokes centred on the path.
Porting the fixtures without reconciling that shifts every border by 1.5px,
which is inside the tolerance of some thresholds here and outside others.

## Grouping

Every MIT/Apache detector returns one box per text **line**;
`comic-text-detector` returned one per **block**, and blocks are what the
overlay and the Phase 3 handoff need. `extension/lib/group.js` closes that gap.

Detection recall says nothing about this — a candidate can find every glyph and
still weld four bubbles into one region while coverage reports 100%. So
`scoreGrouping` measures it separately, through the lines: two lines belong
together if and only if they were in the same baseline region.

| | |
|---|---|
| `exact` | baseline regions matched 1:1 by a block |
| `split` | a baseline region whose lines landed in more than one block |
| `weld` | a block holding lines from more than one baseline region |

```bash
node run.mjs --only paddle-1536 --grouper proximity   # the old placeholder
node run.mjs --only paddle-1536 --grouper structure   # the real one (default)
```

| page | proximity | structure | split | weld |
|---|---|---|---|---|
| ynko.jpg | 56.3% | **100.0%** | 0 | 0 |
| ynko2.jpg | 42.3% | **96.2%** | 1 | 0 |
| ynko3.jpg | 31.8% | **90.9%** | 0 | 1 |

Proximity alone chains: A near B near C near D welds a sidebar to a bubble two
panels away. Structure beats it because three of the signals are free, already
computed by segmentation, and answer questions geometry cannot:

| Signal | Settles |
|---|---|
| Panels | Two lines in different panels are never one region |
| Furniture strips | Two commentary columns 3px apart are two regions — a gap threshold cannot say so, because real column spacing inside a block is just as tight |
| Furniture bands | Three character bios stacked in one strip are three regions, cut on gutters at least a line-height tall (a blank line ends an item) |
| Bubble enclosure | Everything inside one drawn bubble belongs together |

**Two known failures remain, and they are left deliberately.** `ynko2` splits one
character bio; `ynko3` welds a double bubble whose two outlines touch, so it is
genuinely one light region. `BUBBLE_GAP_RATIO` trades one against the other and
no value fixes both — the sweep is recorded in `extension/lib/group.js`. Fitting
a further heuristic to two errors across three pages would be overfitting; the
fix is more pages, not more tuning.

## Reading order

`run.mjs` numbers boxes in manga reading order via `extension/lib/ordering.js`,
not in detection order. Connected-component output is raster order, which is
the exact opposite of how a manga page reads, and a render numbered that way
looks like an ordering bug when it is only an artefact of the harness.

## What ports onward

Written in JS against the Canvas2D API on purpose — the same calls exist in an
offscreen document, so this is not throwaway code:

| Here | Later |
|---|---|
| `lib/render.mjs` | Phase 3's numbered-box handoff. `HANDOFF` preset already there |
| `lib/components.mjs` | Connected components, needed by the panel port too |
| `lib/db-postprocess.mjs` | Whichever DB-headed model wins |
| `candidates/*.mjs` | The winner's pre/post-processing, moved into the extension |
