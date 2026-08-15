// Settings page.
//
// The key lives in chrome.storage.local: extension-scoped, not synced to the
// user's account, and never touched by a content script -- content scripts run
// in the page and a compromised page must not be able to reach it. Only the
// service worker reads it, and only to put it in an Authorization header.

import { DEFAULTS } from "./lib/translate.js";
import { clear as clearCache, stats as cacheStats } from "./lib/cache.js";

const fields = ["apiKey", "model", "reasoningEffort"];
const $ = (id) => document.getElementById(id);

const stored = await chrome.storage.local.get(fields);
$("apiKey").value = stored.apiKey ?? "";
$("model").value = stored.model ?? DEFAULTS.model;
$("reasoningEffort").value = stored.reasoningEffort ?? DEFAULTS.reasoningEffort;

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    // Trimmed: a key pasted from a terminal picks up a trailing newline, and
    // the resulting 401 says nothing about whitespace.
    apiKey: $("apiKey").value.trim(),
    model: $("model").value.trim() || DEFAULTS.model,
    reasoningEffort: $("reasoningEffort").value
  });

  const status = $("status");
  status.classList.add("show");
  setTimeout(() => status.classList.remove("show"), 1500);
});

// The options page shares the extension origin, so it opens the same IndexedDB
// the service worker writes to.
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
