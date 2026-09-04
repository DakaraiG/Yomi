// Connected components on a binary mask, the one primitive DB post-processing,
// the classical detector and the panel segmentation all reduce to. Hand-rolled
// because opencv.js is a multi-megabyte wasm blob to ship for it.
//
// Flood fill is iterative with an explicit stack: recursion blows the JS stack
// on a full-page component, which runs to hundreds of thousands of pixels.

/**
 * @param {Uint8Array} mask   1 = foreground, 0 = background
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 * @param {boolean} [opts.eightWay=false]  8-connectivity instead of 4
 * @returns {{labels:Int32Array, boxes:Array<{x0:number,y0:number,x1:number,y1:number,area:number,touchesEdge:boolean}>}}
 *   `labels` holds 0 for background and 1-based component ids elsewhere; box
 *   `i` in the array corresponds to label `i + 1`. Boxes are inclusive of x0/y0
 *   and exclusive of x1/y1, matching every other box in this project.
 */
export function connectedComponents(mask, width, height, { eightWay = false } = {}) {
  const labels = new Int32Array(width * height);
  const boxes = [];
  const stack = new Int32Array(width * height);

  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || labels[seed]) continue;

    const id = boxes.length + 1;
    let sp = 0;
    stack[sp++] = seed;
    labels[seed] = id;

    let x0 = width, y0 = height, x1 = 0, y1 = 0, area = 0, touchesEdge = false;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % width;
      const y = (p - x) / width;

      area++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x >= x1) x1 = x + 1;
      if (y >= y1) y1 = y + 1;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesEdge = true;

      // Bounds checked per neighbour rather than by padding the mask, which at
      // page size is a real allocation.
      if (x > 0 && mask[p - 1] && !labels[p - 1]) { labels[p - 1] = id; stack[sp++] = p - 1; }
      if (x < width - 1 && mask[p + 1] && !labels[p + 1]) { labels[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - width] && !labels[p - width]) { labels[p - width] = id; stack[sp++] = p - width; }
      if (y < height - 1 && mask[p + width] && !labels[p + width]) { labels[p + width] = id; stack[sp++] = p + width; }

      if (eightWay) {
        const up = y > 0, down = y < height - 1;
        const left = x > 0, right = x < width - 1;
        if (up && left && mask[p - width - 1] && !labels[p - width - 1]) { labels[p - width - 1] = id; stack[sp++] = p - width - 1; }
        if (up && right && mask[p - width + 1] && !labels[p - width + 1]) { labels[p - width + 1] = id; stack[sp++] = p - width + 1; }
        if (down && left && mask[p + width - 1] && !labels[p + width - 1]) { labels[p + width - 1] = id; stack[sp++] = p + width - 1; }
        if (down && right && mask[p + width + 1] && !labels[p + width + 1]) { labels[p + width + 1] = id; stack[sp++] = p + width + 1; }
      }
    }

    boxes.push({ x0, y0, x1, y1, area, touchesEdge });
  }

  return { labels, boxes };
}

/** Dilate a binary mask by a square structuring element, in place-safe fashion. */
export function dilate(mask, width, height, radius = 1) {
  if (radius <= 0) return mask;

  // Separable, so O(n * r) rather than O(n * r^2).
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let d = -radius; d <= radius && !on; d++) {
        const xx = x + d;
        if (xx >= 0 && xx < width && mask[row + xx]) on = 1;
      }
      tmp[row + x] = on;
    }
  }

  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let d = -radius; d <= radius && !on; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < height && tmp[yy * width + x]) on = 1;
      }
      out[y * width + x] = on;
    }
  }
  return out;
}
