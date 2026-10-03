"""Public data sources read by the pipeline.

Every URL the pipeline may fetch is built here from fixed constants, so that no
input (workflow parameter, file content, environment) can redirect a fetch to
another host. The allow list in ``http.py`` is derived from the same constants.
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass
from typing import Literal

FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire"
EFFIS_WFS = "https://maps.effis.emergency.copernicus.eu/effis"
EFFIS_STATS = "https://api2.effis.emergency.copernicus.eu/statistics/v2/effis/weekly"
GEO_API_COMMUNES = "https://geo.api.gouv.fr/communes"

# west, south, east, north: metropolitan France and Corsica with a small margin.
FRANCE_BBOX = (-5.5, 41.0, 10.0, 51.5)

FIRMS_LICENCE = "NASA open data policy, citation and LANCE disclaimer required"
EFFIS_LICENCE = "CC BY 4.0 (EFFIS, European Commission JRC)"
# Not verified yet: to be confirmed on geo.api.gouv.fr before the lookup is used
# by the map. Only the capture of a sample uses this source for now.
GEO_API_LICENCE = "geo.api.gouv.fr, licence to be verified"

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


ALLOWED_HOSTS = frozenset(
    urllib.parse.urlsplit(base).hostname or ""
    for base in (FIRMS_BASE, EFFIS_WFS, EFFIS_STATS, GEO_API_COMMUNES)
)
