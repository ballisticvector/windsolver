"""Dump GDAL's own reading of a raster, for the suites to grade against.

    python3 tools/gdal-reference.py tests/fixtures/cog-lzw-p3 ...
    python3 tools/gdal-reference.py tests/fixtures/hillshade-sample.png

Writes `<name>.gdal.json` (metadata) and `<name>.gdal.f32` (every level's
pixels as little-endian float32, full resolution first).

A name with no extension is a `.tif`, which is what the COG fixtures are. An
extension is honoured as given, so a PNG this repository wrote can be graded by
an independent reader rather than by the writer's own decoder.

`ReadRaster` rather than `ReadAsArray`: the array API goes through
`osgeo.gdal_array`, which needs GDAL and NumPy built against each other, and
fails with `numpy.core.multiarray failed to import` when they are not. Raw
buffers need neither.
"""

import json
import os
import sys

from osgeo import gdal, osr

gdal.UseExceptions()


def dump(name):
    path = name if os.path.splitext(name)[1] else name + ".tif"
    ds = gdal.Open(path)
    band = ds.GetRasterBand(1)
    sr = osr.SpatialReference(wkt=ds.GetProjection())
    width, height = ds.RasterXSize, ds.RasterYSize

    blobs = [band.ReadRaster(0, 0, width, height, buf_type=gdal.GDT_Float32)]
    levels = [{"width": width, "height": height}]
    for i in range(band.GetOverviewCount()):
        ov = band.GetOverview(i)
        blobs.append(ov.ReadRaster(0, 0, ov.XSize, ov.YSize, buf_type=gdal.GDT_Float32))
        levels.append({"width": ov.XSize, "height": ov.YSize})

    meta = {
        "gdal": gdal.VersionInfo("RELEASE_NAME"),
        "geoTransform": list(ds.GetGeoTransform()),
        "epsg": int(sr.GetAuthorityCode(None)) if sr.GetAuthorityCode(None) else None,
        "nodata": band.GetNoDataValue(),
        "blockSize": band.GetBlockSize(),
        "dataType": gdal.GetDataTypeName(band.DataType),
        "levels": levels,
    }
    with open(name + ".gdal.json", "w") as f:
        json.dump(meta, f, indent=1)
    with open(name + ".gdal.f32", "wb") as f:
        for blob in blobs:
            f.write(blob)
    print(name, width, height, meta["epsg"], meta["blockSize"], len(levels))


for arg in sys.argv[1:]:
    dump(arg)
