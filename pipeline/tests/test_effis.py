from __future__ import annotations

import datetime as dt
import json
from typing import Any

import pytest

from tests.helpers import fixture_bytes
from veille_feux import effis, geo
from veille_feux.effis import EffisFormatError

CAPTURE = "20261003T1128Z"
AREA = geo.load_france()


def _load(name: str) -> Any:
    return json.loads(fixture_bytes(f"{CAPTURE}/{name}"))


def _all_positions(geometry: dict[str, Any]) -> list[list[float]]:
    polygons = (
        [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    )
    return [p for polygon in polygons for ring in polygon for p in ring]


def test_dated_layer_keeps_french_areas_only() -> None:
    features, report = effis.dated_areas(_load("effis_burned_dated.extract.geojson.gz"))
    assert report.features == 56
    assert report.kept == len(features) == 43
    assert report.dropped == {"not FR": 13}
    first = features[0]["properties"]
    assert first == {
        "kind": "dated",
        "date": "2026-01-02",
        "updated": "2026-01-07",
        "area_ha": 3,
        "commune": "Pont de Montvert - Sud Mont Lozère",
        "province": "Lozère",
    }


def test_axes_are_swapped_to_lon_lat() -> None:
    features, _ = effis.dated_areas(_load("effis_burned_dated.extract.geojson.gz"))
    for feature in features:
        for lon, lat in _all_positions(feature["geometry"]):
            assert -5.5 <= lon <= 10.0
            assert 41.0 <= lat <= 51.5


def test_geometry_collection_keeps_its_polygon() -> None:
    raw = _load("effis_burned_dated.extract.geojson.gz")
    collection = next(f for f in raw["features"] if f["geometry"]["type"] == "GeometryCollection")
    cleaned = effis.clean_geometry(collection["geometry"])
    assert cleaned is not None
    assert cleaned["type"] == "Polygon"


def test_rings_stay_closed_and_valid() -> None:
    features, _ = effis.dated_areas(_load("effis_burned_dated.extract.geojson.gz"))
    nrt, _ = effis.nrt_areas(_load("effis_burned_nrt.extract.geojson.gz"), AREA)
    for feature in features + nrt:
        geometry = feature["geometry"]
        polygons = (
            [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        )
        for polygon in polygons:
            for ring in polygon:
                assert len(ring) >= 4
                assert ring[0] == ring[-1]


def test_nrt_layer_is_filtered_by_geometry() -> None:
    features, report = effis.nrt_areas(_load("effis_burned_nrt.extract.geojson.gz"), AREA)
    # The extract holds 28 areas inside France and 25 in Spain, Italy and Switzerland.
    assert report.features == 53
    assert report.kept == len(features) == 28
    assert report.dropped == {"outside France": 25}
    assert all(f["properties"] == {"kind": "nrt"} for f in features)


def test_simplification_reduces_vertices_without_moving_far() -> None:
    raw = _load("effis_burned_dated.extract.geojson.gz")
    feature = max(
        (f for f in raw["features"] if f["geometry"]["type"] == "Polygon"),
        key=lambda f: len(f["geometry"]["coordinates"][0]),
    )
    original = feature["geometry"]["coordinates"][0]
    cleaned = effis.clean_geometry(feature["geometry"])
    assert cleaned is not None
    ring = cleaned["coordinates"][0]
    assert len(ring) < len(original)
    kept = {(lon, lat) for lon, lat in ring}
    swapped = {(round(p[1], 4), round(p[0], 4)) for p in original}
    assert kept <= swapped  # only original vertices, never invented ones


def test_degenerate_and_non_polygon_geometries() -> None:
    tiny = [[45.0, 2.0], [45.00001, 2.0], [45.00001, 2.00001], [45.0, 2.0]]
    assert effis.clean_geometry({"type": "Polygon", "coordinates": [tiny]}) is None
    assert effis.clean_geometry({"type": "LineString", "coordinates": [[45, 2], [46, 2]]}) is None
    assert effis.clean_geometry(None) is None
    square = [[45.0, 2.0], [45.0, 2.1], [45.1, 2.1], [45.1, 2.0], [45.0, 2.0]]
    hole = [[45.05, 2.05], [45.05, 2.050001], [45.05, 2.05]]
    cleaned = effis.clean_geometry({"type": "Polygon", "coordinates": [square, hole]})
    assert cleaned is not None
    assert len(cleaned["coordinates"]) == 1  # degenerate hole left out
    multi = effis.clean_geometry({"type": "MultiPolygon", "coordinates": [[square], [square]]})
    assert multi is not None and multi["type"] == "MultiPolygon"


@pytest.mark.parametrize("document", [None, [], {"type": "FeatureCollection"}, {"features": 3}])
def test_not_a_feature_collection(document: Any) -> None:
    with pytest.raises(EffisFormatError):
        effis.dated_areas(document)


def test_national_summary_on_real_statistics() -> None:
    summary = effis.national_summary(_load("effis_weekly_stats.json.gz"), dt.date(2026, 10, 3))
    assert summary == effis.NationalSummary(
        year=2026,
        weeks_counted=39,
        burned_ha=97971,
        average_ha=14198,
        events=374,
        last_week_date="2026-09-30",
    )


def test_national_summary_ignores_future_weeks() -> None:
    early = effis.national_summary(_load("effis_weekly_stats.json.gz"), dt.date(2026, 1, 20))
    assert early.weeks_counted == 2
    assert early.last_week_date == "2026-01-14"


@pytest.mark.parametrize(
    "document",
    [
        {},
        {"banfweekly": []},
        {"banfweekly": [{"mddate": "20990101", "area_ha": 1}]},
        {"banfweekly": [{"mddate": "20260101", "area_ha": 1e9}]},
    ],
)
def test_national_summary_rejects_bad_documents(document: Any) -> None:
    with pytest.raises(EffisFormatError):
        effis.national_summary(document, dt.date(2026, 10, 3))
