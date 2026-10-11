"""Public data sources read by the pipeline.

Every URL the pipeline may fetch is built here from fixed constants, so that no
input (workflow parameter, file content, environment) can redirect a fetch to
another host. The allow list in ``http.py`` is derived from the same constants.
"""

from __future__ import annotations

import urllib.parse
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"
EFFIS_STATS = "https://api2.effis.emergency.copernicus.eu/statistics/v2/effis/weekly"
GEO_API_COMMUNES = "https://geo.api.gouv.fr/communes"
OPEN_METEO_FORECAST = "https://api.open-meteo.com/v1/meteofrance"
OPEN_METEO_MODEL = "meteofrance_arome_france_hd"
# Run times of the model; calls to this metadata API are not counted in the limits.
OPEN_METEO_META = f"https://api.open-meteo.com/data/{OPEN_METEO_MODEL}/static/meta.json"

# west, south, east, north: metropolitan France and Corsica with a small margin.
FRANCE_BBOX = (-5.5, 41.0, 10.0, 51.5)

FIRMS_LICENCE = "NASA open data policy, citation and LANCE disclaimer required"
EFFIS_LICENCE = "CC BY 4.0 (EFFIS, European Commission JRC)"
# Checked on 3 October 2026 in the repositories the service is built from
# (datagouv/api-geo, decoupage-administratif, contours-administratifs): for
# metropolitan France, commune names and codes come from the INSEE Code officiel
# geographique and outlines from IGN ADMIN EXPRESS, both under the Licence Ouverte.
# Run by DINUM, limited to 50 calls per second per IP address.
GEO_API_LICENCE = "Licence Ouverte (Etalab): INSEE COG and IGN ADMIN EXPRESS, via geo.api.gouv.fr"
# Read on 11 October 2026 (open-meteo.com/en/terms, /en/licence and /en/pricing):
# data under CC BY 4.0 with a link to open-meteo.com next to the data shown; the
# free API is for non-commercial use, within 600 calls a minute, 5,000 an hour,
# 10,000 a day and 300,000 a month, each location of a request counting as one call.
OPEN_METEO_LICENCE = (
    "CC BY 4.0 (Open-Meteo.com, AROME France HD model of Météo-France), free non-commercial API"
)

# Hourly variables of the AROME France HD model, as named by Open-Meteo.
WIND_VARIABLES = ("wind_speed_10m", "wind_direction_10m", "wind_gusts_10m")
WEATHER_VARIABLES = (
    "temperature_2m",
    "relative_humidity_2m",
    "precipitation",
    *WIND_VARIABLES,
)
# Wind grid step in degrees: 415 points over metropolitan France and Corsica,
# fetched again at each new model run (8 a day), about 3,300 calls a day.
WIND_GRID_STEP = 0.5
# Every request covers the 7 days of the map and the whole forecast. AROME France
# HD runs every 3 hours and its data ends about 52 hours after the run time, so
# 60 hours always reach the end; the hours past it come back as null values.
PAST_HOURS = 168
FORECAST_HOURS = 60
# Well under the request size that Open-Meteo refuses (about 1,000 points
# according to the Flamap documentation), with short coordinates.
MAX_POINTS_PER_REQUEST = 250
# "nearest" keeps the grid regular, sea included; "land" picks for a fire a land
# cell of similar elevation, which suits temperature and humidity.
CellSelection = Literal["nearest", "land"]

Sensor = Literal["viirs", "modis"]
Window = Literal["24h", "7d"]


@dataclass(frozen=True)
class FirmsFeed:
    id: str
    label: str
    sensor: Sensor
    path: str  # relative to FIRMS_BASE, with a {window} placeholder

    def url(self, window: Window) -> str:
        return f"{FIRMS_BASE}/{self.path.format(window=window)}"


FIRMS_FEEDS: tuple[FirmsFeed, ...] = (
    FirmsFeed(
        "viirs_snpp",
        "VIIRS Suomi NPP (375 m)",
        "viirs",
        "suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_{window}.csv",
    ),
    FirmsFeed(
        "viirs_noaa20",
        "VIIRS NOAA-20 (375 m)",
        "viirs",
        "noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_{window}.csv",
    ),
    FirmsFeed(
        "viirs_noaa21",
        "VIIRS NOAA-21 (375 m)",
        "viirs",
        "noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_{window}.csv",
    ),
    FirmsFeed(
        "modis",
        "MODIS Aqua et Terra (1 km)",
        "modis",
        "modis-c6.1/csv/MODIS_C6_1_Europe_{window}.csv",
    ),
)

EffisLayer = Literal["modis.ba.poly.season", "effis.nrt.ba.poly"]
EFFIS_DATED_LAYER: EffisLayer = "modis.ba.poly.season"
EFFIS_NRT_LAYER: EffisLayer = "effis.nrt.ba.poly"


def effis_wfs_url(layer: EffisLayer) -> str:
    west, south, east, north = FRANCE_BBOX
    query = urllib.parse.urlencode(
        {
            "service": "WFS",
            "version": "1.0.0",
            "request": "GetFeature",
            "typename": f"ms:{layer}",
            "outputformat": "geojson",
            "bbox": f"{west},{south},{east},{north}",
        }
    )
    return f"{EFFIS_WFS}?{query}"


def effis_stats_url(year: int) -> str:
    return f"{EFFIS_STATS}?{urllib.parse.urlencode({'country': 'FRA', 'year': year})}"


def geo_api_commune_url(lat: float, lon: float) -> str:
    query = urllib.parse.urlencode(
        {"lat": f"{lat:.5f}", "lon": f"{lon:.5f}", "fields": "nom,code,departement"}
    )
    return f"{GEO_API_COMMUNES}?{query}"


def _coordinate(value: float) -> str:
    """Shortest exact text of a coordinate rounded to 4 decimals (about 10 m)."""
    # Adding 0.0 turns -0.0 into 0.0.
    return format(round(value, 4) + 0.0, ".4f").rstrip("0").rstrip(".")


def open_meteo_url(
    points: Sequence[tuple[float, float]],
    variables: Sequence[str],
    cell_selection: CellSelection,
) -> str:
    """Hourly AROME France HD data for (lat, lon) points of the map area.

    Times are Unix timestamps (UTC), speeds km/h, directions in degrees the wind
    comes from. Points outside the area are refused: the pipeline only asks for
    places it computed itself.
    """
    if not 0 < len(points) <= MAX_POINTS_PER_REQUEST:
        raise ValueError(f"between 1 and {MAX_POINTS_PER_REQUEST} points expected")
    if not variables:
        raise ValueError("at least one variable expected")
    west, south, east, north = FRANCE_BBOX
    for lat, lon in points:
        # A NaN fails every comparison, so it is refused here too.
        if not (south <= lat <= north and west <= lon <= east):
            raise ValueError(f"point outside the map area: {lat}, {lon}")
    query = urllib.parse.urlencode(
        {
            "latitude": ",".join(_coordinate(lat) for lat, _ in points),
            "longitude": ",".join(_coordinate(lon) for _, lon in points),
            "hourly": ",".join(variables),
            "models": OPEN_METEO_MODEL,
            "past_hours": PAST_HOURS,
            "forecast_hours": FORECAST_HOURS,
            "timeformat": "unixtime",
            "wind_speed_unit": "kmh",
            "cell_selection": cell_selection,
        },
        safe=",",
    )
    return f"{OPEN_METEO_FORECAST}?{query}"


def open_meteo_wind_urls(points: Sequence[tuple[float, float]]) -> list[str]:
    """Wind of the grid points, split into requests of acceptable size."""
    return [
        open_meteo_url(points[i : i + MAX_POINTS_PER_REQUEST], WIND_VARIABLES, "nearest")
        for i in range(0, len(points), MAX_POINTS_PER_REQUEST)
    ]


ALLOWED_HOSTS = frozenset(
    urllib.parse.urlsplit(base).hostname or ""
    for base in (
        FIRMS_BASE,
        EFFIS_WFS,
        EFFIS_STATS,
        GEO_API_COMMUNES,
        OPEN_METEO_FORECAST,
        OPEN_METEO_META,
    )
)
