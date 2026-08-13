// Yomi content script.
//
// Injected on demand when the toolbar button is clicked (v0.3 is manual
// trigger; automatic scroll-based triggering is v0.5).
//
// SPIKE SCOPE: this proves the plumbing end to end -- find the page image, get
// its bytes through the service worker, POST to the backend, receive a
// TranslatedPage. It logs the result rather than rendering it. Rendering is the
// next step and slots in where marked.

(async () => {
  // Re-injection guard. Clicking the toolbar button twice would otherwise run
  // everything again on top of itself.
  if (window.__yomiRunning) {
    console.log("[yomi] already running on this page");
    return;
  }
  window.__yomiRunning = true;

  try {
    const images = findPageImages();
    console.log(`[yomi] found ${images.length} candidate page image(s)`);

    if (images.length === 0) {
      console.warn(
        "[yomi] no candidates. Either the reader uses <canvas> or CSS " +
        "backgrounds rather than <img>, or the size filter is wrong."
      );
      return;
    }

    for (const img of images) {
      console.log(
        `[yomi] requesting ${img.naturalWidth}x${img.naturalHeight} ${img.src}`
      );

      const r = img.getBoundingClientRect();
      const result = await chrome.runtime.sendMessage({
        type: "YOMI_TRANSLATE",
        imageUrl: img.src,
        pageUrl: location.href,
        // Only used if retrieval falls through to the screenshot strategy.
        dpr: window.devicePixelRatio,
        rect: {
          left: r.left, top: r.top, width: r.width, height: r.height,
          bottom: r.bottom, viewportHeight: window.innerHeight
        }
      });

      if (!result?.ok) {
        console.error("[yomi] failed:", result?.error ?? "no response");
        continue;
      }

      const { page, timing } = result;
      console.log(
        `[yomi] ${page.regions.length} regions in ${timing.totalMs}ms ` +
        `via ${result.strategy} ` +
        `(${Math.round(timing.bytes / 1024)}KB, retrieve ${timing.fetchMs}ms)`
      );
      if (result.tried?.length) {
        console.log("[yomi] fell back after:", result.tried.join(" | "));
      }
      console.table(
        page.regions.slice(0, 10).map((r) => ({
          order: r.order,
          kind: r.kind,
          speaker: r.speaker,
          japanese: r.japanese,
          english: r.english
        }))
      );

      // Sanity checks worth having here rather than only in the C# tests: this
      // is the first place the contract crosses a process boundary for real.
      if (typeof page.regions[0]?.kind !== "string") {
        console.error("[yomi] CONTRACT: kind is not a string", page.regions[0]);
      }
      // Only meaningful on the fetch paths. The screenshot strategy crops to
      // the image's bounding box at devicePixelRatio, so the pixel count
      // legitimately differs while the framing is identical -- and polygons are
      // normalised, so the overlay still lands correctly.
      if (result.strategy !== "screenshot" &&
          page.naturalWidth !== img.naturalWidth) {
        console.warn(
          `[yomi] size mismatch: backend says ${page.naturalWidth}, ` +
          `DOM says ${img.naturalWidth}. Polygons will be misplaced.`
        );
      }

      window.__yomiRender(img, page);
    }
  } finally {
    window.__yomiRunning = false;
  }
})();

/**
 * Find images that look like manga pages.
 *
 * Heuristic, and deliberately loose for the spike: big, and taller than wide or
 * close to it. Readers vary enormously, so expect to tune this per site later.
 */
function findPageImages() {
  const seen = new Set();
  return Array.from(document.images)
    .filter((img) => img.naturalWidth >= 400 && img.naturalHeight >= 400)
    .filter((img) => img.naturalHeight / img.naturalWidth > 0.8)
    .filter((img) => {
      // Only what is actually on screen, so a long-strip reader does not fire
      // fifty requests at once.
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    })
    // Readers preload neighbouring pages, so the same src often appears on
    // several elements. Without this you pay for the same page four times.
    .filter((img) => !seen.has(img.src) && seen.add(img.src));
}
