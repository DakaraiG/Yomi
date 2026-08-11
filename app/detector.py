"""Text region detection.

comic-text-detector is GPL-3.0, dormant since Aug 2023, and not on PyPI --
so it sits behind this interface rather than being imported directly at the
call site. If it needs replacing (BallonsTranslator's fork, a fresh YOLO,
manga-image-translator's bundled copy), only this file changes.

Backends are selected by YOMI_DETECTOR:
  comic-text-detector   real thing, requires vendored repo + weights
  stub                  fixed boxes, no weights, for contract/wiring tests
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

log = logging.getLogger(__name__)

DEFAULT_CTD_MODEL = "weights/comictextdetector.pt"

_SETUP_HINT = (
    "See the 'Detector weights' section of the README, or use run.sh, which "
    "sets both variables. YOMI_DETECTOR=stub skips the real backend entirely."
)


def _require_ctd_path() -> str:
    """Resolve YOMI_CTD_PATH, or explain exactly what is wrong with it.

    Without this, every one of these cases surfaces identically as
    `ModuleNotFoundError: No module named 'inference'` from three frames
    down inside ComicTextDetector.__init__ -- which points at the vendored
    repo's internals rather than at the unset variable that actually caused
    it.
    """
    raw = os.environ.get("YOMI_CTD_PATH")
    if not raw or not raw.strip():
        raise RuntimeError(
            "YOMI_CTD_PATH is not set. It must point at a checkout of "
            "dmMaze/comic-text-detector, which is GPL-3.0 and not on PyPI, so "
            f"it has to be vendored rather than pip-installed. {_SETUP_HINT}"
        )

    ctd_path = Path(raw).expanduser()
    if not ctd_path.is_dir():
        raise RuntimeError(
            f"YOMI_CTD_PATH points at {ctd_path}, which is not an existing "
            f"directory. {_SETUP_HINT}"
        )

    # inference.py is the module ComicTextDetector imports TextDetector from.
    # Checking for it here distinguishes "wrong directory" from "empty or
    # half-finished clone", which the ModuleNotFoundError cannot.
    inference = ctd_path / "inference.py"
    if not inference.is_file():
        raise RuntimeError(
            f"YOMI_CTD_PATH points at {ctd_path}, but there is no inference.py "
            "inside it. That file is the detector's entry point, so this is "
            "either the wrong directory or an incomplete clone. "
            f"{_SETUP_HINT}"
        )

    return str(ctd_path)


def _require_ctd_model() -> str:
    """Resolve YOMI_CTD_MODEL to a file that exists.

    Left unchecked, a missing weights file fails deep inside the vendored
    repo's loader, well after the import chain has already succeeded.
    """
    raw = os.environ.get("YOMI_CTD_MODEL", DEFAULT_CTD_MODEL)
    model_path = Path(raw).expanduser()

    if not model_path.is_file():
        origin = (
            "YOMI_CTD_MODEL is not set, so the default was used"
            if "YOMI_CTD_MODEL" not in os.environ
            else "YOMI_CTD_MODEL is set"
        )
        raise RuntimeError(
            f"{origin}, but no weights file exists at {model_path.absolute()}. "
            "Expected comictextdetector.pt (torch) or comictextdetector.pt.onnx, "
            "from the manga-image-translator release tag beta-0.2.1 -- the "
            f"weights are not in the detector repo. {_SETUP_HINT}"
        )

    return str(model_path)


@dataclass
class RawRegion:
    box: tuple[float, float, float, float]  # pixels: x0, y0, x1, y1
    vertical: bool
    confidence: float | None = None


class Detector(Protocol):
    name: str

    def detect(self, image: np.ndarray) -> list[RawRegion]:
        ...


class StubDetector:
    """Two fixed regions. Lets the whole pipeline be exercised without a
    440 MB download -- useful in CI and when the extension work is what is
    actually being tested."""

    name = "stub"

    def detect(self, image: np.ndarray) -> list[RawRegion]:
        h, w = image.shape[:2]
        return [
            RawRegion((w * 0.55, h * 0.05, w * 0.75, h * 0.30), vertical=True, confidence=1.0),
            RawRegion((w * 0.15, h * 0.40, w * 0.40, h * 0.55), vertical=True, confidence=1.0),
        ]


class ComicTextDetector:
    """Adapter over dmMaze/comic-text-detector.

    The repo is not packaged, so vendor it and point YOMI_CTD_PATH at the
    checkout. Weights: comictextdetector.pt (torch) or .pt.onnx, from the
    manga-image-translator beta-0.2.1 release tag.
    """

    name = "comic-text-detector"

    def __init__(self, model_path: str, device: str = "cpu", input_size: int = 1024):
        import sys

        # Validated here rather than only in build_detector() so that direct
        # construction fails the same way.
        ctd_path = _require_ctd_path()
        if ctd_path not in sys.path:
            sys.path.insert(0, ctd_path)

        # The vendored repo predates NumPy 2 and setuptools 81; patch the
        # gaps before its first import. See app/_ctd_compat.py.
        from app._ctd_compat import apply as apply_ctd_compat

        apply_ctd_compat()

        from inference import TextDetector  # type: ignore  # noqa: E402

        self._model = TextDetector(
            model_path=model_path,
            input_size=input_size,
            device=device,
            act="leaky",
        )

    def detect(self, image: np.ndarray) -> list[RawRegion]:
        # comic-text-detector expects BGR uint8 and returns
        # (mask, mask_refined, blk_list). We want only the blocks; the
        # segmentation masks are for inpainting, which Yomi has explicitly
        # deferred past v1.0 in favour of white div fills.
        _, _, blk_list = self._model(image, refine_mode=1, keep_undetected_mask=False)

        regions: list[RawRegion] = []
        for blk in blk_list:
            x0, y0, x1, y1 = (float(v) for v in blk.xyxy)
            if x1 <= x0 or y1 <= y0:
                continue
            vertical = bool(getattr(blk, "vertical", (y1 - y0) > (x1 - x0)))
            conf = getattr(blk, "confidence", None)
            regions.append(
                RawRegion((x0, y0, x1, y1), vertical=vertical,
                          confidence=float(conf) if conf is not None else None)
            )
        return regions


def build_detector() -> Detector:
    backend = os.environ.get("YOMI_DETECTOR", "comic-text-detector")
    if backend == "stub":
        log.warning("Using StubDetector -- no real detection is happening.")
        return StubDetector()

    # Both are checked before anything is imported or loaded, so a
    # misconfigured environment names the variable at fault instead of
    # failing as a ModuleNotFoundError from inside the vendored repo.
    _require_ctd_path()
    model_path = _require_ctd_model()

    device = os.environ.get("YOMI_DEVICE", "cpu")
    return ComicTextDetector(model_path=model_path, device=device)