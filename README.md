# WindSolver — ingestion

Turning a coordinate into the terrain and atmosphere a wind solve needs. This is the
engine side of the split described in `AGENTS.md`: nothing in here knows what a rifle
is, and nothing should learn.

| Module | What it does |
| --- | --- |
| `geo.js` | Boxes, buffers and coverage. Named `west/south/east/north`, never four bare numbers |
| `dem.js` | 3DEP terrain discovery through The National Map |
| `hrrr.js` | HRRR request building through the NOMADS GRIB2 filter |

**Request building is separated from request making.** Everything except `dem.discover`
is a pure function over URLs and JSON, so selection logic, cycle arithmetic and box
maths are tested with no network — see `tests/windsolver.test.js`. `discover` takes a
`fetchJson` so even it can be tested offline.

## Measured, not assumed

Run live against a 2-mile display domain at **36.77, −104.49** — the coordinate from
`docs/terrain-wind-map.md` — with a 6-mile buffer, so a 16 × 16 mile simulation domain:

| | Result |
| --- | --- |
| 3DEP discovery | 1 m DEM, **100% coverage**, 12 tiles, 1.35 s |
| 1 m tiles to download | **3,065 MB** |
| HRRR subset (6 vars, 3 levels, f00) | **2,164 bytes**, magic `GRIB` |
| S3 range requests | supported — `accept-ranges: bytes`, `206` on a partial GET |

Two things fall out of that, and they point in opposite directions.

**The atmosphere is nearly free.** Two kilobytes for the wind over a 16-mile box. Pulling
a whole forecast run, or a decade of archived cycles for the climatology mode, is
cheap. Subsetting through NOMADS is doing exactly what it should.

**The terrain is not.** Three gigabytes for one coordinate. The droplet's 120 GB disk
holds forty of them, and that is before anyone else asks for a different mountain. So
whole-tile fetching is not the plan:

- The tiles are GeoTIFFs on S3 and the bucket answers range requests, so the window a
  domain actually needs can be read without pulling 233 MB per tile. **Confirm the files
  are internally tiled — a real COG — before relying on this.** A stripped TIFF supports
  ranges while still making you read most of the file to get a window.
- The design document's other argument stands on its own: 1 m terrain does not imply a
  1 m computational mesh. Keep the source for display, resample to 10–20 m for the solve.

`discover` returns `downloadBytes` so a caller cannot avoid noticing.

## Resolution is a finding, not a setting

1 m DEM comes from quality-level-2-or-better lidar and covers a subset of the country;
the seamless national product is 1/3 arc-second, about 10 m. `dem.discover` asks what
exists over the domain, takes the finest product that genuinely covers it, and reports
every dataset it considered with the coverage each achieved.

**Partial fine coverage loses to complete coarse coverage.** A seam between a lidar tile
and whatever fills the gap is a step in the terrain, and a step in the terrain is a wind
feature the mountain does not have. The threshold is a parameter (`minCoverage`, default
0.999) so a caller can accept a partial fine product deliberately, but never by accident.

Whatever gets chosen has to reach the UI. A screen that says "1 m" everywhere is lying
wherever the lidar has not been flown.

## Things that bite

**Dataset tags are matched verbatim.** They were read from the live `/datasets` endpoint,
not from documentation. A near-miss returns an empty result rather than an error, which
looks exactly like "no terrain here".

**NOMADS answers a bad request with an HTML error page and HTTP 200.** So an invalid URL
does not fail — it arrives downstream as a GRIB file that will not parse. `hrrr.filterUrl`
throws on an out-of-range forecast hour, a transposed box, or a domain outside CONUS
rather than building a URL that will do that.

**HRRR cycle availability is an assumption.** `DEFAULT_AVAILABILITY_LAG_MINUTES` is 75,
chosen conservatively and not measured from this codebase. It worked on the live test
above. If discovery starts returning error pages, raise it first.

**Coverage is sampled, not exact.** `geo.coverageFraction` grids the box and counts hits
rather than computing a union of rectangles, so an uncovered strip thinner than the
sample spacing can be missed. It is fine for "is this good enough or fall back", and it
is not a number to show a user.

**Domain limits.** HRRR CONUS only here. Alaska has a separate filter script and a
separate domain; Hawaii and the territories have neither and need a different model.

## Not built yet

Fetching and decoding. Nothing here reads a GRIB2 message or a GeoTIFF — `discover`
returns *what to fetch*, and the pipeline that turns those into a terrain grid and a
wind field is the next piece, along with caching, which is what decides whether the
"seconds" tier in the design document is real.
