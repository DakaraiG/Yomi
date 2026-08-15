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

  // The detector returns the TEXT region, not the bubble. Bubbles are larger
  // than the text they contain, so we can spend a little of that margin to give
  // English more room. Too much and boxes collide with neighbouring art.
  const BOX_EXPAND = 0.08;

  const CSS = `
    :host { all: initial; }
    .layer { position: absolute; inset: 0; pointer-events: none; }

    .region {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: center;
      box-sizing: border-box;
      /* Visible, not hidden: the legibility floor in layout() lets a box that
         cannot fit its text at the minimum size overflow rather than shrink
         into unreadability, and clipping would defeat that. */
      overflow: visible;
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
      pointer-events: auto;
      cursor: default;
    }

    /* --fill, --ink and --halo are set per region from the pixels measured in
       the service worker. Covering the original is not optional for anything
       longer than an SFX -- leaving Japanese visible under English makes both
       unreadable -- so the only open question is what colour to cover it in,
       and that is a measurement, not a guess about kind. Defaults here are the
       old white assumption, used only if a region arrives unmeasured. */
    .region {
      --fill: #fff;
      --ink: #111;
      --halo: #fff;
    }

    /* The seamless trick: the fill MATCHES the surface underneath, so a fill
       that is opaque in the middle and fades to transparent before the edge is
       invisible against it. No hard rectangle edge, no need to match the
       bubble's exact outline -- which we cannot know anyway. This is what makes
       a measured colour so much more forgiving than a white one: on a grey
       gradient panel a white box is a hole, a grey one is seamless. */
    .region.bubble, .region.thought {
      background: radial-gradient(ellipse at center,
                  var(--fill) 0%, var(--fill) 72%, transparent 100%);
      color: var(--ink);
      padding: 4%;
    }

    /* Narration boxes are rectangular and usually sit flush to a border, so
       fade on the long axis only. */
    .region.narration {
      background: linear-gradient(to bottom,
                  transparent 0%, var(--fill) 6%, var(--fill) 94%, transparent 100%);
      color: var(--ink);
      padding: 3%;
    }

    /* SFX ALWAYS outlines, however uniform its pixels turn out to be. It is
       short, it sits on artwork by nature, and filling behind it destroys the
       panel for no readability gain. */
    .region.sfx {
      background: none !important;
      color: var(--ink);
      -webkit-text-stroke: 0.09em var(--halo);
      paint-order: stroke fill;
      letter-spacing: 0.02em;
      padding: 0;
    }

    /* Measured as too varied to be a surface -- text sitting on artwork rather
       than inside a bubble. Any fill here punches a hole in the panel, so draw
       outlined text and let the art show through. Ink and halo come from the
       measured luminance, so this works on a dark panel too. Overrides the kind
       rules above. */
    .region.busy {
      background: none !important;
      color: var(--ink);
      -webkit-text-stroke: 0.14em var(--halo);
      paint-order: stroke fill;
      padding: 0;
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
   * Pass 1 finds the largest size each box could take on its own. Fitting each
   * box independently is what makes an amateur page look amateur: a two-word
   * bubble renders huge next to a dense one, and the eye reads the variation as
   * sloppiness even when every box is legible on its own.
   *
   * Pass 2 picks one size for the page -- a low percentile of the individual
   * maxima -- and applies it everywhere, letting only genuinely tight boxes
   * drop below it. Real lettering works the same way.
   *
   * THE FLOOR. Left alone, pass 2 will happily drive every box down to whatever
   * the tightest one allows. Text at 6px covers the Japanese AND cannot be
   * read, which is strictly worse than rendering nothing at all. So nothing
   * renders below MIN_PX; a box that cannot fit its text at that size overflows
   * instead (hence overflow: visible on .region). Overflow is recoverable by
   * eye. Unreadable text is not.
   */
  const UNIFORM_PERCENTILE = 0.35;
  const MIN_PX = 11;

  function layout(host, layer, img) {
    const r = positionHost(host, img);
    const els = Array.from(layer.children);

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
    const target = sorted[Math.floor(sorted.length * UNIFORM_PERCENTILE)];

    els.forEach((el, i) => {
      el.style.fontSize = `${Math.max(MIN_PX, Math.min(maxima[i], target))}px`;
    });
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

    for (const region of page.regions) {
      const el = document.createElement("div");
      const untranslated = !region.english;
      // Busyness is measured from the pixels underneath, not inferred from kind.
      const surface = region.busy ? " busy" : "";
      el.className =
        `region ${region.kind}${surface}${untranslated ? " untranslated" : ""}`;

      // Fill and text colour follow the measured background rather than an
      // assumption about what a bubble looks like.
      if (region.fill) {
        el.style.setProperty("--fill", `rgb(${region.fill.join(",")})`);
      }
      if (region.darkBg !== undefined) {
        el.style.setProperty("--ink", region.darkBg ? "#f4f4f4" : "#111");
        el.style.setProperty("--halo", region.darkBg ? "#000" : "#fff");
      }

      el.textContent = untranslated ? region.japanese : region.english;
      el.dataset.jp = region.japanese;
      el.dataset.bounds = JSON.stringify(boundsOf(region.polygon));
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
      if (e.key !== "t" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      hidden = !hidden;
      document.querySelectorAll(`[${HOST_ATTR}]`).forEach((n) => {
        n.style.display = hidden ? "none" : "";
      });
      console.log(`[yomi] overlays ${hidden ? "hidden" : "shown"} (press t)`);
      window.__yomiToast?.(hidden ? "Original shown — press T" : "Translation shown", "done");
    });
  }
})();