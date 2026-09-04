// What does one page actually measure?
//
// Runs the shipped detector, grouping and reading order over a fixture page,
// then reports the surface each region sits on and the fill decision that
// follows. Exists so rendering questions get answered from the pixels rather
// than inferred from a screenshot.
//
//   node inspect-page.mjs ynko4.png [--render]

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";

import { loadRaster } from "./lib/image.mjs";
import { ctdCandidate } from "./candidates/ctd.mjs";
import { groupIntoBlocks } from "../../extension/lib/group.js";
import { panelReadingOrder } from "../../extension/lib/ordering.js";
import { measureBackground, stripStats, snapFill } from "../../extension/lib/surface.js";
import { shapeBox } from "../../extension/lib/layout.js";

// Kept in step with background.js by hand.

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");

const name = process.argv[2] ?? "ynko4.png";
const raster = await loadRaster(join(FIXTURES, "pages", name));
console.log(`${name}  ${raster.width}x${raster.height}`);

const detector = ctdCandidate({ label: "ctd-fused" });
await detector.init();
const lines = await detector.detect(raster);
// Exactly the call offscreen.js makes: panelReadingOrder takes tuples and
// returns indices into `blocks`.
const blocks = groupIntoBlocks(raster, lines);
const order = panelReadingOrder(raster, blocks.map((b) => [b.x0, b.y0, b.x1, b.y1]));
const ordered = order.map((i) => blocks[i]);
console.log(`${lines.length} line(s) -> ${blocks.length} block(s)`);

function crop(x, y, w, h) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(raster.width, Math.round(x + w));
  const y1 = Math.min(raster.height, Math.round(y + h));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  const out = new Uint8ClampedArray((x1 - x0) * (y1 - y0) * 4);
  let o = 0;
  for (let yy = y0; yy < y1; yy++) {
    const row = (yy * raster.width + x0) * 4;
    out.set(raster.data.subarray(row, row + (x1 - x0) * 4), o);
    o += (x1 - x0) * 4;
  }
  return out;
}
const probe = (x, y, w, h) => {
  const s = crop(x, y, w, h);
  return s ? stripStats(s) : null;
};

const boxes = ordered.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
const rows = [];
const shaped = [];

ordered.forEach((b, i) => {
  const box = boxes[i];
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const px = crop(box.x0, box.y0, w, h);
  if (!px) return;

  const m = measureBackground(px);
  const textured = !b.inBubble;
  const fill = snapFill(m.fill);
  const vertical = h > w;
  const s = shapeBox(box, {
    vertical, base: m, neighbours: boxes,
    imageW: raster.width, imageH: raster.height, probe
  });
  shaped.push({ box, s, textured });

  rows.push({
    i,
    at: `${Math.round(box.x0)},${Math.round(box.y0)}`,
    size: `${Math.round(w)}x${Math.round(h)}`,
    v: vertical ? "V" : "h",
    lum: m.bgLum,
    sd: m.bgStd,
    share: m.bgShare,
    peak: m.bgPeak,
    bub: b.inBubble === true,
    tex: textured,
    fill: fill.join(","),
    widen: +((s.x1 - s.x0) / w).toFixed(2)
  });
});

console.table(rows);
const texCount = rows.filter((r) => r.tex).length;
// Counts what the enclosure test found, which is what decides how far
// lib/layout.js may widen a box.
console.log(`${rows.length} regions — ${texCount} with no drawn bubble, ` +
            `${rows.length - texCount} inside one`);
console.log(`peak range ${Math.min(...rows.map(r => r.peak))} .. ` +
  `${Math.max(...rows.map(r => r.peak))}`);

if (process.argv.includes("--render")) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const canvas = createCanvas(raster.width, raster.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(join(FIXTURES, "pages", name)), 0, 0);
  ctx.lineWidth = 3;
  for (const { box, s, textured } of shaped) {
    // Green = inside a drawn bubble. Orange = no bubble around it.
    ctx.strokeStyle = textured ? "rgba(255,140,0,0.95)" : "rgba(0,190,0,0.95)";
    ctx.strokeRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
    ctx.strokeStyle = "rgba(255,0,0,0.6)";
    ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
  }
  const to = join(FIXTURES, "out", name.replace(/\.\w+$/, ".inspect.png"));
  await writeFile(to, canvas.toBuffer("image/png"));
  console.log("wrote", to);
}
