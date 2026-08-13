"""Reading-order sort for manga text regions.

Reading order is panel-major: finish one panel before starting the next,
panels right-to-left within a row, rows top-to-bottom. That needs panel
boundaries, and panel boundaries are not recoverable from box geometry --
see app/panels.py for why, and for how they are recovered from the image.

Two entry points, deliberately split:

  reading_order()        pure geometry, no image. Bands regions into rows and
                         sorts each row right-to-left. Used inside a single
                         panel, and as the fallback when panel detection comes
                         up empty (borderless page, blank page).

  panel_reading_order()  the real thing. Needs the page image.

The split keeps the banding sort unit-testable on plain coordinate tuples now
that the layer above it needs pixels.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

from app.panels import Page, detect_pages

Box = tuple[float, float, float, float]  # x0, y0, x1, y1

BAND_THRESHOLD = 0.4


def _vertical_overlap(a: Box, b: Box) -> float:
    """Fraction of the shorter box's height that overlaps the taller one."""
    top = max(a[1], b[1])
    bottom = min(a[3], b[3])
    overlap = bottom - top
    if overlap <= 0:
        return 0.0
    shorter = min(a[3] - a[1], b[3] - b[1])
    return overlap / shorter if shorter > 0 else 0.0


def reading_order(boxes: Sequence[Box], band_threshold: float = BAND_THRESHOLD) -> list[int]:
    """Return indices of `boxes` in reading order, ignoring panels.

    band_threshold: minimum vertical overlap fraction for two regions to be
    considered part of the same row.
    """
    if not boxes:
        return []

    indexed = sorted(range(len(boxes)), key=lambda i: boxes[i][1])

    bands: list[list[int]] = []
    for i in indexed:
        for band in bands:
            # Against the band's seed -- the topmost box, since `indexed` is
            # sorted by y0 -- not against its accumulated envelope. The
            # envelope grows every time a slightly lower box joins, so a long
            # row of staggered bubbles drags the band down the page and
            # swallows the row below it.
            if _vertical_overlap(boxes[band[0]], boxes[i]) >= band_threshold:
                band.append(i)
                break
        else:
            bands.append([i])

    bands.sort(key=lambda band: min(boxes[j][1] for j in band))

    ordered: list[int] = []
    for band in bands:
        # Right-to-left: rightmost edge first.
        ordered.extend(sorted(band, key=lambda j: -boxes[j][2]))
    return ordered


def _sorted_subset(
    boxes: Sequence[Box], idxs: list[int], band_threshold: float
) -> list[int]:
    """reading_order() over a subset, mapped back to original indices."""
    local = reading_order([boxes[i] for i in idxs], band_threshold)
    return [idxs[k] for k in local]


def _assign(panels: Sequence[Box], cx: float, cy: float) -> int:
    """Index of the panel owning this centroid.

    Falls back to the nearest panel centre, which covers a bubble whose middle
    lands in a gutter because it straddles two panels.
    """
    for i, (x0, y0, x1, y1) in enumerate(panels):
        if x0 <= cx <= x1 and y0 <= cy <= y1:
            return i
    return min(
        range(len(panels)),
        key=lambda i: (cx - (panels[i][0] + panels[i][2]) / 2) ** 2
        + (cy - (panels[i][1] + panels[i][3]) / 2) ** 2,
    )


def _order_page(
    boxes: Sequence[Box], idxs: list[int], page: Page, band_threshold: float
) -> list[int]:
    """Order one page's regions, panel-major.

    Furniture -- anything outside the panel block -- is placed by where it
    falls: above the block (a page title) reads first, beside or below it
    (margin commentary, character sidebars) reads last.
    """
    if not idxs:
        return []
    if page.block is None:
        return _sorted_subset(boxes, idxs, band_threshold)

    bx0, by0, bx1, by1 = page.block
    leading: list[int] = []
    trailing: list[int] = []
    buckets: list[list[int]] = [[] for _ in page.panels]

    for i in idxs:
        x0, y0, x1, y1 = boxes[i]
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        if cx < bx0 or cx > bx1:
            trailing.append(i)   # beside the panels
        elif cy < by0:
            leading.append(i)    # above them
        elif cy > by1:
            trailing.append(i)
        else:
            buckets[_assign(page.panels, cx, cy)].append(i)

    ordered = _sorted_subset(boxes, leading, band_threshold)
    for bucket in buckets:  # panels are already in reading order
        ordered.extend(_sorted_subset(boxes, bucket, band_threshold))
    ordered.extend(_sorted_subset(boxes, trailing, band_threshold))
    return ordered


def panel_reading_order(
    image: np.ndarray,
    boxes: Sequence[Box],
    band_threshold: float = BAND_THRESHOLD,
) -> list[int]:
    """Return indices of `boxes` in panel-major reading order.

    On a double-page spread the right page is ordered out entirely before the
    left page begins.
    """
    if not boxes:
        return []

    pages = detect_pages(image)
    buckets: list[list[int]] = [[] for _ in pages]
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        cx = (x0 + x1) / 2
        # Pages tile the image, so the containment test only misses on a
        # centroid sitting exactly on the far edge.
        page = next(
            (k for k, p in enumerate(pages) if p.x0 <= cx < p.x1), len(pages) - 1
        )
        buckets[page].append(i)

    ordered: list[int] = []
    for page, idxs in zip(pages, buckets):
        ordered.extend(_order_page(boxes, idxs, page, band_threshold))
    return ordered
