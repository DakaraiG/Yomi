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
      overflow: hidden;
      text-align: center;
      font-family: "Trebuchet MS", "Segoe UI", system-ui, sans-serif;
      font-weight: 700;
      line-height: 1.08;
      hyphens: auto;
      overflow-wrap: break-word;
      pointer-events: auto;
      cursor: default;
    }

    /* Speech and thought: cover the Japanese, because leaving it visible under
       English is unreadable for both. */
    .region.bubble, .region.thought {
      background: #fff;
      color: #111;
      border-radius: 42% / 34%;
      padding: 2%;
    }
    .region.thought { border-radius: 46% / 40%; }

    /* Narration boxes are usually rectangular. */
    .region.narration {
      background: #fff;
      color: #111;
      border-radius: 2px;
      padding: 3%;
    }

    /* SFX sits on artwork. Covering it with a white box would destroy the panel,
       so draw outlined text and let the art show through. */
    .region.sfx {
      background: transparent;
      color: #fff;
      -webkit-text-stroke: 0.09em #000;
      paint-order: stroke fill;
      letter-spacing: 0.02em;
    }

    /* Anything the model dropped renders as the original Japanese, dimmed, so a
       gap is visible rather than silent. */
    .region.untranslated {
      background: rgba(255,255,255,0.82);
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

  function layout(host, layer, img) {
    const r = positionHost(host, img);
    for (const el of layer.children) {
      const b = JSON.parse(el.dataset.bounds);
      el.style.left = `${b.x * r.width}px`;
      el.style.top = `${b.y * r.height}px`;
      el.style.width = `${b.w * r.width}px`;
      el.style.height = `${b.h * r.height}px`;
      // Cap font size by box height so a short line in a tall box does not
      // render absurdly large.
      fitText(el, b.h * r.height * 0.9);
    }
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
      el.className = `region ${region.kind}${untranslated ? " untranslated" : ""}`;
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
    });
  }
})();
