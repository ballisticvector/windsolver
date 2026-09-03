#!/usr/bin/env python3
"""Independent reference for the geodesic direct problem, from PROJ.

`slice.js` walks a straight line over the ground from a coordinate and a
bearing, which is the direct problem on the WGS84 ellipsoid. Every intermediate
quantity in that computation is a plausible latitude, so an implementation
graded against its own arithmetic passes while being wrong by a flattening
term — the same reason the GRIB decoder is graded against ecCodes.

    pip install pyproj
    python3 tools/geodesic-reference.py > tests/fixtures/geodesic.reference.json

pyproj wraps PROJ, which uses Karney's algorithm; it is accurate to round-off
and is what GDAL, QGIS and PostGIS answer with.
"""

import json
import sys

from pyproj import Geod

# Boulder, the Boulder domain's south-west, a southern-hemisphere point, a
# point near the pole and one beside the antimeridian: the cases where a
# spherical approximation and a sign convention respectively come apart.
ORIGINS = [
    (40.0150, -105.2705),
    (39.9800, -105.3200),
    (-33.8688, 151.2093),
    (78.2232, 15.6267),
    (17.7500, 179.9900),
]

BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315, 359.5]
DISTANCES = [1.0, 100.0, 1609.344, 3218.688, 20000.0, 100000.0]


def main():
    geod = Geod(ellps="WGS84")
    cases = []
    for lat, lon in ORIGINS:
        for bearing in BEARINGS:
            for distance in DISTANCES:
                # pyproj takes and returns azimuths in -180..180, measured
                # clockwise from north, which is the same convention as a
                # compass bearing once wrapped.
                lon2, lat2, back = geod.fwd(lon, lat, bearing, distance)
                cases.append({
                    "lat": lat,
                    "lon": lon,
                    "bearingDeg": bearing,
                    "distanceM": distance,
                    "toLat": lat2,
                    "toLon": lon2,
                    # The forward azimuth at the far end is the back azimuth
                    # turned around; it is what the line's own direction has
                    # become there, and it is not the bearing it started with.
                    "forwardDeg": (back + 180.0) % 360.0,
                })

    json.dump({
        "generator": "pyproj Geod(ellps='WGS84').fwd",
        "cases": cases,
    }, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
