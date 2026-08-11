import base64
import io
import os

import pytest
from PIL import Image

from app.ordering import reading_order


def test_single_row_is_right_to_left():
    # Three bubbles across one row.
    boxes = [
        (10, 10, 100, 100),   # left
        (200, 12, 290, 105),  # middle
        (400, 8, 490, 98),    # right
    ]
    assert reading_order(boxes) == [2, 1, 0]


def test_rows_run_top_to_bottom():
    boxes = [
        (400, 300, 490, 390),  # row 2, right
        (10, 10, 100, 100),    # row 1, left
        (400, 10, 490, 100),   # row 1, right
        (10, 300, 100, 390),   # row 2, left
    ]
    assert reading_order(boxes) == [2, 1, 0, 3]


def test_slight_vertical_offset_stays_in_one_band():
    # The case a naive (y, -x) sort gets wrong: same visual row, different y0.
    boxes = [
        (10, 40, 100, 130),
        (400, 10, 490, 100),
    ]
    assert reading_order(boxes) == [1, 0]


def test_tall_column_does_not_swallow_a_distant_row():
    boxes = [
        (400, 10, 460, 300),   # tall column, top right
        (10, 600, 100, 690),   # well below it
    ]
    assert reading_order(boxes) == [0, 1]


def test_empty_input():
    assert reading_order([]) == []


def _png_b64(w=800, h=1200):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (255, 255, 255)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def test_detect_contract(monkeypatch):
    monkeypatch.setenv("YOMI_DETECTOR", "stub")
    monkeypatch.setenv("YOMI_OCR", "stub")

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "ok"

        r = client.post("/detect", json={"imageB64": _png_b64()})
        assert r.status_code == 200
        body = r.json()

        assert body["naturalWidth"] == 800
        assert body["naturalHeight"] == 1200
        assert [x["order"] for x in body["regions"]] == [0, 1]

        for region in body["regions"]:
            assert len(region["polygon"]) == 4
            for x, y in region["polygon"]:
                assert 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0


def test_rejects_junk_base64(monkeypatch):
    monkeypatch.setenv("YOMI_DETECTOR", "stub")
    monkeypatch.setenv("YOMI_OCR", "stub")

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        assert client.post("/detect", json={"imageB64": "not base64!!"}).status_code == 400


# Everything above runs on stubs, which is the point -- but it means the whole
# suite stayed green while the real backend could not even be imported. This
# one covers the vendored repo's import chain, which is where the rot is.
@pytest.mark.skipif(
    not os.environ.get("YOMI_CTD_PATH"),
    reason="needs the vendored comic-text-detector checkout + weights",
)
def test_real_detector_imports_and_detects(monkeypatch):
    monkeypatch.delenv("YOMI_DETECTOR", raising=False)  # default = the real one

    import numpy as np

    from app.detector import build_detector

    detector = build_detector()
    assert detector.name == "comic-text-detector"

    # A blank page is fine; this is about the import chain and a clean
    # forward pass, not detection quality.
    page = np.full((1024, 720, 3), 255, dtype=np.uint8)
    regions = detector.detect(page)

    assert isinstance(regions, list)
    for region in regions:
        x0, y0, x1, y1 = region.box
        assert x1 > x0 and y1 > y0