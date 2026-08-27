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
- [Ingestion](#ingestion) · [The network client](#the-network-client)
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

**Coverage is sampled, not exact.** `geo.coverageFraction` grids the box and counts hits
rather than computing a union of rectangles, so an uncovered strip thinner than the
sample spacing can be missed. It is fine for "is this good enough or fall back", and it
is not a number to show a user.

**Domain limits.** HRRR CONUS only here. Alaska has a separate filter script and a
separate domain; Hawaii and the territories have neither and need a different model.

## Not built yet

Terrain, the volume, and the field itself. `nomads.js` will fetch and decode an HRRR
subset, but nothing here caches one, nothing reads a GeoTIFF, and no `windProfile` is
produced: `discover` still returns *what to fetch*. Next, in this order, is a volume
cached on `(bbox, level set, valid time)`; then terrain-aware downscaling; then the slice
along an azimuth that BallisticVector already consumes. The cache is what decides whether
the "seconds" tier in the design document is real.

**What a caller can rely on today** is `profile.js` — the contract, its validation and
its sampling — plus `grib2.js`, `nomads.js`, and the request builders in `geo.js`,
`dem.js` and `hrrr.js`. That is
what BallisticVector installs and runs in production; it is not a preview. What it
cannot do is *produce* a field, so a caller has to bring its own and have it validated,
which is exactly what BV does with a browser-built wind call.

**On the version number:** `1.0.0` is the version of the *published contract*, and it is
deliberately not a claim that the product is finished. A `0.x` package would imply the
payload may be reshaped without warning, which is the opposite of the promise being made
— the whole reason the consumer pins a tag is that this shape is stable. The ingestion
pipeline is unbuilt, and building it should add modules and tags, not change what a
valid `windProfile` is. If it ever has to, that is a `2.0.0` and a consumer PR.
