"""Group fire detections into fire clusters ("foyers").

The method is adapted from carte-incendies by Lucas Legrand (MIT): detections
are binned on a 0.02 degree grid, occupied cells touching each other (8-
connectivity) form one cluster, and clusters with fewer than three detections
are ignored. The burnt surface is an estimate: the number of distinct ~375 m
cells hit by detections, times the area of such a cell. It is labelled as an
estimate everywhere it is shown.

The cluster outline is the convex hull of its detections, computed with
Andrew's monotone chain algorithm.
"""

from __future__ import annotations

import datetime as dt
import math
from collections.abc import Sequence
from dataclasses import dataclass

from veille_feux.firms import Detection

GRID_DEG = 0.02
FINE_GRID_DEG = 0.00375
FINE_CELL_HA = 14.06  # 375 m x 375 m
MIN_DETECTIONS = 3
ACTIVE_HOURS = 6

Cell = tuple[int, int]
Point = tuple[float, float]


@dataclass(frozen=True)
class Foyer:
    id: int
    lat: float
    lon: float
    detections: int
    detections_24h: int
    first: dt.datetime
    last: dt.datetime
    max_frp_mw: float | None
    estimated_area_ha: int
    active: bool
    hull: tuple[Point, ...] | None  # (lon, lat) ring, closed; None below 3 points


def _cell(lat: float, lon: float, size: float) -> Cell:
    return math.floor(lat / size), math.floor(lon / size)


def _components(cells: set[Cell]) -> list[list[Cell]]:
    remaining = set(cells)
    components: list[list[Cell]] = []
    while remaining:
        seed = min(remaining)  # deterministic order
        remaining.discard(seed)
        stack, component = [seed], [seed]
        while stack:
            cy, cx = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    neighbour = (cy + dy, cx + dx)
                    if neighbour in remaining:
                        remaining.discard(neighbour)
                        stack.append(neighbour)
                        component.append(neighbour)
        components.append(component)
    return components


def convex_hull(points: Sequence[Point]) -> tuple[Point, ...] | None:
    """Closed convex hull of (x, y) points, or None if they do not span an area."""
    unique = sorted(set(points))
    if len(unique) < 3:
        return None

    def cross(o: Point, a: Point, b: Point) -> float:
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[Point] = []
    for p in unique:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list[Point] = []
    for p in reversed(unique):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    ring = lower[:-1] + upper[:-1]
    if len(ring) < 3:
        return None  # all points on one line
    return (*ring, ring[0])


def cluster(
    detections: Sequence[Detection], now: dt.datetime
) -> tuple[list[Foyer], dict[int, int]]:
    """Return the clusters, largest first, and a map detection index -> cluster id."""
    by_cell: dict[Cell, list[int]] = {}
    for index, d in enumerate(detections):
        by_cell.setdefault(_cell(d.lat, d.lon, GRID_DEG), []).append(index)

    drafts = []
    for component in _components(set(by_cell)):
        members = sorted(i for c in component for i in by_cell[c])
        if len(members) < MIN_DETECTIONS:
            continue
        drafts.append(members)

    def rank(members: list[int]) -> tuple[int, float, float, float]:
        """Largest first, then most recent, then position: stable between runs."""
        last = max(detections[i].acquired for i in members)
        first_member = detections[members[0]]
        return (-len(members), -last.timestamp(), first_member.lat, first_member.lon)

    drafts.sort(key=rank)

    foyers: list[Foyer] = []
    assignment: dict[int, int] = {}
    for foyer_id, members in enumerate(drafts, start=1):
        points = [detections[i] for i in members]
        n = len(points)
        last = max(p.acquired for p in points)
        frps = [p.frp_mw for p in points if p.frp_mw is not None]
        fine_cells = {_cell(p.lat, p.lon, FINE_GRID_DEG) for p in points}
        foyers.append(
            Foyer(
                id=foyer_id,
                lat=round(sum(p.lat for p in points) / n, 5),
                lon=round(sum(p.lon for p in points) / n, 5),
                detections=n,
                detections_24h=sum(1 for p in points if now - p.acquired < dt.timedelta(hours=24)),
                first=min(p.acquired for p in points),
                last=last,
                max_frp_mw=round(max(frps), 2) if frps else None,
                estimated_area_ha=round(len(fine_cells) * FINE_CELL_HA),
                active=now - last < dt.timedelta(hours=ACTIVE_HOURS),
                hull=convex_hull([(p.lon, p.lat) for p in points]),
            )
        )
        for i in members:
            assignment[i] = foyer_id
    return foyers, assignment
