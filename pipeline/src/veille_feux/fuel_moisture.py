"""Hourly moisture of the dead fine fuels at a fire cluster.

This is the hourly Fine Fuel Moisture Code (FFMC) of the 2025 update of the
Canadian Fire Weather Index System (FWI2025), written from the published
reports, not from any code:

- Van Wagner (1977), Information Report PS-X-69: the hourly computation, the
  equilibrium moisture contents for drying and wetting and the log drying and
  wetting rates (equations 2a to 5b);
- Van Wagner and Pickett (1985), Forestry Technical Report 33: the moisture
  scale of the code (equations 1 and 10) and the wetting by rain (equations 3a
  and 3b);
- Canadian Forest Service Fire Danger Group (2025), Information Report
  GLC-X-42, pages 18 and 19: the hourly time lag cut in half (the rate 0.0579
  of 1977 becomes 0.1158), and the first 0.5 mm of each rain event intercepted
  by the canopy, an event ending after six hours without rain.

The inputs are the hourly values written in meteo-foyers.json (temperature,
relative humidity, wind speed and the precipitation of the preceding hour), so
that the codes can be computed again from the file. The rain of an hour wets
the fuels first, then the fuels dry or wet towards the equilibrium of that
hour, as GLC-X-42 describes for hourly data.

The moisture content is carried from one hour to the next and converted to the
code only for the output: equations 1 and 10 are not exact inverses, and going
back and forth every hour would shift the moisture by about 0.05 % each time.

The computation starts from the standard starting code, 85 (GLC-X-42, appendix
C-2.4), at the first hour of the file. An hour with a missing input breaks the
bookkeeping: that hour and all the hours after it are left empty, never
estimated.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

# Standard starting code (GLC-X-42, appendix C-2.4).
START_FFMC = 85.0
# Hourly log drying and wetting rate factor: 0.0579 in Van Wagner (1977),
# doubled by FWI2025 (GLC-X-42, page 19, time lag cut in half).
HOURLY_RATE = 0.1158
# Rain intercepted by the canopy at the start of each rain event, mm, and dry
# hours after which an event ends (GLC-X-42, page 18).
INTERCEPTION_MM = 0.5
CANOPY_DRY_HOURS = 6
# Upper bound of the moisture content after rain, % (Technical Report 33).
MAX_MOISTURE = 250.0
# Above this moisture content of the fine dead fuels, Cruz and Alexander (2019)
# found that the wind rule of thumb overpredicts: 7.5 %.
DRY_LIMIT = 7.5


def moisture_from_code(code: float) -> float:
    """Moisture content, %, of an FFMC (Technical Report 33, equation 1)."""
    return 147.2 * (101.0 - code) / (59.5 + code)


def code_from_moisture(moisture: float) -> float:
    """FFMC of a moisture content, % (Technical Report 33, equation 10), within 0 and 101."""
    code = 59.5 * (250.0 - moisture) / (147.2 + moisture)
    return min(101.0, max(0.0, code))


def after_rain(moisture: float, rain: float) -> float:
    """Moisture content after ``rain`` mm reached the litter (equations 3a and 3b)."""
    if rain <= 0:
        return moisture
    wet = moisture + 42.5 * rain * math.exp(-100.0 / (251.0 - moisture)) * (
        1.0 - math.exp(-6.93 / rain)
    )
    if moisture > 150.0:
        wet += 0.0015 * (moisture - 150.0) ** 2 * math.sqrt(rain)
    return min(wet, MAX_MOISTURE)


def _rate(humidity_ratio: float, wind: float, temperature: float, factor: float) -> float:
    base = 0.424 * (1.0 - math.pow(humidity_ratio, 1.7)) + 0.0694 * math.sqrt(wind) * (
        1.0 - math.pow(humidity_ratio, 8)
    )
    return base * factor * math.exp(0.0365 * temperature)


def after_drying(
    moisture: float,
    temperature: float,
    humidity: float,
    wind: float,
    factor: float = HOURLY_RATE,
) -> float:
    """Moisture content after one step of drying or wetting by the air.

    The fuels dry towards the equilibrium for drying when wetter than it,
    wet towards the equilibrium for wetting when drier than it, and stay as
    they are in between (Van Wagner 1977, equations 2a to 5b). ``factor`` is
    the rate of one step: 0.1158 for an hour in FWI2025.
    """
    common = 0.18 * (21.1 - temperature) * (1.0 - math.exp(-0.115 * humidity))
    drying = 0.942 * math.pow(humidity, 0.679) + 11.0 * math.exp((humidity - 100.0) / 10.0) + common
    if moisture > drying:
        k = _rate(humidity / 100.0, wind, temperature, factor)
        return drying + (moisture - drying) * math.pow(10.0, -k)
    wetting = (
        0.618 * math.pow(humidity, 0.753) + 10.0 * math.exp((humidity - 100.0) / 10.0) + common
    )
    if moisture < wetting:
        k = _rate((100.0 - humidity) / 100.0, wind, temperature, factor)
        return wetting - (wetting - moisture) * math.pow(10.0, -k)
    return moisture


@dataclass
class Canopy:
    """Rain of the current event and dry hours since it last rained."""

    event_rain: float = 0.0
    dry_hours: int = 0

    def reaching_litter(self, rain: float) -> float:
        """Rain of the hour that reaches the litter, mm, after interception."""
        if rain > 0:
            before = self.event_rain
            self.event_rain += rain
            self.dry_hours = 0
            return max(0.0, self.event_rain - INTERCEPTION_MM) - max(0.0, before - INTERCEPTION_MM)
        if self.event_rain > 0:
            self.dry_hours += 1
            if self.dry_hours >= CANOPY_DRY_HOURS:
                self.event_rain = 0.0
                self.dry_hours = 0
        return 0.0


@dataclass(frozen=True)
class FineFuelMoisture:
    """Hourly codes and moisture contents, null after a missing input."""

    code: list[float | None]
    moisture: list[float | None]


def hourly_fine_fuel_moisture(
    temperature: Sequence[float | None],
    humidity: Sequence[float | None],
    wind: Sequence[float | None],
    precipitation: Sequence[float | None],
    start: float = START_FFMC,
) -> FineFuelMoisture:
    """FFMC and moisture content of each hour, from the standard starting code."""
    hours = len(temperature)
    if not len(humidity) == len(wind) == len(precipitation) == hours:
        raise ValueError("series of different lengths")
    codes: list[float | None] = []
    contents: list[float | None] = []
    moisture = moisture_from_code(start)
    canopy = Canopy()
    for t, h, w, p in zip(temperature, humidity, wind, precipitation, strict=True):
        if t is None or h is None or w is None or p is None:
            break
        moisture = after_rain(moisture, canopy.reaching_litter(p))
        moisture = after_drying(moisture, t, h, w)
        codes.append(code_from_moisture(moisture))
        contents.append(moisture)
    missing = hours - len(codes)
    return FineFuelMoisture(codes + [None] * missing, contents + [None] * missing)
