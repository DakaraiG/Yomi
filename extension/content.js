// Yomi content script, injected when the toolbar button is clicked.
//
// The click arms the tab rather than translating once: pages then translate as
// they come into view, and clicking again disarms. Everything between the
// trigger and the overlay happens in the service worker, since a content script
// cannot fetch cross-origin and has no business holding an API key.
//
// Auto-triggering spends money, and scrolling is not a decision to pay for
// anything, so three things stand between a scroll and a request: the dwell
// timer, the queue (only CONCURRENCY in flight, and anything that scrolls away
// while waiting is dropped), and the ceiling in the service worker, which is the
// only side that can tell a paid call from a cache hit.
//
// A request already sent to the model is deliberately never cancelled: the money
// is committed the moment it goes out and a cancelled page is not cached, so
// cancelling and re-reading pays for it twice.

(() => {
  // Long enough that a flick through a chapter costs nothing, short enough that
  // stopping to read does not feel broken.
  const DWELL_MS = 400;
  // How far outside the viewport counts as "in view", so the next page is ready
  // by the time it is reached.
  const BAND = "60% 0px";
  const CONCURRENCY = 3;

  // Second click disarms: the toolbar button is the only control there is.
  if (window.__yomiAuto) {
    window.__yomiAuto.disarm();
    return;
  }

  const seen = new Map();        // img -> { status, timer }
  // Readers preload neighbouring pages, so the same src is often on several
  // elements at once. Without this they race, both miss the cache because
  // neither has finished, and the page is paid for twice.
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
    // "inflight" is deliberately left alone: the money is already committed.
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
      // Unattended, which is what subjects it to the ceiling.
      auto: true,
      // Series identity of last resort, for readers keyed entirely on uuids.
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

      // The ceiling ends unattended work for the session, so stop rather than
      // retry every page in turn.
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

    // The contract's first real crossing of a process boundary. Must stay below
    // the emptiness check: an empty page has no regions[0], and reporting it as
    // a contract violation sends you hunting a serialisation bug that does not
    // exist.
    if (typeof page.regions[0].kind !== "string") {
      console.error("[yomi] CONTRACT: kind is not a string", page.regions[0]);
    }
    // Only meaningful on the fetch paths: the screenshot strategy crops at
    // devicePixelRatio, so its pixel count legitimately differs while the
    // framing is identical, and normalised polygons still land correctly.
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
    // The measured surface, so the decisions in background.js can be tuned
    // against real numbers. `fill` is never painted; it is the measured
    // background colour, and only decides which way round the lettering goes.
    console.table(
      page.regions.map((r) => ({
        order: r.order, kind: r.kind, bubble: r.inBubble,
        erased: r.erased, structure: r.structure,
        lum: r.bgLum, sd: r.bgStd, share: r.bgShare, peak: r.bgPeak,
        fill: r.fill ? `rgb(${r.fill.join(",")})` : "—",
        dark: r.darkBg,
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

      // The dwell gate, cleared by drop() if the page leaves first, so a scroll
      // straight past never reaches enqueue().
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
      // isPageImage.
      else img.addEventListener("load", () => !stopped && watch(img), { once: true });
    }
    // Long-strip readers recycle nodes as you scroll, so forget the ones that
    // have left the document rather than growing for a whole chapter.
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
  // first screen of a long-strip chapter. Coalesced because scan() walks every
  // image and a reader fires hundreds of mutations while scrolling.
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
