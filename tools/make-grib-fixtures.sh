#!/usr/bin/env bash
#
# Rebuild the complex-packing GRIB2 fixtures and ecCodes' reading of them.
#
# The simple-packed fixture (hrrr-20260826t20z-f00-boulder.grib2) comes from a
# NOMADS subregion request and is small enough to keep every value. The complex
# ones cannot be: NCEP's archive is written whole-CONUS, so the smallest real
# message still carries 1,905,141 points, and a JSON of those is 60 MB. Three
# real messages are kept instead, chosen as the smallest in the file that still
# exercise the format, and ecCodes grades them two ways — its own statistics
# over every point, and its value at a decimated sample.
#
# Requires: curl, libeccodes-tools (grib_ls, grib_get_data, grib_dump), python3.
#
#   apt-get install -y libeccodes-tools
#   tools/make-grib-fixtures.sh
#
# The byte ranges come from the .idx sidecar NCEP publishes beside every object,
# which is the same mechanism archive.js uses at run time:
#
#   curl -s https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20250901/conus/hrrr.t12z.wrfsfcf01.grib2.idx
#
# They are pinned rather than re-derived so that a change in the sidecar shows
# up as a checksum failure rather than as a silently different fixture.

set -euo pipefail

cd "$(dirname "$0")/.."
out=tests/fixtures
obj=https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.20250901/conus/hrrr.t12z.wrfsfcf01.grib2
stem=hrrr-20250901t12z-f01

# name        first byte   last byte     what it exercises
#
# land        142679338    142729813     discipline 2, 3 bits per value, 20326 groups
# snod         40985133     40985742     16 bits, 45 groups, a field that is almost all zero
# cfnsf        91413985     91417100     12 bits, 570 groups, a local NCEP parameter number
fetch() {
  curl -sS --fail --max-time 120 -r "$2-$3" "$obj" -o "$out/$stem-$1.grib2"
  echo "$1 $(stat -c%s "$out/$stem-$1.grib2") bytes"
}

fetch land  142679338 142729813
fetch snod   40985133  40985742
fetch cfnsf  91413985  91417100

# ecCodes' reading of each: the statistics it computes over all 1,905,141 points,
# and its value at every 977th point. 977 is prime and coprime with the 1799-wide
# grid, so the sample walks across rows rather than down one column.
for name in land snod cfnsf; do
  f="$out/$stem-$name.grib2"
  grib_get_data -m nan "$f" | tail -n +2 | python3 -c '
import json, sys, subprocess
f = sys.argv[1]
stride = 977
vals = []
n = 0
for line in sys.stdin:
    p = line.split()
    if len(p) != 3:
        continue
    if n % stride == 0:
        vals.append(None if p[2] == "nan" else float(p[2]))
    n += 1
keys = "shortName,discipline,parameterCategory,parameterNumber,typeOfLevel,level," \
       "packingType,bitsPerValue,numberOfValues,min,max,average"
ls = subprocess.run(["grib_ls", "-p", keys, f], capture_output=True, text=True).stdout
row = ls.strip().split("\n")[2].split()
meta = dict(zip(keys.split(","), row))
json.dump({
    "source": f,
    "eccodes": "grib_ls -p " + keys + " ; grib_get_data -m nan",
    "shortName": meta["shortName"],
    "discipline": int(meta["discipline"]),
    "parameterCategory": int(meta["parameterCategory"]),
    "parameterNumber": int(meta["parameterNumber"]),
    "typeOfLevel": meta["typeOfLevel"],
    "level": int(meta["level"]),
    "packingType": meta["packingType"],
    "bitsPerValue": int(meta["bitsPerValue"]),
    "numberOfValues": n,
    "min": float(meta["min"]),
    "max": float(meta["max"]),
    "average": float(meta["average"]),
    "sampleStride": stride,
    "sample": vals
}, open(sys.argv[2], "w"), indent=1)
' "$f" "$out/$stem-$name.eccodes.json"
  echo "$name graded"
done

# Complex packing without spatial differencing (template 5.2) is not something
# NCEP writes, so the one committed case is ecCodes re-packing the existing
# simple-packed fixture. That is a real encoder rather than this repository's
# arithmetic, and the grid is small enough to keep every value.
#
# ecCodes will also re-pack to template 5.3 on request, and the message it
# writes then declares an order of spatial differencing with zero extra
# descriptor octets — no seeds — and ecCodes reads its own output back as a
# field diverging to -4.9e5. That output is not a fixture; it is why 5.3 is
# graded only against real NCEP messages.
src=$out/hrrr-20260826t20z-f00-boulder.grib2
cpx=$out/hrrr-20260826t20z-f00-boulder-complex.grib2
grib_set -s packingType=grid_complex "$src" "$cpx"
grib_get_data -m nan "$cpx" | python3 -c '
import json, sys
vals = []
for line in sys.stdin:
    p = line.split()
    if len(p) != 3 or p[0] == "Latitude":
        continue
    vals.append(None if p[2] == "nan" else float(p[2]))
json.dump({
    "source": sys.argv[1],
    "eccodes": "grib_set -s packingType=grid_complex ; grib_get_data -m nan",
    "pointsPerMessage": 42,
    "values": vals
}, open(sys.argv[2], "w"), indent=1)
' "$cpx" "$out/hrrr-20260826t20z-f00-boulder-complex.eccodes.json"
echo "complex-repack graded"
