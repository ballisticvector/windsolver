# Working on WindSolver

Notes for anyone — human or AI agent — picking up work here. `README.md` documents the
modules and the contract; this file covers the decisions that are not visible in the
code and that will otherwise be undone by accident.

## Contents

- [Start here](#start-here) — the four rules, and the ones that bite
- [What this is](#what-this-is)
- [The line: WindSolver knows nothing about rifles](#the-line-windsolver-knows-nothing-about-rifles)
- [The contract is published, not internal](#the-contract-is-published-not-internal)
- [The shooter's grid is a projection, not the native shape](#the-shooters-grid-is-a-projection-not-the-native-shape)
- [The downscaling is under investigation](#the-downscaling-is-under-investigation-and-nothing-about-it-is-settled)
- [Things that bite](#things-that-bite)
- [Licensing, before anything is sold](#licensing-before-anything-is-sold)
- [Conventions](#conventions)

## Start here

```bash
npm install
npm test
npm run lint
```

- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). Branch from `main`
  with a `devin/…` or `claude/…` prefix, land through a PR, CI green before merge.
- ESLint enforces `eqeqeq`, `no-var`, `prefer-const`, and no unused variables.
- Write the failing test first for anything the contract or the geometry turns on.
- **Say what you did not verify.** The rest is in [Conventions](#conventions).

> **Read this before you touch ingestion.** All but one of these look like working code
> returning an ordinary answer, which is why they cost time rather than failing loudly.
> Full detail in [Things that bite](#things-that-bite) and in `README.md`.
>
> - **Dataset tags are matched verbatim** — a near-miss returns an empty result, which
>   is indistinguishable from "no terrain here".
> - **NOMADS answers a bad request with an HTML error page and HTTP 200** — and answers a
>   bad *subregion* with 20 MB of perfectly valid GRIB for the whole continent.
>   `nomads.fetchGrib` refuses both; nothing downstream can tell the second one apart.
> - **HRRR wind components are relative to the grid, not to true north** — using them
>   as-is rotates the wind by up to 14° over CONUS, and every value still looks like a
>   wind. `grib2.toEarthRelativeWind` is the fix.
> - **The HRRR availability lag is an assumption, not a measurement** — 75 minutes,
>   chosen conservatively. `nomads.fetchLatestHrrrBox` walks back until a cycle answers
>   and reports the lag it really had, which is the only number worth quoting.
> - **Coverage is sampled, not exact** — fine for "good enough or fall back", not a
>   number to show a user.
> - **A listed 3DEP tile can be nodata over the whole box** — over Boulder the *newer* of
>   the two 1 m tiles is void across the domain, 181,872 pixels out of 181,872, and the
>   older project underneath it carries the ground. `readTerrain` sorts least void first.
> - **A listed 3DEP product can be a `.zip` of ERDAS IMG, not a COG** — the 1/9
>   arc-second dataset over Boulder is exactly that, and it fails as `not-tiff` long
>   after discovery said it had found terrain. `dem.parseProducts` drops anything that is
>   not a `.tif`/`.tiff` and counts it `unreadable`, so "unusable" stays distinct from
>   "absent".
> - **NWS station observations are not independent of the HRRR analysis** — NCEP
>   assimilates them, so `tools/score-wind.js --forecast 0` grades an analysis fit. And
>   the stations are at airports, so they sit on the flattest ground for miles: the first
>   five-station run found the downscaling **no better than raw HRRR**, on terrain where
>   it should do least. Do not quote that as a verdict on the downscaling, and do not
>   quote it as a confidence either.
> - **The terrain downscaling is not yet known to help, and on ridges it measurably
>   hurts.** `docs/downscaling.md` is the standing note: read it before changing anything
>   in `downscale.js`, and add to it rather than starting a new one.

## The downscaling is under investigation, and nothing about it is settled

`docs/downscaling.md` holds every measurement taken against real anemometers so far, the
hypotheses each one supports, and the runs that would settle them. The two facts most
likely to make a well-meant change wrong:

- **HRRR runs about 70% fast over the RAWS sample**, so any multiplicative term is graded
  on the sign of its gain rather than on its physics until that bias is dealt with. A
  candidate that wins the raw table may only be the one that slows the wind down.
- **The model has its own mountains.** `tools/model-terrain.js` measures HRRR's surface
  orography against the 3DEP ground under a station: about 70 m above the floor of a
  valley station, 41 m below the top of a ridge one. A correction computed against the
  absolute landform therefore re-adds terrain the model has already applied, which is the
  leading explanation for the ridge result.

**Do not change a default, a coefficient or the formula on one state and one day of
observations.** Add a candidate to `tools/score-wind.js --ablate` instead, so the change
is scored beside the others on the same pairs before it is anywhere near a default.

## What this is

WindSolver turns a coordinate into an atmosphere over real ground: USGS 3DEP terrain,
NOAA HRRR through NOMADS, NCEI observations, terrain-aware downscaling, and live,
forecast, historical and climatology modes over the top.

**It is a product with its own users, not an engine factored out of a shooting app.**
windsolver.com serves boating, hiking, sailing, flying, fire and agriculture.
BallisticVector (ballisticvector.com) is one API consumer among them — the first one,
and the only one that exists today, which is a fact about the calendar and not about
the design.

## The line: WindSolver knows nothing about rifles

If a change needs a bullet, a barrel, a scope, a zero or a hold, it belongs in
BallisticVector. If it would be just as useful to a fire crew, a drone operator, a
sailplane pilot or an agronomist, it belongs here. Anything terrain- or
atmosphere-shaped that has quietly grown a reference to a projectile is on the wrong
side and should be moved back.

**The pressure to break this is a `forShot=` parameter the first time a shooting client
calls.** A wind solution custom to a rifle and load is a BallisticVector feature that
*consumes* the field; it is not a WindSolver tier. Sampling a field along a trajectory,
turning drift into a hold, and drawing it on a reticle all happen on the consumer's
side.

To be clear that this is a prediction and not a war story: **nobody has asked for
`forShot=` yet.** It is written down now precisely because it has not happened — the
moment it does it will arrive as a small, reasonable-sounding request from the one
consumer that exists, and the cost of agreeing to it is invisible until a second
consumer needs the same endpoint without a rifle.

## The contract is published, not internal

`profile.js` is the `windProfile` v1 contract: a range × height grid of `u`/`v`/`w` in
the shooter's frame, with an azimuth, a source, two resolutions and a confidence.

**The shooter's frame** is a right-handed coordinate system pinned to one shot: origin
at the muzzle, `u` along the downrange axis named by `azimuthDeg`, `v` positive to the
shooter's right, `w` positive up, all three the velocity *of the air* in fps. It is not
a compass frame — two shooters standing together facing different ways describe the same
air with different numbers — which is why the sender has to rotate an east-north field
rather than hand it over as-is. `README.md` has the diagram.

The contract exists so there is **one definition of a valid field rather than two that
drift**, which is the whole reason this module is a dependency of the consumer rather
than a copy in it.

- Adding a key is cheap. Changing what an existing key *means* breaks a caller you
  cannot see — treat it the way you would treat a change to a published endpoint, and
  cut a new major tag.
- **A bad field is refused with a code and a reason, never quietly ignored and never
  partially applied.** Silence is the only outcome that reaches a user as a confident,
  wrong answer. `azimuth-mismatch` exists because a caller can be entirely
  self-consistent and still hand over a wind pointing somewhere else.
- `confidence` and the two resolution figures are the engine being honest about what it
  knows. A modelled wind presented as a measured one is the single worst thing either
  product can ship. Consumers display them; they do not swallow them for a cleaner
  screen.

## The shooter's grid is a projection, not the native shape

The general service answers over a **volume and a time**: wind components on a 3D grid
— a lat/long bbox × a set of vertical levels — valid at one instant, with no bearing
anywhere in it. That is the *volume endpoint*. The shooter's range × height grid is one
vertical plane cut out of that volume along `azimuthDeg` and re-expressed in the
shooter's frame; a sailor asking about a bay wants a horizontal slice at 10 m, and a
fire crew wants the whole box. A sailor and a fire crew have no `azimuthDeg` to give it,
so the shooter's slice must be a documented *view* over the general field, not the
format everything else is bent into.

**This decided the cache key, and that deadline has passed: `cache.js` keys on
`(source, snapped bbox, level set, valid time)`.** Never `(azimuth, ranges)` — producing a
slice at ingestion collapses two dimensions early and then rebuilds them later, and every
consumer that is not a rifle would re-fetch the same air. Terrain derivatives, the
downscaling and the map UI are all downstream of that key and should extend it, not
replace it.

Order of work, which is deliberately not "general API first": get a real field over a
bbox and a time in memory, cache it, expose the slice the one existing consumer can
validate end to end — then the volume endpoint. A volume API with no consumer is the
same mistake as a shooter-shaped field, pointing the other way.

## Things that bite

The ones summarised at the top of this file are set out in full in the "Things that
bite" section of `README.md`, along with one more: HRRR here is **CONUS only**, and
Alaska, Hawaii and the territories need a different filter or a different model
entirely.

**A decoder that guesses is worse than one that refuses.** `grib2.js` handles the
templates HRRR actually sends — Lambert conformal 3.30, simple packing 5.0, scanning
mode 0x40 — and throws, naming the template, on everything else. The temptation when
NCEP changes something is to decode it approximately; the output of that is a wind field
that looks entirely ordinary and is wrong. Add a fixture and a test first, then widen the
decoder.

**Grade the decoder against ecCodes, not against your own arithmetic.**
`tests/fixtures/*.eccodes.json` is `grib_get_data`'s reading of the committed fixture,
and the header of `tests/grib2.test.js` has the commands that regenerate it
(`apt-get install libeccodes-tools`). Every intermediate quantity in a GRIB decode is
plausible, so a decoder checked against itself passes while being wrong by a scale
factor.

**Request building is separated from request making** so that every bit of selection
logic, cycle arithmetic and box maths is testable with no network. `nomads.js` is the one
module on the other side of that line, and it takes its `fetch` as an option so even its
own suite is offline. Keep new code on the pure side: a function that both decides what
to fetch and fetches it cannot be tested offline, and none of the interesting bugs are in
the fetching.

**A 200 from NOMADS means nothing on its own.** The measured table is in `README.md`; the
part to carry around is that a missing `file=` returns the filter's HTML form with HTTP
200, and a subregion that misses the grid returns the entire CONUS field — 20 MB, valid
GRIB, decodes cleanly, wrong place. `nomads.js` checks the body shape, a byte ceiling
enforced while reading, the GRIB magic, and the bounds of the grid that came back. Do not
relax any of those four to make a new request work; the request is what is wrong.
Captured error pages live in `tests/fixtures/nomads-*.html`, so the suite is graded
against what the service really sends rather than against an invented page.

**Measure before you size anything.** The numbers in `README.md` — 3 GB of 1 m terrain
for one coordinate, 2 KB for the atmosphere over the same box — came from live runs, and
they are why terrain is windowed rather than tile-fetched. Do not buy hardware, or
promise a latency tier, against a guess.

**Both DEM products are COGs, so do not mirror CONUS for speed.** `tools/cog-survey.js`
reads the TIFF headers over range requests; across 30 tiles in six states every one had
its directory in the first 4 KB, was internally tiled and carried five overview levels,
so a domain's window is one round trip and ~267 GB of block storage buys nothing but
resilience.

**But two of those 30 are 256 x 256 with predictor 1, not 512 x 512 with predictor 3.**
3DEP is thousands of separately converted projects and the physical shape of a file
belongs to its conversion, not to the product: the 2013 tiles over Boulder disagree with
the 2023 tiles over the same ground. A reader that hard-codes a block size or a predictor
reads the other conversion as noise, and a directory at the end of the file is legal too
— still windowable, one extra range request to locate. `tests/cog.test.js` keeps a real
header from each conversion and parameterises the differences rather than asserting one
shape. Re-run the survey before relying on any of it.

**And a shape the survey missed entirely: float32 with predictor 2.** Horizontal
differencing is usually seen on 8-bit imagery, so a reader that undoes it byte by byte
looks correct until a project writes it on 32-bit elevations —
CO_SanLuisJuanMiguel_2020_D20 over Copper Mountain does, and 30 sampled tiles contained
none. The difference is between whole samples, and libtiff accumulates a 32-bit sample as
an unsigned integer whatever the sample format says it means, so the sum wraps at 2^32
rather than adding as floats. `tests/fixtures/cog-lzw-p2.tif` is cut from that tile so the
case is a real conversion rather than a hypothetical one.

**Grade the terrain reader against GDAL, not against your own arithmetic**, for the same
reason the decoder is graded against ecCodes. `tests/cog.test.js` compares every pixel of
every overview level against `gdal_translate`'s reading of the same fixture, and the
fixtures are regenerated by `tools/make-cog-fixtures.sh` from real 3DEP tiles rather than
hand-maintained. A live window over Boulder agrees with `gdallocationinfo` bit for bit at
five coordinates, which grades the projection, the overview choice, the tile arithmetic,
the LZW decode and the predictor in one number.

**A nodata sentinel is decimal text and may not name the pixel it stands for.** The 2013
3DEP conversions write `GDAL_NODATA` as `-3.4028234e+38` for a pixel that is really
-3.4028234663852886e+38; compared as written they are different numbers, so every void in
those files reads as ground 3.4e38 m deep — finite, so it survives averaging and slope and
poisons the derivatives rather than failing. `cog.js` brings the sentinel into float32
before comparing. Do not trust a sentinel read from text without doing the same.

**Nodata is `NaN`, and it stays that way.** 3DEP writes -999999 in a void; passing that
on puts a kilometre-deep cliff in the terrain, and flattening it to zero puts a sea-level
plain in the mountains. `sampleElevation` refuses to interpolate across a hole rather
than inventing ground between two real pixels, and a cliff or a plain that is not there
is a wind feature the mountain does not have.

## Licensing, before anything is sold

If a tier ends up driven by WindNinja's momentum solver, that solver is OpenFOAM, which
is GPL-3. Running it behind a hosted API is not distribution and does not trigger the
licence; shipping a customer a container image containing it is. Settle that before an
on-prem or self-hosted offering is promised to anyone.

**Get an actual opinion from counsel before the first commercial tier ships**, and treat
the paragraph above as a flag planted by an engineer, not as advice. The reason it is in
this file at all is that the decision is cheap now and expensive after a customer has
been promised a self-hosted deployment.

## Conventions

The short form is at the top of this file; this is the reasoning.

- ESLint enforces `eqeqeq`, `no-var`, `prefer-const`, and no unused variables.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- Branch from `main`, land through a PR, CI green before merge. Branch prefixes say who
  is holding what: `devin/…`, `claude/…`.
- Write the failing test first for anything the contract or the geometry turns on. The
  suite is what lets two agents work on the engine and its consumer at once.
- Comments explain the code, not the diff. Cite the source of a constant.
- **Say what you did not verify.** Unverified work is fine; unverified work described as
  verified poisons the next agent's assumptions, because they will build on it.
