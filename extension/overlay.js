// Yomi overlay renderer: draws English over the page image from the backend's
// normalised polygons. Three problems drive most of the code:
//
// 1. Isolation. Manga readers have aggressive CSS, so everything lives in a
//    shadow root and neither side can restyle the other.
//
// 2. Fitting. Japanese is vertical and compact, English horizontal and long: a
//    tall narrow bubble that held 8 kana has to hold a full sentence.
//
// 3. Repositioning. Zoom, window resize and responsive readers all change the
//    image's rendered size. Polygons are normalised 0-1 so this is a multiply
//    rather than a re-request.

(() => {
  const HOST_ATTR = "data-yomi-overlay";

  // ---- font loading -------------------------------------------------------
  //
  // Font faces are document-scoped, so an @font-face rule inside a shadow root
  // is silently ignored and everything falls back with no error. The CSS Font
  // Loading API registers against the document, and the shadow tree can then use
  // the family name normally.
  //
  // Filenames must match extension/fonts/; missing faces are skipped, so a
  // regular-only font still works.
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

  // Only for regions that arrive without a box shaped by lib/layout.js.
  const BOX_EXPAND = 0.08;

  const CSS = `
    :host { all: initial; }
    .layer { position: absolute; inset: 0; pointer-events: none; }

    /* The clean plate: the whole page with the Japanese erased, drawn over the
       original. Sized in percentages so it follows the host, which is already
       positioned from the image's bounding rect on every resize and reflow.

       image-rendering stays at the default -- the plate is the page at natural
       size, so the browser applies the same downscale as to the image beneath,
       which is the point. */
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
      /* The box is the only part of the page this region may paint on; text
         spilling out of it lands on artwork or a neighbour's bubble. A region
         that cannot fit its text is reported rather than allowed to bleed. */
      overflow: hidden;
      text-align: center;
      font-family: "Yomi Letter", "CC Wild Words", "Wild Words", "Anime Ace",
                   "Comic Neue", "Comic Sans MS", system-ui, sans-serif;
      font-weight: 700;
      /* Scanlation convention. */
      text-transform: uppercase;
      line-height: 1.06;
      letter-spacing: 0.005em;
      hyphens: auto;
      overflow-wrap: break-word;
      /* Greedy wrapping fills each line to the brim and leaves the last holding
         a single word; balancing evens the line lengths, which is the ragged
         edge people read as hand-set. */
      text-wrap: balance;
      pointer-events: auto;
      cursor: default;
    }

    /* --ink and --halo are set per region from pixels measured in the service
       worker; the defaults here are for a region that arrives unmeasured. */
    .region {
      --ink: #000;
      --halo: #fff;
      /* Above the plate, stated rather than left to insertion order, which is
         one reordering away from every translation vanishing behind an image of
         the page it belongs to. */
      z-index: 1;
      color: var(--ink);
      /* In em, not %: percentage padding resolves against the box's width on
         every side, so a wide short box loses a third of its height to top and
         bottom padding and has to set its text smaller to compensate. */
      padding: 0.1em 0.3em;

      /* The plate removes the Japanese, so the only thing left for the text to
         separate itself from is artwork -- screentone, hatching, a panel tone.
         A light stroke does that without reading as a sticker; the heavy
         treatment survives below for regions the plate could not repair. */
      -webkit-text-stroke: 0.08em var(--halo);
      paint-order: stroke fill;
      text-shadow: 0 0 0.12em var(--halo), 0 0 0.24em var(--halo);
    }

    /* Tracking, so SFX still reads as SFX rather than as narration that
       happened to land on artwork. */
    .region.sfx {
      letter-spacing: 0.02em;
    }

    /* The Japanese is still under this one: the service worker marks regions the
       plate deliberately left alone, where erasing would rub out the drawing.
       The repeated identical shadows are the point -- each compounds the alpha,
       so eight of them build an opaque cushion in the text's own shape, enough
       to win against artwork and the lettering underneath. */
    .region.unerased {
      -webkit-text-stroke: 0.18em var(--halo);
      padding: 0;
      text-shadow:
        0 0 0.30em var(--halo), 0 0 0.30em var(--halo),
        0 0 0.30em var(--halo), 0 0 0.30em var(--halo),
        0 0 0.60em var(--halo), 0 0 0.60em var(--halo),
        0 0 0.60em var(--halo), 0 0 0.90em var(--halo);
      /* Beside the artwork, not on it: the box belongs to the drawing, so
         layout() gives this region a strip alongside instead, and it is the one
         kind of region allowed out of its own box rather than clipping a
         descender or a wide word. */
      overflow: visible;
      align-items: flex-start;
      white-space: nowrap;
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
   * Binary search rather than shrink-until-it-fits: every measurement forces a
   * reflow, so ~6 beats up to 40 on a page with 20 regions.
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
   * Position and size every region: pass 1 finds the largest size each box could
   * take on its own, pass 2 applies the page-wide cap and floor.
   *
   * Size tracks the bubble, as in published scans -- a big bubble gets big
   * lettering and a two-word one does not shout -- so the page percentile is a
   * cap on the outliers rather than a uniform target. Sizing every box near the
   * tightest one on the page throws away the room in all the others.
   *
   * Both the cap and the MIN_PX floor are soft: neither may set a size the box
   * did not measure as able to hold, or words run past the edges and, with
   * nothing allowed out of the box, get cut off mid-word.
   */

  const CAP_PERCENTILE = 0.8;
  const MIN_PX = 11;

  // The strip an unerased region's translation is set in, as a fraction of the
  // region's height and as a floor in pixels. Deliberately small: a label beside
  // a drawing, not a replacement for it.
  const SFX_STRIP = 0.34;
  const SFX_STRIP_PX = 16;

  function layout(host, layer, img) {
    const t0 = performance.now();
    const r = positionHost(host, img);
    // Regions only: the clean plate is an <img> in the same layer with no
    // data-bounds, and JSON.parse(undefined) below would abandon layout() before
    // a single region was positioned, stacking every translation at the top of
    // the page with nothing but a missing log line to show for it.
    const els = Array.from(layer.querySelectorAll(".region"));

    // Skip if nothing moved. layout() runs on render and on every
    // ResizeObserver and window-resize callback, which readers fire freely, and
    // each fitText step forces a synchronous reflow on the page's own main
    // thread -- ~150 of them at 25 regions.
    if (host.__yomiFitAt &&
        Math.abs(host.__yomiFitAt.w - r.width) < 0.5 &&
        Math.abs(host.__yomiFitAt.h - r.height) < 0.5) {
      return;
    }
    host.__yomiFitAt = { w: r.width, h: r.height };

    const maxima = els.map((el) => {
      const b = JSON.parse(el.dataset.bounds);

      // A region the plate could not repair keeps its artwork, so the
      // translation goes in a strip against the outside edge instead -- below
      // by default, above when below would leave the page. The scanlation
      // convention for SFX: leave the drawing, set the reading beside it.
      if (el.classList.contains("unerased")) {
        const strip = Math.max(SFX_STRIP_PX, b.h * r.height * SFX_STRIP);
        const below = (b.y + b.h) * r.height;
        const fits = below + strip <= r.height;
        el.style.left = `${b.x * r.width}px`;
        el.style.top = `${fits ? below : Math.max(0, b.y * r.height - strip)}px`;
        el.style.width = `${b.w * r.width}px`;
        el.style.height = `${strip}px`;
        el.style.alignItems = fits ? "flex-start" : "flex-end";
        return fitText(el, strip * 0.8);
      }

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
      // min() last: whatever the floor and cap want, the size the box measured
      // as able to hold wins.
      el.style.fontSize = `${Math.min(maxima[i], Math.max(MIN_PX, cap))}px`;
      // An unerased region is meant to overflow: its strip is an anchor, not a
      // container. Checking it would report every SFX label as clipped and bury
      // the real ones.
      if (el.classList.contains("unerased")) return;
      const over = el.scrollHeight > el.clientHeight + 1 ||
                   el.scrollWidth > el.clientWidth + 1;
      if (over) clipped.push(el.textContent.slice(0, 30));
    });

    // Reported, not drawn: an outline around the offenders is a visible defect
    // in the thing being debugged.
    if (clipped.length) {
      console.warn(
        `[yomi] ${clipped.length}/${els.length} region(s) too small even for ` +
        `their fitted size:`, clipped);
    }

    // Page-side layout only, so "the overlay feels slow" can be separated from
    // "the model call was slow".
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

    // The plate first, so every region lands on top of it.
    //
    // A data URL rather than a blob URL: a blob URL must be revoked or it leaks
    // for the lifetime of the tab, and this overlay is rebuilt on every resize.
    // A page cached before plates existed has none and renders on the original.
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
      // The overlay does not decide what was erased; it renders what the
      // service worker reports. An unerased region still has Japanese under it
      // and needs the heavy treatment.
      const unerased = region.erased === false ? " unerased" : "";
      el.className =
        `region ${region.kind}${unerased}${untranslated ? " untranslated" : ""}`;

      // Pure black or white, like the scans this imitates: a near-black reads as
      // washed out next to the artwork's own solid blacks.
      if (region.darkBg !== undefined) {
        el.style.setProperty("--ink", region.darkBg ? "#fff" : "#000");
        el.style.setProperty("--halo", region.darkBg ? "#000" : "#fff");
      }

      // Required for `hyphens: auto` to do anything: hyphenation is
      // per-language and the browser will not guess, and inside a shadow root on
      // a Japanese reader these otherwise inherit lang="ja" or nothing. Without
      // it, long words cannot fit a narrow bubble at any readable size.
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
  // A translation takes ten seconds, and silence for that long is
  // indistinguishable from the extension being broken.

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

  // `t` hides every overlay, to read the original or check a translation
  // against the Japanese.
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