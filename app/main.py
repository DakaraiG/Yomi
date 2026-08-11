"""Yomi detection sidecar -- v0.1.

Thin, stateless, one job: image in, ordered Japanese lines out. No caching,
no glossary, no translation, no persistence. All of that is ASP.NET Core's
problem by design.

Exit criteria for this version (from the plan): on 10 varied pages, >=90%
of speech bubbles detected and OCR output visually correct on a manual
read-through. /detect/debug exists to make that judgement possible.
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import os
import time
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from PIL import Image, ImageDraw, ImageFont

from app.detector import build_detector
from app.ocr import build_ocr, crop_region
from app.ordering import reading_order
from app.schemas import DetectedRegion, DetectRequest, DetectResponse, HealthResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("yomi")

MAX_IMAGE_BYTES = 12 * 1024 * 1024

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load once at boot, not per request. Cold-starting a ViT per page would
    # dominate the latency budget.
    t0 = time.perf_counter()
    state["detector"] = build_detector()
    state["ocr"] = build_ocr()
    log.info(
        "models ready in %.1fs (detector=%s ocr=%s)",
        time.perf_counter() - t0,
        state["detector"].name,
        state["ocr"].name,
    )
    yield
    state.clear()


app = FastAPI(title="Yomi sidecar", version="0.1.0", lifespan=lifespan)


def _decode(image_b64: str) -> np.ndarray:
    """Base64 (bare or data: URL) -> RGB ndarray."""
    if "," in image_b64[:64] and image_b64.lstrip().startswith("data:"):
        image_b64 = image_b64.split(",", 1)[1]

    try:
        raw = base64.b64decode(image_b64, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="imageB64 is not valid base64")

    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image exceeds 12 MB")

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except Exception:
        raise HTTPException(status_code=400, detail="could not decode image")

    return np.array(img.convert("RGB"))


def _analyse(image: np.ndarray) -> DetectResponse:
    h, w = image.shape[:2]
    detector, ocr = state["detector"], state["ocr"]

    t0 = time.perf_counter()
    # comic-text-detector wants BGR.
    raw_regions = detector.detect(image[:, :, ::-1].copy())
    t_detect = time.perf_counter() - t0

    order = reading_order([r.box for r in raw_regions])

    t0 = time.perf_counter()
    regions: list[DetectedRegion] = []
    for rank, idx in enumerate(order):
        raw = raw_regions[idx]
        text = ocr.read(crop_region(image, raw.box))
        x0, y0, x1, y1 = raw.box
        regions.append(
            DetectedRegion(
                id=f"r{rank}",
                order=rank,
                polygon=[
                    (x0 / w, y0 / h),
                    (x1 / w, y0 / h),
                    (x1 / w, y1 / h),
                    (x0 / w, y1 / h),
                ],
                vertical=raw.vertical,
                japanese=text,
                detConfidence=raw.confidence,
            )
        )
    t_ocr = time.perf_counter() - t0

    log.info(
        "page %dx%d: %d regions, detect %.2fs, ocr %.2fs",
        w, h, len(regions), t_detect, t_ocr,
    )
    return DetectResponse(naturalWidth=w, naturalHeight=h, regions=regions)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        detector=state["detector"].name,
        ocr=state["ocr"].name,
        device=os.environ.get("YOMI_DEVICE", "cpu"),
    )


@app.post("/detect", response_model=DetectResponse)
def detect(req: DetectRequest) -> DetectResponse:
    return _analyse(_decode(req.imageB64))


@app.post("/detect/debug")
def detect_debug(req: DetectRequest) -> Response:
    """Same pipeline, but returns the page with boxes and reading-order
    numbers drawn on it. This is how the v0.1 exit criteria get judged --
    reading a JSON blob will not tell you the reading order is wrong."""
    image = _decode(req.imageB64)
    result = _analyse(image)

    canvas = Image.fromarray(image).convert("RGB")
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", 28)
    except OSError:
        font = ImageFont.load_default()

    for region in result.regions:
        pts = [(x * result.naturalWidth, y * result.naturalHeight) for x, y in region.polygon]
        draw.polygon(pts, outline=(255, 0, 0), width=3)
        label = str(region.order)
        lx, ly = pts[0]
        draw.rectangle([lx, ly - 32, lx + 14 * len(label) + 10, ly], fill=(255, 0, 0))
        draw.text((lx + 5, ly - 30), label, fill=(255, 255, 255), font=font)

    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    return Response(content=buf.getvalue(), media_type="image/png")