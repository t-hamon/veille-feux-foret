"""Extract the countries around metropolitan France from Natural Earth.

The pipeline keeps a FIRMS detection when it falls inside the France outline,
or at sea within a short distance of the coast: the simplified outline cuts
some coastal land (up to about 2.4 km at the Golfe de Fos). The neighbours are
used to refuse that margin near a land border, so that a steelworks just
across the Rhine is never taken for a French fire.

Source: ne_10m_admin_0_countries.geojson from Natural Earth (public domain),
https://github.com/nvkelso/natural-earth-vector. Only the outer rings of the
polygons that reach the area around France are kept, rounded to 4 decimals.

Usage: python tools/build_neighbours.py NE_10M_COUNTRIES_GEOJSON OUTPUT
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

NEIGHBOURS = (
    "AND", "AUT", "BEL", "CHE", "DEU", "ESP", "GBR", "GGY",
    "ITA", "JEY", "LIE", "LUX", "MCO", "NLD", "SMR", "VAT",
)  # fmt: skip
# west, south, east, north: France with a margin wider than any distance used.
AREA = (-7.0, 40.0, 11.5, 52.5)


def _touches_area(ring: list[list[float]]) -> bool:
    west, south, east, north = AREA
    xs = [p[0] for p in ring]
    ys = [p[1] for p in ring]
    return max(xs) >= west and min(xs) <= east and max(ys) >= south and min(ys) <= north


def extract(document: dict[str, Any]) -> dict[str, Any]:
    polygons: list[list[list[list[float]]]] = []
    codes: list[str] = []
    for feature in document["features"]:
        code = feature["properties"].get("ADM0_A3")
        if code not in NEIGHBOURS:
            continue
        geometry = feature["geometry"]
        parts = (
            [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        )
        kept = 0
        for part in parts:
            outer = part[0]
            if _touches_area(outer):
                polygons.append([[[round(x, 4), round(y, 4)] for x, y, *_ in outer]])
                kept += 1
        if kept:
            codes.append(code)
    return {
        "type": "Feature",
        "properties": {
            "source": "Natural Earth 1:10m Admin 0 countries (public domain)",
            "countries": sorted(codes),
        },
        "geometry": {"type": "MultiPolygon", "coordinates": polygons},
    }


def main(source: Path, output: Path) -> None:
    result = extract(json.loads(source.read_text(encoding="utf-8")))
    output.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8"
    )
    rings = result["geometry"]["coordinates"]
    print(f"{len(rings)} rings, {sum(len(r[0]) for r in rings)} vertices")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
