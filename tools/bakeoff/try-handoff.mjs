// Phase 3 end-to-end: numbered render -> provider -> transcription + translation.
//
// This is the experiment that decides whether the rewrite's central bet pays
// off. v0.4 removed manga-ocr on the strength of one observation -- that the
// translation model transcribes the Japanese itself, unprompted. This script
// checks that it does so RELIABLY, KEYED TO THE RIGHT BOX, on a real page.
//
//   node try-handoff.mjs --page ynko.jpg
//   node try-handoff.mjs --page ynko.jpg --dry     print the request, call nothing
//
// COSTS MONEY AND LEAVES THE MACHINE. It uploads a page image to the provider
// and bills the account behind the key. --dry does everything except the call.
//
// The key comes from YOMI_API_KEY, or from the .NET user-secrets store the v0.3
// backend used (~/.microsoft/usersecrets/yomi-api/secrets.json). It is never
// printed, and never written to fixtures/out.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { loadRaster } from "./lib/image.mjs";
import { drawNumberedBoxes, HANDOFF } from "./lib/render.mjs";
import { ctdCandidate } from "./candidates/ctd.mjs";
import { buildRegions } from "./handoff.mjs";
import { translatePage, cacheKey, DEFAULTS } from "../../extension/lib/translate.js";
import { SYSTEM, buildUserText } from "../../extension/lib/prompt.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "..", "fixtures");
const OUT_DIR = join(FIXTURES, "out");

// $/1M tokens, from the v0.3 measurements. Reasoning bills as output.
const INPUT_RATE = 0.20 / 1e6;
const OUTPUT_RATE = 1.20 / 1e6;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function loadKey() {
  if (process.env.YOMI_API_KEY) return process.env.YOMI_API_KEY;
  const path = join(homedir(), ".microsoft", "usersecrets", "yomi-api", "secrets.json");
  try {
    // `dotnet user-secrets set` writes this file with a UTF-8 BOM, and
    // JSON.parse rejects a BOM outright -- "Unexpected token" on a file that
    // looks perfectly fine in an editor.
    const text = (await readFile(path, "utf8")).replace(/^﻿/, "");
    const secrets = JSON.parse(text);
    const key = secrets["Yomi:ApiKey"] ?? secrets?.Yomi?.ApiKey;
    if (key) return key;
  } catch { /* fall through to the message below */ }
  throw new Error(
    "No API key.\n" +
    "  export YOMI_API_KEY=sk-...\n" +
    "The v0.3 .NET user-secrets store is still read if it happens to exist, but\n" +
    "backend/ was removed in v0.4, so there is no longer a way to populate it.\n" +
    "The extension itself keeps its key in chrome.storage.local, set from the\n" +
    "options page; this harness cannot reach that.");
}

/** How close is the model's transcription to manga-ocr's, character by character? */
function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

/**
 * The baseline region this block corresponds to, by overlap AREA.
 *
 * Was centre distance, which is wrong for the shape manga actually produces: a
 * page-height margin column has its centre a long way from its own text and
 * close to whatever sits mid-page, so region 16 got compared against "ていっ！"
 * and reported a meaningless 0% match. Overlap cannot make that mistake.
 */
function nearestBaseline(box, baselineBoxes) {
  let best = null, bestArea = 0;
  for (const b of baselineBoxes) {
    const w = Math.min(box.x1, b.x1) - Math.max(box.x0, b.x0);
    const h = Math.min(box.y1, b.y1) - Math.max(box.y0, b.y0);
    if (w <= 0 || h <= 0) continue;
    if (w * h > bestArea) { bestArea = w * h; best = b; }
  }
  return best;
}

async function main() {
  const page = arg("page", "ynko.jpg");
  const dry = process.argv.includes("--dry");
  const seriesId = arg("series", "ynko");

  const raster = await loadRaster(join(FIXTURES, "pages", page));
  const detector = ctdCandidate({ label: "ctd-fused" });
  await detector.init();

  const regions = await buildRegions(raster, detector);
  const canvas = drawNumberedBoxes(raster.canvas, regions, HANDOFF);
  const png = canvas.toBuffer("image/png");

  await mkdir(OUT_DIR, { recursive: true });
  const stem = basename(page, extname(page));
  await writeFile(join(OUT_DIR, `${stem}.handoff.png`), png);

  const contentHash = "sha256:" + createHash("sha256").update(png).digest("hex");
  console.log(`page      ${page} ${raster.width}x${raster.height}`);
  console.log(`regions   ${regions.length}`);
  console.log(`upload    ${(png.length / 1024).toFixed(0)}KB PNG`);
  console.log(`cacheKey  ${cacheKey({
    contentHash, seriesId, targetLang: "en", model: DEFAULTS.model
  }).slice(0, 96)}…`);

  if (dry) {
    console.log(`\n--- system (${SYSTEM.length} chars) ---\n${SYSTEM}`);
    console.log(`\n--- user ---\n${buildUserText(regions.length, seriesId)}`);
    console.log("\n--dry: no request sent.");
    return;
  }

  const apiKey = await loadKey();
  console.log(`\ncalling ${DEFAULTS.model}…`);
  const started = Date.now();
  const result = await translatePage({
    imageB64: png.toString("base64"),
    regionCount: regions.length,
    seriesId,
    apiKey
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const cost = result.inputTokens * INPUT_RATE + result.outputTokens * OUTPUT_RATE;
  console.log(
    `${seconds}s  in=${result.inputTokens} out=${result.outputTokens} ` +
    `reasoning=${result.reasoningTokens}  $${cost.toFixed(5)}\n`);

  // Contract checks the schema cannot make for us.
  const ids = result.regions.map((r) => String(r.id)).sort((a, b) => a - b);
  const expected = regions.map((_, i) => String(i));
  const missing = expected.filter((i) => !ids.includes(i));
  const extra = ids.filter((i) => !expected.includes(i));
  if (missing.length) console.log(`⚠ missing ids: ${missing.join(",")}`);
  if (extra.length) console.log(`⚠ invented ids: ${extra.join(",")}`);

  let baseline = null;
  try {
    baseline = JSON.parse(await readFile(join(FIXTURES, "baseline.json"), "utf8"));
  } catch { /* comparison is optional */ }
  const baselineBoxes = baseline?.pages?.[page]?.boxes ?? null;

  const byId = new Map(result.regions.map((r) => [String(r.id), r]));
  const scores = [];

  console.log("id  kind       conf  japanese / english");
  console.log("-".repeat(78));
  regions.forEach((region, i) => {
    const t = byId.get(String(i));
    if (!t) { console.log(`${String(i).padEnd(3)} —  (no entry returned)`); return; }

    console.log(
      `${String(i).padEnd(3)} ${String(t.kind).padEnd(10)} ${t.confidence.toFixed(2)}  ${t.japanese}`);
    console.log(`${" ".repeat(21)}${t.english}`);

    if (baselineBoxes) {
      const b = nearestBaseline(region, baselineBoxes);
      if (b?.japanese) {
        const s = similarity(t.japanese, b.japanese);
        scores.push(s);
        if (s < 0.75) console.log(`${" ".repeat(21)}ocr: ${b.japanese}  (${(s * 100).toFixed(0)}% match)`);
      }
    }
  });

  if (scores.length) {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    console.log(
      `\ntranscription vs manga-ocr: ${(mean * 100).toFixed(1)}% mean similarity ` +
      `over ${scores.length} comparable regions`);
    console.log(
      "Disagreement is not automatically the model being wrong -- manga-ocr was\n" +
      "measurably poor on dense marginalia, which is part of what v0.4 is testing.");
  }
}

await main();
