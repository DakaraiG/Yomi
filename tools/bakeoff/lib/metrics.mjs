// Bake-off metrics.
//
// Recall is coverage -- how much of a baseline box is covered by the union of
// the candidate boxes -- not IoU. The baseline returns one box per text block
// while the candidates return one per line, so a bubble of three columns scores
// an IoU around 0.3 per box and looks missed when it was found perfectly.
// Coverage is merge-independent, which keeps the metric about detection rather
// than about how well the crude block-merge heuristic happens to work.

/** Fraction of `target`'s area covered by the union of `boxes`. */
export function coverageOf(target, boxes) {
  const w = Math.max(1, Math.round(target.x1 - target.x0));
  const h = Math.max(1, Math.round(target.y1 - target.y0));
  if (w * h === 0) return 0;

  // Rasterising the union is exact and needs no interval algebra; the capped
  // resolution keeps a full-page baseline box from allocating megapixels.
  const scale = Math.min(1, Math.sqrt(250_000 / (w * h)));
  const gw = Math.max(1, Math.round(w * scale));
  const gh = Math.max(1, Math.round(h * scale));
  const grid = new Uint8Array(gw * gh);

  const clamp = (v, hi) => Math.max(0, Math.min(hi, v));

  for (const b of boxes) {
    // Both ends must be clamped, and non-overlapping boxes must bail: a box
    // entirely left of the target gives a negative x1, and TypedArray.fill
    // reads a negative `end` as an offset from the end of the array, so the row
    // fills almost entirely and scores ~100% coverage of a region it never
    // touches.
    const x0 = clamp(Math.floor((b.x0 - target.x0) * scale), gw);
    const x1 = clamp(Math.ceil((b.x1 - target.x0) * scale), gw);
    const y0 = clamp(Math.floor((b.y0 - target.y0) * scale), gh);
    const y1 = clamp(Math.ceil((b.y1 - target.y0) * scale), gh);
    if (x1 <= x0 || y1 <= y0) continue;

    for (let y = y0; y < y1; y++) {
      grid.fill(1, y * gw + x0, y * gw + x1);
    }
  }

  let covered = 0;
  for (let i = 0; i < grid.length; i++) covered += grid[i];
  return covered / grid.length;
}

function intersects(a, b) {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Grouping quality: did the line-to-block step recover the baseline's regions?
 *
 * Detection recall says nothing about this: a candidate can find every glyph on
 * the page, weld four bubbles into one region, and still report 100% coverage.
 *
 * Scored through the lines rather than by comparing boxes, since the question is
 * whether two lines that shared a baseline region ended up together. Each line
 * is assigned to the baseline region it overlaps most; lines overlapping nothing
 * are ignored, the baseline having missed that text.
 *
 *   split    a baseline region whose lines ended up in more than one block
 *   welded   a block holding lines from more than one baseline region
 *   exact    a baseline region matched 1:1 by a block, with nothing else in it
 */
export function scoreGrouping(baseline, lines, blocks) {
  const overlapArea = (a, b) => {
    const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    return w > 0 && h > 0 ? w * h : 0;
  };

  // line -> baseline region
  const lineRegion = lines.map((line) => {
    let best = -1, bestArea = 0;
    baseline.forEach((region, r) => {
      const area = overlapArea(line, region);
      if (area > bestArea) { bestArea = area; best = r; }
    });
    return best;
  });

  // line -> block
  const lineBlock = new Int32Array(lines.length).fill(-1);
  blocks.forEach((block, b) => {
    for (const m of block.members ?? []) lineBlock[m] = b;
  });

  const regionBlocks = baseline.map(() => new Set());
  const blockRegions = blocks.map(() => new Set());

  for (let i = 0; i < lines.length; i++) {
    const r = lineRegion[i];
    const b = lineBlock[i];
    if (r === -1 || b === -1) continue;
    regionBlocks[r].add(b);
    blockRegions[b].add(r);
  }

  const seen = regionBlocks.filter((s) => s.size > 0);
  const split = seen.filter((s) => s.size > 1).length;
  const welded = blockRegions.filter((s) => s.size > 1).length;
  const exact = regionBlocks.filter(
    (s, r) => s.size === 1 && blockRegions[[...s][0]].size === 1 && regionBlocks[r].size === 1
  ).length;

  return {
    regionsWithLines: seen.length,
    blocks: blocks.length,
    split,
    welded,
    exact,
    exactRate: seen.length ? exact / seen.length : null
  };
}

/**
 * @param {Array} baseline   comic-text-detector boxes, pixel coords
 * @param {Array} candidate  boxes under test, pixel coords
 * @param {number} [threshold=0.5]  coverage at which a baseline box counts found
 */
export function score(baseline, candidate, threshold = 0.5) {
  const perBaseline = baseline.map((b) => ({
    box: b,
    coverage: coverageOf(b, candidate)
  }));

  const found = perBaseline.filter((r) => r.coverage >= threshold);

  // A spurious-box smell test, not precision: there is no ground truth for text
  // the baseline itself missed, which on-art SFX routinely is.
  const onBaseline = candidate.filter((c) => baseline.some((b) => intersects(b, c)));

  return {
    baselineCount: baseline.length,
    candidateCount: candidate.length,
    recall: baseline.length ? found.length / baseline.length : null,
    found: found.length,
    missed: perBaseline
      .filter((r) => r.coverage < threshold)
      .map((r) => ({ box: r.box, coverage: Number(r.coverage.toFixed(3)) })),
    offBaselineCount: candidate.length - onBaseline.length,
    meanCoverage: perBaseline.length
      ? perBaseline.reduce((s, r) => s + r.coverage, 0) / perBaseline.length
      : null
  };
}
