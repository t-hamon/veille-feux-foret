from __future__ import annotations

import pytest

from veille_feux import geo
from veille_feux.geo import IndustrialSite, Outline

FRANCE = geo.load_france()


@pytest.mark.parametrize(
    ("name", "lon", "lat"),
    [
        ("Paris", 2.3522, 48.8566),
        ("Marseille", 5.3698, 43.2965),
        ("Bordeaux", -0.5792, 44.8378),
        ("Strasbourg", 7.7521, 48.5734),
        ("Brest", -4.4861, 48.3904),
        ("Ajaccio, Corse", 8.7369, 41.9192),
        ("Bastia, Corse", 9.4500, 42.7000),
        ("Landes, forêt de Saumos", -0.9970, 44.9230),
    ],
)
def test_places_in_metropolitan_france(name: str, lon: float, lat: float) -> None:
    assert FRANCE.contains(lon, lat), name


@pytest.mark.parametrize(
    ("name", "lon", "lat"),
    [
        ("Barcelone", 2.1734, 41.3851),
        ("Turin", 7.6869, 45.0703),
        ("Genève", 6.1432, 46.2044),
        ("Bruxelles", 4.3517, 50.8503),
        ("Sardaigne", 9.1, 40.5),
        ("Golfe de Gascogne, en mer", -3.0, 45.5),
        ("Méditerranée, en mer", 5.0, 42.5),
        ("Londres", -0.1276, 51.5072),
    ],
)
def test_places_outside(name: str, lon: float, lat: float) -> None:
    assert not FRANCE.contains(lon, lat), name


def test_square_with_band_crossing_edges() -> None:
    shape = Outline.from_rings([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    assert shape.contains(0.5, 0.5)
    assert shape.contains(0.5, 0.999)
    assert not shape.contains(1.5, 0.5)
    assert not shape.contains(0.5, 1.5)
    assert not shape.contains(0.5, -0.5)


def test_two_disjoint_rings() -> None:
    square = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]
    island = [[5, 0], [6, 0], [6, 1], [5, 1], [5, 0]]
    shape = Outline.from_rings([square, island])
    assert shape.contains(0.5, 0.5)
    assert shape.contains(5.5, 0.5)
    assert not shape.contains(3, 0.5)


def test_from_geojson_rejects_other_types() -> None:
    with pytest.raises(ValueError, match="Point"):
        Outline.from_geojson({"type": "Point", "coordinates": [0, 0]})
    with pytest.raises(ValueError):
        Outline.from_rings([])


def test_from_geojson_polygon() -> None:
    shape = Outline.from_geojson(
        {"type": "Polygon", "coordinates": [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]]}
    )
    assert shape.contains(1, 1)


def test_distance_km_order_of_magnitude() -> None:
    # Paris to Lyon is about 392 km as the crow flies.
    assert geo.distance_km(48.8566, 2.3522, 45.7640, 4.8357) == pytest.approx(392, rel=0.02)


@pytest.mark.parametrize(
    ("name", "lon", "lat", "expected"),
    [
        # Coastal land cut by the simplified outline: the steelworks of the
        # industrial sites list lies 2.4 km outside it.
        ("aciérie de Fos-sur-Mer", 4.9167, 43.4333, True),
        # Detections from a real capture, just across a land border.
        ("Kehl, Allemagne, 0,6 km de l'outline", 7.82178, 48.59986, False),
        ("Esch-sur-Alzette, Luxembourg, 0,7 km", 5.95186, 49.50285, False),
        # Open sea, far from the coast.
        ("golfe du Lion, au large", 4.0, 43.2, False),
        ("Manche, au large", -0.5, 49.9, False),
    ],
)
def test_coastal_margin_but_not_across_borders(
    name: str, lon: float, lat: float, expected: bool
) -> None:
    assert FRANCE.contains(lon, lat) is expected, name


def test_is_within_km() -> None:
    shape = Outline.from_rings([[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]])
    # 0.01 degree east of the square is about 1.1 km.
    assert shape.is_within_km(1.01, 0.5, 2)
    assert not shape.is_within_km(1.05, 0.5, 2)
    assert shape.is_within_km(0.5, 1.01, 2)


def test_industrial_sites_are_valid_and_in_france() -> None:
    sites = geo.load_industrial_sites()
    assert len(sites) == 21
    for site in sites:
        assert 0 < site.radius_km <= 5
        assert FRANCE.contains(site.lon, site.lat), site.name
        assert "\u2014" not in site.name


def test_industrial_site_at() -> None:
    site = IndustrialSite("test", 45.0, 5.0, 2.0)
    assert geo.industrial_site_at(45.01, 5.01, [site]) is site
    assert geo.industrial_site_at(45.1, 5.1, [site]) is None
