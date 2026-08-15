// What surface is a region sitting on?


/** Luminance, 0-255, from 0-255 channels. */
const LUM = (r, g, b) => r * 0.299 + g * 0.587 + b * 0.114;

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
 * Describe the background of one region.
 *
 * @param {Uint8ClampedArray} data RGBA for the region's bounding box.
 * @param {number} stride Bytes between sampled pixels. Every 4th pixel (16) is
 *   plenty of signal and keeps this off the critical path.
 * @returns {{fill:number[], bgLum:number, bgStd:number, bgShare:number}|null}
 *   `fill` is the mean RGB of the background pixels -- what to cover the region
 *   with. `bgLum` is their mean luminance 0-1, which decides ink colour.
 *   `bgStd` is their luminance standard deviation 0-1: how far from uniform the
 *   surface is, i.e. how much of a lie any fill would be. `bgShare` is the
 *   fraction of the region they account for -- see below.
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

  // Second pass: colour and luminance moments for each class.
  //
  // Classified on the SAME truncated value the histogram was built from. Using
  // the float here instead puts every pixel whose luminance falls inside the
  // threshold's own bin on the wrong side -- and since Otsu returns the lowest
  // tying threshold, that bin is usually the text itself, which quietly dragged
  // glyph pixels into the background and turned a cream bubble into "artwork".
  const cnt = [0, 0], sr = [0, 0], sg = [0, 0], sb = [0, 0];
  const sl = [0, 0], sl2 = [0, 0];
  for (let i = 0; i < data.length; i += stride) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const lum = LUM(r, g, b);
    const c = (lum | 0) > t ? 1 : 0;
    cnt[c]++; sr[c] += r; sg[c] += g; sb[c] += b;
    sl[c] += lum; sl2[c] += lum * lum;
  }

  // The background is whichever side of the split holds the bulk.
  const c = cnt[1] >= cnt[0] ? 1 : 0;
  const k = cnt[c];
  const mean = sl[c] / k;
  // Clamped because floating-point error can make a uniform region's variance
  // very slightly negative.
  const sd = Math.sqrt(Math.max(0, sl2[c] / k - mean * mean));

  return {
    fill: [Math.round(sr[c] / k), Math.round(sg[c] / k), Math.round(sb[c] / k)],
    bgLum: +(mean / 255).toFixed(3),
    bgStd: +(sd / 255).toFixed(3),
    bgShare: +(k / n).toFixed(3)
  };
}
