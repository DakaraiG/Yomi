// What surface is a region sitting on?


/** Luminance, 0-255, from 0-255 channels. */
const LUM = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;

/**
 * Snap a near-neutral surface to stark white or black, as official scans letter.
 *
 * A measured 252 is not white; it is 255 with JPEG noise on it, so committing to
 * the stark value beats getting closer to the average.
 *
 * The neutrality guard keeps this from undoing the measurement underneath: a
 * cream or toned bubble has a real tint across its channels and keeps it, and a
 * grey narration panel is far from either end and keeps its grey.
 */
export const SNAP_WHITE = 0.94;
export const SNAP_BLACK = 0.06;
const NEUTRAL_SPREAD = 12;

export function snapFill(fill) {
  const spread = Math.max(...fill) - Math.min(...fill);
  if (spread > NEUTRAL_SPREAD) return fill;
  const lum = LUM(fill[0], fill[1], fill[2]) / 255;
  if (lum >= SNAP_WHITE) return [255, 255, 255];
  if (lum <= SNAP_BLACK) return [0, 0, 0];
  return fill;
}

/** Otsu's threshold over a 256-bin histogram: maximises between-class variance. */
export function otsuThreshold(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];

  let sumB = 0, wB = 0, best = 0, bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;          // everything on one side: uniform region
    sumB += t * hist[t];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > bestVar) { bestVar = between; best = t; }
  }
  return best;
}

/**
 * Mean and spread of luminance over every pixel, 0-1.
 *
 * Deliberately not measureBackground: the box-widening probe asks whether a
 * strip is still the surface it started on, and a strip clipping a bubble
 * outline still has a majority of interior pixels, so a background-class
 * measurement would call it a match and walk straight off the bubble.
 */
export function stripStats(data, stride = 16) {
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < data.length; i += stride) {
    const lum = LUM(data[i], data[i + 1], data[i + 2]);
    n++; s += lum; s2 += lum * lum;
  }
  if (n === 0) return null;
  const mean = s / n;
  return {
    lum: mean / 255,
    sd: Math.sqrt(Math.max(0, s2 / n - mean * mean)) / 255
  };
}

/**
 * Describe the background of one region.
 *
 * @param {Uint8ClampedArray} data RGBA for the region's bounding box.
 * @param {number} stride Bytes between sampled pixels. Every 4th pixel is plenty
 *   of signal and keeps this off the critical path.
 * @returns {{fill:number[], bgLum:number, bgStd:number, bgShare:number}|null}
 *   `fill` is the mean RGB of the pixels at the most common background value.
 *   `bgLum` is that value 0-1, which decides ink colour. `bgStd` is the
 *   luminance spread across the whole background class, and `bgShare` the
 *   fraction of the region that class accounts for.
 */
export function measureBackground(data, stride = 16) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += stride) {
    hist[LUM(data[i], data[i + 1], data[i + 2]) | 0]++;
    n++;
  }
  if (n === 0) return null;

  const t = otsuThreshold(hist, n);

  // Which side of the split is the background: whichever holds the bulk.
  let below = 0;
  for (let i = 0; i <= t; i++) below += hist[i];
  const upper = n - below >= below;
  const k = upper ? n - below : below;
  if (k === 0) return null;

  // The mode, not the mean. A glyph fades out through antialiasing and JPEG
  // ringing, and that ramp lands on the background side of any threshold, which
  // pulls the class mean several levels dark. Taking the most common value and
  // averaging only the pixels at it keeps a cream bubble's tint and ignores the
  // ramp.
  const from = upper ? t + 1 : 0;
  const to = upper ? 255 : t;
  let peak = from;
  for (let i = from; i <= to; i++) if (hist[i] > hist[peak]) peak = i;

  // Second pass: luminance moments over the whole class, which is meant to
  // include the ramp, and colour over a tight band at the peak.
  //
  // Classified on the same truncated value the histogram was built from. The
  // float puts every pixel inside the threshold's own bin on the wrong side, and
  // since Otsu returns the lowest tying threshold, that bin is usually the text
  // -- which drags glyph pixels into the background class.
  const BAND = 6;
  let sl = 0, sl2 = 0;
  let bn = 0, br = 0, bg = 0, bb = 0;
  for (let i = 0; i < data.length; i += stride) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = LUM(r, g, b);
    const li = lum | 0;
    if ((li > t) !== upper) continue;
    sl += lum; sl2 += lum * lum;
    if (li >= peak - BAND && li <= peak + BAND) { bn++; br += r; bg += g; bb += b; }
  }

  const mean = sl / k;
  // Clamped because floating-point error can make a uniform region's variance
  // very slightly negative.
  const sd = Math.sqrt(Math.max(0, sl2 / k - mean * mean));

  return {
    fill: bn
      ? [Math.round(br / bn), Math.round(bg / bn), Math.round(bb / bn)]
      : [peak, peak, peak],
    bgLum: +(peak / 255).toFixed(3),
    bgStd: +(sd / 255).toFixed(3),
    bgShare: +(k / n).toFixed(3),
    // How much of the background sits at the surface value rather than merely on
    // that side of the split -- the test for whether there is one surface here
    // at all, since artwork has no dominant value to concentrate at.
    bgPeak: +(bn / k).toFixed(3)
  };
}
