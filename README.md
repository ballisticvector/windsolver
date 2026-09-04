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
- [Ingestion](#ingestion) · [The network client](#the-network-client) · [The volume and its cache](#the-volume-and-its-cache) · [Terrain, read as windows](#terrain-read-as-windows) · [Terrain derivatives](#terrain-derivatives) · [Downscaling: the model wind over the ground](#downscaling-the-model-wind-over-the-ground) · [The whole chain: `field.js`](#the-whole-chain-fieldjs) · [The line a consumer cuts: `slice.js`](#the-line-a-consumer-cuts-slicejs)
- [The HTTP service](#the-http-service) · [Routes](#routes) · [What every answer carries](#what-every-answer-carries) · [What it refuses, and with which status](#what-it-refuses-and-with-which-status) · [Running it](#running-it)
- [Measured, not assumed](#measured-not-assumed) · [The whole chain, live over Boulder](#the-whole-chain-live-over-boulder) · [A line through it, live](#a-line-through-it-live)
- [Against a measured wind](#against-a-measured-wind)
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
| `field.js` | The whole chain in one call: a coordinate in, terrain read, derived and cached, live HRRR fetched and cached, an east/north field over the domain out |
| `slice.js` | The view a consumer cuts out of a field: a WGS84 geodesic from a point and a bearing, the wind resolved onto it, stacked over a set of heights, and serialised as a `windProfile`. Pure arithmetic, no network |
| `observations.js` | Station observations from `api.weather.gov`, parsed strictly: known units only, QC-validated only, station coordinates rather than the observation's rounded ones |
| `verify.js` | Pairs an observation with a model time and scores the difference — circular direction arithmetic, vector error, and the quantisation floor of the instrument. Pure arithmetic, no network |
| `profile.js` | The `windProfile` contract: what a field looks like leaving here, and every check it has to pass |
| `server.js` | The HTTP boundary: the general field over a box, the line view for a caller that has a bearing, and the limits that keep a slow upstream from becoming a hung socket |

## Using it

Consumers pin a tag rather than tracking a branch, so a change to the contract cannot
reach a caller on a Tuesday:

```json
"dependencies": {
  "@ballisticvector/windsolver":
    "https://github.com/ballisticvector/windsolver/archive/refs/tags/v1.1.0.tar.gz"
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

**`tpi` is a 3 × 3 answer, and a landform is not 3 × 3.** The topographic position
index in the table above compares a pixel with its eight neighbours, which at 10–30 m
resolution asks "is this bump higher than the ground it is sitting on" — a question about
boulders and gullies. Asked of a station on a named ridge it returns tenths of a metre,
because 30 m either side of a ridge crest is still the crest. `positionIndexAt` asks the
same question at the scale the wind cares about:

```js
derive.positionIndexAt(d, 39.4058, -105.7561, { radiusM: 500 });
// { tpiM: 40.5, radiusM: 500, samples: …, coverage: 1 }   Kenosha Pass RAWS
```

It is the station's elevation less the mean elevation of a disc around it, and the
**radius is part of the answer** because the number means nothing without it: Kenosha
Pass reads +40.5 m over 500 m and +0.28 m over 3 × 3, and both are correct descriptions
of different things. A disc that runs off the domain returns `null` rather than the mean
of the half that fits — a half-disc on the downhill side is a ridge whatever the ground
does — and so does one whose valid pixels fall below `minCoverage` (0.9) of it.

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

### The whole chain: `field.js`

Everything above is a stage; `field.js` is the pipe. A coordinate goes in, and a wind
over the real ground comes out.

```js
const { createFieldService } = require("@ballisticvector/windsolver/field");

const service = createFieldService();
const f = await service.get({ lat: 40.015, lon: -105.2705, radiusMiles: 1 });

f.speedMps; f.east; f.north;         // Float32Array over the domain, earth-relative
f.reference;                         // the model wind it started from
f.terrain; f.offset; f.validTime;    // what ground, how far off the model's, and when
```

**The domain read is larger than the domain asked for**, because a pixel's derivatives
are a function of the ground around it: half a curvature length and the whole shelter
search are undefined that far in from the edge. `domainOf` pads by the larger of the
two plus a pixel, so the box the caller asked for comes back filled rather than with a
ragged undefined border exactly where they were looking.

**The atmospheric request is padded too, and for a different reason.** A two-mile box is
1.07 HRRR cells across, and the NOMADS filter can answer it with a single column of
cells — which has no 2 × 2 to interpolate the centre in. The request is widened by one
cell each way; the *domain* is not.

**Two caches, and only one of them expires.** The prepared ground — grid, derivatives,
weights — is keyed on the ground alone and stands until USGS reflies it. The atmosphere
is keyed on `(source, snapped box, level set, variables, valid time)`. The hourly
update is the arithmetic in between.

**A hole in the finest product falls back to the next one down.** TNM reports 1 m as
covering Boulder in full and both 1 m projects are nodata over the north of a two-mile
box, because coverage is computed from tile footprints and a void is a property of the
pixels. Any hole at all is worth one read of the coarser product: a hole costs more than
itself, since every derivative within a curvature arm of it is undefined too. What was
filled and from which product is reported rather than blended away — over Boulder, a
third of the "1 m" domain is really 10 m ground.

### The line a consumer cuts: `slice.js`

`field.js` answers over a box, which is the shape a map, a fire crew and a sailor all
want. A consumer travelling along a line — a leg, a route, a shot — wants that box cut
down to the line. `slice.js` is that cut, and it is a **view**: it takes a field that has
already been solved and does no fetching and no second solve.

```js
const slice = require("@ballisticvector/windsolver/slice");

const from = { lat: 40.015, lon: -105.2705 };
const f = await service.get({ box: slice.boxFor(from, 90, 914.4) });

const cut = slice.plane(f, {
  from: from, bearingDeg: 90, lengthM: 914.4, stepM: 91.44,
  heightsAglM: [0.6, 1.5, 3, 6, 15]
});

cut.stations;                    // where each one is, its ground, and the wind there
cut.alongMps; cut.crossMps;      // [height][distance], m/s, velocity of the air
slice.toWindProfile(cut, { source: "WindSolver HRRR + 3DEP 10 m" });
```

**`along` is positive in the direction of travel, `cross` is positive to the right of
it, `up` is positive up, and all three are the velocity of the air** — not the direction
it comes from. A wind out of the south crossing an eastward line blows toward the
traveller's left, so it is negative cross. That is the convention the contract's shooter
frame already uses, which is why `toWindProfile` is a rename and a unit conversion rather
than a rotation.

**The line is a geodesic, and its bearing is not constant.** Walk 1,000 yards east from
Boulder and the line's own direction at the far end is 90.007°, because a geodesic is
straight on the ellipsoid and curved on the graticule. Every station resolves the wind
onto the direction of the line *there*, and `convergenceDeg` reports the difference; at a
mile it is under a hundredth of a degree, and over a sailing leg it is not.

**`destination` is graded against PROJ, not against its own arithmetic** — 270 cases from
`tools/geodesic-reference.py` (`pyproj.Geod(ellps="WGS84").fwd`), five origins including
Sydney, Svalbard and a point half a minute from the antimeridian, nine bearings and six
distances from 1 m to 100 km. The worst disagreement is under a micrometre on the ground
and 1e-9° on the bearing.

**A line that leaves the field is refused, not clamped.** Holding the edge value returns
a plausible wind for ground the field never covered, which is the same shape of failure
as a nodata sentinel that decodes to a number. `outside-domain` names the distance and
the coordinate where it ran out. `boxFor` exists so a caller does not have to guess a
radius that happens to contain the line: it is the corridor the line needs, and
`field.js` adds the derivative margin on top of it.

**Heights are the neutral log law and nothing else.** `plane` scales the field's own
height to each requested height with `downscale.heightFactor` and reports the factors it
used. It does **not** turn the wind with height — no Ekman veer, no stability — and `w`
is explicitly zero, because the downscaling model has no vertical velocity term to give
it. A profile that quietly invented one would look exactly like a measured one.

**`toWindProfile` will not invent provenance.** `source` is required; `confidence` and
the two resolutions are `null` unless the caller supplies them, rather than defaulting to
something that reads as a claim. The azimuth it writes is the line's own, so a consumer
cannot produce an `azimuth-mismatch` by accident.

## The HTTP service

`server.js` is the boundary a consumer calls. It is a plain `http.Server` over
`field.js` and `slice.js` — no framework, no new dependency — so it is deployed like any
other node process and started with `npm run serve`.

### Routes

| Route | What it answers |
| --- | --- |
| `GET /healthz` | Liveness, the routes it serves, and how many solves are in flight or queued. Touches no engine |
| `GET /v1/field` | **The general one.** `lat`, `lon`, `radiusMiles`, and an east/north wind over a lat/long grid of the box. No bearing anywhere in it |
| `GET /v1/line` | The derived view for a caller that has one: `bearingDeg` and `lengthM`, the wind resolved along and across a WGS84 geodesic, optionally stacked over `heightsM` |
| `GET /v1/windprofile` | The same cut, serialised as a v1 `windProfile` and validated by `profile.js` before it is sent |

**`/v1/field` is the endpoint the other two are views of, and the reason it comes first.**
A sailor and a fire crew have no bearing to give, and an azimuth in the general route
would put one in the cache key — the mistake `cache.js` was designed to avoid. `/v1/line`
and `/v1/windprofile` take a bearing, solve the same cached field, and cut it on the way
out; a second bearing over the same ground is a millisecond, not a second solve.

The field answers on a **regular lat/long grid**, because a consumer should not have to
carry a UTM implementation to read a wind. The native projected grid is described
alongside it — CRS, EPSG, shape and spacing — so a caller that does have one can tell how
much resampling stands between it and the solve.

### What every answer carries

`validTime`, the source line, the reference wind and its `resolutionM`, the terrain
dataset and how much of it was void, and the model-versus-terrain elevation offset. Plus,
on every route:

```json
"modelled": true,
"notice": "Modelled, not measured: HRRR downscaled onto 3DEP terrain. ..."
```

That is not decoration. Nothing here has been compared with a measured wind, and a
modelled field presented as a measured one is the worst thing either product can ship —
so the disclaimer travels in the payload, where a UI cannot forget to fetch it.

**A cell the field does not cover is `null`.** `NaN` and `Infinity` are not JSON, and
`JSON.stringify` writes them as the bare token `NaN`, which is a body a strict parser
rejects and a lenient one reads as something else. They are converted on the way out.

### What it refuses, and with which status

| Status | When |
| --- | --- |
| `400` | The caller's mistake, named: a missing coordinate, a bearing off the compass, heights out of order, a line that leaves the domain |
| `413` | A grid larger than the output ceiling, with the size that would fit |
| `502` | An upstream that answered with something other than the field — no terrain, not GRIB, the HTML error page, the whole-continent subregion |
| `503` | No HRRR cycle available, or the queue is full — with a `Retry-After` |
| `504` | A solve slower than the timeout |
| `500` | Anything unrecognised, with nothing of the internals in it |

**Bounded before it is exposed, because the upstream is not.** A cold solve is seconds
and NOMADS has been measured at 53 s on a bad minute, so the service runs at most
`maxConcurrent` solves (2), queues `maxQueue` more (8), and gives up on a solve after
`timeoutMs` (45 s) rather than holding a socket open. The gate is verified by measuring
peak concurrency, not by asserting the option was read: at 2 the observed peak is 2, at 6
it is 6.

A timeout abandons the *wait*, not the work — an in-flight fetch runs to completion and
warms the cache, so the retry after a 504 is usually the fast one.

### Running it

```bash
npm run serve -- --port 8787 --origins https://windsolver.com
```

`PORT`, `HOST`, `WINDSOLVER_ORIGINS`, `WINDSOLVER_TIMEOUT_MS`, `WINDSOLVER_MAX_CONCURRENT`
and `WINDSOLVER_MAX_QUEUE` do the same. It binds `127.0.0.1` by default, so it is behind a
reverse proxy unless someone deliberately says otherwise, and logs one JSON object per
line.

### Keeping named places warm

```bash
npm run serve -- --prewarm "40.0150,-105.2705;36.77,-104.49,2"
```

`WINDSOLVER_PREWARM` does the same: semicolon-separated `lat,lon[,radiusMiles]`. After it
starts listening the service sends itself the `/v1/field` request a browser would send,
one place at a time so a visitor never queues behind the warming, and repeats every 30
minutes — a new HRRR cycle gives every cached field a new valid time, so a place warmed
once is cold again within the hour. A place that times out is retried in a minute rather
than in half an hour, because the solve is still running and lands in the cache.

**It does not make a cold solve faster**; it moves who waits for one, and only for the
places named. `docs/deploy.md` covers what windsolver.com runs.

### The product listing is kept on disk

The slow part of a cold solve is not the terrain. Reading a window out of a 449 MB COG
is 5 requests and 1.29 MB; asking `tnmaccess.nationalmap.gov/api/v1/products` *which*
tiles cover the box was measured at **29 s**, and at 504 in the same minute, for an
answer that changes when a project is re-flown — monthly at best.

`listing.js` keeps successful listing responses in `~/.cache/windsolver/tnm`
(`WINDSOLVER_CACHE_DIR` moves it), keyed on the request URL, for 14 days. Three
properties are the whole point:

- **A failure is never cached.** A 503 from TNM must not become two weeks of "there is
  no terrain here", which is the one way a cache can turn an outage into a wrong answer.
- **A cache that cannot be read or written is a miss, not an error.** Corrupt JSON, a
  half-written file, an unwritable directory and a clock that has gone backwards all
  fall through to the network.
- **Two requests for the same URL in flight at once make one call**, so the first two
  visitors to new ground do not both pay for it.

The listing query is also **snapped outward onto a 0.05° grid** (~5.5 km), so pins a
few hundred metres apart ask the same question and share the answer. Coverage is still
measured against the domain that was actually asked for, never against the snapped box.

`listingCache: false` bypasses it for a caller that needs what TNM says right now.

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

**A fourth conversion is not in the table at all**, which is the other half of the same
point: CO_SanLuisJuanMiguel_2020_D20 writes float32 with *horizontal* differencing,
predictor 2, and none of the 30 sampled tiles did. Horizontal differencing is a byte-wise
operation on 8-bit imagery and a whole-sample one on anything wider — libtiff accumulates
a 32-bit sample as an unsigned integer regardless of the sample format, wrapping at 2^32
rather than adding as floats — so a reader that treats it as bytes decodes 8-bit files
correctly and turns every float raster into noise. Sampling 30 files says what is common,
not what exists.

The design document's other argument stands regardless: 1 m terrain does not imply a
1 m computational mesh. Keep the source for display, resample to 10–20 m for the solve.

### The whole chain, live over Boulder

`node tools/field-live.js --lat 40.0150 --lon -105.2705 --radius 1` — a 2-mile domain,
real 3DEP, a live NOMADS pull and the downscaling, run at two resolutions:

| | 10 m | 1 m |
| --- | --- | --- |
| Terrain read | 475 × 472, **4.11 MB in 15 requests** | 3746 × 3730, **34.05 MB in 35 requests** |
| Void after fallback | 0.12% | 0.00% |
| Filled from the 10 m product | **35.3%** | **35.3%** |
| Elevation | 1601–1854 m, mean 1641 | 1600–1831 m, mean 1640 |
| Model ground vs real | 1670 m, −70 to +183 m | 1670 m, −70 to +161 m |
| Model wind | 7.93 mph, east −3.54 north 0.21 m/s, **1.07 cells across the box** | same |
| Downscaled | 6.05–9.79 mph, mean 7.92; factor 0.763–1.234 | 5.40–10.16 mph, mean 7.91; factor 0.681–1.281 |
| Undefined inside the box | **0.0%** | **0.0%** |
| Cold / warm | 3.4 s / **15 ms** | 22 s / **22 s** |

**The warm number is the whole argument for the split**, and at 1 m it disappears: a
3746 × 3730 prepared domain is larger than the terrain cache's entire 512 MB budget, so
it is refused rather than evicting everything else, and every request re-reads and
re-derives the ground. 10 m over the same box is 4 MB on the wire and answers in 15 ms.
Ten metres is the solve resolution; one metre is for display.

**A third of that "1 m" domain is 10 m ground**, filled in from the seamless product
where both Boulder lidar projects are nodata. It is reported as `coarserDataset` and
`filledFromCoarser` rather than blended away, for the same reason the chosen dataset has
to reach the UI: a screen that says 1 m everywhere is lying wherever the lidar is a hole.

**Still not verified:** none of these numbers has been compared with a measured wind. The
reference wind is one HRRR sample at the domain centre, which is defensible at 1.07 cells
across and is not for a map-sized domain.

### A line through it, live

`node tools/slice-live.js --lat 40.0150 --lon -105.2705 --bearing 90 --range 1000` — a
live field over the corridor `boxFor` asked for, and a 1,000-yard line cut out of it at
five heights:

```
valid          2026-09-03T21:00:00.000Z, field 209 x 94 at 8.00 x 8.00 m of 1m
model wind     8.11 mph, 0.37 HRRR cells across the box
convergence    0.0069° between the start of the line and its far end
contract       valid v1 windProfile

  yards   ground   wind        from   along    cross   (at 10 ft)
      0     1621    6.02 mph     94°    -6.00    -0.44
    500     1616    5.84 mph     94°    -5.82    -0.45
   1000     1612    5.77 mph     94°    -5.75    -0.44

timing         1504 ms for the field, 1 ms to cut the line
```

**One millisecond to cut the line**, against 1.5 seconds to solve the field it came out
of — which is the whole reason the slice is a view and not a solve. A second bearing over
the same ground is free.

The signs are the ones the diagram promises: a wind *from* 94° is a headwind on a 90°
line, so `along` is negative, and turning the line to 180° over the same field moves the
same air to **+6.5 mph of `cross`**, because west is now the traveller's right.

**The terrain is doing visible work.** On that southward line the ground climbs from
1621 m to 1648 m and the 10 ft cross-wind runs 7.5 to 11.0 fps along it — a spread of
nearly half, which the 3 km model wind has no way to express.

A line-shaped box is a fraction of an HRRR cell across, so every point starts from the
same model wind and all the variation along the line is terrain. The height stack is the
log law over that, with no veer, and is still compared with nothing.

## Against a measured wind

Everything above grades the arithmetic against another implementation of the same
arithmetic. `tools/score-wind.js` does the other thing: it takes the wind that stations
actually recorded and asks how far the model was from it, for the HRRR wind and for the
downscaled wind separately, so the downscaling is graded against the thing it claims to
improve rather than against nothing.

```bash
node tools/score-wind.js --stations KBDU,KBJC,KEGE,KASE,KLXV --hours 24 \
  --radius 0.5 --resolution 30 --out score.json
```

**The observations are METARs from `api.weather.gov`** — the ASOS/AWOS network, one
station per airport. `observations.js` reads them, converts km/h, knots and m/s and
refuses any other unit rather than guessing, drops anything the QC field does not call
validated, and takes the coordinate from the *station* endpoint because the observation's
own geometry is rounded to four decimals. A calm observation keeps `fromDeg: null`: 0°
means north, and a calm wind that scores as northerly is a direction error invented by
the parser.

**Pairing is nearest-in-time within ten minutes, and nothing is interpolated.** An
interpolated observation is a modelled observation, which is the one thing that must not
appear on the measured side of a comparison. Observations with no hour inside the window
are reported as `unmatched`, not dropped.

Live over the Colorado mountains, 24 hours to 2026-09-04T12Z, five stations from 1,612 m
to 3,026 m, 30 m terrain over a half-mile box each:

```
candidate        obs   hrs  spd bias  spd rmse  dir bias  dir rmse  vec rmse
HRRR alone       423   107      0.24      1.61      -9.2      62.2      2.93
downscaled       423   107      0.29      1.65      -9.2      62.1      2.96
```

**The downscaling did not help.** It is 0.03 m/s worse in speed RMSE and 0.02 m/s worse
as a vector, which is inside the noise of 107 station-hours but is certainly not the
improvement the module exists to make. That is the finding, and it is written here rather
than in a backlog because the whole point of building this tool was to be told something
unwelcome.

Two reasons it is not yet an indictment of the downscaling, both about *where* the
stations are:

| Station | | Terrain class under it |
| --- | --- | --- |
| KBDU | Boulder Municipal, 1,612 m | flat |
| KBJC | Broomfield/Jeffco, 1,692 m | slope |
| KEGE | Eagle County Regional, 1,993 m | flat |
| KASE | Aspen-Pitkin County, 2,339 m | flat |
| KLXV | Leadville, 3,026 m | flat |

**Airports are built on the flat bit.** Aspen sits in a canyon and scores as `flat`,
because the class describes the ground within the domain around the station and that
ground is a runway. Four of the five stations are therefore the case where terrain
correction should do least, and the one slope station — 12 observations — is the only row
where the downscaled wind is clearly better: 20.1° direction RMSE against 62.8° on the
flat stations, and 1.59 m/s vector RMSE against 2.98. Twelve samples proves nothing. It
is the only place the hypothesis is even being tested.

**`obs` and `hrs` are both printed because they are not the same evidence.** A station
reporting every twenty minutes pairs several observations to one hourly field, so 423
observations are 107 station-hours; quoting the larger number as the sample size claims
independence the data does not have.

**The floor is quoted with the error.** METAR speed is whole knots and direction whole
tens of degrees, so a model that were exactly right would still score 0.15 m/s and 2.9°
against it. An error is meaningless without the resolution of the ruler.

**And the independence caveat is printed above every table**, because it is the one that
would make these numbers a lie by omission: NCEP *assimilates* surface observations into
the HRRR analysis, so the `f0` field has already seen these stations. The `HRRR alone`
row is therefore not a forecast skill score — it is closer to an analysis fit. The
downscaling has not seen them, which is why the *difference* between the two rows is the
honest part of the table. `--forecast 6` scores an f06 forecast instead, which has not
seen the observations at its own valid hour; `cache.js` keys on the lead time so an
analysis and a forecast valid at the same moment cannot share a cache entry.

**What this does not yet support:** a `confidence` number. Five stations, one day, four
of them flat, and 95 of the 423 observations calm and so carrying no direction at all. It
is a harness with a first result, not a calibration.

### RAWS, because airports are the wrong ground

The table above is a statement about airports, not about downscaling, so `synoptic.js`
adds the stations that are not on airports: RAWS and the rest of Synoptic Data's mesonet,
which are fire-weather and land-management towers put deliberately on ridges, in gulches
and at passes.

```bash
export SYNOPTIC_API_TOKEN=…      # customer.synopticdata.com, free; never committed
node tools/score-wind.js --source synoptic --hours 24 --forecast 6 \
  --stations CPTC2,KSHC2,LPRC2,PKLC2,BMOC2 --out raws.json
```

It emits the same normalised observation as `observations.js` — `speedMps`, `fromDeg`,
`calm`, `gustMps`, a `quality` block — so nothing in the scoring knows which network an
observation came from. What is specific to Synoptic stays in the provider:

- **the token never reaches an error message.** `redactToken` rewrites it out of every
  URL before the URL is quoted in a `fail`, because the natural way to write "this
  request was refused: <url>" publishes the credential to the logs;
- **`RESPONSE_CODE` is checked, not the HTTP status.** An unknown station is a 200 with
  `RESPONSE_CODE: 2` and no `STATION` array, and asking for history the account is not
  entitled to is a 200 with `RESPONSE_CODE: 403`. Both are fixtures;
- **units are read from the response and refused if they are not the ones expected**,
  rather than assumed. Station elevation is declared in feet and converted at 0.3048;
- **`ELEV_DEM` is discarded.** Synoptic publishes its own DEM elevation for each station,
  and using it would make the elevation check a comparison of Synoptic against Synoptic;
  the check is against the 3DEP ground this service read for itself;
- **QC flags are honoured per variable per timestamp**, since a flagged direction does
  not invalidate the speed beside it.

**RWIS is not RAWS, and the difference decided this.** Iowa State serves Colorado DOT's
170 road-weather stations with no key at all, and they sit on exactly the passes worth
scoring — but their direction is quantised to eight compass points, a 13° error floor
before the model is wrong about anything, and several publish coordinates that do not
match their names. Synoptic's directions are whole degrees; the fixture test asserts that
some are not multiples of 45, which is the property RWIS lacks and the reason for the
token. Speeds are still whole miles per hour — 0.44704 m/s — and that is the floor
printed above every table.

**A RAWS anemometer is 6.1 m up; HRRR's surface wind is at 10 m.** 20 ft is the NFDRS
standard height for a fire-weather station, so this is not an occasional mismatch — it
is every RAWS in the network, and it is one-directional: the model is quoted at a level
where the wind is faster than the level the station measured. Over short grass the
neutral log law puts 8.5% between the two: on the 15-station f06 run below that is
0.37 m/s of a 1.62 m/s speed bias — about a quarter of it — removed by measuring the
same air at the same height rather than by changing the model at all. `metadataUrl`
therefore asks for `sensorvars=1` and the
station carries `sensorHeightM`, and `tools/score-wind.js` moves the model wind to the
station's height with `downscale.heightFactor` before scoring it. Three deliberate
limits on that correction:

- **speed only.** A log law is a statement about the magnitude of a neutral profile and
  says nothing about the veering between 6 m and 10 m, so the direction is scored
  unmoved and the report says so;
- **the model moves, not the observation**, because the observation is the thing being
  treated as true;
- **a station that publishes no height is scored unmoved and named as such.** An ASOS is
  at 10 m by federal standard and would need no correction anyway, but `observations.js`
  reports `sensorHeightM: null` rather than 10, because a default is indistinguishable
  from a measurement and this whole correction exists because a default was invisible.
  `--no-height` turns the correction off, and `--roughness` is the z0 it assumes.

**Every station is checked against the ground under its own published coordinate**
before it is scored, and dropped by name if the two disagree by more than 50 m. A station
whose coordinate is wrong is not a bad sample; it is a sample of somewhere else, and it
would carry the wrong terrain class into the table it is there to explain.

**Putting real ridges in front of the classifier is what showed the classifier was wrong.**
`verify.classifyTerrain` used to split on the 3 × 3 `tpi`, and the first RAWS run called
Kenosha Pass, Carpenter Ridge and Pickle Gulch `flat` or `slope` — the same failure as
Aspen scoring flat, in a place where the ground is unarguable. It now splits on
`positionIndexAt`'s 500 m index: ±15 m separates `ridge` and `valley`, and 5° of slope
separates `slope` from `flat` below that. Both numbers are printed in the report's
`domain` block and on the summary's terrain heading, because a class is only comparable
with another class measured at the same radius. The 3 × 3 `tpi` is still carried per
station, next to the 500 m figure, so the difference between the two scales stays visible
rather than being a thing you have to know.

Neither threshold is a physical constant. ±15 m at 500 m is a convention chosen to put
named ridges and gulches on the right side of the line; the honest version is a
standard deviation over the domain, and that is a change to make once there are enough
stations to fit one.

### What 15 RAWS stations said

24 hours, f06, 15 Colorado RAWS, 30-minute pairing window, model wind moved to each
station's 6.1 m anemometer:

```text
candidate        obs   hrs  spd bias  spd rmse  dir bias  dir rmse  vec rmse
HRRR alone       360   360      1.25      2.30       7.9      60.4      3.25
downscaled       360   360      1.57      2.55       8.2      60.7      3.50

ridge hrrr       264   264      1.20      2.27       4.1      57.0      3.14
ridge down       264   264      1.58      2.57       4.4      57.3      3.46
slope hrrr        48    48      2.60      3.02      43.6      61.0      4.02
slope down        48    48      2.68      3.15      43.9      61.2      4.11
flat hrrr         48    48      0.23      1.54       5.6      75.4      2.94
flat down         48    48      0.40      1.63       5.7      75.6      3.04
```

**The downscaling is worse than the model it starts from on every stratum here**, which
is the opposite of the result the airport run was supposed to be hiding. Read it as a
finding to chase rather than a verdict: 15 stations in one state over one day, the
observations within a station are correlated, there is no `valley` stratum at all
because none of these 15 sit in one, and the remaining +1.25 m/s says the model is still
being quoted faster than the ground measures — some of which is siting, since a RAWS
tower stands in brush and its own roughness is not the 0.03 m the correction assumes.
The direction bias of 43.6° on the `slope` pair is two stations, not a property of
slopes.

What it does establish is that the harness now scores the terrain the downscaling is
about, at the height the wind was measured, with the pieces that were previously
confounded — landform scale, sensor height, pairing window — each visible in the report
rather than baked into the number.

### The downscaling does not yet earn its place

Scored that way, term by term and split by landform, **the terrain correction is no
better than raw HRRR overall and clearly worse on ridges.** `docs/downscaling.md` is the
working note: every measurement taken so far, what each one does and does not license
anyone to say, and the runs that would settle the open questions. Two of its findings are
worth knowing before touching `downscale.js`:

- **HRRR's mean wind over these stations is 70% too fast**, so a multiplicative term is
  graded on the sign of its gain rather than on its physics until that is accounted for.
- **The model has its own mountains.** `tools/model-terrain.js` compares HRRR's surface
  orography with the 3DEP ground under each station: the model's ground sits ~70 m above
  the floor of a valley station and ~41 m below the top of a ridge station, so part of
  the landform the correction adds has already been applied by the model.

```bash
node tools/model-terrain.js --stations PCPC2,KSHC2,TT532 --at 2026-09-04T18:00:00Z
```

**No default or formula has been changed on the strength of any of it**, and none should
be on one state and one day.

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

**A listed 3DEP product may not be a GeoTIFF at all.** Over Boulder the 1/9 arc-second
dataset returns real, current products whose `downloadURL` ends `.zip` — ERDAS IMG inside
an archive, which no amount of range-reading turns into a window. The reader used to
select one and fail with `not-tiff … starts "PK\u0003\u0004"` after the discovery had
already succeeded. `dem.parseProducts` now drops any product that is not a `.tif`/`.tiff`
and counts it as `unreadable`, so discovery falls through to the coarser product that can
be read, and **"terrain exists but this reader cannot open it" stays distinct from "there
is no terrain here"** in the listing and in `selectDataset().considered`.

**A station observation is not independent of the HRRR analysis.** NCEP assimilates
surface observations, so scoring `f0` against `api.weather.gov` grades a fit, not a
forecast. `tools/score-wind.js` prints that above every table and takes `--forecast` for
the comparison that is not circular.

**And an ASOS station is on the flattest ground for miles**, because it is at an airport.
Four of the five Colorado stations scored so far classify as `flat` — including Aspen, in
a canyon — so a terrain correction is being graded where it should do the least.

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

**A consumer calling the service, and the service facing the public.** There is an
endpoint now, and it answers live over Boulder — but it is bound to localhost, nothing in
BallisticVector calls it, and windsolver.com points at a parking page. Today BV still
builds a wind call in the browser and has `profile.js` validate it, which is the same
contract and none of the field.

Nor is the service fully hardened for a public URL. `/v1/` takes a shared API key —
`WINDSOLVER_API_KEYS=name:secret,…` in the environment, `Authorization: Bearer <key>` or
`X-API-Key` on the request, off entirely when no key is configured — but **there is no
per-key quota, no issuance beyond editing the unit, and no request log beyond stdout.**
The rate limit is per IP at the edge and the concurrency gate bounds what the process
will attempt, neither of which is a bound on what one named caller may ask for.

And a key cannot protect the map page's own calls, because the page runs in a stranger's
browser and any key in it is in view-source. The page is let through on
`Sec-Fetch-Site: same-origin`, which a browser sets and page script cannot — **a door,
not a wall**, since `curl` can send it too. `WINDSOLVER_PAGE_NEEDS_KEY=1` shuts it, and
shuts the page with it. See `docs/deploy.md`.

A cold `/v1/field` over a 1-mile box is **~4 s**, measured; the warm path is the field
cache's. No load test has been run, and a cache hit rate over a real day still needs
traffic rather than a test.

Nothing above the surface, either: one level, one valid time. Forecast hours, history,
climatology and the map's animated field are all downstream of the same cache key and
none of them exists.

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
the arithmetic, not the physics. The weights are the paper's defaults rather than
anything fitted to this terrain, and the one measured comparison there is —
[against a measured wind](#against-a-measured-wind), five Colorado stations over a day —
found the downscaled wind **no better than the HRRR wind it corrects**, at stations that
are almost all airport-flat. That is a first result on the wrong terrain, not a verdict.

The slice on top of it is graded against PROJ for the geodesic and against `profile.js`
for the contract, which grades the geometry and the serialisation. It does not grade the
height stack: the log law is applied and reported, and has been compared with nothing.

**On the version number:** `1.0.0` is the version of the *published contract*, and it is
deliberately not a claim that the product is finished. A `0.x` package would imply the
payload may be reshaped without warning, which is the opposite of the promise being made
— the whole reason the consumer pins a tag is that this shape is stable. Building the
ingestion pipeline has added modules and will add tags; it has not changed what a
valid `windProfile` is, and should not. If it ever has to, that is a `2.0.0` and a consumer PR.
