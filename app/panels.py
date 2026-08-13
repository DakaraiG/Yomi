"""Panel segmentation from the page image.

Reading order on manga is panel-major: you finish one panel before starting
the next. Box geometry alone cannot recover panel boundaries -- on the ynko
test page the widest inter-box vertical gap (113px) is not a border, while the
real gutter between rows is 28px, and a 61px gap inside row 1 exceeds the 49px
gap that actually separates rows 1 and 2. Any rule keyed on "big gap = panel
edge" gets that page wrong. So we go to the image and find the drawn borders.

Method:

  1. Derive the panel block by excluding the x-span of detected regions taller
     than half the page -- those are full-height margin commentary, not panels.
  2. Split into rows on horizontal scanlines that are >98% white.
  3. Split each row into panels on vertical columns that are >99% white,
     keeping only candidates flanked within ~6px by a <25%-white column.

Step 3's flanking test is what makes this work. Artwork whitespace produces
plenty of white columns -- 9 of them in row 3 of the test page -- and none are
flanked by drawn borders, so all 9 are correctly rejected. Without it every
one becomes a false gutter.

The borders sit hard against the gutters, so the surviving pure-white run is
only 3-5px even where the gutter looks wide. Any minimum-width filter has to
stay <=2px or it discards real gutters.

EVERY THRESHOLD HERE IS PROVISIONAL. They are validated against exactly one
page (ynko, at full resolution, 17/17 regions correctly ordered, no per-page
tuning). Treat the numbers as a starting point, not as settled.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

Box = tuple[float, float, float, float]  # x0, y0, x1, y1

# A pixel counts as white below this much ink. Loose enough to survive JPEG
# ringing around the borders, tight enough that screentone reads as content.
WHITE_LEVEL = 235

ROW_WHITE_FRACTION = 0.98   # scanline is a row gutter above this
COL_WHITE_FRACTION = 0.99   # column is a panel gutter above this
BORDER_WHITE_FRACTION = 0.25  # column is a drawn border below this
BORDER_DARK_FRACTION = 0.60   # scanline is a panel's top/bottom border above this

BORDER_SEARCH_PX = 6  # how far either side of a gutter to look for a border
MIN_GUTTER_PX = 1     # see the module note: this must stay <= 2

# A region taller than this fraction of the page is margin commentary running
# the full height of the page, not text inside a panel.
TALL_REGION_FRACTION = 0.5

# Anything smaller than this is not a panel. Without it the scan's dark page
# edge yields 3px-wide "panels" down both sides, the sheet's top and bottom
# edges yield full-width 10px ones, and a title set in heavy type clears the
# border test on its own -- 13 panels on a page that has 5. These bound the
# panel, not the gutter, so the <=2px rule in the module note does not apply.
MIN_PANEL_WIDTH_FRACTION = 0.10
MIN_PANEL_HEIGHT_FRACTION = 0.05


def _runs(flags: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) runs of True in a 1-D boolean array."""
    runs: list[tuple[int, int]] = []
    start: int | None = None
    for i, flag in enumerate(flags):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _white_mask(image: np.ndarray) -> np.ndarray:
    gray = image if image.ndim == 2 else image[..., :3].mean(axis=2)
    return gray >= WHITE_LEVEL


def panel_block_x_span(boxes: Sequence[Box], width: int, height: int) -> tuple[int, int]:
    """Horizontal extent of the page that actually holds panels.

    Full-height margin commentary sits beside the panels, so its x-span is not
    part of the block. Which side it is on decides which edge we pull in.
    """
    left, right = 0, width
    for x0, y0, x1, y1 in boxes:
        if (y1 - y0) < TALL_REGION_FRACTION * height:
            continue
        if (x0 + x1) / 2 > width / 2:
            right = min(right, int(x0))
        else:
            left = max(left, int(x1))

    # A detector false positive -- one spurious tall box across the middle --
    # would otherwise clip the block down to nothing.
    if right - left < 0.2 * width:
        return 0, width
    return left, right


def _content_extent(white_cols: np.ndarray) -> tuple[int, int] | None:
    """[first, last) columns holding ink, trimming the page margins."""
    ink = np.flatnonzero(~white_cols)
    if ink.size == 0:
        return None
    return int(ink[0]), int(ink[-1]) + 1


def _split_row(
    white: np.ndarray, y0: int, y1: int, x_offset: int, min_width: int
) -> list[Box] | None:
    """Split one row band into panels. None if the band holds no drawn panel.

    `white` is the boolean mask already clipped to the panel block's x-span.
    """
    band = white[y0:y1]
    if band.shape[0] == 0 or band.shape[1] == 0:
        return None

    col_white_frac = band.mean(axis=0)
    extent = _content_extent(col_white_frac > COL_WHITE_FRACTION)
    if extent is None:
        return None
    left, right = extent

    is_gutter = col_white_frac > COL_WHITE_FRACTION
    is_border = col_white_frac < BORDER_WHITE_FRACTION

    cuts: list[tuple[int, int]] = []
    for start, end in _runs(is_gutter):
        if end - start < MIN_GUTTER_PX:
            continue
        if start <= left or end >= right:
            continue  # page margin, not an interior gutter
        # The drawn borders of the panels on either side. Artwork whitespace
        # fails here, which is the entire point of the test.
        before = is_border[max(0, start - BORDER_SEARCH_PX):start]
        after = is_border[end:end + BORDER_SEARCH_PX]
        if before.any() and after.any():
            cuts.append((start, end))

    spans: list[tuple[int, int]] = []
    cursor = left
    for start, end in cuts:
        spans.append((cursor, start))
        cursor = end
    spans.append((cursor, right))
    spans = [(sx0, sx1) for sx0, sx1 in spans if sx1 - sx0 >= min_width]

    # Is this a panel row at all, or just loose text (a page title)? A panel
    # has a drawn border running across its width; a line of text does not.
    bordered = False
    for sx0, sx1 in spans:
        dark_frac = 1.0 - band[:, sx0:sx1].mean(axis=1)
        if dark_frac.max(initial=0.0) >= BORDER_DARK_FRACTION:
            bordered = True
            break
    if not bordered:
        return None

    return [
        (float(sx0 + x_offset), float(y0), float(sx1 + x_offset), float(y1))
        for sx0, sx1 in spans
    ]


def detect_panels(
    image: np.ndarray, boxes: Sequence[Box]
) -> tuple[list[Box], Box | None]:
    """Panels in reading order, plus the bounding box of the panel block.

    Panels come back right-to-left within a row, rows top-to-bottom. Returns
    ([], None) when the page has no drawn panels -- a borderless or bleed
    page, or a blank one -- and the caller should fall back to pure geometry.

    Only two levels are projected (rows, then panels). Recursing further would
    re-split a panel on any horizontal band of white artwork, and the
    flanking test that makes the vertical split safe has no horizontal
    equivalent here.
    """
    height, width = image.shape[:2]
    bx0, bx1 = panel_block_x_span(boxes, width, height)
    if bx1 - bx0 <= 0:
        return [], None

    white = _white_mask(image)[:, bx0:bx1]

    row_white = white.mean(axis=1) > ROW_WHITE_FRACTION
    gutter = np.zeros(height, dtype=bool)
    for start, end in _runs(row_white):
        if end - start >= MIN_GUTTER_PX:
            gutter[start:end] = True

    min_width = int(MIN_PANEL_WIDTH_FRACTION * width)
    min_height = int(MIN_PANEL_HEIGHT_FRACTION * height)

    panels: list[Box] = []
    for y0, y1 in _runs(~gutter):
        if y1 - y0 < min_height:
            continue
        row = _split_row(white, y0, y1, bx0, min_width)
        if row:
            # Right-to-left within the row.
            panels.extend(sorted(row, key=lambda p: -p[2]))

    if not panels:
        return [], None

    block = (
        min(p[0] for p in panels),
        min(p[1] for p in panels),
        max(p[2] for p in panels),
        max(p[3] for p in panels),
    )
    return panels, block
