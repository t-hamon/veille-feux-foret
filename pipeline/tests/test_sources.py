from __future__ import annotations

import math
import urllib.parse

import pytest

from veille_feux import sources
from veille_feux.http import check_url

AIX = (43.5297, 5.4474)
LANDES = (44.923, -0.997)


def query_of(url: str) -> dict[str, str]:
    parsed = urllib.parse.urlsplit(url)
    assert f"{parsed.scheme}://{parsed.netloc}{parsed.path}" == sources.OPEN_METEO_FORECAST
    return dict(urllib.parse.parse_qsl(parsed.query, strict_parsing=True))


def test_open_meteo_url_parameters() -> None:
    url = sources.open_meteo_url([AIX, LANDES], sources.WEATHER_VARIABLES, "land")
    assert query_of(url) == {
        "latitude": "43.5297,44.923",
        "longitude": "5.4474,-0.997",
        "hourly": "temperature_2m,relative_humidity_2m,precipitation,"
        "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "models": "meteofrance_arome_france_hd",
        "past_hours": "168",
        "forecast_hours": "60",
        "timeformat": "unixtime",
        "wind_speed_unit": "kmh",
        "cell_selection": "land",
    }
    # Commas stay literal: shorter requests, as in the Open-Meteo documentation.
    assert "%2C" not in url
    check_url(url)


def test_coordinates_are_short_and_rounded() -> None:
    points = [(41.0, -5.5), (43.52971, -0.00001), (51.5, 9.99999)]
    query = query_of(sources.open_meteo_url(points, sources.WIND_VARIABLES, "nearest"))
    assert query["latitude"] == "41,43.5297,51.5"
    assert query["longitude"] == "-5.5,0,10"


@pytest.mark.parametrize(
    "point",
    [(40.9, 2.0), (51.6, 2.0), (46.0, -5.6), (46.0, 10.1), (math.nan, 2.0), (46.0, math.inf)],
)
def test_points_outside_the_map_area_are_refused(point: tuple[float, float]) -> None:
    with pytest.raises(ValueError):
        sources.open_meteo_url([point], sources.WIND_VARIABLES, "nearest")


def test_request_size_and_variables_are_checked() -> None:
    with pytest.raises(ValueError, match="points expected"):
        sources.open_meteo_url([], sources.WIND_VARIABLES, "nearest")
    too_many = [(46.0, 2.0)] * (sources.MAX_POINTS_PER_REQUEST + 1)
    with pytest.raises(ValueError, match="points expected"):
        sources.open_meteo_url(too_many, sources.WIND_VARIABLES, "nearest")
    with pytest.raises(ValueError, match="variable"):
        sources.open_meteo_url([AIX], (), "nearest")


def test_wind_urls_split_the_grid() -> None:
    points = [(41.0 + i * 0.01, 2.0) for i in range(415)]
    urls = sources.open_meteo_wind_urls(points)
    assert len(urls) == 2
    first, second = (query_of(url) for url in urls)
    assert len(first["latitude"].split(",")) == 250
    assert len(second["latitude"].split(",")) == 165
    assert first["hourly"] == "wind_speed_10m,wind_direction_10m,wind_gusts_10m"
    assert first["cell_selection"] == "nearest"
    assert sources.open_meteo_wind_urls([]) == []


def test_open_meteo_hosts_are_allowed() -> None:
    assert "api.open-meteo.com" in sources.ALLOWED_HOSTS
    assert len(sources.ALLOWED_HOSTS) == 5
    check_url(sources.OPEN_METEO_META)
    assert sources.OPEN_METEO_META.endswith("/meteofrance_arome_france_hd/static/meta.json")
