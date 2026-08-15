// Yomi content script.
//
// Injected on demand when the toolbar button is clicked (still a manual
// trigger; automatic scroll-based triggering is v0.5).
//
// Finds the page images, hands each to the service worker, and renders what
// comes back. Everything between those two points -- retrieval, detection,
// grouping, ordering, the model call -- happens out of the page, because a
// content script can do almost none of it: it cannot fetch cross-origin, and it
// has no business holding an API key.

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
    window.__yomiToast?.(
      images.length === 1 ? "Translating page…"
                          : `Translating ${images.length} pages…`);

    if (images.length === 0) {
      window.__yomiToast?.("No manga page found here", "error");
      console.warn(
        "[yomi] no candidates. Either the reader uses <canvas> or CSS " +
        "backgrounds rather than <img>, or the size filter is wrong."
      );
      return;
    }

    // Pages are translated CONCURRENTLY, up to a limit.
    //
    // Sequentially, a four-image screen costs four ~15s model calls end to end
    // -- a minute of watching a spinner for work that is almost entirely
    // waiting. Detection is serialised on the other side of the message
    // boundary (one ORT session), which is fine, because the model call is
    // where the time goes and those overlap freely.
    //
    // Bounded rather than unbounded: an unbounded fan-out on a long-strip
    // reader would fire a dozen paid requests at once and invite a rate limit.
    const CONCURRENCY = 3;
    let done = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < images.length) {
        const img = images[cursor++];
        await translateOne(img);
      }
    };

    const translateOne = async (img) => {
      console.log(
        `[yomi] requesting ${img.naturalWidth}x${img.naturalHeight} ${img.src}`
      );

      const r = img.getBoundingClientRect();
      const result = await chrome.runtime.sendMessage({
        type: "YOMI_TRANSLATE",
        imageUrl: img.src,
        pageUrl: location.href,
        // Last-resort signal for series identity, used only when the URL
        // carries none -- readers keyed entirely on chapter uuids.
        pageTitle: document.title,
        // Only used if retrieval falls through to the screenshot strategy.
        dpr: window.devicePixelRatio,
        rect: {
          left: r.left, top: r.top, width: r.width, height: r.height,
          bottom: r.bottom, viewportHeight: window.innerHeight
        }
      });

      if (!result?.ok) {
        const raw = result?.error ?? "no response";
        // Turn backend status codes into something a user can act on.
        const friendly =
          /No API key/i.test(raw) ? "No API key — open the extension's options"
          : /did not respond within/i.test(raw) ? "Translation timed out — try again"
          : /Provider returned 429/.test(raw) ? "Rate limited — wait a moment"
          : /Provider returned 4\d\d/.test(raw) ? "Translation refused — check your API key"
          : /all retrieval/.test(raw) ? "Couldn't read this image"
          : raw.slice(0, 90);
        window.__yomiToast?.(friendly, "error");
        console.error("[yomi] failed:", raw);
        return;
      }

      const { page, timing } = result;
      const stages = result.marks
        ? " · " + Object.entries(result.marks).map(([k, v]) => `${k} ${v}ms`).join(" ")
        : "";
      console.log(
        `[yomi] ${page.regions.length} regions in ${timing.totalMs}ms ` +
        `via ${result.strategy}${result.cached ? " (cached)" : ""} ` +
        `on ${result.backend ?? "—"} ` +
        `(${Math.round(timing.bytes / 1024)}KB, retrieve ${timing.fetchMs}ms)${stages}`
      );
      if (result.backendWarning) console.warn("[yomi]", result.backendWarning);
      if (result.usage) {
        console.log(
          `[yomi] tokens in=${result.usage.inputTokens} ` +
          `out=${result.usage.outputTokens} reasoning=${result.usage.reasoningTokens}`);
      }
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
      // The measured surface, so BUSY_STD and MIN_SHARE in background.js can be
      // tuned against real numbers rather than guessed at. `busy` regions get
      // outlined text and no fill; everything else is covered in `fill`.
      //
      // What to look for: a region that renders unreadably should show either a
      // `fill` that does not match what you see on the page, or `busy` set on
      // something that is plainly a flat surface (sd too low a bar) -- or
      // cleared on something that is plainly artwork (sd too high).
      console.table(
        page.regions.map((r) => ({
          order: r.order,
          kind: r.kind,
          lum: r.bgLum,
          sd: r.bgStd,
          share: r.bgShare,
          busy: r.busy,
          fill: r.fill ? `rgb(${r.fill.join(",")})` : "—"
        }))
      );

      if (page.regions.length === 0) {
        console.warn(
          `[yomi] no text found on this image (via ${result.strategy}). ` +
          (result.strategy === "screenshot"
            ? "The screenshot tier only captures what is on screen — scroll the " +
              "page fully into view and retry."
            : "The page may genuinely have no text."));
        window.__yomiToast?.("No text found on that page", "error");
        return;
      }

      // Sanity check worth having here: this is the first place the contract
      // crosses a process boundary for real. Guarded by the emptiness check
      // above -- an empty page has no regions[0], and reporting "kind is not a
      // string: undefined" for it sends you hunting a serialisation bug that
      // does not exist.
      if (typeof page.regions[0].kind !== "string") {
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
      done++;
      window.__yomiToast?.(
        `${done}/${images.length} translated · ${page.regions.length} regions`,
        done === images.length ? "done" : "busy");
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, images.length) }, worker));
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