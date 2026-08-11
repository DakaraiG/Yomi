"""Reading-order sort for manga text regions.

The spec calls for "naive R->L, T->B". A literal lexicographic sort on
(y, -x) is naive in the wrong way: it interleaves bubbles from adjacent
panels the moment their vertical extents differ by a few pixels, which on
manga is constantly.

The cheapest thing that actually works is banding -- group regions that
share vertical extent into a row, order rows top-to-bottom, order within a
row right-to-left. This is still panel-unaware (the [OPEN] question in the
spec) but it degrades gracefully instead of scrambling.

Known failure mode, expected: a tall column spanning two stacked panels on
one side of the page will absorb both panels' bubbles into one band. That
is the case that will force panel segmentation if it shows up often.
"""

from __future__ import annotations

from typing import Sequence

Box = tuple[float, float, float, float]  # x0, y0, x1, y1


def _vertical_overlap(a: Box, b: Box) -> float:
    """Fraction of the shorter box's height that overlaps the taller one."""
    top = max(a[1], b[1])
    bottom = min(a[3], b[3])
    overlap = bottom - top
    if overlap <= 0:
        return 0.0
    shorter = min(a[3] - a[1], b[3] - b[1])
    return overlap / shorter if shorter > 0 else 0.0


def reading_order(boxes: Sequence[Box], band_threshold: float = 0.4) -> list[int]:
    """Return indices of `boxes` in reading order.

    band_threshold: minimum vertical overlap fraction for two regions to be
    considered part of the same row. 0.4 is empirical-ish; tune during the
    v0.1 spike against real pages before treating it as settled.
    """
    if not boxes:
        return []

    indexed = sorted(range(len(boxes)), key=lambda i: boxes[i][1])

    bands: list[list[int]] = []
    for i in indexed:
        for band in bands:
            # Compare against the band's current vertical envelope.
            top = min(boxes[j][1] for j in band)
            bottom = max(boxes[j][3] for j in band)
            if _vertical_overlap((0.0, top, 0.0, bottom), boxes[i]) >= band_threshold:
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