"""Build the reduced EFFIS fixtures from a raw capture.

The raw burnt-area responses weigh 19 MB and 2.7 MB; the tests only need a few
dozen features covering every case met in the real data. The selection rules
are deterministic, so running this script again on the same capture gives the
same files. Features are copied unchanged, axes still in the [lat, lon] order
EFFIS returns.

Usage: python tools/extract_effis_fixtures.py RAW_CAPTURE_DIR FIXTURE_DIR
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path
from typing import Any


def _positions(geometry: dict[str, Any]) -> list[list[float]]:
    out: list[list[float]] = []

    def walk(node: Any) -> None:
        if isinstance(node, list) and node:
            if isinstance(node[0], (int, float)):
                out.append(node)
            else:
                for child in node:
                    walk(child)

    if geometry.get("type") == "GeometryCollection":
        for part in geometry.get("geometries", []):
            walk(part.get("coordinates"))
    else:
        walk(geometry.get("coordinates"))
    return out


def _centre(feature: dict[str, Any]) -> tuple[float, float]:
    """Mean of the positions, as (lat, lon): EFFIS axes are swapped."""
    pos = _positions(feature["geometry"])
    return sum(p[0] for p in pos) / len(pos), sum(p[1] for p in pos) / len(pos)


def _key(feature: dict[str, Any]) -> tuple[str, str]:
    props = feature.get("properties") or {}
    return str(props.get("FIREDATE", "")), str(props.get("id", ""))


def select_dated(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_country: dict[str, list[dict[str, Any]]] = {}
    for f in sorted(features, key=_key):
        by_country.setdefault((f["properties"].get("COUNTRY") or "").strip(), []).append(f)
    special = [f for f in features if f["geometry"]["type"] != "Polygon"]
    chosen = (
        by_country.get("FR", [])[:40]
        + by_country.get("ES", [])[:8]
        + by_country.get("IT", [])[:2]
        + by_country.get("", [])[:2]
        + sorted(special, key=_key)
    )
    seen: set[int] = set()
    unique = []
    for f in chosen:
        if id(f) not in seen:
            seen.add(id(f))
            unique.append(f)
    return unique


def select_nrt(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(features, key=lambda f: json.dumps(f["geometry"], sort_keys=True)[:200])
    inland: list[dict[str, Any]] = []
    spain: list[dict[str, Any]] = []
    east: list[dict[str, Any]] = []
    multi: list[dict[str, Any]] = []
    for f in ordered:
        lat, lon = _centre(f)
        if f["geometry"]["type"] == "MultiPolygon" and len(multi) < 3 and 43 < lat < 49:
            multi.append(f)
        elif 43.5 < lat < 48.5 and -0.5 < lon < 6.0 and len(inland) < 25:
            inland.append(f)
        elif lat < 42.2 and lon < 2.5 and len(spain) < 15:
            spain.append(f)
        elif lon > 7.9 and lat > 44.2 and len(east) < 10:
            east.append(f)
    return inland + multi + spain + east


def main(raw: Path, dest: Path) -> None:
    for name, select in (("effis_burned_dated", select_dated), ("effis_burned_nrt", select_nrt)):
        data = json.loads(gzip.open(raw / f"{name}.geojson.gz").read())
        extract = {"type": "FeatureCollection", "features": select(data["features"])}
        body = json.dumps(extract, ensure_ascii=False, separators=(",", ":")).encode()
        with gzip.GzipFile(dest / f"{name}.extract.geojson.gz", "wb", mtime=0) as handle:
            handle.write(body)
        print(f"{name}: {len(extract['features'])} of {len(data['features'])} features")


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
