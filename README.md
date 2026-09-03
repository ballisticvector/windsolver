# WindSolver

[![CI](https://github.com/ballisticvector/windsolver/actions/workflows/ci.yml/badge.svg)](https://github.com/ballisticvector/windsolver/actions/workflows/ci.yml)

Turning a coordinate into the terrain and atmosphere a wind solve needs. windsolver.com
is being built as a product in its own right — boating, hiking, sailing, flying, fire,
agriculture — and BallisticVector is one API consumer among them. **Nothing in here knows
what a rifle is, and nothing should learn.** See `AGENTS.md` for where that line runs and
why a `forShot=` parameter is the way it dies.

> **What works today:** the `windProfile` contract, the request-building half of
> ingestion, and a GRIB2 decoder that turns an HRRR response into values and
> coordinates. Nothing here *fetches* anything yet, and no GeoTIFF is read — see
> [Not built yet](#not-built-yet). **Read [Things that bite](#things-that-bite) before you
> touch ingestion**, not after: four of the five items there look like working code
> returning an ordinary answer.

## Contents

- [Modules](#modules)
- [Using it](#using-it) · [Why the tarball](#why-the-tarball) · [Releasing a contract change](#releasing-a-contract-change)
- [The `windProfile` contract — v1](#the-windprofile-contract--v1) · [The frame](#the-frame) · [The keys](#the-keys) · [The grids](#the-grids) · [Why it refuses things](#why-it-refuses-things)
- [Ingestion](#ingestion) · [The network client](#the-network-client) · [The volume and its cache](#the-volume-and-its-cache) · [Terrain, read as windows](#terrain-read-as-windows) · [Terrain derivatives](#terrain-derivatives) · [Downscaling: the model wind over the ground](#downscaling-the-model-wind-over-the-ground)
- [Measured, not assumed](#measured-not-assumed)
- [Resolution is a finding, not a setting](#resolution-is-a-finding-not-a-setting)
- [Things that bite](#things-that-bite)
- [Not built yet](#not-built-yet)

## Modules

| Module | What it does |
| --- | --- |
| `geo.js` | Boxes, buffers and coverage. Named `west/south/east/north`, never four bare numbers |
| `dem.js` | 3DEP terrain discovery through The National Map |
| `hrrr.js` | HRRR request building through the NOMADS GRIB2 filter |
| `grib2.js` | Decodes what NOMADS returns: message parsing, simple packing, the Lambert grid, and the grid-to-earth wind rotation |
| `nomads.js` | The only module that makes a request. Fetches a subset and refuses everything NOMADS returns that is not the field that was asked for |
| `volume.js` | The general atmosphere in memory: a lat/long box × a set of levels at one valid time, earth-relative, with no bearing in it. Sampling and interpolation live here |
| `cache.js` | Keys a volume on `(bbox, level set, valid time)`, keeps it while it is the newest field there is, and collapses simultaneous callers into one fetch. Keys terrain derivatives on the ground alone, with no time in the key at all |
| `proj.js` | UTM ⇄ geographic for the datums 3DEP is published on, graded against PROJ |
| `cog.js` | Reads a GeoTIFF: directories, tags, LZW and Deflate, the floating-point predictor, and which bytes a lat/long box needs. No network |
| `terrain.js` | The only other module that makes a request. Turns a box into elevation grids over HTTP range reads |
| `derive.js` | What the ground does to the wind: slope, aspect, curvature, roughness and directional sheltering over an elevation grid. Pure arithmetic, no network |
| `downscale.js` | Puts the two halves together: a 3 km model wind × the terrain, giving east/north over every pixel of the domain. Pure arithmetic, no network |
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

```js
const { validateWindProfile, sampleWindField } = require("@ballisticvector/windsolver/profile");
```

That is the whole install. The repo is public, so it resolves with no credential — on a
CI runner, on a deploy runner and on the droplet.

### Why the tarball

Rather than `github:ballisticvector/windsolver#v1.0.0`: npm rewrites the shorthand to
`git+ssh://git@github.com/…` in the consumer's lockfile, and `npm ci` then needs an SSH
key on every runner and host that installs it — three of them in BallisticVector's case,
to fetch a public repo. The tarball is plain HTTPS and npm records an integrity hash for
it, so no credential is needed anywhere and a moved tag fails the install loudly instead
of quietly delivering different code.

### Releasing a contract change

Land it here, tag it, then bump the pin in the consumer in its own PR. The consumer's
full suite running against the new tag is the test that the change did not break
anything; there is no job in this repo that can do it, because checking out a private
consumer from a public repo needs a credential and a job that skips without one asserts
nothing while looking like it does.

## The `windProfile` contract — v1

The payload that crosses the product line, and the thing to treat as published rather
than internal. `profile.js` owns it; BallisticVector's `lib/solver.js` consumes it and
reports what it did.

### The frame

`frame: "shooter"` is a right-handed coordinate system pinned to **one shot**: its origin
is the muzzle, and its downrange axis is the bearing in `azimuthDeg`. It is not a
compass frame, and the same air over the same ground has different numbers in it for
two shooters facing different ways — which is why the frame has to be declared and why
an east-north field must be rotated by the sender rather than sent as-is.

Looking down on a shot fired due east — `azimuthDeg: 90` — with a 10 mph wind out of the
south, which for this shooter is a 3 o'clock wind:

```
   N (0°)
   ^
   |                        +u  downrange, azimuthDeg = 90
   |     muzzle o---------------------------------> target
   |            |
   |            |  +v  to the shooter's RIGHT (here, due south)
   |            v                    +w is up, out of the page
   |
   |            air moves south -> north, i.e. toward the shooter's LEFT:
   |            uFps = 0,  vFps = -14.7,  wFps = 0     (10 mph = 14.7 fps)
```

The sign is the part that catches people. Components are the velocity **of the air**,
whereas the app's clock convention names where the wind comes **from**. A "3 o'clock
wind" blows from the shooter's right, toward their left, so it is **negative** `v` —
and it pushes the bullet left, so the shooter dials right.

Heights are **above ground level**, in feet, not above the muzzle and not above sea
level. Ranges are in yards from the muzzle along the downrange axis.

### The keys

**Every key is required to be present.** The `Null?` column says only whether `null` is
an accepted *value* — never whether the key may be omitted. Omitting one is
`missing-field`, including the ones that are nearly always `null` in practice.

| Key | Type | Null? | Meaning |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | no | Contract version. Read before anything else |
| `frame` | `"shooter"` | no | The only frame accepted — see above |
| `azimuthDeg` | 0…360 | no | True-north bearing **of the downrange axis** — not where the wind comes from |
| `rangesYards` | number[] | no | Strictly ascending, 0…20000. Non-empty |
| `heightsAglFt` | number[] | no | Strictly ascending, −1000…30000. Non-empty |
| `uFps` `vFps` `wFps` | grid | **yes** | See below. `null` means calm on that axis, and is expanded to a zero grid |
| `source` | string | no | Non-empty, ≤ 200 chars, naming where the field came from, e.g. `"hrrr:2024-06-01T18Z+f01"` |
| `terrainResolutionM` | number | **yes** | Resolution of the terrain the downscaling used |
| `windSourceResolutionM` | number | **yes** | Native resolution of the weather model |
| `confidence` | 0…1 | **yes** | The engine's own account of how much to believe the field |

### The grids

Each of `uFps`, `vFps` and `wFps` is a **2D array of arrays**, indexed
`[heightIndex][rangeIndex]`, with **exactly** `heightsAglFt.length` rows each of
**exactly** `rangesYards.length` numbers. A flat array is not accepted, and a row of the
wrong length is `malformed-grid` rather than being padded or truncated — a grid whose
shape disagrees with its axes is a units-or-transpose bug, and guessing which is how a
transposed field becomes a plausible wrong answer. The two axes are independent and
routinely differ in length.

Two heights × three ranges: no headwind component, and a left-blowing crosswind that
strengthens both with height and downrange.

```js
{
  rangesYards:  [0, 500, 1000],     // 3 columns
  heightsAglFt: [6, 60],            // 2 rows
  uFps: [[0, 0, 0],                 // [heightIndex][rangeIndex]
         [0, 0, 0]],
  vFps: [[-7.3, -8.8, -10.3],       // 5–7 mph at 6 ft AGL
         [-11.7, -13.2, -14.7]],    // 8–10 mph at 60 ft AGL
  wFps: null                        // no vertical component: same as a zero grid
}
```

Every component must be finite and **within ±300 fps, which is a refusal and not a
warning**: 300 fps is 205 mph, past any surface wind ever recorded, so a value beyond it
is a field built in cm/s or km/h and labelled fps. It comes back `out-of-range`.

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
| `malformed-field` | `source` is absent as a description: empty, not a string, or over 200 characters |
| `unsupported-vertical-wind` | A non-zero `wFps`. The 3DOF solver has no vertical wind term, and discarding a measured updraft quietly is worse than refusing the field |

The codes are the stable half of the answer — a caller may branch on them. The sentences
are for a person and may be reworded.

**Presence is required on purpose, and it is why `null` has to be spelled out.** A
mistyped `uMps` is otherwise just an absent `uFps`, which reads as calm and solves
cleanly; a missing confidence and an unknown confidence look identical on a screen, and
only one of them is honest. Sending `confidence: null` is a sender saying *I do not
know*; omitting it is a sender who has not read this page, and the two must not be
allowed to look the same.

## Ingestion

**Request building is separated from request making.** Everything except `dem.discover`
is a pure function over URLs and JSON, so selection logic, cycle arithmetic and box
maths are tested with no network — see `tests/ingestion.test.js`. `discover` takes a
`fetchJson` so even it can be tested offline.

`grib2.decode(buffer)` is on the same side of that line: it takes bytes and returns one
record per message — parameter, level, valid time, the grid, and a value plus a latitude
and longitude for every point. It is **checked against ecCodes rather than against
itself**: `tests/fixtures/….eccodes.json` is `grib_get_data`'s reading of the same bytes,
and the suite compares all 336 values and coordinates against it. Every intermediate
quantity in a GRIB decode looks plausible, so a decoder graded on its own arithmetic
passes while being wrong by a scale factor.

It decodes the templates HRRR sends and **refuses the rest by name** — packing, grid
template, scanning mode, earth shape — rather than approximating them. Refusing is the
only safe default here: a half-understood field is a wind blowing the wrong way, and it
arrives with no error attached.

### The network client

`nomads.js` is the seam: `hrrr.js` decides what to ask for, `nomads.js` asks, `grib2.js`
reads the answer. It is a separate module because NOMADS does not fail the way an API is
expected to fail. Measured against `filter_hrrr_2d.pl` on 2026-08-27, over a two-mile box:

| Defect in the request | Status | Body | What arrives |
| --- | --- | --- | --- |
| none | 200 | 1,529 B GRIB | the subset |
| `var_NOTAVAR=on` | 500 | 292 B HTML | "invalid parameter: var_NOTAVAR" |
| forecast hour that does not exist | 404 | 412 B HTML | "Data file is not present" |
| cycle older than the archive | 403 | 681 B HTML | "Request for Old Data" |
| no `file=` | **200** | 111 KB HTML | the filter's own web form |
| no `var_` selected | **200** | 10 KB GRIB | every variable at those levels |
| no `subregion` | **200** | **13.4 MB** GRIB | the whole CONUS grid |
| subregion off the grid | **200** | **20.2 MB** GRIB | the whole CONUS grid, 1799 × 1059 |

Only the first three are ordinary HTTP errors. The last two are HTTP 200 **and valid
GRIB** — they decode perfectly, they are simply not what was asked for, and a 20 MB
answer to a 1.5 KB question is noticed as a bandwidth bill rather than as a bug. So the
client checks four things past the status code:

- the body does not open like HTML, whatever the content type claims (`html-response`);
- it stays under a byte ceiling, enforced **while reading** so an unexpected full-domain
  file is abandoned in flight rather than buffered and then rejected (`too-large`);
- it starts with the GRIB magic (`not-grib`);
- and the grid that comes back covers the box that was asked for (`subregion-ignored`).

The error carries the filter's own sentence, because "500" alone leaves the caller
guessing which parameter was wrong. Retries are narrow: transport failures and
502/503/504 only. A 500 here means *you sent a bad parameter*, and sending it again is
not a recovery strategy.

```js
const { fetchLatestHrrrBox } = require("@ballisticvector/windsolver/nomads");

const got = await fetchLatestHrrrBox({
  box: { west: -105.32, south: 39.98, east: -105.24, north: 40.04 }
});
// got.cycle, got.lagMinutes, got.bytes, got.records — grib2 records, still grid-relative
```

`fetchLatestHrrrBox` walks back an hour at a time while the answer is a 404, so the
75-minute availability lag stops being an assumption: `lagMinutes` on the result is what
it actually was for the cycle that answered. It does **not** walk past a 403 or a 500 —
those are defects in the request, and an hour earlier they are just as wrong.

### The volume and its cache

```js
const { createHrrrVolumeSource } = require("@ballisticvector/windsolver/cache");
const { windProfileAt, mpsToFps } = require("@ballisticvector/windsolver/volume");

const source = createHrrrVolumeSource({});
const v = await source.getLatest({ box, levels: ["heightAboveGround:10", "heightAboveGround:80"] });

windProfileAt(v, 40.02, -105.28);  // [{ heightAglM: 10, east, north }, …] in m/s
```

**The key is `(source, snapped bbox, level set, valid time)` and never an azimuth or a
set of ranges.** A sailor and a fire crew have no bearing to give, and a bearing in the
key means every consumer that is not a rifle re-fetches the same air. The shooter's
range × height grid is a *view* over this, cut later.

What that costs in practice, measured live on 2026-08-27:

| Box | Grid | On the wire | In the cache | Fetch |
| --- | --- | --- | --- | --- |
| 2 miles | 3 × 3 | 1,576 B | 720 B | 0.9–1.4 s |
| 16 miles | 19 × 19 | 4,800 B | 28 KB | 1.0–4.2 s |
| 60 miles | 70 × 70 | 48,668 B | 392 KB | 1.2 s |

So the default 256-entry LRU is about 100 MB of resident memory if every entry is a
60-mile map domain, and a few megabytes if they are shooting boxes. **Nothing here needs
a bigger droplet.** One cold fetch was also measured at 53 s against the same service
that answered in 1.1 s a minute earlier — NOMADS latency is the variable that matters,
not ours, which is the argument for the cache rather than for hardware.

A few decisions worth not undoing:

- **Boxes are snapped outward to a 0.01° grid before they are keyed *and before they are
  fetched*.** Two shooters a hundred metres apart otherwise miss each other's cache entry
  for the same air. Snapping only the key would serve the second one a field that does
  not cover them.
- **An entry lives 135 minutes from its valid time**, not 60. HRRR is hourly but takes up
  to 75 minutes to appear, so expiring on the hour throws a field away during the window
  in which nothing newer can be fetched — a miss that resolves to a 404.
- **Simultaneous misses on one key are coalesced**, so ten callers over the same box make
  one request. Measured: 10 concurrent calls, 1 load, 9 coalesced.
- **A failed load is not cached**, and the valid time the source returns is checked
  against the one that was asked for. Filing an hour of weather under the wrong hour is
  a cache that is confidently wrong, which is worse than an empty one.
- **`buildVolume` rotates grid-relative wind to earth-relative once**, on the way in, so
  nothing downstream can forget to.

### Terrain, read as windows

```js
const { readTerrain, elevationAt } = require("@ballisticvector/windsolver/terrain");

const t = await readTerrain(box, { fetch, targetResolutionM: 10 });
elevationAt(t.grids, 39.985, -105.30);  // metres, or null over a void
```

`dem.js` decides which product covers the domain, `cog.js` decides which bytes of a tile
are worth asking for, and `terrain.js` is the thin layer that asks. It takes its `fetch`
as an option, so its own suite is offline; the fixtures are real 3DEP bytes cut down with
GDAL by `tools/make-cog-fixtures.sh`.

**A window is not a download.** Live over a 2.7 × 3.3 km box west of Boulder, on
2026-09-08:

| Asked for | Level | Grid | Read | Requests | Of the tiles |
| --- | --- | --- | --- | --- | --- |
| 10 m | overview 3 | 432 × 421 | **1.29 MB** | 5 | 0.28% |
| 1 m | full | 3430 × 3345 | 45.2 MB | 15 | 9.8% |

The two tiles listed over that box weigh **459 MB** between them. `targetResolutionM`
chooses the overview — the coarsest level still finer than what was asked for — because
that is the number a caller actually knows: a solver mesh is 10–20 m whatever the source
is, and reading 1 m terrain in order to average it down is nine tenths of the bytes
thrown away.

**Graded against GDAL, not against itself**, the same way the decoder is graded against
ecCodes. `tests/cog.test.js` compares every pixel of every overview level of every
fixture with `gdal_translate`'s reading of the same file, and the live window above
agrees with `gdallocationinfo` **to the bit** at five coordinates — which grades the
projection, the overview choice, the tile arithmetic, the LZW decode and the predictor in
one number, since any of them being wrong moves the value.

What it refuses, and why each one is a wrong answer rather than an error:

- a server that answers a `Range` with **200 and the whole file** (`no-range-support`) —
  otherwise a window silently becomes a 400 MB download that only looks slow;
- a directory chain that is still asking for bytes after several round trips
  (`header-scattered`), rather than crawling a file one tag at a time;
- a box that does not touch the tile (`outside-tile`) and one that wraps the antimeridian
  (`box-crosses-antimeridian`);
- a compression, predictor, sample format or bit depth it has not been shown
  (`unsupported-*`), by name;
- and a read that would exceed its byte budget, counted **across the whole read**
  (`too-many-bytes`).

Holes stay holes. 3DEP writes `-999999` where a project boundary, water or a void sits;
`cog.js` turns nodata into `NaN`, `sampleElevation` returns `null` beside one rather than
interpolating across it, and `elevationAt` moves to the next grid. Interpolating over a
void invents ground, and invented ground is a wind feature the mountain does not have.

### Terrain derivatives

```js
const { derive, shelterAt } = require("@ballisticvector/windsolver/derive");

const d = derive(grid, { shelter: { maxDistanceM: 300 } });   // grid from readTerrain
d.fields.slopeDeg;                       // Float32Array, NaN where undefined
shelterAt(d, 39.985, -105.30, 270);      // Sx for a wind from due west, in degrees
```

Terrain does not change between forecast hours, so all of this is a function of the
elevation grid alone. That is the point of computing it separately: the expensive
geometry moves off the request path once per domain, and an hourly wind update becomes
arithmetic over grids that already exist.

| Field | What it is |
| --- | --- |
| `slopeDeg`, `aspectDeg` | Horn's 3 × 3 weighted difference, the one GDAL, ArcGIS and GRASS all use. Aspect is the downhill compass bearing |
| `dzdx`, `dzdy` | The gradient itself, kept because a bearing cannot be interpolated and a vector can |
| `profileCurvature`, `planCurvature`, `totalCurvature` | Zevenbergen & Thorne, in 1/m, **positive convex in all three** |
| `relief`, `tri`, `tpi` | Roughness three ways, in metres: GDAL's `roughness`, Riley's ruggedness index, and the topographic position index |
| `shelter.sectors[i].sx` | Winstral's Sx per wind sector, in degrees. Positive is sheltered |

**Metres, not degrees.** A geographic DEM's pixel is 1/3 arc-second on both axes and
those are not the same distance on the ground — about 10.3 m north-south and 7.9 m
east-west at 40°, and the ratio moves with latitude across a single domain. Every
derivative divides by a spacing computed per row for that reason. `gdaldem -s` cannot
express it: it takes one scale for both axes, so on a geographic DEM it overstates the
east-west spacing by 1/cos(lat), and `tests/derive.test.js` measures that disagreement
rather than papering over it.

Graded against `gdaldem` for slope, aspect, roughness, TRI and TPI over the same fixtures
`cog.js` uses; against analytic surfaces of known curvature, since no GDAL tool computes
curvature; and against a synthetic wall, summit and hollow for sheltering. Where we and
GDAL differ — up to 0.011° of slope on ground 2,218 m above the datum — the suite
reproduces GDAL's float32 arithmetic bit for bit to show the difference is its rounding
rather than a different formula, and then shows on a plane of known gradient that ours is
the closer of the two.

Undefined stays undefined, for the same reason holes stay holes:

- **the border is `NaN`**, because a 3 × 3 window does not fit, and reflecting it invents
  a gradient exactly where one domain is stitched to the next;
- **any neighbourhood touching a void is `NaN`** — nothing is averaged around the hole;
- **flat ground has no aspect**, so it gets `NaN` rather than 0. Zero is a real bearing,
  and a flat pixel reported as facing north becomes a sheltering answer nothing
  downstream can tell is wrong;
- **a shelter ray that leaves the grid is `NaN`, not 0.** "Nothing upwind" and "we did not
  look" are different answers and only one of them means exposed — read the window with
  `maxDistanceM` of padding if the edges matter;
- **`fieldAt` refuses `aspectDeg`.** Interpolating 350 and 10 gives 180, which points the
  wrong way; `aspectAt` goes through the gradient instead.

Sheltering costs cells × sectors × steps, so it is computed only when asked for. Bearings
are true north: a UTM grid's columns follow its central meridian rather than the local
one, which is up to 3° of rotation applied to every sector in the domain, and one
projection removes it. That is also the one thing the topocalc comparison cannot see —
it walks the raster's rows and columns, so the two agree only where grid north *is* true
north. Off the central meridian a ray 800 m long lands a few centimetres to the side of
topocalc's, and on smooth ground that is already a thousandth of a degree of horizon.

**The cache for these has no time in the key.** `cache.terrainKey` is
`(dataset, snapped box, resolution, sheltering parameters)` — a mountain is the same at
06Z as at 18Z, so a derived domain stands until USGS reflies the ground and the dataset
tag changes. What is in the key is everything that changes the numbers: an Sx searched to
300 m is a different answer from one searched to 1000 m. `createStaticCache` is bounded
in **bytes** rather than entries, because ten float32 fields plus the elevation over a
432 × 421 domain is 7 MB before any sheltering, and sixteen sectors is another 11 MB —
256 of those would be five gigabytes, not the ~100 MB the volume cache holds.

### Downscaling: the model wind over the ground

The two halves meet here. HRRR knows the weather and does not know the canyon: its pixel
is 3 km, so a domain a shooter, a sailor or a fire crew cares about is one or two model
cells and comes back as a single wind. `downscale.js` spreads that wind over the terrain.

```js
const { terrainWeights, downscale, windAt } =
  require("@ballisticvector/windsolver/downscale");

const weights = terrainWeights(derived);              // once per domain, cache it
const field = downscale(weights, { speedMps: 8, fromDeg: 270 });   // every hour

field.east; field.north;                 // Float32Array, m/s, earth-relative
windAt(field, 39.985, -105.30);          // { east, north, speedMps, fromDeg, factor }
```

**The split is the point.** `terrainWeights` is a function of the ground alone — no wind,
no valid time — so it belongs in the terrain cache beside the derivatives and is computed
once per domain. `downscale` is then a few multiplications per pixel, which is what makes
an hourly update cheap. Anything that needs the wind must live in the second half; the
day something time-dependent leaks into the first, the caching argument is gone.

The scheme is Liston & Elder's MicroMet (*J. Hydrometeorology* 7, 2006, §2.2), the
empirical downscaling SnowModel has used operationally for two decades, with Winstral's
Sx as a third term:

```
W = (1 + γs·Ωs + γc·Ωc) · (1 − γx·Ωx)          θ = θmodel − 0.5·Ωs·sin(2(ξ − θmodel))
```

| Term | What it is |
| --- | --- |
| `Ωs` | The slope in the wind's own direction, `slope·cos(θ − aspect)`, scaled by the steepest slope in the domain into ±0.5. Uphill into the wind speeds up, the lee slows down |
| `Ωc` | Curvature at a **length scale**, not at the pixel, scaled the same way. Convex ground speeds up |
| `Ωx` | Sx for the wind's bearing, blended between sectors, scaled by the largest in the domain. Optional, and off unless the domain was derived with shelter |
| `ξ` | The aspect: the diverting term turns the wind towards the fall line across a slope, and does nothing at all straight up it |

γs = γc = 0.5 are the paper's, which is what bounds `W` in [0.5, 1.5].

**Curvature is measured over hundreds of metres, not over one pixel.** MicroMet's
curvature is the height above the mean of four opposing pairs of points at a distance of
roughly half a terrain wavelength — 500 m by default here, as in SnowModel. A 3 × 3
curvature on a 1 m DEM measures the boulders: on the test ridge it changes sign between
neighbouring pixels while the 500 m one is smoothly positive along the crest. Using the
pixel-scale field is the easiest way to ship a wind that is noisy at a scale nobody can
feel, so `terrainWeights` computes its own rather than reusing `derive.curvature` — and
the pixels within half a length scale of the edge are `NaN`, because the rose does not
fit. Read the window with that much padding.

Graded against `tools/micromet-reference.py`, an independent Numpy implementation written
from the paper: four domains, every pixel of the curvature, the factor and the diverted
bearing, to 2e-6 on the factor and 2e-4° on the bearing. Flipping the sign of the
diverting term fails it on all four.

Two rules it keeps that the arithmetic would happily break:

- **Speed and bearing are never interpolated.** `windAt` interpolates east and north and
  derives the rest, because averaging 350° and 10° gives 180° — the same trap
  `aspectAt` exists for.
- **A wind is `{ speedMps, fromDeg }` or `{ east, north }`, and `fromDeg` is where it
  comes *from*.** Both are accepted, one is refused: `{ speedMps: 8 }` on its own is not
  a wind, and a negative speed is a bearing error wearing a minus sign.

`terrainOffset(weights, modelElevationM)` reports how far the model's smoothed terrain
sits from the real ground — over a mountain domain that is easily 100 m, and it is
*reported and not applied*, because correcting a wind for it needs a vertical profile
this layer does not have. `heightFactor` is the log law and is there for the caller who
knows their roughness; both are honest arithmetic, neither is a calibrated correction.

**What this is not.** It is an empirical weighting, not a momentum solver: no
conservation of mass, no separation, no recirculation in the lee, no thermally driven
slope flow. It cannot tell you about a rotor behind a ridge, and on a domain with
significant terrain it should be read as a considerably better first guess than the
3 km model wind rather than as a measured field. A momentum solver (WindNinja's, and its
GPL-3 question) sits above this, not instead of it.

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

A second live pull, over a 0.2° box west of Boulder, is what `grib2.js` was written
against and is committed as `tests/fixtures/hrrr-20260826t20z-f00-boulder.grib2`:

| | Result |
| --- | --- |
| Response | **1,883 bytes**, 8 messages, magic `GRIB` |
| Grid | 6 × 7 points, 3 km spacing, Lambert conformal tangent at 38.5° (template 3.30) |
| Packing | simple, 6–16 bits per value (template 5.0) — **not** JPEG2000 |
| Wind components | relative to the grid, not to true north |

**Simple packing is the load-bearing finding.** JPEG2000 would have meant a native
dependency on the droplet; simple packing is a bit reader and a scale factor, which is
why decoding landed in one module with no build step.

Two things fall out of the sizing, and they point in opposite directions.

**The atmosphere is nearly free.** Two kilobytes for the wind over a 16-mile box. Pulling
a whole forecast run, or a decade of archived cycles for the climatology mode, is
cheap. Subsetting through NOMADS is doing exactly what it should.

**The terrain is not.** Three gigabytes for one coordinate. The droplet's 120 GB disk
holds forty of them, and that is before anyone else asks for a different mountain.

That figure is the cost of *whole-tile* fetching, and it does not have to be paid. Both
DEM products are Cloud Optimized GeoTIFFs, measured by reading the TIFF headers over
range requests — 30 tiles, six states, both datasets (`node tools/cog-survey.js`):

| | 1 m — 22 tiles | 1/3 arc-second — 8 tiles |
| --- | --- | --- |
| Directory in the first 4 KB | 22/22 | 8/8 |
| Internally tiled | 22/22 | 8/8 |
| Internal tile | 512 × 512 (20), **256 × 256 (2)** | 512 × 512 |
| Predictor | 3 (20), **1 (2)** | 3 |
| Overviews | 5 levels | 5 levels |
| Range requests | 206 | 206 |

So the window a domain needs is one round trip: the directory is in the first kilobyte,
it says where the tiles are, and only those tiles are fetched. The overviews mean a
zoomed-out preview is cheaper still. **Mirroring CONUS is therefore optional** — do it
for resilience if USGS availability becomes a problem, not for speed.

**The two odd tiles are the point of the table.** The 3DEP catalogue is thousands of
separate lidar projects converted at different times, and the physical shape of a file
is a property of its conversion, not of the product: the two 2013 tiles over Boulder are
256 to a block with no floating-point predictor, next to 2023 tiles over the same ground
that are 512 and predictor 3. Both are windowable and both are read here; a reader that
hard-codes either shape reads the other as noise. A directory at the *end* of a 400 MB
file is legal too — none of these 30 had one, but it costs one extra range request to
find and `cog.js` handles it, because a reader that assumes otherwise fetches a whole
tile without saying so.

The design document's other argument stands regardless: 1 m terrain does not imply a
1 m computational mesh. Keep the source for display, resample to 10–20 m for the solve.

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
rather than building a URL that will do that, and `nomads.fetchGrib` refuses the page
itself, quoting the filter's complaint.

**And a bad subregion is worse than an error page: it is 20 MB of valid GRIB.** A box
that misses the grid returns the entire CONUS field under HTTP 200. It decodes, it is
internally consistent, and nothing about it says it is the wrong place — only a byte
ceiling and a bounds check separate it from a legitimate answer.

**HRRR wind components are relative to the grid, not to north.** Flag table 3.3 bit 5 is
set in every HRRR message, so `UGRD` is along the grid's x axis and not eastward. Using
them as earth-relative rotates the wind by the grid convergence — about 5° near Boulder,
up to 14° at the western edge of CONUS — and every value still looks like a plausible
wind. `grib2.toEarthRelativeWind` does the rotation; `grid.windComponentsRelativeToGrid`
says when it is needed.

**HRRR cycle availability is an assumption.** `DEFAULT_AVAILABILITY_LAG_MINUTES` is 75,
chosen conservatively and not measured from this codebase. It worked on the live test
above. If discovery starts returning error pages, raise it first.

**A listed tile can hold no ground at all.** Over the Boulder box above, TNM lists two
1 m tiles and the *newer* one — a 2023 project — is nodata across the whole domain,
181,872 pixels out of 181,872; the 2013 project underneath it carries the terrain. So
"newest per footprint" is the right rule for avoiding superseded data and the wrong rule
for picking what to read. `readTerrain` returns every intersecting tile, sorted least
void first, with `voidFraction` on each grid and `allVoid` on the result.

**A nodata sentinel is decimal text, and may not name the pixel it stands for.** The
2013 3DEP conversions write `GDAL_NODATA` as `-3.4028234e+38` for a pixel that is really
−3.4028234663852886 × 10³⁸. Compared as written, the two are different numbers, so every
void in those files reads as ground 3.4 × 10³⁸ metres deep — a value that survives
averaging, slope and every later stage as a finite float. `cog.js` brings the sentinel
into float32 before comparing, which is where the file's own arithmetic lives.

**Coverage is sampled, not exact.** `geo.coverageFraction` grids the box and counts hits
rather than computing a union of rectangles, so an uncovered strip thinner than the
sample spacing can be missed. It is fine for "is this good enough or fall back", and it
is not a number to show a user.

**Domain limits.** HRRR CONUS only here. Alaska has a separate filter script and a
separate domain; Hawaii and the territories have neither and need a different model.

## Not built yet

The field itself. Terrain and atmosphere can both be fetched, decoded, sampled and — for
terrain — reduced to the geometry a downscaling model needs, but nothing joins them: no
`windProfile` is produced. Next, in this order, are terrain-aware downscaling of the
volume onto those derivatives, and then the slice along an azimuth that BallisticVector
already consumes. Both inherit the cache keys that are now settled.

**What a caller can rely on today** is `profile.js` — the contract, its validation and
its sampling — plus `grib2.js`, `nomads.js`, `volume.js`, `cache.js`, `proj.js`,
`cog.js`, `terrain.js`, `derive.js`, and the request builders in `geo.js`, `dem.js` and `hrrr.js`. `profile.js` is what BallisticVector
installs and runs in production; it is not a preview. What none of it does yet is
*produce* a `windProfile`, so a caller still has to bring its own and have it validated,
which is exactly what BV does with a browser-built wind call.

The volume layer is exercised against live NOMADS and against the committed fixture, but
its sampling has **not** been graded against an independent interpolator the way the
decoder was graded against ecCodes, and no vertical level above 80 m has been fetched.

The terrain reader is graded against GDAL, but only on what it has been shown: LZW and
Deflate with the floating-point predictor, float32, one geographic and one projected CRS,
both over Colorado. BigTIFF, tiles in other UTM zones, Alaska's projections and any
compression 3DEP has not used here are refused by name rather than handled, and the
`no-range-support` and `header-scattered` refusals are proved by fixtures rather than by
a server that has actually done either.

The derivatives are graded against `gdaldem` for the five measures GDAL computes, and
against analytic surfaces for the three curvatures, which no GDAL tool produces —
so curvature is checked against theory rather than against a second implementation.
**Sheltering now has one:** with the search run out to the edge of the domain, Sx is the
horizon angle, and every interior pixel of a synthetic bowl-and-wall agrees with
topocalc's to 1e-4°, on all four cardinal bearings. The diagonals do not, and are not
claimed: topocalc reaches them by skewing and resampling the raster, so a comparison
there measures one interpolation against another rather than the two formulas. The
comparison also only holds on the central meridian — see the note on convergence below.

The downscaling is graded factor by factor and bearing by bearing against an independent
Numpy implementation of Liston & Elder, over four synthetic domains. What that grades is
the arithmetic, not the physics: **no part of it has been compared with a measured wind**,
the weights are the paper's defaults rather than anything fitted to this terrain, and no
real 3DEP domain has been run through it end to end. Nothing consumes any of it yet.

**On the version number:** `1.0.0` is the version of the *published contract*, and it is
deliberately not a claim that the product is finished. A `0.x` package would imply the
payload may be reshaped without warning, which is the opposite of the promise being made
— the whole reason the consumer pins a tag is that this shape is stable. The ingestion
pipeline is unbuilt, and building it should add modules and tags, not change what a
valid `windProfile` is. If it ever has to, that is a `2.0.0` and a consumer PR.
