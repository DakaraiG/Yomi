// Generate a synthetic manga-ish page.
//
// NOT a substitute for real fixtures -- it has none of what makes manga hard
// (screentone, stylised lettering, art that looks like text). It exists so the
// harness itself can be proven to run end to end before Dak's pages arrive, and
// so a regression in the plumbing is distinguishable from a regression in a
// detector.
//
//   node make-synthetic.mjs [out.png]

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas } from "@napi-rs/canvas";

const HERE = dirname(fileURLToPath(import.meta.url));

const W = 1400, H = 2000;

// Four bordered panels in two rows, mid-grey inside. The grey matters for the
// same reason it does in the Python panel tests: an empty white interior leaves
// scanlines through the panel >98% white, and the row split cuts it in half.
const PANELS = [
  [60, 60, 680, 960], [720, 60, 1340, 960],
  [60, 1000, 680, 1940], [720, 1000, 1340, 1940]
];

// Vertical Japanese in bubbles, one or two per panel.
const BUBBLES = [
  { cx: 200, cy: 260, rx: 105, ry: 175, text: "こんにちは" },
  { cx: 520, cy: 700, rx: 95, ry: 150, text: "ねこです" },
  { cx: 900, cy: 240, rx: 110, ry: 190, text: "ありがとう" },
  { cx: 1200, cy: 640, rx: 90, ry: 145, text: "そうだね" },
  { cx: 220, cy: 1250, rx: 100, ry: 170, text: "まってよ" },
  { cx: 500, cy: 1720, rx: 105, ry: 180, text: "たべもの" },
  { cx: 980, cy: 1300, rx: 115, ry: 200, text: "おはよう" },
  { cx: 1230, cy: 1750, rx: 95, ry: 155, text: "またね" }
];

const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");

ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, W, H);

for (const [x0, y0, x1, y1] of PANELS) {
  ctx.fillStyle = "#b4b4b4";
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 3;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

// A white blob inside a panel: a perfect false gutter for the panel splitter,
// except that nothing dark flanks it. Mirrors the Python test of the same name.
ctx.fillStyle = "#ffffff";
ctx.beginPath();
ctx.ellipse(400, 500, 60, 300, 0, 0, Math.PI * 2);
ctx.fill();

ctx.textAlign = "center";
ctx.textBaseline = "middle";

for (const b of BUBBLES) {
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Set the kana as a vertical column, which is the layout that matters here --
  // a horizontal-line detector has to be talked out of merging columns, and a
  // synthetic page with horizontal text would hide that entirely.
  ctx.fillStyle = "#000000";
  ctx.font = "bold 42px sans-serif";
  const chars = [...b.text];
  const step = 50;
  const top = b.cy - ((chars.length - 1) * step) / 2;
  chars.forEach((ch, i) => ctx.fillText(ch, b.cx, top + i * step));
}

// SFX over artwork, no bubble. comic-text-detector misses these too -- the
// brief calls that expected and acceptable -- so it is here to confirm that a
// candidate finding it counts as a bonus, not as a false positive.
ctx.save();
ctx.translate(340, 1600);
ctx.rotate(-0.2);
ctx.fillStyle = "#ffffff";
ctx.strokeStyle = "#000000";
ctx.lineWidth = 6;
ctx.font = "bold 90px sans-serif";
ctx.strokeText("ドーン", 0, 0);
ctx.fillText("ドーン", 0, 0);
ctx.restore();

const target = process.argv[2] ?? join(HERE, "..", "..", "fixtures", "pages", "synthetic-01.png");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, canvas.toBuffer("image/png"));
console.log(`wrote ${target} (${W}x${H}, ${BUBBLES.length} bubbles + 1 on-art SFX)`);
