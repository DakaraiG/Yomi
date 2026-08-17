// Yomi content script.
//
// Injected on demand when the toolbar button is clicked. The click ARMS the tab
// rather than translating it once: from then on, pages translate as they come
// into view, and clicking again disarms. Everything between the trigger and the
// overlay -- retrieval, detection, grouping, ordering, the model call -- happens
// out of the page, because a content script can do almost none of it: it cannot
// fetch cross-origin, and it has no business holding an API key.
//
// AUTO-TRIGGERING SPENDS MONEY, and that is the whole design problem. Scrolling
// is not a decision to pay for anything, so three things stand between a scroll
// and a request:
//
//   1. DWELL. A page must stay in view for DWELL_MS before it is worth
//      anything. Scrolling briskly past twenty pages should cost nothing, and
//      this is what makes that true.
//   2. THE QUEUE. Only CONCURRENCY pages are ever in flight; the rest wait, and
//      anything that scrolls out of view while still waiting is dropped before
//      it costs a thing.
//   3. THE CEILING, enforced in the service worker, which is the only side that
//      can tell a paid call from a free cache hit.
//
// WHAT IS DELIBERATELY NOT CANCELLED: a request already sent to the model. The
// money is committed the moment it goes out, and a cancelled page is not
// cached, so cancelling and later re-reading that page pays for it twice.
// Letting it finish costs nothing extra and fills the cache. Cancellation is
// therefore something that happens to pages waiting, never to pages in flight.

(() => {
  // How long a page must stay in view before it is worth paying for. Long
  // enough that a flick through a chapter costs nothing, short enough that it
  // does not feel broken when you stop to read.
  const DWELL_MS = 400;
  // How far outside the viewport counts as "in view", so the next page is ready
  // by the time it is reached. Detection is ~230ms and reads are cached, so a
  // little lookahead holds comfortably.
  const BAND = "60% 0px";
  const CONCURRENCY = 3;

  // Second click disarms. The toolbar button is the only control there is, so
  // it has to be able to undo what it did.
  if (window.__yomiAuto) {
    window.__yomiAuto.disarm();
    return;
  }

  const seen = new Map();        // img -> { status, timer }
  // Readers preload neighbouring pages, so the same src is often on several
  // elements at once. Without this they race each other, both miss the cache
  // because neither has finished, and the same page is paid for twice.
  const claimed = new Set();     // src already queued, in flight, or done
  const queue = [];
  let active = 0;
  let stopped = false;
  let translated = 0;

  const status = (img) => seen.get(img)?.status ?? "idle";
  const setStatus = (img, s) => {
    const e = seen.get(img);
    if (e) e.status = s;
  };

  /** Big enough, and roughly page-shaped. Readers vary; expect to tune this. */
  function isPageImage(img) {
    return img.naturalWidth >= 400 && img.naturalHeight >= 400 &&
           img.naturalHeight / img.naturalWidth > 0.8;
  }

  // ---- the queue ----------------------------------------------------------

  function enqueue(img) {
    if (stopped || status(img) !== "idle") return;
    if (claimed.has(img.src)) { setStatus(img, "done"); return; }
    claimed.add(img.src);
    setStatus(img, "queued");
    queue.push(img);
    pump();
  }

  /** Drop a page that left the viewport before it cost anything. */
  function drop(img) {
    const entry = seen.get(img);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.status === "queued") {
      const i = queue.indexOf(img);
      if (i >= 0) queue.splice(i, 1);
      claimed.delete(img.src);
      entry.status = "idle";
    }
    // "inflight" is deliberately left alone -- see the header.
  }

  function pump() {
    while (!stopped && active < CONCURRENCY && queue.length) {
      const img = queue.shift();
      if (status(img) !== "queued") continue;
      setStatus(img, "inflight");
      active++;
      translateOne(img)
        .catch(() => setStatus(img, "failed"))
        .finally(() => { active--; pump(); });
    }
  }

  // ---- one page -----------------------------------------------------------

  async function translateOne(img) {
    const r = img.getBoundingClientRect();
    const result = await chrome.runtime.sendMessage({
      type: "YOMI_TRANSLATE",
      imageUrl: img.src,
      pageUrl: location.href,
      // Marks this as unattended, which is what subjects it to the ceiling.
      auto: true,
      // Last-resort signal for series identity, used only when the URL carries
      // none -- readers keyed entirely on chapter uuids.
      pageTitle: document.title,
      // Only used if retrieval falls through to the screenshot strategy.
      dpr: window.devicePixelRatio,
      rect: {
        left: r.left, top: r.top, width: r.width, height: r.height,
        bottom: r.bottom, viewportHeight: window.innerHeight
      }
    });

    if (!result?.ok) {
      setStatus(img, "failed");

      // The ceiling is not a per-page failure -- it is the end of unattended
      // work for this session, so stop rather than retry every page in turn.
      if (result?.budgetExceeded) {
        window.__yomiToast?.("Auto-translate ceiling reached — click to resume",
                             "error");
        console.warn("[yomi]", result.error);
        disarm({ quiet: true });
        return;
      }

      const raw = result?.error ?? "no response";
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
    if (result.budget) {
      console.log(
        `[yomi] budget ${result.budget.spent}/${result.budget.limit} paid ` +
        `page(s) this session`);
    }
    if (result.usage) {
      console.log(
        `[yomi] tokens in=${result.usage.inputTokens} ` +
        `out=${result.usage.outputTokens} reasoning=${result.usage.reasoningTokens}`);
    }
    if (result.tried?.length) {
      console.log("[yomi] fell back after:", result.tried.join(" | "));
    }

    if (page.regions.length === 0) {
      setStatus(img, "done");
      console.warn(
        `[yomi] no text found on this image (via ${result.strategy}). ` +
        (result.strategy === "screenshot"
          ? "The screenshot tier only captures what is on screen — scroll the " +
            "page fully into view and retry."
          : "The page may genuinely have no text."));
      return;
    }

    // Sanity check worth having here: this is the first place the contract
    // crosses a process boundary for real. Guarded by the emptiness check above
    // -- an empty page has no regions[0], and reporting "kind is not a string:
    // undefined" for it sends you hunting a serialisation bug that does not
    // exist.
    if (typeof page.regions[0].kind !== "string") {
      console.error("[yomi] CONTRACT: kind is not a string", page.regions[0]);
    }
    // Only meaningful on the fetch paths. The screenshot strategy crops to the
    // image's bounding box at devicePixelRatio, so the pixel count legitimately
    // differs while the framing is identical -- and polygons are normalised, so
    // the overlay still lands correctly.
    if (result.strategy !== "screenshot" &&
        page.naturalWidth !== img.naturalWidth) {
      console.warn(
        `[yomi] size mismatch: backend says ${page.naturalWidth}, ` +
        `DOM says ${img.naturalWidth}. Polygons will be misplaced.`
      );
    }

    console.table(
      page.regions.slice(0, 10).map((r) => ({
        order: r.order, kind: r.kind, speaker: r.speaker,
        japanese: r.japanese, english: r.english
      }))
    );
    // The measured surface, so BUSY_STD and MIN_SHARE in background.js can be
    // tuned against real numbers rather than guessed at. `tex` regions have no
    // bubble, so they get a heavy halo and no fill; the rest are covered in
    // `fill`.
    console.table(
      page.regions.map((r) => ({
        order: r.order, kind: r.kind,
        lum: r.bgLum, sd: r.bgStd, share: r.bgShare, peak: r.bgPeak, tex: r.textured,
        fill: r.fill ? `rgb(${r.fill.join(",")})` : "—",
        widen: r.vertical ? r.widenedBy : "—"
      }))
    );

    window.__yomiRender(img, page);
    setStatus(img, "done");
    translated++;
    window.__yomiToast?.(`${translated} page(s) translated`, "done");
  }

  // ---- watching -----------------------------------------------------------

  const io = new IntersectionObserver((entries) => {
    if (stopped) return;
    for (const e of entries) {
      const img = e.target;
      const entry = seen.get(img);
      if (!entry) continue;

      if (!e.isIntersecting) { drop(img); continue; }
      if (entry.status !== "idle" || entry.timer) continue;

      // The dwell gate. Cleared by drop() if the page leaves first, so a scroll
      // that passes straight through never reaches enqueue().
      entry.timer = setTimeout(() => {
        entry.timer = null;
        enqueue(img);
      }, DWELL_MS);
    }
  }, { root: null, rootMargin: BAND, threshold: 0 });

  function watch(img) {
    if (seen.has(img) || !isPageImage(img)) return;
    seen.set(img, { status: "idle", timer: null });
    io.observe(img);
  }

  function scan() {
    for (const img of document.images) {
      if (img.complete) watch(img);
      // Readers lazy-load constantly, and an <img> with no dimensions yet fails
      // isPageImage. Re-check once it has actually loaded.
      else img.addEventListener("load", () => !stopped && watch(img), { once: true });
    }
    // Long-strip readers recycle nodes as you scroll. Forgetting the ones that
    // have left the document keeps this from growing for a whole chapter.
    for (const [img, entry] of seen) {
      // Never drop one mid-call: its result still has to be rendered, and the
      // queue still has to hear that the slot is free.
      if (img.isConnected || entry.status === "inflight") continue;
      clearTimeout(entry.timer);
      io.unobserve(img);
      seen.delete(img);
    }
  }

  // Readers add pages as you scroll, so a single scan at arm time sees only the
  // first screen of a long-strip chapter.
  //
  // Coalesced: a reader can fire hundreds of mutations while scrolling, and
  // scan() walks every image on the page. Doing that per mutation makes the
  // extension the reason the page stutters.
  let scanPending = false;
  const mo = new MutationObserver(() => {
    if (stopped || scanPending) return;
    scanPending = true;
    setTimeout(() => { scanPending = false; if (!stopped) scan(); }, 200);
  });

  function disarm({ quiet = false } = {}) {
    if (stopped) return;
    stopped = true;
    io.disconnect();
    mo.disconnect();
    for (const entry of seen.values()) clearTimeout(entry.timer);
    queue.length = 0;
    window.__yomiAuto = null;
    console.log("[yomi] auto-translate off");
    if (!quiet) window.__yomiToast?.("Auto-translate off — click to resume", "done");
  }

  window.__yomiAuto = { disarm };

  scan();
  mo.observe(document.body, { childList: true, subtree: true });

  if (seen.size === 0) {
    console.warn(
      "[yomi] no candidate page images. Either the reader uses <canvas> or CSS " +
      "backgrounds rather than <img>, or the size filter is wrong."
    );
    window.__yomiToast?.("No manga page found here", "error");
  } else {
    console.log(`[yomi] auto-translate on — watching ${seen.size} page image(s)`);
    window.__yomiToast?.("Auto-translate on — click again to stop");
  }
})();
