"""OCR over detected regions.

manga-ocr is Apache-2.0 and healthy. It recognises multi-line text in one
forward pass, so regions are fed whole rather than split into lines.

Two things the model card warns about that matter here:
  - it always returns *something*, even on a blank crop. Empty output is
    not a signal; garbage output is what an over-detection looks like.
  - accuracy falls off as crops get longer. Tall vertical columns are the
    worst case, which is exactly what manga is made of.
"""

from __future__ import annotations

import logging
import os
from typing import Protocol

import numpy as np
from PIL import Image

log = logging.getLogger(__name__)

# manga-ocr was trained on tightly-but-not-tightly cropped bubbles. A few
# pixels of margin measurably helps; a lot of margin pulls in artwork.
CROP_PAD_RATIO = 0.02


class Ocr(Protocol):
    name: str

    def read(self, crop: Image.Image) -> str:
        ...


class StubOcr:
    name = "stub"

    def read(self, crop: Image.Image) -> str:
        return "テスト"


class MangaOcr:
    name = "manga-ocr"

    def __init__(self, device: str = "cpu"):
        from manga_ocr import MangaOcr as _MangaOcr

        force_cpu = device == "cpu"
        self._m = _MangaOcr(force_cpu=force_cpu)

    def read(self, crop: Image.Image) -> str:
        return self._m(crop).strip()


def crop_region(
    image: np.ndarray, box: tuple[float, float, float, float]
) -> Image.Image:
    """Crop with a small margin, clamped to image bounds. Expects RGB."""
    h, w = image.shape[:2]
    x0, y0, x1, y1 = box
    pad_x = (x1 - x0) * CROP_PAD_RATIO
    pad_y = (y1 - y0) * CROP_PAD_RATIO

    x0 = int(max(0, x0 - pad_x))
    y0 = int(max(0, y0 - pad_y))
    x1 = int(min(w, x1 + pad_x))
    y1 = int(min(h, y1 + pad_y))

    return Image.fromarray(image[y0:y1, x0:x1])


def build_ocr() -> Ocr:
    if os.environ.get("YOMI_OCR", "manga-ocr") == "stub":
        log.warning("Using StubOcr -- no real recognition is happening.")
        return StubOcr()
    return MangaOcr(device=os.environ.get("YOMI_DEVICE", "cpu"))