#!/usr/bin/env python3
"""Reference pipeline: CTD segmentation mask -> dilate -> inpaint.

Every number in HANDOFF.md comes from this file. It is the spec for the
JavaScript port, not code to ship.

    python ctd_pipeline.py ctd.onnx page.jpg out.png
"""
import sys
import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

SEG_THRESHOLD = 0.30      # tuned by eye on the fixtures; revisit visually
DILATE_PX = 5             # CTD's mask is tight; this covers antialiased edges
DIFFUSION_PASSES = 48     # matches Telea to 3.0/255 on a thin mask


def detect(model_path, img, size=1024):
    """Returns (seg at page resolution, blk, det)."""
    h, w = img.shape[:2]
    r = size / max(h, w)
    nh, nw = int(round(h * r)), int(round(w * r))
    # Pad value 114, not black or white -- those read as page content and pull
    # spurious detections toward the edge.
    lb = np.full((size, size, 3), 114, np.uint8)
    lb[:nh, :nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    x = (lb.astype(np.float32) / 255.0).transpose(2, 0, 1)[None]

    sess = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    blk, seg, det = sess.run(None, {"images": x})
    # Crop the padding BEFORE resizing back, or the mask lands offset.
    return cv2.resize(seg[0, 0][:nh, :nw], (w, h)), blk, det


def diffusion_inpaint(img, mask, passes=DIFFUSION_PASSES):
    """Repeatedly replace each masked pixel with the weighted mean of its
    unmasked neighbours.

    This exists because OpenCV is not available in the browser and porting
    Telea's fast marching is a few hundred lines. On a THIN mask the two agree
    to a mean of 3.0/255 and are visually indistinguishable -- Telea earns its
    complexity on wide masks, which a per-pixel glyph mask is not.

    Port this to JS. Do not port Telea.
    """
    out = img.astype(np.float32).copy()
    m = mask.astype(bool)
    out[m] = 0
    k = np.array([[.05, .2, .05], [.2, 0, .2], [.05, .2, .05]], np.float32)
    known = (~m).astype(np.float32)
    for _ in range(passes):
        for c in range(3):
            num = cv2.filter2D(out[:, :, c] * known, -1, k)
            den = cv2.filter2D(known, -1, k) + 1e-6
            out[:, :, c] = np.where(m, num / den, out[:, :, c])
        known = np.maximum(known, cv2.filter2D(known, -1, k) > 0.02)
    return np.clip(out, 0, 255).astype(np.uint8)


def main(model_path, page_path, out_path):
    img = np.asarray(Image.open(page_path).convert("RGB"))
    seg, blk, det = detect(model_path, img)

    mask = ((seg > SEG_THRESHOLD) * 255).astype(np.uint8)
    mask = cv2.dilate(mask, np.ones((DILATE_PX, DILATE_PX), np.uint8), 1)
    print(f"mask covers {(mask > 0).mean() * 100:.1f}% of the page")

    clean = diffusion_inpaint(img, mask > 0)
    Image.fromarray(clean).save(out_path)
    Image.fromarray(mask).save(out_path.replace(".png", ".mask.png"))
    print(f"wrote {out_path} and its mask")
    print("NOW LOOK AT IT. Four metrics on this task have scored a broken "
          "result as an improvement.")


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(1)
    main(*sys.argv[1:4])
