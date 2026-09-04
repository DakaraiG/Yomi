// Settings page.
//
// The key lives in chrome.storage.local: extension-scoped, not synced, and read
// only by the service worker. A content script runs in the page, and a
// compromised page must not be able to reach it.

import { DEFAULTS } from "./lib/translate.js";
import { clear as clearCache, stats as cacheStats } from "./lib/cache.js";
import { DEFAULT_LIMIT } from "./lib/budget.js";

const fields = ["apiKey", "model", "reasoningEffort", "autoLimit"];
const $ = (id) => document.getElementById(id);

const stored = await chrome.storage.local.get(fields);
$("apiKey").value = stored.apiKey ?? "";
$("model").value = stored.model ?? DEFAULTS.model;
$("reasoningEffort").value = stored.reasoningEffort ?? DEFAULTS.reasoningEffort;
$("autoLimit").value = stored.autoLimit ?? DEFAULT_LIMIT;

// In storage.session, so it clears when the browser closes.
const { autoSpent = 0 } = await chrome.storage.session.get("autoSpent");
$("budgetNow").textContent =
  autoSpent > 0 ? ` Used so far this session: ${autoSpent}.` : "";

$("save").addEventListener("click", async () => {
  const limit = Number.parseInt($("autoLimit").value, 10);
  await chrome.storage.local.set({
    // A key pasted from a terminal picks up a trailing newline, and the
    // resulting 401 says nothing about whitespace.
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    reasoningEffort: $("reasoningEffort").value,
    autoLimit: Number.isFinite(limit) && limit >= 0 ? limit : DEFAULT_LIMIT
  });

  const status = $("status");
  status.classList.add("show");
  setTimeout(() => status.classList.remove("show"), 1500);
});

// Shares the extension origin, so this opens the same IndexedDB the service
// worker writes to.
async function showCacheStats() {
  const { entries } = await cacheStats();
  $("cacheStats").textContent =
    entries === 0 ? "Empty." : `${entries} page${entries === 1 ? "" : "s"} stored.`;
}

$("clearCache").addEventListener("click", async () => {
  await clearCache();
  await showCacheStats();
});

await showCacheStats();
