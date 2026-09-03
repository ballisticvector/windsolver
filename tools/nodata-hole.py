"""Punch a nodata rectangle into a COG, to make a fixture with a hole in it.

    python3 tools/nodata-hole.py in.tif out.tif

3DEP tiles have them where a lidar project boundary, water or a void sits, and
the value on disk is -999999. A reader that hands that number on, or flattens it
to zero, puts a kilometre-deep cliff in the terrain — and a cliff is a wind
feature the ground does not have. `tests/cog.test.js` uses this file to pin that
a hole comes back as NaN and that interpolation refuses to cross it.

The hole is columns 40-99 of rows 20-59, which the test hard-codes.
"""

import struct
import sys

from osgeo import gdal

gdal.UseExceptions()

NODATA = -999999.0

src_path, dst_path = sys.argv[1], sys.argv[2]
src = gdal.Open(src_path)
width, height = src.RasterXSize, src.RasterYSize
values = list(struct.unpack(
    "<" + "f" * (width * height),
    src.GetRasterBand(1).ReadRaster(0, 0, width, height, buf_type=gdal.GDT_Float32)
))

for y in range(20, 60):
    for x in range(40, 100):
        values[y * width + x] = NODATA

mem = gdal.GetDriverByName("MEM").Create("", width, height, 1, gdal.GDT_Float32)
mem.SetGeoTransform(src.GetGeoTransform())
mem.SetProjection(src.GetProjection())
mem.GetRasterBand(1).SetNoDataValue(NODATA)
mem.GetRasterBand(1).WriteRaster(
    0, 0, width, height,
    struct.pack("<" + "f" * (width * height), *values),
    buf_type=gdal.GDT_Float32
)

# OVERVIEWS=NONE: averaging a hole into its overviews spreads the nodata, and
# what this fixture is for is the hole at full resolution.
gdal.GetDriverByName("COG").CreateCopy(
    dst_path, mem,
    options=["COMPRESS=LZW", "PREDICTOR=YES", "BLOCKSIZE=32", "OVERVIEWS=NONE"]
)
print(dst_path, "written")
