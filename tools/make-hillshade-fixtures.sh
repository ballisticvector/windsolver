#!/usr/bin/env bash
#
# Rebuild the references `tests/hillshade.test.js` and `tests/png.test.js` grade
# against.
#
#   sudo apt-get install -y gdal-bin python3-gdal
#   tools/make-hillshade-fixtures.sh
#
# Unlike `tools/make-cog-fixtures.sh` this needs no network: it works off the
# COG fixtures that script already committed. It writes into tests/fixtures:
#
#   gdaldem-utm13-hillshade.gdal.json/.f32   GDAL's hillshade of the 1 m tile,
#                                            default illumination (315°, 45°)
#   hillshade-sample.png                     a PNG *this repository wrote*,
#                                            from that hillshade resampled onto
#                                            a lat/long lattice
#   hillshade-sample.png.gdal.json/.f32      GDAL's reading of that PNG
#
# The last two are the point. A PNG writer graded by its own decoder passes
# while producing a file no other reader accepts, the same way a GRIB decoder
# graded against its own arithmetic passes while being wrong by a scale factor.
# GDAL is the independent reader here, and it also reports whether the `tRNS`
# chunk really made grey 0 nodata to somebody else.

set -euo pipefail

cd "$(dirname "$0")/.."
FIX=tests/fixtures
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# GDAL's own shaded relief over the same pixels `tests/derive.test.js` grades
# slope and aspect against. Defaults on purpose: azimuth 315, altitude 45,
# z-factor 1, Horn's gradient — the convention `hillshade.js` implements.
gdaldem hillshade "$FIX/cog-utm13-1m.tif" "$WORK/gdaldem-utm13-hillshade.tif" -q
python3 tools/gdal-reference.py "$WORK/gdaldem-utm13-hillshade" > /dev/null
mv "$WORK/gdaldem-utm13-hillshade.gdal.json" "$WORK/gdaldem-utm13-hillshade.gdal.f32" "$FIX/"

# A PNG written by png.js, over ground with a real void in it so the
# transparency is exercised rather than asserted. 256 px wide, which lands on a
# non-square raster and so catches a width/height transposition.
node - <<'JS'
const fs = require("fs");
const cog = require("./cog.js");
const hillshade = require("./hillshade.js");
const png = require("./png.js");

const buffer = fs.readFileSync("tests/fixtures/cog-nodata-hole.tif");
const header = cog.readHeader(cog.byteSource([{ start: 0, buffer: buffer }]));
const level = header.levels[0];
const window = { x0: 0, y0: 0, x1: level.width, y1: level.height };
const decoded = new Map();
cog.tilesForWindow(level, window).forEach(function (tile) {
  if (tile.empty) return;
  decoded.set(
    tile.tx + "," + tile.ty,
    cog.decodeTile(buffer.subarray(tile.offset, tile.offset + tile.byteCount), level, header)
  );
});
const grid = cog.assembleWindow(header, level, window, decoded);

const raster = hillshade.toGeographic(hillshade.shade(grid), cog.gridBounds(grid), { width: 256 });
const bytes = hillshade.toBytes(raster);
fs.writeFileSync("tests/fixtures/hillshade-sample.png", png.greyscalePng(bytes, raster.width, raster.height));
console.log("hillshade-sample.png", raster.width + "x" + raster.height);
JS

python3 tools/gdal-reference.py "$FIX/hillshade-sample.png" > /dev/null

# One tiny image per filter type. The adaptive heuristic picks three of the five
# on a hillshade, so Up and Average would otherwise ship graded by nothing but
# the code that wrote them.
node - <<'JS'
const fs = require("fs");
const png = require("./png.js");

const width = 32;
const height = 24;
const bytes = new Uint8Array(width * height);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    // Structure along both axes and a ramp across the rows, so no filter is
    // accidentally the identity.
    bytes[y * width + x] = 1 + ((x * 7 + y * 13 + ((x * y) % 11)) % 254);
  }
}
for (let filter = 0; filter <= 4; filter++) {
  fs.writeFileSync(
    "tests/fixtures/png-filter-" + filter + ".png",
    png.greyscalePng(bytes, width, height, { filter: filter })
  );
}
console.log("png-filter-0..4.png", width + "x" + height);
JS

for filter in 0 1 2 3 4; do
  python3 tools/gdal-reference.py "$FIX/png-filter-$filter.png" > /dev/null
done

echo "fixtures rebuilt in $FIX"
