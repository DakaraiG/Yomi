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


def test_band_uses_its_seed_not_a_growing_envelope():
    # Each box overlaps the previous one enough to join, but the accumulated
    # envelope creeps down the page until it reaches a box that belongs to the
    # row below. Banding against the seed keeps the two rows apart.
    boxes = [
        (600, 0, 700, 100),    # row 1 seed
        (400, 45, 500, 145),
        (200, 90, 300, 190),
        (600, 200, 700, 300),  # row 2 -- 10px clear of the row-1 envelope
    ]
    assert reading_order(boxes) == [0, 1, 2, 3]


# --- panel-major ordering ---------------------------------------------------

def _panel_page(width=800, height=1000):
    """Two rows of two bordered panels, with mid-grey 'artwork' inside.

    The grey matters: an empty white panel interior leaves scanlines through
    it >98% white, so the row split would cut the panel in half. Real pages
    have art there.
    """
    from PIL import ImageDraw

    page = Image.new("RGB", (width, height), (255, 255, 255))
    draw = ImageDraw.Draw(page)
    panels = [
        (40, 40, 390, 440), (410, 40, 760, 440),
        (40, 460, 390, 860), (410, 460, 760, 860),
    ]
    for rect in panels:
        draw.rectangle(rect, fill=(180, 180, 180), outline=(0, 0, 0), width=3)
    return page, panels


def test_panels_are_right_to_left_then_top_to_bottom():
    import numpy as np
    from app.ordering import panel_reading_order

    page, panels = _panel_page()
    # One box centred in each panel, listed top-left first so a naive sort
    # would produce a different answer than the panel-major one.
    boxes = []
    for x0, y0, x1, y1 in panels:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        boxes.append((cx - 40, cy - 40, cx + 40, cy + 40))

    order = panel_reading_order(np.array(page), boxes)
    assert order == [1, 0, 3, 2]  # TR, TL, BR, BL


def test_two_bubbles_in_one_panel_stay_together():
    # The case pure geometry gets wrong: a bubble low in the right panel sits
    # below one that is high in the left panel. Panel-major keeps the right
    # panel's pair contiguous instead of interleaving them.
    import numpy as np
    from app.ordering import panel_reading_order

    page, _ = _panel_page()
    boxes = [
        (100, 80, 200, 160),    # left panel, high
        (450, 60, 550, 140),    # right panel, high
        (600, 300, 700, 380),   # right panel, low
    ]
    order = panel_reading_order(np.array(page), boxes)
    assert order == [1, 2, 0]


def test_artwork_whitespace_is_not_a_gutter():
    # A white blob inside a panel makes a column of white running the panel's
    # full height -- a perfect false gutter, except that nothing dark flanks
    # it. If the flanking test regresses, this page splits into three panels
    # and the two boxes come back in the wrong order.
    import numpy as np
    from PIL import ImageDraw
    from app.ordering import panel_reading_order
    from app.panels import detect_pages

    page = Image.new("RGB", (800, 600), (255, 255, 255))
    draw = ImageDraw.Draw(page)
    draw.rectangle((40, 40, 760, 560), fill=(180, 180, 180), outline=(0, 0, 0), width=3)
    draw.rectangle((380, 44, 420, 556), fill=(255, 255, 255))  # the false gutter

    assert len(detect_pages(np.array(page))[0].panels) == 1

    boxes = [(100, 100, 200, 200), (600, 100, 700, 200)]
    assert panel_reading_order(np.array(page), boxes) == [1, 0]


def _vertical_text(draw, x0, y0, x1, y1, cell=44, stroke=3):
    """A column of glyph-ish marks: horizontal strokes with gaps between.

    Not decoration. A solid block would pass for a drawn panel -- it is dark
    across its width *and* down its height -- whereas real type is only dark
    across. That asymmetry is what tells furniture from a panel, so the
    fixture has to have it.
    """
    y = y0
    while y + cell <= y1:
        for k in (0.2, 0.5, 0.8):
            top = y + int(cell * k)
            draw.rectangle((x0, top, x1, top + stroke), fill=(20, 20, 20))
        y += cell


def _centres(panels, pad=40):
    return [
        ((p[0] + p[2]) / 2 - pad, (p[1] + p[3]) / 2 - pad,
         (p[0] + p[2]) / 2 + pad, (p[1] + p[3]) / 2 + pad)
        for p in panels
    ]


def test_stacked_sidebars_are_furniture_and_read_last():
    # The case that killed the "taller than half the page" rule: margin
    # content broken into several stacked sidebars, none of them tall enough
    # to trip a height threshold. What marks them is that no strip they sit in
    # contains a drawn panel border.
    import numpy as np
    from PIL import ImageDraw
    from app.ordering import panel_reading_order

    page, panels = _panel_page(width=900)
    draw = ImageDraw.Draw(page)
    sidebars = [(810, 60, 870, 290), (810, 350, 870, 580), (810, 640, 870, 870)]
    for bar in sidebars:  # ~23% of page height each, like the real spread
        _vertical_text(draw, *bar)

    title = (300.0, 5.0, 500.0, 30.0)
    boxes = [*sidebars, *_centres(panels), title]

    order = panel_reading_order(np.array(page), boxes)
    assert order[0] == 7                 # title first
    assert order[1:5] == [4, 3, 6, 5]    # panels, TR TL BR BL
    assert order[5:] == [0, 1, 2]        # sidebars last, top to bottom


def test_spread_orders_the_right_page_first():
    import numpy as np
    from app.ordering import panel_reading_order
    from app.panels import detect_pages, spread_split

    left, lp = _panel_page(width=800)
    right, rp = _panel_page(width=800)
    spread = Image.new("RGB", (1700, 1000), (255, 255, 255))
    spread.paste(left, (0, 0))
    spread.paste(right, (900, 0))

    arr = np.array(spread)
    assert spread_split(arr) is not None
    pages = detect_pages(arr)
    assert [len(p.panels) for p in pages] == [4, 4]
    assert pages[0].x0 > pages[1].x0  # right page first

    boxes = _centres(lp) + _centres([(p[0] + 900, p[1], p[2] + 900, p[3]) for p in rp])
    # 0-3 left page, 4-7 right page; each in TL TR BL BR order.
    assert panel_reading_order(arr, boxes) == [5, 4, 7, 6, 1, 0, 3, 2]


def test_single_page_grid_is_not_split_as_a_spread():
    # A portrait page whose panels line up produces a full-height white
    # column too. Splitting on it would give column-major order.
    import numpy as np
    from app.panels import detect_pages, spread_split

    page, _ = _panel_page(width=800, height=1000)
    arr = np.array(page)
    assert spread_split(arr) is None
    pages = detect_pages(arr)
    assert len(pages) == 1
    assert len(pages[0].panels) == 4


def test_landscape_without_a_central_gutter_is_one_page():
    import numpy as np
    from PIL import ImageDraw
    from app.panels import spread_split

    # Wide, but the panels straddle the middle -- no full-height white column.
    page = Image.new("RGB", (1600, 900), (255, 255, 255))
    draw = ImageDraw.Draw(page)
    draw.rectangle((40, 40, 1560, 430), fill=(180, 180, 180), outline=(0, 0, 0), width=3)
    draw.rectangle((40, 460, 1560, 860), fill=(180, 180, 180), outline=(0, 0, 0), width=3)
    assert spread_split(np.array(page)) is None


def test_blank_page_falls_back_to_geometry():
    import numpy as np
    from app.ordering import panel_reading_order
    from app.panels import detect_pages

    blank = np.full((600, 800, 3), 255, dtype=np.uint8)
    boxes = [(10, 10, 100, 100), (400, 10, 490, 100)]

    assert detect_pages(blank)[0].block is None
    assert panel_reading_order(blank, boxes) == [1, 0]


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