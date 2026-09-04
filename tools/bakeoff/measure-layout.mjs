// What does the box-widening probe actually do to real pages?
//
// Runs lib/layout.js over the fixture baseline's vertical regions using real
// pixels, and reports the aspect ratio before and after. The point is to tune
// TARGET_ASPECT / MAX_GROW against measured behaviour rather than to guess.
//
//   node measure-layout.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRaster } from "./lib/image.mjs";
import { measureBackground, stripStats } from "../../extension/lib/surface.js";
import { widenBox, shapeBox } from "../../extension/lib/layout.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "../../fixtures");

const baseline = JSON.parse(
  await readFile(join(fixtures, "baseline.json"), "utf8"));

/** Crop an RGBA raster to a rect, clamped to the image. */
function crop(raster, x, y, w, h) {
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

let grew = 0, total = 0;
const leaked = [];
const before = [], after = [];

for (const [name, page] of Object.entries(baseline.pages)) {
  const raster = await loadRaster(join(fixtures, "pages", name));
  const boxes = page.boxes.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));

  console.log(`\n== ${name}  ${page.width}x${page.height}`);
  const rows = [];

  page.boxes.forEach((b, i) => {
    if (!b.vertical) return;
    const box = boxes[i];
    const w = box.x1 - box.x0, h = box.y1 - box.y0;

    const px = crop(raster, box.x0, box.y0, w, h);
    if (!px) return;
    const base = measureBackground(px);

    const probe = (x, y, pw, ph) => {
      const strip = crop(raster, x, y, pw, ph);
      return strip ? stripStats(strip) : null;
    };

    const out = widenBox(box, {
      base, neighbours: boxes, imageW: page.width, probe
    });
    const nw = out.x1 - out.x0;

    total++;
    if (nw > w + 0.5) grew++;
    before.push(w / h); after.push(nw / h);

    // Widening may only stay on the surface it started on, so a grown box that
    // has drifted in colour or picked up the variance of artwork is the probe
    // having walked off a bubble.
    const grownPx = crop(raster, out.x0, out.y0, nw, h);
    const after2 = grownPx ? measureBackground(grownPx) : base;
    const drift = Math.abs(after2.bgLum - base.bgLum);
    const bad = nw > w + 0.5 && (drift > 0.05 || after2.bgStd > 0.10);
    if (bad) leaked.push(`${name} ${b.id}`);

    rows.push({
      id: b.id,
      w: Math.round(w),
      newW: Math.round(nw),
      grow: +(nw / w).toFixed(2),
      asp: +(w / h).toFixed(2),
      newAsp: +(nw / h).toFixed(2),
      lum: base.bgLum,
      drift: +drift.toFixed(3),
      sd: after2.bgStd,
      ok: bad ? "LEAK" : "",
      jp: b.japanese.slice(0, 12)
    });
  });
  console.table(rows);
}

const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(`\n${grew}/${total} vertical regions widened`);
console.log(`median aspect ${med(before).toFixed(2)} -> ${med(after).toFixed(2)}`);
console.log(`slivers (asp<0.25): ${before.filter((a) => a < 0.25).length}` +
            ` -> ${after.filter((a) => a < 0.25).length}`);
console.log(leaked.length
  ? `LEAKED off-surface: ${leaked.join(", ")}`
  : "no region leaked off its surface");

// Original box in red, widened box in green. The measurement above proves the
// grown box is one uniform surface; only the eye can say it is still inside the
// bubble.
if (process.argv.includes("--render")) {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const { writeFile } = await import("node:fs/promises");

  for (const [name, page] of Object.entries(baseline.pages)) {
    const raster = await loadRaster(join(fixtures, "pages", name));
    const boxes = page.boxes.map((b) => ({ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }));
    const canvas = createCanvas(page.width, page.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(await loadImage(join(fixtures, "pages", name)), 0, 0);
    ctx.lineWidth = 3;

    page.boxes.forEach((b, i) => {
      if (!b.vertical) return;
      const box = boxes[i];
      const w = box.x1 - box.x0, h = box.y1 - box.y0;
      const px = crop(raster, box.x0, box.y0, w, h);
      if (!px) return;
      const base = measureBackground(px);
      const probe = (x, y, pw, ph) => {
        const s = crop(raster, x, y, pw, ph);
        return s ? stripStats(s) : null;
      };
      const out = shapeBox(box, {
        vertical: b.vertical, base, neighbours: boxes,
        imageW: page.width, imageH: page.height, probe
      });
      ctx.strokeStyle = "rgba(255,0,0,0.9)";
      ctx.strokeRect(box.x0, box.y0, w, h);
      ctx.strokeStyle = "rgba(0,190,0,0.9)";
      ctx.strokeRect(out.x0, out.y0, out.x1 - out.x0, out.y1 - out.y0);
    });

    const to = join(fixtures, "out", name.replace(/\.jpg$/, ".widen.png"));
    await writeFile(to, canvas.toBuffer("image/png"));
    console.log("wrote", to);
  }
}
