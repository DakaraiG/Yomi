// Panel and page segmentation from the image.
//
// Port of sidecar/app/panels.py, faithful down to the thresholds. The Python
// original is archived at the v0.3-server-architecture tag; fixtures/baseline.json
// holds the reading order it produced on the test pages, which is what the
// tests here assert against.
//
// Reading order on manga is panel-major: you finish one panel before starting
// the next. Box geometry alone cannot recover panel boundaries -- on the ynko
// test page the widest inter-box vertical gap (113px) is not a border, while the
// real gutter between rows is 28px, and a 61px gap inside row 1 exceeds the 49px
// gap that actually separates rows 1 and 2. Any rule keyed on "big gap = panel
// edge" gets that page wrong. So we go to the image and find the drawn borders.
//
// Method:
//
//   1. Split a double-page spread down its central gutter, right page first.
//   2. Split each page into vertical strips on full-height white columns. A
//      strip with no drawn panel border in it is furniture -- margin commentary,
//      character sidebars -- not panels.
//   3. Over the strips that do hold panels, split into rows on horizontal
//      scanlines that are >98% white.
//   4. Split each row into panels on vertical columns that are >99% white,
//      keeping only candidates flanked within ~6px by a <25%-white column.
//
// Step 4's flanking test is what makes this work. Artwork whitespace produces
// plenty of white columns -- 9 of them in row 3 of the single-page test -- and
// none are flanked by drawn borders, so all 9 are correctly rejected. Without it
// every one becomes a false gutter.
//
// The borders sit hard against the gutters, so the surviving pure-white run is
// only 3-5px even where the gutter looks wide. Any minimum-width filter has to
// stay <=2px or it discards real gutters.
//
// EVERY THRESHOLD HERE IS PROVISIONAL, validated against two images: one page
// (17/17 regions correctly ordered) and one spread.

// A pixel counts as white below this much ink. Loose enough to survive JPEG
// ringing around the borders, tight enough that screentone reads as content.
export const WHITE_LEVEL = 235;

export const ROW_WHITE_FRACTION = 0.98;     // scanline is a row gutter above this
export const COL_WHITE_FRACTION = 0.99;     // column is a panel gutter above this
// Column runs clear from top to bottom. Not 1.0, and not even 0.995: a scan
// carries a dark strip along the sheet's top and bottom edges, ~10 rows on the
// test images, which caps *every* column at ~0.994 white. A literal full-height
// test finds nothing at all on a real page.
export const FULL_HEIGHT_WHITE_FRACTION = 0.98;
export const BORDER_WHITE_FRACTION = 0.25;  // column is a drawn border below this
export const BORDER_DARK_FRACTION = 0.60;   // scanline is a panel's top/bottom border above this

export const BORDER_SEARCH_PX = 6;  // how far either side of a gutter to look for a border
export const MIN_GUTTER_PX = 1;     // see the module note: this must stay <= 2

// Anything smaller than this is not a panel. Without it the scan's dark page
// edge yields 3px-wide "panels" down both sides, the sheet's top and bottom
// edges yield full-width 10px ones, and a title set in heavy type clears the
// border test on its own -- 13 panels on a page that has 5. These bound the
// panel, not the gutter, so the <=2px rule above does not apply.
export const MIN_PANEL_WIDTH_FRACTION = 0.10;
export const MIN_PANEL_HEIGHT_FRACTION = 0.05;

// A spread's central gutter. Both signals are required: an aligned single-page
// panel grid also produces a full-height white column, and splitting a page on
// it would order the page column-major instead of row-major.
export const SPREAD_MIN_ASPECT = 1.0;
export const SPREAD_GUTTER_WIDTH_FRACTION = 0.015;

/**
 * White mask, with an integral image over it.
 *
 * NumPy gets `white[y0:y1, x0:x1].mean(axis=0)` for free; JS does not, and this
 * algorithm asks for exactly that over dozens of overlapping rectangles. A
 * summed-area table makes every one of them O(width) instead of O(area), which
 * is the difference between milliseconds and seconds on a 2248x1604 spread.
 *
 * NOTE the grey conversion is a plain channel MEAN, matching panels.py. It is
 * deliberately not the Rec. 601 luma used elsewhere in the project: the
 * thresholds above were tuned against this definition, and swapping in luma
 * shifts every one of them.
 */
export class WhiteField {
  constructor({ width, height, data }) {
    this.width = width;
    this.height = height;

    const mask = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      mask[p] = (data[i] + data[i + 1] + data[i + 2]) / 3 >= WHITE_LEVEL ? 1 : 0;
    }
    this.mask = mask;

    // (height+1) x (width+1), so every lookup is unconditional.
    const stride = width + 1;
    const sum = new Int32Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowRun = 0;
      const src = y * width;
      const cur = (y + 1) * stride;
      const prev = y * stride;
      for (let x = 0; x < width; x++) {
        rowRun += mask[src + x];
        sum[cur + x + 1] = sum[prev + x + 1] + rowRun;
      }
    }
    this.sum = sum;
    this.stride = stride;
  }

  /** Count of white pixels in [x0,x1) x [y0,y1). */
  rect(x0, y0, x1, y1) {
    const { sum, stride } = this;
    return sum[y1 * stride + x1] - sum[y0 * stride + x1]
         - sum[y1 * stride + x0] + sum[y0 * stride + x0];
  }

  /** Per-column white fraction over rows [y0,y1), for columns [x0,x1). */
  columnFractions(x0, x1, y0, y1) {
    const rows = y1 - y0;
    const out = new Float64Array(x1 - x0);
    if (rows <= 0) return out;
    for (let x = x0; x < x1; x++) out[x - x0] = this.rect(x, y0, x + 1, y1) / rows;
    return out;
  }

  /** Per-row white fraction over columns [x0,x1), for rows [y0,y1). */
  rowFractions(y0, y1, x0, x1) {
    const cols = x1 - x0;
    const out = new Float64Array(y1 - y0);
    if (cols <= 0) return out;
    for (let y = y0; y < y1; y++) out[y - y0] = this.rect(x0, y, x1, y + 1) / cols;
    return out;
  }
}

/** [start, end) runs of true in a boolean-ish array. */
export function runs(flags) {
  const out = [];
  let start = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] && start === null) start = i;
    else if (!flags[i] && start !== null) { out.push([start, i]); start = null; }
  }
  if (start !== null) out.push([start, flags.length]);
  return out;
}

/** [first, last) entries holding ink, trimming the margins. */
function contentExtent(isWhite) {
  let first = -1, last = -1;
  for (let i = 0; i < isWhite.length; i++) {
    if (isWhite[i]) continue;
    if (first === -1) first = i;
    last = i;
  }
  return first === -1 ? null : [first, last + 1];
}

/**
 * x of the gutter between two pages, or null if this is a single page.
 *
 * Requires both a landscape aspect and a wide full-height white column near the
 * middle. Either signal alone is ambiguous -- see SPREAD_MIN_ASPECT.
 */
export function spreadSplit(field) {
  const { width, height } = field;
  if (width <= SPREAD_MIN_ASPECT * height) return null;

  const cols = field.columnFractions(0, width, 0, height);
  const fullHeight = new Uint8Array(width);
  for (let x = 0; x < width; x++) fullHeight[x] = cols[x] >= FULL_HEIGHT_WHITE_FRACTION ? 1 : 0;

  const minWidth = SPREAD_GUTTER_WIDTH_FRACTION * width;
  let best = null;

  for (const [start, end] of runs(fullHeight)) {
    if (end - start <= minWidth) continue;
    const centre = (start + end) / 2;
    if (centre < width / 3 || centre > (2 * width) / 3) continue;
    if (best === null || end - start > best[1] - best[0]) best = [start, end];
  }

  return best === null ? null : Math.floor((best[0] + best[1]) / 2);
}

/** Split one row band into panels. null if the band holds no drawn panel. */
function splitRow(field, y0, y1, x0, x1, minWidth) {
  if (y1 - y0 <= 0 || x1 - x0 <= 0) return null;

  const colWhite = field.columnFractions(x0, x1, y0, y1);
  const isGutter = new Uint8Array(colWhite.length);
  const isBorder = new Uint8Array(colWhite.length);
  for (let i = 0; i < colWhite.length; i++) {
    isGutter[i] = colWhite[i] > COL_WHITE_FRACTION ? 1 : 0;
    isBorder[i] = colWhite[i] < BORDER_WHITE_FRACTION ? 1 : 0;
  }

  const extent = contentExtent(isGutter);
  if (extent === null) return null;
  const [left, right] = extent;

  const cuts = [];
  for (const [start, end] of runs(isGutter)) {
    if (end - start < MIN_GUTTER_PX) continue;
    if (start <= left || end >= right) continue;  // page margin, not an interior gutter

    // The drawn borders of the panels on either side. Artwork whitespace fails
    // here, which is the entire point of the test.
    let before = false;
    for (let i = Math.max(0, start - BORDER_SEARCH_PX); i < start; i++) {
      if (isBorder[i]) { before = true; break; }
    }
    if (!before) continue;

    let after = false;
    for (let i = end; i < Math.min(isBorder.length, end + BORDER_SEARCH_PX); i++) {
      if (isBorder[i]) { after = true; break; }
    }
    if (after) cuts.push([start, end]);
  }

  let spans = [];
  let cursor = left;
  for (const [start, end] of cuts) { spans.push([cursor, start]); cursor = end; }
  spans.push([cursor, right]);
  spans = spans.filter(([sx0, sx1]) => sx1 - sx0 >= minWidth);

  // Is this a panel row, or just ink -- a title, a column of commentary? A drawn
  // panel is a rectangle: a border running across its width AND one running down
  // its height. Text clears the first test on any horizontal stroke, so the
  // second is what actually separates the two.
  const bordered = spans.some(([sx0, sx1]) => {
    const rowWhite = field.rowFractions(y0, y1, x0 + sx0, x0 + sx1);
    let maxDark = 0;
    for (let i = 0; i < rowWhite.length; i++) {
      const dark = 1 - rowWhite[i];
      if (dark > maxDark) maxDark = dark;
    }
    if (maxDark < BORDER_DARK_FRACTION) return false;
    for (let i = sx0; i < sx1; i++) if (isBorder[i]) return true;
    return false;
  });
  if (!bordered) return null;

  return spans.map(([sx0, sx1]) => [sx0 + x0, y0, sx1 + x0, y1]);
}

/**
 * Horizontal bands of content within a column range, split on row gutters.
 *
 * Shared by panel finding and furniture segmentation: "what is stacked in this
 * column" is the same question in both cases, and a strip of three character
 * bios separates exactly the way a page of three panel rows does.
 */
export function rowBands(field, x0, x1, minGutter = MIN_GUTTER_PX) {
  if (x1 - x0 <= 0) return [];

  const rowWhite = field.rowFractions(0, field.height, x0, x1);
  const isRowGutter = new Uint8Array(field.height);
  for (let y = 0; y < field.height; y++) {
    isRowGutter[y] = rowWhite[y] > ROW_WHITE_FRACTION ? 1 : 0;
  }

  const gutter = new Uint8Array(field.height);
  for (const [start, end] of runs(isRowGutter)) {
    if (end - start >= minGutter) gutter.fill(1, start, end);
  }

  const notGutter = new Uint8Array(field.height);
  for (let y = 0; y < field.height; y++) notGutter[y] = gutter[y] ? 0 : 1;

  return runs(notGutter);
}

/**
 * Stacked items within a furniture strip -- one per character bio, not one per
 * line of type.
 *
 * The strip's row projection alone splits on EVERY line gap, because a narrow
 * column of horizontal text has a white scanline between each line. On the
 * ynko2 sidebar that is 48 gutters for 3 bios.
 *
 * The separating rule is typographic rather than numeric: a blank line ends an
 * item, and you do not leave one between lines of the same paragraph. So the
 * unit is the strip's own line height -- measured from the first pass, then
 * used as the gutter threshold for the second. On that sidebar the line gaps
 * run 1-12px against a ~17px line height and the bio separators are 29px, so
 * the rule cuts in exactly the right two places and adapts to type size rather
 * than assuming one.
 */
export function furnitureBands(field, x0, x1) {
  const lines = rowBands(field, x0, x1);
  if (lines.length < 2) return lines;

  const heights = lines.map(([a, b]) => b - a).sort((a, b) => a - b);
  const lineHeight = heights[Math.floor(heights.length / 2)];
  if (lineHeight < 1) return lines;

  return rowBands(field, x0, x1, lineHeight);
}

/** Panels within a column range, in reading order (R->L, then T->B). */
function panelsIn(field, x0, x1, minWidth, minHeight) {
  if (x1 - x0 <= 0) return [];

  const panels = [];
  for (const [y0, y1] of rowBands(field, x0, x1)) {
    if (y1 - y0 < minHeight) continue;
    const row = splitRow(field, y0, y1, x0, x1, minWidth);
    if (row && row.length) {
      // Right-to-left within the row.
      panels.push(...row.sort((a, b) => b[2] - a[2]));
    }
  }
  return panels;
}

/**
 * One page of the image. `panels` is already in reading order.
 *
 * `block` is the bounding box of the panels, or null when the page has no drawn
 * panels at all -- a borderless page, a blank one -- in which case the caller
 * should fall back to pure geometry for this page's regions.
 *
 * `furniture` holds the vertical strips that contain no drawn panel: margin
 * commentary, character sidebars. Segmentation has to identify these anyway in
 * order to exclude them, and each strip is one column of commentary -- which
 * makes them the structural answer to a question geometry cannot settle, namely
 * whether two vertical columns 3px apart are one commentary or two.
 */
function makePage(x0, x1, panels, block, furniture = []) {
  return { x0, x1, panels, block, furniture };
}

/** Segment one page: drop the furniture strips, then find the panels. */
function readPage(field, x0, x1) {
  const minWidth = Math.trunc(MIN_PANEL_WIDTH_FRACTION * (x1 - x0));
  const minHeight = Math.trunc(MIN_PANEL_HEIGHT_FRACTION * field.height);

  // Vertical strips, divided by columns that run clear top to bottom. A strip
  // holding no drawn panel is furniture: margin commentary, character sidebars.
  // Stacked sidebars defeat a "taller than half the page" heuristic -- the
  // spread has three per page, each about 23% of the height -- but none of them
  // contains a panel border, which is the real signal.
  const cols = field.columnFractions(x0, x1, 0, field.height);
  const notFullHeight = new Uint8Array(cols.length);
  for (let i = 0; i < cols.length; i++) {
    notFullHeight[i] = cols[i] >= FULL_HEIGHT_WHITE_FRACTION ? 0 : 1;
  }

  // The size filter has to run here and not only below: the scan's dark edge
  // forms its own full-height strip, 8px and 3px wide on the test page, and a
  // solid dark bar passes the border test honestly -- it is dark across its
  // width and down its height, which is exactly what a border is. Too narrow to
  // hold a panel is the thing that disqualifies it.
  const withPanels = [];
  const furniture = [];
  for (const [sx0, sx1] of runs(notFullHeight)) {
    const a = x0 + sx0;
    const b = x0 + sx1;
    if (panelsIn(field, a, b, minWidth, minHeight).length) {
      withPanels.push([a, b]);
    } else {
      // One box per stacked item, not one per strip. A margin holding three
      // character bios is three regions, and they separate on row gutters
      // exactly as panel rows do -- so the same projection answers it.
      for (const [by0, by1] of furnitureBands(field, a, b)) furniture.push([a, by0, b, by1]);
    }
  }
  if (!withPanels.length) return makePage(x0, x1, [], null, furniture);

  // Re-run over the strips as one span so rows line up across them. An aligned
  // panel grid splits into strips at step one; this puts it back.
  const panels = panelsIn(
    field,
    Math.min(...withPanels.map((s) => s[0])),
    Math.max(...withPanels.map((s) => s[1])),
    minWidth,
    minHeight
  );
  if (!panels.length) return makePage(x0, x1, [], null, furniture);

  const block = [
    Math.min(...panels.map((p) => p[0])),
    Math.min(...panels.map((p) => p[1])),
    Math.max(...panels.map((p) => p[2])),
    Math.max(...panels.map((p) => p[3]))
  ];
  return makePage(x0, x1, panels, block, furniture);
}

/**
 * Pages in reading order: right page first on a spread.
 *
 * Only two levels are projected within a page (rows, then panels). Recursing
 * further would re-split a panel on any horizontal band of white artwork, and
 * the flanking test that makes the vertical split safe has no horizontal
 * equivalent here.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}|WhiteField} image
 */
export function detectPages(image) {
  const field = image instanceof WhiteField ? image : new WhiteField(image);
  const split = spreadSplit(field);
  const bounds = split === null
    ? [[0, field.width]]
    : [[split, field.width], [0, split]];
  return bounds.map(([x0, x1]) => readPage(field, x0, x1));
}
