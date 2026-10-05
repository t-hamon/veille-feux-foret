from __future__ import annotations

import datetime as dt

import pytest

from tests.helpers import fixture_bytes
from veille_feux import firms, foyers, geo
from veille_feux.firms import Detection
from veille_feux.sources import FIRMS_FEEDS, FirmsFeed

NOW = dt.datetime(2026, 7, 26, 18, 0, tzinfo=dt.UTC)


def det(lat: float, lon: float, hours_ago: float = 1, frp: float | None = 10.0) -> Detection:
    return Detection(
        lat=lat,
        lon=lon,
        acquired=NOW - dt.timedelta(hours=hours_ago),
        source="viirs_snpp",
        frp_mw=frp,
        confidence_class="nominal",
        confidence_pct=None,
        daynight="D",
    )


def test_neighbouring_cells_form_one_cluster() -> None:
    points = [det(44.901, -1.001), det(44.905, -1.005), det(44.921, -0.981), det(44.911, -0.99)]
    result, assignment = foyers.cluster(points, NOW)
    assert len(result) == 1
    assert result[0].detections == 4
    assert set(assignment) == {0, 1, 2, 3}


def test_separate_fires_and_minimum_size() -> None:
    big = [det(44.90 + i * 0.001, -1.0) for i in range(5)]
    small = [det(43.5, 5.4), det(43.501, 5.401)]  # two detections only
    result, assignment = foyers.cluster(big + small, NOW)
    assert [f.detections for f in result] == [5]
    assert 5 not in assignment and 6 not in assignment


def test_order_and_ids_are_deterministic() -> None:
    a = [det(44.9 + i * 0.001, -1.0) for i in range(3)]
    b = [det(43.5 + i * 0.001, 5.4) for i in range(4)]
    first, _ = foyers.cluster(a + b, NOW)
    second, _ = foyers.cluster(list(reversed(b + a)), NOW)
    assert [(f.id, f.detections, f.lat) for f in first] == [
        (f.id, f.detections, f.lat) for f in second
    ]
    assert first[0].detections == 4


def test_activity_window_and_24h_count() -> None:
    old = [det(44.9 + i * 0.001, -1.0, hours_ago=30) for i in range(3)]
    recent = [det(43.5 + i * 0.001, 5.4, hours_ago=2) for i in range(3)]
    result, _ = foyers.cluster(old + recent, NOW)
    by_lat = {round(f.lat): f for f in result}
    assert by_lat[45].active is False
    assert by_lat[45].detections_24h == 0
    assert by_lat[44].active is True
    assert by_lat[44].detections_24h == 3


def test_missing_frp_does_not_break_the_maximum() -> None:
    points = [det(44.9, -1.0, frp=None), det(44.901, -1.0, frp=None), det(44.902, -1.0, frp=None)]
    result, _ = foyers.cluster(points, NOW)
    assert result[0].max_frp_mw is None


def test_convex_hull() -> None:
    hull = foyers.convex_hull([(0, 0), (1, 0), (1, 1), (0, 1), (0.5, 0.5)])
    assert hull is not None
    assert hull[0] == hull[-1]
    assert set(hull) == {(0, 0), (1, 0), (1, 1), (0, 1)}
    assert foyers.convex_hull([(0, 0), (1, 1), (2, 2)]) is None
    assert foyers.convex_hull([(0, 0), (0, 0), (1, 1)]) is None


@pytest.mark.parametrize("feed", FIRMS_FEEDS, ids=lambda f: f.id)
def test_real_capture_clusters(feed: FirmsFeed) -> None:
    text = fixture_bytes(f"20261003T1128Z/firms_{feed.id}_24h.csv.gz").decode()
    detections, _ = firms.parse_csv(text, feed.id, feed.sensor)
    kept, _ = firms.select_france(detections, geo.load_france(), geo.load_industrial_sites())
    now = dt.datetime(2026, 10, 3, 11, 28, tzinfo=dt.UTC)
    result, assignment = foyers.cluster(kept, now)
    assert all(f.detections >= foyers.MIN_DETECTIONS for f in result)
    assert sum(f.detections for f in result) == len(assignment)
    assert all(geo.load_france().contains(f.lon, f.lat) for f in result)
