"""Geography helpers: metropolitan France outline and known industrial heat sources.

The outline is ``metropole.geojson`` from the france-geojson project by Gregoire
David, a simplified conversion of IGN Admin Express COG 2018 (Licence Ouverte).
The point-in-polygon test and its latitude band index are adapted from
carte-incendies by Lucas Legrand (MIT).

The simplification cuts some coastal land: the Fos-sur-Mer steelworks lies
2.4 km outside the outline. A point at sea close to the coast is therefore
accepted, unless a neighbouring country is close (``voisins.geojson``, extracted
from Natural Earth, public domain), so that a site just across a land border is
never taken for a French one.

The industrial sites list (refineries, steelworks, cement plants and other
permanent heat sources that FIRMS detects every day) comes from carte-incendies.
"""

from __future__ import annotations

import json
import math
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from importlib import resources
from typing import Any

Position = Sequence[float]
Edge = tuple[float, float, float, float]

# Height of a latitude band of the index, in degrees.
BAND = 0.05
KM_PER_DEGREE = 111.0
# A point outside the outline is accepted up to this distance from it...
COAST_MARGIN_KM = 3.0
# ...if no neighbouring country is closer than this.
BORDER_CLEARANCE_KM = 5.0


@dataclass(frozen=True)
class Outline:
    """Point-in-polygon test against the outer rings of a (Multi)Polygon.

    Edges are stored by latitude band, so a point is only compared with the
    edges its horizontal ray can cross. Horizontal edges are kept for distance
    queries; the crossing test skips them by construction. The outline has no
    holes and its rings
    do not overlap, so counting crossings over all rings at once gives the same
    parity as testing each ring separately.
    """

    lat0: float
    bands: dict[int, tuple[Edge, ...]]

    @classmethod
    def from_rings(cls, rings: Iterable[Sequence[Position]]) -> Outline:
        ring_list = [list(ring) for ring in rings]
        if not ring_list:
            raise ValueError("an outline needs at least one ring")
        lat0 = min(float(p[1]) for ring in ring_list for p in ring)
        buckets: dict[int, list[Edge]] = {}
        for ring in ring_list:
            for i in range(len(ring)):
                x1, y1 = float(ring[i - 1][0]), float(ring[i - 1][1])
                x2, y2 = float(ring[i][0]), float(ring[i][1])
                first = int((min(y1, y2) - lat0) / BAND)
                last = int((max(y1, y2) - lat0) / BAND)
                for band in range(first, last + 1):
                    buckets.setdefault(band, []).append((x1, y1, x2, y2))
        return cls(lat0, {band: tuple(edges) for band, edges in buckets.items()})

    @classmethod
    def from_geojson(cls, document: dict[str, Any]) -> Outline:
        geometry = document.get("geometry", document)
        kind = geometry.get("type")
        if kind == "Polygon":
            rings = [geometry["coordinates"][0]]
        elif kind == "MultiPolygon":
            rings = [polygon[0] for polygon in geometry["coordinates"]]
        else:
            raise ValueError(f"expected a Polygon or MultiPolygon, got {kind}")
        return cls.from_rings(rings)

    def contains(self, lon: float, lat: float) -> bool:
        edges = self.bands.get(int((lat - self.lat0) / BAND), ())
        inside = False
        for x1, y1, x2, y2 in edges:
            if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
                inside = not inside
        return inside

    def is_within_km(self, lon: float, lat: float, limit_km: float) -> bool:
        """True if an edge of the outline is closer than ``limit_km``.

        Only the bands that can hold such an edge are scanned. Distances use a
        local equirectangular projection centred on the point.
        """
        reach = limit_km / KM_PER_DEGREE
        first = int((lat - reach - self.lat0) / BAND)
        last = int((lat + reach - self.lat0) / BAND)
        kx = KM_PER_DEGREE * math.cos(math.radians(lat))
        seen: set[Edge] = set()
        for band in range(first, last + 1):
            for edge in self.bands.get(band, ()):
                if edge in seen:
                    continue
                seen.add(edge)
                if _segment_distance_km(lon, lat, edge, kx) <= limit_km:
                    return True
        return False


def _segment_distance_km(lon: float, lat: float, edge: Edge, kx: float) -> float:
    x1, y1, x2, y2 = edge
    ax, ay = (x1 - lon) * kx, (y1 - lat) * KM_PER_DEGREE
    bx, by = (x2 - lon) * kx, (y2 - lat) * KM_PER_DEGREE
    dx, dy = bx - ax, by - ay
    length2 = dx * dx + dy * dy
    t = 0.0 if length2 == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / length2))
    return math.hypot(ax + t * dx, ay + t * dy)


@dataclass(frozen=True)
class FranceArea:
    """Decides whether a point belongs to metropolitan France for this map."""

    france: Outline
    neighbours: Outline

    def contains(self, lon: float, lat: float) -> bool:
        if self.france.contains(lon, lat):
            return True
        return (
            self.france.is_within_km(lon, lat, COAST_MARGIN_KM)
            and not self.neighbours.contains(lon, lat)
            and not self.neighbours.is_within_km(lon, lat, BORDER_CLEARANCE_KM)
        )


@dataclass(frozen=True)
class IndustrialSite:
    name: str
    lat: float
    lon: float
    radius_km: float


def distance_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Equirectangular approximation: accurate to well under 1 % at a few km."""
    dlat = (lat2 - lat1) * KM_PER_DEGREE
    dlon = (lon2 - lon1) * KM_PER_DEGREE * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dlat, dlon)


def industrial_site_at(
    lat: float, lon: float, sites: Iterable[IndustrialSite]
) -> IndustrialSite | None:
    for site in sites:
        if distance_km(lat, lon, site.lat, site.lon) <= site.radius_km:
            return site
    return None


def _data_text(name: str) -> str:
    return resources.files("veille_feux").joinpath("data", name).read_text(encoding="utf-8")


def load_france() -> FranceArea:
    return FranceArea(
        france=Outline.from_geojson(json.loads(_data_text("metropole.geojson"))),
        neighbours=Outline.from_geojson(json.loads(_data_text("voisins.geojson"))),
    )


def load_industrial_sites() -> tuple[IndustrialSite, ...]:
    document = json.loads(_data_text("sites_industriels.json"))
    return tuple(
        IndustrialSite(
            name=str(entry["nom"]),
            lat=float(entry["lat"]),
            lon=float(entry["lon"]),
            radius_km=float(entry.get("rayon_km", 3.0)),
        )
        for entry in document["sites"]
    )
