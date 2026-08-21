// Why did two neighbouring columns not become one block?
//
// Prints the adjacency test's own terms for every pair of detected lines inside
// a region of interest, so a grouping decision can be read off numbers rather
// than guessed at.
//
//   node why-no-merge.mjs ynko4.png 540 800     (page, yMin, yMax)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRaster } from "./lib/image.mjs";
import { ctdCandidate } from "./candidates/ctd.mjs";

const MIN_PARALLEL_OVERLAP = 0.35;
const ADJACENT_GAP_RATIO = 0.9;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");

const name = process.argv[2] ?? "ynko4.png";
const yMin = Number(process.argv[3] ?? 540);
const yMax = Number(process.argv[4] ?? 800);

const raster = await loadRaster(join(FIXTURES, "pages", name));
const detector = ctdCandidate({ label: "ctd-fused" });
await detector.init();
const all = await detector.detect(raster);

const lines = all
  .filter((l) => (l.y0 + l.y1) / 2 >= yMin && (l.y0 + l.y1) / 2 <= yMax)
  .sort((a, b) => b.x0 - a.x0);          // right to left, reading order

console.log(`${lines.length} line(s) with centre in y ${yMin}..${yMax}\n`);
console.table(lines.map((l, i) => ({
  i,
  box: `${Math.round(l.x0)},${Math.round(l.y0)} ${Math.round(l.x1 - l.x0)}x${Math.round(l.y1 - l.y0)}`
})));

// Every neighbouring pair, in reading order, with the test's own terms.
const rows = [];
for (let i = 0; i < lines.length - 1; i++) {
  const a = lines[i], b = lines[i + 1];
  const aw = a.x1 - a.x0, ah = a.y1 - a.y0;
  const bw = b.x1 - b.x0, bh = b.y1 - b.y0;

  const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const xGap = -xOverlap;

  const needOverlap = MIN_PARALLEL_OVERLAP * Math.min(ah, bh);
  const allowGap = ADJACENT_GAP_RATIO * Math.min(aw, bw);

  const overlapOk = yOverlap > 0 && yOverlap >= needOverlap;
  const gapOk = xGap <= allowGap;

  rows.push({
    pair: `${i}-${i + 1}`,
    yOverlap: Math.round(yOverlap),
    needs: Math.round(needOverlap),
    "overlap?": overlapOk,
    xGap: Math.round(xGap),
    allowed: Math.round(allowGap),
    "gap?": gapOk,
    merges: overlapOk && gapOk,
    // What ratio WOULD have been needed for each term to pass.
    ovlNeeded: +(yOverlap / Math.min(ah, bh)).toFixed(2),
    gapNeeded: +(xGap / Math.min(aw, bw)).toFixed(2)
  });
}
console.table(rows);

const blocked = rows.filter((r) => !r.merges);
console.log(`${blocked.length}/${rows.length} neighbouring pairs do NOT merge`);
console.log(`  blocked by overlap only: ${blocked.filter(r => !r["overlap?"] && r["gap?"]).length}`);
console.log(`  blocked by gap only:     ${blocked.filter(r => r["overlap?"] && !r["gap?"]).length}`);
console.log(`  blocked by both:         ${blocked.filter(r => !r["overlap?"] && !r["gap?"]).length}`);

// Which bubble bucket does each line land in? Two lines in different buckets
// cannot merge however adjacent they are -- the bucket is checked first.
const { bubbleMap, WHITE_LEVEL } = await import("../../extension/lib/group.js");
const bubbles = bubbleMap(raster);
function bucketOf(box) {
  const { labels, width, height } = bubbles;
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(width, Math.ceil(box.x1)), y1 = Math.min(height, Math.ceil(box.y1));
  const counts = new Map();
  const stepX = Math.max(1, Math.floor((x1 - x0) / 32));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 32));
  let sampled = 0;
  for (let y = y0; y < y1; y += stepY) {
    const row = y * width;
    for (let x = x0; x < x1; x += stepX) {
      sampled++;
      const id = labels[row + x];
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let best = 0, bestCount = 0;
  for (const [id, n] of counts) if (n > bestCount) { best = id; bestCount = n; }
  return { best, frac: sampled ? +(bestCount / sampled).toFixed(2) : 0 };
}
console.log("\nbubble bucket per line (different bucket => cannot merge):");
console.table(lines.map((l, i) => {
  const b = bucketOf(l);
  return { i, x: Math.round(l.x0), bubbleId: b.best, coverage: b.frac };
}));
