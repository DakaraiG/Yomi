// Panel and page segmentation from the image.
//
// A port of the v0.3 sidecar's panels.py, faithful down to the thresholds;
// fixtures/baseline.json holds the reading order it produced, which is what the
// tests assert against.
//
// Reading order on manga is panel-major, and box geometry alone cannot recover
// panel boundaries: on the ynko test page the widest gap between boxes is not a
// border, and a gap inside one row exceeds the gap that separates two rows. Any
// "big gap = panel edge" rule gets that page wrong, so this goes to the image
// and finds the drawn borders.
//
//   1. Split a double-page spread down its central gutter, right page first.
//   2. Split each page into vertical strips on full-height white columns. A
//      strip with no drawn panel border is furniture, not panels.
//   3. Over the strips that hold panels, split into rows on near-white
//      horizontal scanlines.
//   4. Split each row into panels on near-white vertical columns, keeping only
//      candidates flanked within ~6px by a drawn border.
//
// Step 4's flanking test is what makes this work: artwork whitespace produces
// plenty of white columns, and without the test every one becomes a false
// gutter.
//
// Borders sit hard against the gutters, so the pure-white run that survives is
// only 3-5px even where the gutter looks wide -- any minimum-width filter has to
// stay <= 2px or it discards real gutters.
//
// Every threshold here is provisional, validated against one page and one
// spread.

// A pixel counts as white below this much ink. Loose enough to survive JPEG
// ringing around the borders, tight enough that screentone reads as content.
export const WHITE_LEVEL = 235;

export const ROW_WHITE_FRACTION = 0.98;     // scanline is a row gutter above this
export const COL_WHITE_FRACTION = 0.99;     // column is a panel gutter above this
// Column runs clear top to bottom. Not 1.0, nor even 0.995: a scan carries a
// dark strip along the sheet's top and bottom edges, which caps every column at
// ~0.994 white, so a literal full-height test finds nothing on a real page.
export const FULL_HEIGHT_WHITE_FRACTION = 0.98;
export const BORDER_WHITE_FRACTION = 0.25;  // column is a drawn border below this
export const BORDER_DARK_FRACTION = 0.60;   // scanline is a panel's top/bottom border above this

export const BORDER_SEARCH_PX = 6;  // how far either side of a gutter to look for a border
export const MIN_GUTTER_PX = 1;     // see the module note: this must stay <= 2

// Anything smaller is not a panel. Without this the scan's dark page edge yields
// sliver "panels" down both sides and a title in heavy type clears the border
// test on its own. These bound the panel, not the gutter, so the <= 2px rule
// above does not apply.
export const MIN_PANEL_WIDTH_FRACTION = 0.10;
export const MIN_PANEL_HEIGHT_FRACTION = 0.05;

// A spread's central gutter. Both signals are required: an aligned single-page
// panel grid also produces a full-height white column, and splitting a page on
// it would order the page column-major instead of row-major.
export const SPREAD_MIN_ASPECT = 1.0;
export const SPREAD_GUTTER_WIDTH_FRACTION = 0.015;

/**
 * White mask with a summed-area table over it, so the dozens of overlapping
 * rectangle means this algorithm asks for cost O(width) rather than O(area).
 *
 * Grey is a plain channel mean, not the Rec. 601 luma used elsewhere in the
 * project: the thresholds above were tuned against this definition and swapping
 * in luma shifts every one of them.
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
 * middle; either signal alone is ambiguous.
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

    // A drawn border on either side. Artwork whitespace fails this, which is
    // the entire point of the test.
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

  // A panel row, or just ink -- a title, a column of commentary? A drawn panel
  // is a rectangle: a border across its width and one down its height. Text
  // clears the first on any horizontal stroke, so the second decides.
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
 * Shared by panel finding and furniture segmentation: a strip of three character
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
 * line of type, which is what the row projection alone gives.
 *
 * The rule is typographic: a blank line ends an item and never falls between
 * lines of one paragraph, so the strip's own median line height (measured in the
 * first pass) becomes the gutter threshold for the second. That adapts to type
 * size rather than assuming one.
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
 * commentary, character sidebars. Segmentation identifies these in order to
 * exclude them, and one strip is one column of commentary -- which settles what
 * geometry cannot, namely whether two columns 3px apart are one block or two.
 */
function makePage(x0, x1, panels, block, furniture = []) {
  return { x0, x1, panels, block, furniture };
}

/** Segment one page: drop the furniture strips, then find the panels. */
function readPage(field, x0, x1) {
  const minWidth = Math.trunc(MIN_PANEL_WIDTH_FRACTION * (x1 - x0));
  const minHeight = Math.trunc(MIN_PANEL_HEIGHT_FRACTION * field.height);

  // Vertical strips, divided by columns that run clear top to bottom. A strip
  // holding no drawn panel is furniture. Stacked sidebars defeat any "taller
  // than half the page" heuristic; containing no panel border is the real
  // signal.
  const cols = field.columnFractions(x0, x1, 0, field.height);
  const notFullHeight = new Uint8Array(cols.length);
  for (let i = 0; i < cols.length; i++) {
    notFullHeight[i] = cols[i] >= FULL_HEIGHT_WHITE_FRACTION ? 0 : 1;
  }

  // The size filter has to run here, not only below: the scan's dark edge forms
  // its own full-height strip, and a solid dark bar passes the border test
  // honestly. Being too narrow to hold a panel is what disqualifies it.
  const withPanels = [];
  const furniture = [];
  for (const [sx0, sx1] of runs(notFullHeight)) {
    const a = x0 + sx0;
    const b = x0 + sx1;
    if (panelsIn(field, a, b, minWidth, minHeight).length) {
      withPanels.push([a, b]);
    } else {
      // One box per stacked item, not one per strip: a margin holding three
      // character bios is three regions.
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
