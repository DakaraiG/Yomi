"""Wire contract for the Yomi detection sidecar.

This is the seam between the Python sidecar and ASP.NET Core. It is NOT the
public TranslatedPage contract (that is frozen in v0.2 and owned by .NET) --
this is deliberately one layer lower: no translation, no glossary, no `kind`.

Coordinates are normalised 0-1 against natural image dimensions, per the
rendering spec. Nothing downstream should ever handle pixel coordinates.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


Point = tuple[float, float]


class DetectedRegion(BaseModel):
    id: str = Field(..., description="Stable within this response only, e.g. 'r0'.")
    order: int = Field(..., description="Reading order index, 0-based.")
    polygon: list[Point] = Field(
        ...,
        description="Normalised 0-1, clockwise from top-left. Axis-aligned in v0.1.",
    )
    vertical: bool = Field(..., description="Text runs top-to-bottom in columns.")
    japanese: str = Field(..., description="Raw OCR output. Not cleaned, not translated.")
    detConfidence: float | None = Field(
        None, description="Detector confidence. Null if the backend does not report one."
    )


class DetectResponse(BaseModel):
    naturalWidth: int
    naturalHeight: int
    regions: list[DetectedRegion]

    # Included so the .NET layer can construct TranslatedPage without decoding
    # the image a second time.


class DetectRequest(BaseModel):
    imageB64: str = Field(..., description="Bare base64 or a data: URL. Both accepted.")


class HealthResponse(BaseModel):
    status: str
    detector: str
    ocr: str
    device: str