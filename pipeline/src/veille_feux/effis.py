"""Burnt areas and national statistics from Copernicus EFFIS (CC BY 4.0).

Facts about the WFS responses, checked on a real capture (3 October 2026):
- positions come as [lat, lon], the reverse of the GeoJSON order;
- the dated layer (modis.ba.poly.season) has attributes: COUNTRY, FIREDATE,
  LASTUPDATE, AREA_HA, COMMUNE, PROVINCE...; it mixes Polygon, MultiPolygon
  and GeometryCollection (one French fire came as a polygon plus a line);
- the near real time layer (effis.nrt.ba.poly) has no attribute at all, not
  even the country, so French areas are found by geometry.

Axis swapping, Douglas-Peucker simplification and the France test of the NRT
layer are adapted from carte-incendies by Lucas Legrand (MIT). Keeping the
polygon parts of a GeometryCollection is new: carte-incendies dropped those
features.
"""

from __future__ import annotations

import datetime as dt
from collections import Counter
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

from veille_feux.geo import FranceArea

DECIMALS = 4  # about 11 m, far below the EFFIS resolution
SIMPLIFY_DEG = 0.0004  # about 45 m, removes the pixel staircase only

Ring = list[list[float]]
PolygonCoords = list[Ring]


class EffisFormatError(ValueError):
    """The response is not the expected EFFIS document."""


@dataclass
class BurnReport:
    features: int = 0
    kept: int = 0
    dropped: Counter[str] = field(default_factory=Counter)


def _swap(ring: Iterable[Any]) -> Ring:
    out: Ring = []
    for position in ring:
        if not isinstance(position, list) or len(position) < 2:
            raise ValueError("bad position")
        out.append([round(float(position[1]), DECIMALS), round(float(position[0]), DECIMALS)])
    return out


def _seg_dist2(p: list[float], a: list[float], b: list[float]) -> float:
    dx, dy = b[0] - a[0], b[1] - a[1]
    if dx == 0 and dy == 0:
        return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2


def simplify_ring(ring: Ring, tolerance: float = SIMPLIFY_DEG) -> Ring:
    """Iterative Douglas-Peucker on a closed ring; returns the ring unchanged if
    simplifying would leave fewer than four positions."""
    if len(ring) < 5 or ring[0] != ring[-1]:
        return ring
    pts = ring[:-1]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tolerance * tolerance
    while stack:
        i, j = stack.pop()
        worst, worst_d = -1, -1.0
        for k in range(i + 1, j):
            d = _seg_dist2(pts[k], pts[i], pts[j])
            if d > worst_d:
                worst, worst_d = k, d
        if worst_d > tol2:
            keep[worst] = True
            stack.extend(((i, worst), (worst, j)))
    out = [p for p, k in zip(pts, keep, strict=True) if k]
    return [*out, out[0]] if len(out) >= 3 else ring


def _dedupe(ring: Ring) -> Ring | None:
    out: Ring = []
    for p in ring:
        if not out or p != out[-1]:
            out.append(p)
    if out and out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def _polygon_parts(geometry: dict[str, Any]) -> list[Any]:
    kind = geometry.get("type")
    if kind == "Polygon":
        return [geometry.get("coordinates")]
    if kind == "MultiPolygon":
        return list(geometry.get("coordinates") or [])
    if kind == "GeometryCollection":
        parts: list[Any] = []
        for member in geometry.get("geometries") or []:
            parts.extend(_polygon_parts(member))
        return parts
    return []  # points and lines do not describe a burnt area


def clean_geometry(geometry: dict[str, Any] | None) -> dict[str, Any] | None:
    """Swap axes, simplify and keep only polygon parts. None if nothing is left."""
    polygons: list[PolygonCoords] = []
    for part in _polygon_parts(geometry or {}):
        rings: PolygonCoords = []
        for index, raw_ring in enumerate(part or []):
            ring = _dedupe(simplify_ring(_swap(raw_ring)))
            if ring is None:
                if index == 0:
                    break  # no outer ring, no polygon
                continue  # a degenerate hole is simply left out
            rings.append(ring)
        if rings:
            polygons.append(rings)
    if not polygons:
        return None
    if len(polygons) == 1:
        return {"type": "Polygon", "coordinates": polygons[0]}
    return {"type": "MultiPolygon", "coordinates": polygons}


def _positions(geometry: dict[str, Any]) -> list[list[float]]:
    polygons = (
        [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    )
    return [p for polygon in polygons for ring in polygon for p in ring]


def touches_france(geometry: dict[str, Any], area: FranceArea) -> bool:
    """Centroid of the positions first, then a sample of positions, so that a
    concave or border area still counts if part of it is in France."""
    pos = _positions(geometry)
    lon = sum(p[0] for p in pos) / len(pos)
    lat = sum(p[1] for p in pos) / len(pos)
    if area.contains(lon, lat):
        return True
    stride = max(1, len(pos) // 12)
    return any(area.contains(p[0], p[1]) for p in pos[::stride])


def _number(raw: Any) -> int | None:
    try:
        return round(float(raw))
    except (TypeError, ValueError):
        return None


def _day(raw: Any) -> str | None:
    """'2026-02-24 12:01:00' -> '2026-02-24'; None if not a date."""
    if not isinstance(raw, str):
        return None
    try:
        return dt.date.fromisoformat(raw[:10]).isoformat()
    except ValueError:
        return None


def _text(raw: Any) -> str | None:
    return raw.strip() or None if isinstance(raw, str) else None


def _features(document: Any) -> list[dict[str, Any]]:
    if not isinstance(document, dict) or not isinstance(document.get("features"), list):
        raise EffisFormatError("not a GeoJSON FeatureCollection")
    features: list[dict[str, Any]] = document["features"]
    return features


def dated_areas(document: Any) -> tuple[list[dict[str, Any]], BurnReport]:
    """French features of the dated layer, as GeoJSON features with clean geometry."""
    report = BurnReport()
    out: list[dict[str, Any]] = []
    for feature in _features(document):
        report.features += 1
        props = feature.get("properties") or {}
        if (_text(props.get("COUNTRY")) or "").upper() != "FR":
            report.dropped["not FR"] += 1
            continue
        try:
            geometry = clean_geometry(feature.get("geometry"))
        except (ValueError, TypeError):
            geometry = None
        if geometry is None:
            report.dropped["no polygon"] += 1
            continue
        out.append(
            {
                "type": "Feature",
                "geometry": geometry,
                "properties": {
                    "kind": "dated",
                    "date": _day(props.get("FIREDATE")),
                    "updated": _day(props.get("LASTUPDATE")),
                    "area_ha": _number(props.get("AREA_HA")),
                    "commune": _text(props.get("COMMUNE")),
                    "province": _text(props.get("PROVINCE")),
                },
            }
        )
    report.kept = len(out)
    return out, report


def nrt_areas(document: Any, area: FranceArea) -> tuple[list[dict[str, Any]], BurnReport]:
    """Features of the NRT layer that touch France. They carry no attribute."""
    report = BurnReport()
    out: list[dict[str, Any]] = []
    for feature in _features(document):
        report.features += 1
        try:
            geometry = clean_geometry(feature.get("geometry"))
        except (ValueError, TypeError):
            geometry = None
        if geometry is None:
            report.dropped["no polygon"] += 1
            continue
        if not touches_france(geometry, area):
            report.dropped["outside France"] += 1
            continue
        out.append({"type": "Feature", "geometry": geometry, "properties": {"kind": "nrt"}})
    report.kept = len(out)
    return out, report


@dataclass(frozen=True)
class NationalSummary:
    year: int
    weeks_counted: int
    burned_ha: int
    average_ha: int
    events: int
    last_week_date: str


def national_summary(document: Any, today: dt.date) -> NationalSummary:
    """Season to date for France: sum of the weeks already past.

    Future weeks are present with empty values and are ignored. ``average_ha``
    is the EFFIS average since 2006 for the same weeks.
    """
    weeks = document.get("banfweekly") if isinstance(document, dict) else None
    if not isinstance(weeks, list) or not weeks:
        raise EffisFormatError("no banfweekly list")
    burned = average = events = 0.0
    counted = 0
    last = ""
    for week in weeks:
        mddate = week.get("mddate")
        if not isinstance(mddate, str) or len(mddate) != 8 or mddate > today.strftime("%Y%m%d"):
            continue
        if week.get("area_ha") is None:
            continue  # not published yet
        burned += float(week["area_ha"])
        average += float(week.get("area_ha_avg") or 0)
        events += float(week.get("events") or 0)
        counted += 1
        last = max(last, mddate)
    if not counted:
        raise EffisFormatError("no week before today")
    if not 0 <= burned < 10_000_000:
        raise EffisFormatError(f"implausible burnt area: {burned}")
    return NationalSummary(
        year=int(last[:4]),
        weeks_counted=counted,
        burned_ha=round(burned),
        average_ha=round(average),
        events=round(events),
        last_week_date=f"{last[:4]}-{last[4:6]}-{last[6:]}",
    )
