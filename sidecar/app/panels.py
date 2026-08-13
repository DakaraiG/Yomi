"""Panel and page segmentation from the image.

Reading order on manga is panel-major: you finish one panel before starting
the next. Box geometry alone cannot recover panel boundaries -- on the ynko
test page the widest inter-box vertical gap (113px) is not a border, while the
real gutter between rows is 28px, and a 61px gap inside row 1 exceeds the 49px
gap that actually separates rows 1 and 2. Any rule keyed on "big gap = panel
edge" gets that page wrong. So we go to the image and find the drawn borders.

Method:

  1. Split a double-page spread down its central gutter, right page first.
  2. Split each page into vertical strips on full-height white columns. A
     strip with no drawn panel border in it is furniture -- margin commentary,
     character sidebars -- not panels.
  3. Over the strips that do hold panels, split into rows on horizontal
     scanlines that are >98% white.
  4. Split each row into panels on vertical columns that are >99% white,
     keeping only candidates flanked within ~6px by a <25%-white column.

Step 4's flanking test is what makes this work. Artwork whitespace produces
plenty of white columns -- 9 of them in row 3 of the single-page test -- and
none are flanked by drawn borders, so all 9 are correctly rejected. Without it
every one becomes a false gutter.

The borders sit hard against the gutters, so the surviving pure-white run is
only 3-5px even where the gutter looks wide. Any minimum-width filter has to
stay <=2px or it discards real gutters.

EVERY THRESHOLD HERE IS PROVISIONAL, validated against two images: one page
(17/17 regions correctly ordered) and one spread.
"""

from __future__ import annotations

from typing import NamedTuple

import numpy as np

Box = tuple[float, float, float, float]  # x0, y0, x1, y1

# A pixel counts as white below this much ink. Loose enough to survive JPEG
# ringing around the borders, tight enough that screentone reads as content.
WHITE_LEVEL = 235

ROW_WHITE_FRACTION = 0.98     # scanline is a row gutter above this
COL_WHITE_FRACTION = 0.99     # column is a panel gutter above this
# Column runs clear from top to bottom. Not 1.0, and not even 0.995: a scan
# carries a dark strip along the sheet's top and bottom edges, ~10 rows on the
# test images, which caps *every* column at ~0.994 white. A literal full-height
# test finds nothing at all on a real page.
FULL_HEIGHT_WHITE_FRACTION = 0.98
BORDER_WHITE_FRACTION = 0.25  # column is a drawn border below this
BORDER_DARK_FRACTION = 0.60   # scanline is a panel's top/bottom border above this

BORDER_SEARCH_PX = 6  # how far either side of a gutter to look for a border
MIN_GUTTER_PX = 1     # see the module note: this must stay <= 2

# Anything smaller than this is not a panel. Without it the scan's dark page
# edge yields 3px-wide "panels" down both sides, the sheet's top and bottom
# edges yield full-width 10px ones, and a title set in heavy type clears the
# border test on its own -- 13 panels on a page that has 5. These bound the
# panel, not the gutter, so the <=2px rule above does not apply.
MIN_PANEL_WIDTH_FRACTION = 0.10
MIN_PANEL_HEIGHT_FRACTION = 0.05

# A spread's central gutter. Both signals are required: an aligned single-page
# panel grid also produces a full-height white column, and splitting a page on
# it would order the page column-major instead of row-major.
SPREAD_MIN_ASPECT = 1.0
SPREAD_GUTTER_WIDTH_FRACTION = 0.015


class Page(NamedTuple):
    """One page of the image. `panels` is already in reading order.

    `block` is the bounding box of the panels, or None when the page has no
    drawn panels at all -- a borderless page, a blank one -- in which case the
    caller should fall back to pure geometry for this page's regions.
    """

    x0: int
    x1: int
    panels: list[Box]
    block: Box | None


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


def _content_extent(white_cols: np.ndarray) -> tuple[int, int] | None:
    """[first, last) columns holding ink, trimming the page margins."""
    ink = np.flatnonzero(~white_cols)
    if ink.size == 0:
        return None
    return int(ink[0]), int(ink[-1]) + 1


def spread_split(image: np.ndarray) -> int | None:
    """x of the gutter between two pages, or None if this is a single page.

    Requires both a landscape aspect and a wide full-height white column near
    the middle. Either signal alone is ambiguous -- see SPREAD_MIN_ASPECT.
    """
    height, width = image.shape[:2]
    if width <= SPREAD_MIN_ASPECT * height:
        return None

    full_height = _white_mask(image).mean(axis=0) >= FULL_HEIGHT_WHITE_FRACTION
    min_width = SPREAD_GUTTER_WIDTH_FRACTION * width

    best: tuple[int, int] | None = None
    for start, end in _runs(full_height):
        if end - start <= min_width:
            continue
        if not (width / 3 <= (start + end) / 2 <= 2 * width / 3):
            continue
        if best is None or end - start > best[1] - best[0]:
            best = (start, end)

    return None if best is None else (best[0] + best[1]) // 2


def _split_row(
    white: np.ndarray, y0: int, y1: int, x0: int, x1: int, min_width: int
) -> list[Box] | None:
    """Split one row band into panels. None if the band holds no drawn panel."""
    band = white[y0:y1, x0:x1]
    if band.shape[0] == 0 or band.shape[1] == 0:
        return None

    col_white_frac = band.mean(axis=0)
    is_gutter = col_white_frac > COL_WHITE_FRACTION
    is_border = col_white_frac < BORDER_WHITE_FRACTION

    extent = _content_extent(is_gutter)
    if extent is None:
        return None
    left, right = extent

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

    # Is this a panel row, or just ink -- a title, a column of commentary? A
    # drawn panel is a rectangle: a border running across its width AND one
    # running down its height. Text clears the first test on any horizontal
    # stroke, so the second is what actually separates the two.
    bordered = any(
        (1.0 - band[:, sx0:sx1].mean(axis=1)).max(initial=0.0) >= BORDER_DARK_FRACTION
        and is_border[sx0:sx1].any()
        for sx0, sx1 in spans
    )
    if not bordered:
        return None

    return [
        (float(sx0 + x0), float(y0), float(sx1 + x0), float(y1))
        for sx0, sx1 in spans
    ]


def _panels_in(
    white: np.ndarray, x0: int, x1: int, min_width: int, min_height: int
) -> list[Box]:
    """Panels within a column range, in reading order (R->L, then T->B)."""
    if x1 - x0 <= 0:
        return []

    row_white = white[:, x0:x1].mean(axis=1) > ROW_WHITE_FRACTION
    gutter = np.zeros(white.shape[0], dtype=bool)
    for start, end in _runs(row_white):
        if end - start >= MIN_GUTTER_PX:
            gutter[start:end] = True

    panels: list[Box] = []
    for y0, y1 in _runs(~gutter):
        if y1 - y0 < min_height:
            continue
        row = _split_row(white, y0, y1, x0, x1, min_width)
        if row:
            panels.extend(sorted(row, key=lambda p: -p[2]))  # right-to-left
    return panels


def _read_page(white: np.ndarray, x0: int, x1: int) -> Page:
    """Segment one page: drop the furniture strips, then find the panels."""
    height = white.shape[0]
    min_width = int(MIN_PANEL_WIDTH_FRACTION * (x1 - x0))
    min_height = int(MIN_PANEL_HEIGHT_FRACTION * height)

    # Vertical strips, divided by columns that run clear top to bottom. A
    # strip holding no drawn panel is furniture: margin commentary, character
    # sidebars. Stacked sidebars defeat a "taller than half the page"
    # heuristic -- the spread has three per page, each about 23% of the height
    # -- but none of them contains a panel border, which is the real signal.
    full_height = white[:, x0:x1].mean(axis=0) >= FULL_HEIGHT_WHITE_FRACTION
    # The size filter has to run here and not only below: the scan's dark edge
    # forms its own full-height strip, 8px and 3px wide on the test page, and
    # a solid dark bar passes the border test honestly -- it is dark across
    # its width and down its height, which is exactly what a border is. Too
    # narrow to hold a panel is the thing that disqualifies it.
    with_panels = [
        (x0 + sx0, x0 + sx1)
        for sx0, sx1 in _runs(~full_height)
        if _panels_in(white, x0 + sx0, x0 + sx1, min_width, min_height)
    ]
    if not with_panels:
        return Page(x0, x1, [], None)

    # Re-run over the strips as one span so rows line up across them. An
    # aligned panel grid splits into strips at step one; this puts it back.
    panels = _panels_in(
        white,
        min(s[0] for s in with_panels),
        max(s[1] for s in with_panels),
        min_width,
        min_height,
    )
    if not panels:
        return Page(x0, x1, [], None)

    block = (
        min(p[0] for p in panels),
        min(p[1] for p in panels),
        max(p[2] for p in panels),
        max(p[3] for p in panels),
    )
    return Page(x0, x1, panels, block)


def detect_pages(image: np.ndarray) -> list[Page]:
    """Pages in reading order: right page first on a spread.

    Only two levels are projected within a page (rows, then panels). Recursing
    further would re-split a panel on any horizontal band of white artwork,
    and the flanking test that makes the vertical split safe has no horizontal
    equivalent here.
    """
    white = _white_mask(image)
    width = image.shape[1]

    split = spread_split(image)
    bounds = [(0, width)] if split is None else [(split, width), (0, split)]
    return [_read_page(white, x0, x1) for x0, x1 in bounds]
