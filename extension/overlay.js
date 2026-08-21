// Yomi overlay renderer.
//
// Draws English over the page image using the normalised polygons from the
// backend. Three problems worth naming, because they drive most of the code:
//
// 1. ISOLATION. Manga readers have aggressive CSS. Everything lives inside a
//    shadow root so the host page cannot restyle our boxes and we cannot
//    restyle theirs.
//
// 2. FITTING. Japanese is vertical and compact; English is horizontal and long.
//    A tall narrow bubble that comfortably held 8 kana has to hold "You'll get
//    a stomach ache sleeping like that". Binary search on font size is the
//    workable answer -- see fitText.
//
// 3. REPOSITIONING. Zoom, window resize, and responsive readers all change the
//    image's rendered size. Polygons are normalised 0-1 precisely so this is a
//    multiply rather than a re-request.

(() => {
  const HOST_ATTR = "data-yomi-overlay";

  // ---- font loading -------------------------------------------------------
  //
  // THE TRAP: an @font-face rule declared inside a shadow root does not
  // register the font. Font faces are document-scoped, so a @font-face in our
  // shadow stylesheet is silently ignored and everything falls back -- with no
  // error to tell you why.
  //
  // The CSS Font Loading API registers against the document, and shadow DOM can
  // then use the family name normally.
  //
  // Filenames must match what is actually in extension/fonts/. Faces that are
  // missing are skipped, so a regular-only font still works.
  const FACES = [
    { file: "YomiLetter-Regular.ttf",    weight: "400", style: "normal" },
    { file: "YomiLetter-Bold.ttf",       weight: "700", style: "normal" },
    { file: "YomiLetter-Italic.ttf",     weight: "400", style: "italic" },
    { file: "YomiLetter-BoldItalic.ttf", weight: "700", style: "italic" }
  ];

  if (!window.__yomiFontsLoaded) {
    window.__yomiFontsLoaded = true;
    Promise.allSettled(FACES.map(async (f) => {
      const face = new FontFace(
        "Yomi Letter",
        `url(${chrome.runtime.getURL("fonts/" + f.file)})`,
        { weight: f.weight, style: f.style }
      );
      document.fonts.add(await face.load());
      return f.file;
    })).then((results) => {
      const ok = results.filter((r) => r.status === "fulfilled").length;
      if (ok === 0) {
        console.warn(
          "[yomi] no fonts loaded — check filenames in FACES match " +
          "extension/fonts/, and that web_accessible_resources is set. " +
          "Falling back to the system stack."
        );
      } else {
        console.log(`[yomi] loaded ${ok}/${FACES.length} font face(s)`);
      }
    });
  }

  // Fallback expansion only. Boxes normally arrive already shaped by
  // lib/layout.js, which knows the pixels and can widen a vertical region as
  // far as its bubble actually goes; this is what a region falls back to if it
  // arrives without one.
  const BOX_EXPAND = 0.08;

  const CSS = `
    :host { all: initial; }
    .layer { position: absolute; inset: 0; pointer-events: none; }

    /* THE CLEAN PLATE: the whole page with the Japanese erased, drawn over the
       original at exactly its rendered size. Every region sits on it, which is
       why there is only one kind of region below -- the question "what is
       behind this text" has the same answer everywhere now.

       Sized in percentages rather than pixels so it follows the host, which is
       already positioned and sized from the image's bounding rect on every
       resize, zoom and reflow. Nothing here needs to know the page's natural
       dimensions.

       image-rendering is left at the default: the plate IS the page at natural
       size, so the browser is doing the same downscale it already does to the
       image underneath, and matching it is the point. */
    .plate {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      z-index: 0;
    }

    .region {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      /* Nothing leaves the box. The box is the region of the page we have
         measured and are entitled to paint on; text spilling out of it lands
         on artwork or on a neighbour's bubble, which is the mess this is
         meant to replace. A region that cannot fit its text at MIN_PX is
         reported rather than allowed to bleed -- see layout(). */
      overflow: hidden;
      text-align: center;
      font-family: "Yomi Letter", "CC Wild Words", "Wild Words", "Anime Ace",
                   "Comic Neue", "Comic Sans MS", system-ui, sans-serif;
      font-weight: 700;
      /* Scanlation convention. Costs nothing and does more for the look than
         any other single change. */
      text-transform: uppercase;
      line-height: 1.06;
      letter-spacing: 0.005em;
      hyphens: auto;
      overflow-wrap: break-word;
      /* Greedy wrapping fills each line to the brim and leaves the last one
         holding a single word -- the other half of the machine-made look, and
         the half that survives however well the box is shaped. Balancing evens
         the line lengths instead, which is what a letterer does by hand. It is
         the shape of the ragged edge people read as hand-set. */
      text-wrap: balance;
      pointer-events: auto;
      cursor: default;
    }

    /* --ink and --halo are set per region from the pixels measured in the
       service worker, and are all that is left of that measurement: there is
       no --fill because nothing is filled any more. Defaults here are the old
       white-bubble assumption, used only if a region arrives unmeasured. */
    .region {
      --ink: #000;
      --halo: #fff;
      /* Above the plate, stated rather than inherited from tree order. The
         regions are appended after the plate so they would paint above it
         anyway today, but that is an accident of insertion order and one
         reordering away from every translation vanishing behind an image of
         the page it belongs to. */
      z-index: 1;
      color: var(--ink);
      /* In em, not %. Percentage padding resolves against the box's WIDTH on
         every side, so a wide short box lost ~30% of its height to top and
         bottom padding and had to set its text smaller to compensate. In em it
         tracks the lettering instead. */
      padding: 0.1em 0.3em;

      /* THE HALO IS NOW A STYLE CHOICE, WHICH IT USED TO NOT BE.
         It began as the only way to make English readable on top of Japanese
         that could not be removed: a 0.18em stroke and eight stacked shadows,
         tuned by eye, meant to look like too much -- because too much was what
         it took to win against the artwork AND the lettering underneath it.
         The plate removes the lettering, so what is left to survive is only the
         artwork: screentone, hatching, a panel tone. That needs separation, not
         a cushion. A light stroke does it, and it does not read as a sticker.
         On a repaired white bubble it costs nothing and is invisible. */
      -webkit-text-stroke: 0.08em var(--halo);
      paint-order: stroke fill;
      text-shadow: 0 0 0.12em var(--halo), 0 0 0.24em var(--halo);
    }

    /* SFX keeps its tracking, so it still reads as SFX rather than as
       narration that happened to land on artwork. It no longer needs a
       different stroke: the reason it had one was that SFX always outlined
       while everything else filled, and there was a jump between the two. */
    .region.sfx {
      letter-spacing: 0.02em;
    }

    /* Anything the model dropped renders as the original Japanese, dimmed, so a
       gap is visible rather than silent. */
    .region.untranslated {
      color: #666;
      font-style: italic;
    }


    .region:hover::after {
      content: attr(data-jp);
      position: absolute;
      left: 50%; bottom: 100%;
      transform: translateX(-50%);
      white-space: nowrap;
      background: #111; color: #fff;
      font-size: 12px; font-weight: 400;
      padding: 3px 6px; border-radius: 3px;
      pointer-events: none;
      z-index: 10;
    }
  `;

  /** Bounding box of a normalised polygon, expanded slightly, clamped to 0-1. */
  function boundsOf(polygon) {
    const xs = polygon.map((p) => p[0]);
    const ys = polygon.map((p) => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);

    const dx = (x1 - x0) * BOX_EXPAND;
    const dy = (y1 - y0) * BOX_EXPAND;
    x0 = Math.max(0, x0 - dx); x1 = Math.min(1, x1 + dx);
    y0 = Math.max(0, y0 - dy); y1 = Math.min(1, y1 + dy);

    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Largest font size at which the text still fits.
   *
   * Binary search rather than shrink-until-it-fits: ~6 measurements instead of
   * up to 40, and each measurement forces a reflow, so the difference is real
   * on a page with 20 regions.
   */
  function fitText(el, maxPx) {
    let lo = 5, hi = Math.max(6, Math.floor(maxPx)), best = 5;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.style.fontSize = mid + "px";
      const fits = el.scrollWidth <= el.clientWidth + 1 &&
                   el.scrollHeight <= el.clientHeight + 1;
      if (fits) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    el.style.fontSize = best + "px";
    return best;
  }

  function positionHost(host, img) {
    const r = img.getBoundingClientRect();
    host.style.position = "absolute";
    host.style.left = `${r.left + window.scrollX}px`;
    host.style.top = `${r.top + window.scrollY}px`;
    host.style.width = `${r.width}px`;
    host.style.height = `${r.height}px`;
    host.style.zIndex = "2147483000";
    host.style.pointerEvents = "none";
    return r;
  }

  /**
   * Layout in two passes.
   *
   * Pass 1 finds the largest size each box could take on its own.
   *
   * Pass 2 USED TO pick one size for the whole page -- the 35th percentile of
   * those maxima -- on the theory that uniform lettering looks professional.
   * That theory is wrong, and it is why the type came out small: sizing every
   * box near the tightest one on the page throws away the room in all the
   * others, and two thirds of the page renders smaller than it could.
   *
   * Look at what published scans actually do and the size plainly tracks the
   * bubble -- a big bubble gets big lettering, "THANKS~" in a small one gets
   * small lettering, on the same page. So the page percentile is a CAP on the
   * outliers, not a target: a box uses its own maximum, and only the largest
   * few are pulled back so a two-word bubble does not shout.
   *
   * THE FLOOR IS SOFT, and it has to be. Left alone, pass 2 drives every box
   * down to whatever the tightest one allows, and text at 6px covers the
   * Japanese while being unreadable itself. So MIN_PX pulls the uniform size
   * back up.
   *
   * What it must never do is set a size the box cannot hold. A hard floor did
   * exactly that: boxes were given 11px whether or not 11px fitted, words then
   * ran past the edges, and with nothing allowed out of the box they were cut
   * off mid-word -- text visibly fighting the box it sits in. The floor now
   * raises the UNIFORM size only, and never past what the box measured as
   * able to hold. A box too small for MIN_PX renders small rather than clipped.
   */

  const CAP_PERCENTILE = 0.8;
  const MIN_PX = 11;

  function layout(host, layer, img) {
    const t0 = performance.now();
    const r = positionHost(host, img);
    // REGIONS ONLY, not every child of the layer. The clean plate is an <img>
    // in here too, and it has no data-bounds -- so `layer.children` put it
    // through JSON.parse(undefined) on the first iteration of the map below,
    // which threw and abandoned layout() before a single region was positioned.
    // Every region then rendered at its static position and default size:
    // twenty translations stacked on top of each other at the top of the page,
    // with no error visible unless you notice the "fitted N region(s)" line
    // missing from the log.
    const els = Array.from(layer.querySelectorAll(".region"));

    // SKIP IF NOTHING MOVED. fitText binary-searches the font size, and every
    // step reads scrollHeight straight after writing fontSize, which forces a
    // synchronous reflow -- about six per region, and more expensive now that
    // each reflow also does balanced wrapping and hyphenation. At 25 regions
    // that is ~150 forced reflows, on the page's own main thread.
    //
    // layout() runs on render AND on every ResizeObserver and window resize
    // callback, and readers fire those freely. If the image is the same size as
    // last time, every size already computed is still correct.
    if (host.__yomiFitAt &&
        Math.abs(host.__yomiFitAt.w - r.width) < 0.5 &&
        Math.abs(host.__yomiFitAt.h - r.height) < 0.5) {
      return;
    }
    host.__yomiFitAt = { w: r.width, h: r.height };

    const maxima = els.map((el) => {
      const b = JSON.parse(el.dataset.bounds);
      el.style.left = `${b.x * r.width}px`;
      el.style.top = `${b.y * r.height}px`;
      el.style.width = `${b.w * r.width}px`;
      el.style.height = `${b.h * r.height}px`;
      return fitText(el, b.h * r.height * 0.9);
    });

    if (maxima.length === 0) return;
    const sorted = [...maxima].sort((a, b) => a - b);
    const cap = sorted[Math.min(sorted.length - 1,
                                Math.floor(sorted.length * CAP_PERCENTILE))];

    const clipped = [];
    els.forEach((el, i) => {
      // min() last: whatever the floor and the cap want, the size the box
      // measured as able to hold wins. Setting a size a box cannot hold is what
      // made words run past the edges and get cut off mid-word.
      el.style.fontSize = `${Math.min(maxima[i], Math.max(MIN_PX, cap))}px`;
      const over = el.scrollHeight > el.clientHeight + 1 ||
                   el.scrollWidth > el.clientWidth + 1;
      if (over) clipped.push(el.textContent.slice(0, 30));
    });

    // Reported, not drawn on the page. An outline around the offenders was a
    // useful debugging aid and a visible defect in the thing being debugged.
    if (clipped.length) {
      console.warn(
        `[yomi] ${clipped.length}/${els.length} region(s) too small even for ` +
        `their fitted size:`, clipped);
    }

    // So "the overlay feels slow" can be separated from "the translation was
    // slow". This is page-side layout only and has nothing to do with the
    // model call.
    console.log(
      `[yomi] fitted ${els.length} region(s) in ` +
      `${Math.round(performance.now() - t0)}ms`);
  }

  window.__yomiRender = function renderOverlay(img, page) {
    // Replace any previous overlay for this image rather than stacking.
    document.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => {
      if (n.__yomiImg === img) { n.__yomiCleanup?.(); n.remove(); }
    });

    const host = document.createElement("div");
    host.setAttribute(HOST_ATTR, "");
    host.__yomiImg = img;

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const layer = document.createElement("div");
    layer.className = "layer";
    shadow.appendChild(layer);

    // THE PLATE FIRST, so every region lands on top of it.
    //
    // A data URL rather than a blob URL: a blob URL has to be revoked or it
    // leaks for the lifetime of the tab, and an overlay that is torn down and
    // rebuilt on every resize would leak one per rebuild. The base64 is a few
    // hundred KB and the decode is off the main thread.
    //
    // A page cached before plates existed arrives without one and simply
    // renders on the original background, which is what it did before.
    if (page.plate) {
      const plate = document.createElement("img");
      plate.className = "plate";
      plate.src = `data:image/png;base64,${page.plate}`;
      plate.alt = "";
      layer.appendChild(plate);
    }

    for (const region of page.regions) {
      const el = document.createElement("div");
      const untranslated = !region.english;
      // ONE SURFACE. There used to be two -- filled inside a drawn bubble,
      // outlined everywhere else -- and the split was never about taste: a
      // rectangle is safe on a bubble's flat interior and destroys artwork
      // anywhere else, so text on a panel tone had to be left sitting on top of
      // the Japanese with a halo heavy enough to win. The plate erases the
      // Japanese instead, so both cases now have a clean background and there
      // is nothing left for the branch to decide.
      el.className =
        `region ${region.kind}${untranslated ? " untranslated" : ""}`;

      // Stark, like the scans this imitates -- they letter in pure black on
      // pure white, and a near-black on a near-white reads as washed out next
      // to the artwork's own solid blacks.
      if (region.darkBg !== undefined) {
        el.style.setProperty("--ink", region.darkBg ? "#fff" : "#000");
        el.style.setProperty("--halo", region.darkBg ? "#000" : "#fff");
      }

      // REQUIRED for hyphens: auto to do anything. Hyphenation is per-language
      // and the browser will not guess: inside a shadow root on a Japanese
      // reader these inherit lang="ja" or nothing at all, and the rule silently
      // does nothing. Official scans hyphenate constantly -- REMEM-BER,
      // DI-VORCED, EL-EMENTARY -- because it is the only way long words fit a
      // narrow bubble without shrinking the whole page's lettering.
      el.lang = untranslated ? "ja" : "en";
      el.textContent = untranslated ? region.japanese : region.english;
      el.dataset.jp = region.japanese;
      el.dataset.bounds = JSON.stringify(region.box ?? boundsOf(region.polygon));
      layer.appendChild(el);
    }

    document.body.appendChild(host);
    layout(host, layer, img);

    // Reposition on anything that changes the image's rendered size: zoom,
    // window resize, responsive reflow.
    const ro = new ResizeObserver(() => layout(host, layer, img));
    ro.observe(img);
    const onResize = () => layout(host, layer, img);
    window.addEventListener("resize", onResize);

    host.__yomiCleanup = () => {
      ro.disconnect();
      window.removeEventListener("resize", onResize);
    };

    return host;
  };

  // ---- status toast -------------------------------------------------------
  // Clicking the toolbar button used to produce nothing visible for ten seconds,
  // which is indistinguishable from the extension being broken.

  const TOAST_ID = "yomi-toast-host";

  function toastEl() {
    let host = document.getElementById(TOAST_ID);
    if (host) return host.shadowRoot.querySelector(".toast");

    host = document.createElement("div");
    host.id = TOAST_ID;
    host.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;pointer-events:none";
    const sr = host.attachShadow({ mode: "open" });
    sr.innerHTML = `
      <style>
        .toast {
          font: 500 13px/1.4 system-ui, sans-serif;
          background: #16181d; color: #f2f4f8;
          padding: 9px 14px; border-radius: 8px;
          box-shadow: 0 4px 20px rgba(0,0,0,.35);
          display: flex; align-items: center; gap: 9px;
          opacity: 0; transform: translateY(6px);
          transition: opacity .18s, transform .18s;
          max-width: 340px;
        }
        .toast.show { opacity: 1; transform: none; }
        .toast.error { background: #7f1d1d; }
        .toast.done  { background: #14532d; }
        .spin {
          width: 12px; height: 12px; flex: 0 0 12px;
          border: 2px solid rgba(255,255,255,.25);
          border-top-color: #fff; border-radius: 50%;
          animation: r .7s linear infinite;
        }
        .toast:not(.busy) .spin { display: none; }
        @keyframes r { to { transform: rotate(360deg); } }
      </style>
      <div class="toast"><div class="spin"></div><span class="msg"></span></div>`;
    document.body.appendChild(host);
    return sr.querySelector(".toast");
  }

  window.__yomiToast = function toast(message, state = "busy") {
    const el = toastEl();
    el.className = `toast show ${state}`;
    el.querySelector(".msg").textContent = message;
    clearTimeout(el.__t);
    if (state !== "busy") {
      el.__t = setTimeout(() => el.classList.remove("show"),
                          state === "error" ? 8000 : 4500);
    }
  };

  // Toggle key. `t` hides every overlay so the original page can be read, which
  // is also the fastest way to check a translation against the Japanese.
  if (!window.__yomiToggleBound) {
    window.__yomiToggleBound = true;
    let hidden = false;
    window.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

      if (e.key !== "t") return;
      hidden = !hidden;
      document.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => {
        n.style.display = hidden ? "none" : "";
      });
      console.log(`[yomi] overlays ${hidden ? "hidden" : "shown"} (press t)`);
      window.__yomiToast?.(hidden ? "Original shown — press T" : "Translation shown", "done");
    });
  }
})();