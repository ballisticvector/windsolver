# WindSolver

Turning a coordinate into the terrain and atmosphere a wind solve needs. windsolver.com
is being built as a product in its own right — boating, hiking, sailing, flying, fire,
agriculture — and BallisticVector is one API consumer among them. **Nothing in here knows
what a rifle is, and nothing should learn.** See `AGENTS.md` for where that line runs and
why a `forShot=` parameter is the way it dies.

| Module | What it does |
| --- | --- |
| `geo.js` | Boxes, buffers and coverage. Named `west/south/east/north`, never four bare numbers |
| `dem.js` | 3DEP terrain discovery through The National Map |
| `hrrr.js` | HRRR request building through the NOMADS GRIB2 filter |
| `profile.js` | The `windProfile` contract: what a field looks like leaving here, and every check it has to pass |

## Using it

Consumers pin a tag rather than tracking a branch, so a change to the contract cannot
reach a caller on a Tuesday:

```json
"dependencies": {
  "@ballisticvector/windsolver":
    "https://github.com/ballisticvector/windsolver/archive/refs/tags/v1.0.0.tar.gz"
}
```

The release tarball rather than `github:ballisticvector/windsolver#v1.0.0`, because npm
rewrites the shorthand to `git+ssh://git@github.com/…` in the consumer's lockfile, and
`npm ci` then needs an SSH key on every runner and host that installs it — three of them
in BallisticVector's case, to fetch a public repo. The tarball is plain HTTPS and npm
records an integrity hash for it, so no credential is needed anywhere and a moved tag
fails the install loudly instead of quietly delivering different code.

```js
const { validateWindProfile, sampleWindField } = require("@ballisticvector/windsolver/profile");
```

The repo is public so that resolves with no credential — on a CI runner, on a deploy
runner and on the droplet, which is three places a private-repo token would have had to
live and expire.

**Releasing a contract change:** land it here, tag it, then bump the pin in the consumer
in its own PR. The consumer's full suite running against the new tag is the test that the
change did not break anything; there is no job in this repo that can do it, because
checking out a private consumer from a public repo needs a credential and a job that
skips without one asserts nothing while looking like it does.

## The `windProfile` contract — v1

The payload that crosses the product line, and the thing to treat as published rather
than internal. `profile.js` owns it; BallisticVector's `lib/solver.js` consumes it and
reports what it did. Every key below is **required to be present**, with `null` the legal way to say
"not known" or "calm on this axis".

| Key | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Contract version. Read before anything else |
| `frame` | `"shooter"` | `u` along the downrange axis, `v` to the shooter's right, `w` up. The only frame accepted |
| `azimuthDeg` | 0…360 | True-north bearing **of the downrange axis** — not where the wind comes from |
| `rangesYards` | number[] | Strictly ascending, 0…20000 |
| `heightsAglFt` | number[] | Strictly ascending, −1000…30000 |
| `uFps` `vFps` `wFps` | grid or `null` | `[heightIndex][rangeIndex]`, finite, ≤ 300 fps. `null` means calm on that axis |
| `source` | string | Where the field came from, e.g. `"hrrr:2024-06-01T18Z+f01"` |
| `terrainResolutionM` | number \| `null` | Resolution of the terrain the downscaling used |
| `windSourceResolutionM` | number \| `null` | Native resolution of the weather model |
| `confidence` | 0…1 \| `null` | The engine's own account of how much to believe the field |

Components are the velocity **of the air**, which is the opposite sense to the app's
clock convention: a "3 o'clock wind" names where the wind blows *from*, and blows
toward the shooter's left, so it is negative `v`.

Sampling is bilinear between nodes and **flat outside them** — the edge value is held
rather than extrapolating a wind nobody looked at.

### Why it refuses things

A field that cannot be trusted comes back `{ ok: false, code, reason }`, and the solver
reports `windProfileApplied: false` with the same code and sentence. It is never
silently ignored and never partially applied, because the failure mode being avoided is
a confident, wrong hold.

| Code | Raised when |
| --- | --- |
| `not-an-object`, `missing-field`, `unknown-field`, `unsupported-version` | The envelope is not v1 |
| `unsupported-frame` | Anything but `"shooter"` — an east-north field is numerically indistinguishable, so it has to be declared and rotated by the sender |
| `azimuth-missing`, `azimuth-mismatch` | The shot has no bearing, or the field describes a different one. This is the one field nothing else can catch: get it wrong and every shot solves as if fired due north |
| `malformed-axis`, `malformed-grid`, `out-of-range` | Shape, ordering, finiteness, or a magnitude that means the units are wrong |
| `unsupported-vertical-wind` | A non-zero `wFps`. The 3DOF solver has no vertical wind term, and discarding a measured updraft quietly is worse than refusing the field |

The codes are the stable half of the answer — a caller may branch on them. The sentences
are for a person and may be reworded.

**Presence is required on purpose.** A mistyped `uMps` is otherwise just an absent
`uFps`, which reads as calm and solves cleanly; a missing confidence and an unknown
confidence look identical on a screen, and only one of them is honest.

## Ingestion

**Request building is separated from request making.** Everything except `dem.discover`
is a pure function over URLs and JSON, so selection logic, cycle arithmetic and box
maths are tested with no network — see `tests/ingestion.test.js`. `discover` takes a
`fetchJson` so even it can be tested offline.

## Measured, not assumed

Run live against a 2-mile display domain at **36.77, −104.49** — the coordinate from the
terrain wind map design, `docs/terrain-wind-map.md` in the BallisticVector repo — with a
6-mile buffer, so a 16 × 16 mile simulation domain:

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
