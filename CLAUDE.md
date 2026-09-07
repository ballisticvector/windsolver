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
- [A weather history is four products](#a-weather-history-is-four-products-and-one-of-them-must-never-ship)
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
>   quote it as a confidence either. **And the ASOS User's Guide puts a floor under that
>   run that is bigger than anything it could have measured**: the sensor is allowed
>   ±2 kt (±1.03 m/s) where the whole ablation table spans 0.06.
> - **A reported calm is censored, not zero, and the sample sits on top of the
>   censoring** — ASOS declares calm at or below 2 kt, so `00000KT` means somewhere in
>   0-1.03 m/s against an observed mean of about 2.1. `verify.js` still scores the
>   reported 0 rather than inventing a value, and reports `calmCeilingMps` and
>   `speed.biasCensoringMps` — the most the calms could have added to the speed bias —
>   beside it. Neither is subtracted from a score. A RAWS is a different instrument and
>   its specification has not been read, so `tools/score-wind.js` gives those readers a
>   null tolerance instead of borrowing the airport's. `docs/observations.md` has the
>   table.
> - **An ASOS is not at 10 m either** — the guide says 33 ft or 27 ft "depending on local
>   site-specific criteria", so the airport comparisons were never height-matched, and a
>   pre-2010 series also has the Belfort-to-Vaisala change buried in it.
> - **The terrain downscaling is not yet known to help, and on ridges it measurably
>   hurts.** `docs/downscaling.md` is the standing note: read it before changing anything
>   in `downscale.js`, and add to it rather than starting a new one.
> - **Three observation providers put three different timestamps on the same wind, and
>   FEMS' is not off by a fixed amount.** For one RAWS report MADIS and Synoptic both say
>   `12:54`; FEMS says `13:00`, because it labels the *nearest* whole hour and throws the
>   minute away. The measured transmit slots run from :08 to :58, so at eight of eleven
>   stations the label belongs to the hour before it and at the other three to the label's
>   own hour — a station-dependent hour of error inside a report that still balances, and
>   `tools/score-wind.js` pairs on 10-30 minutes, which is smaller than any of it.
>   `fems.js` reconstructs the time from the transmit minute in
>   `data/fems-stations.json` and refuses a station that has no entry; never add a station
>   to a FEMS run without calibrating it first. `docs/observations.md` has the
>   measurement.

## The downscaling is under investigation, and nothing about it is settled

`docs/downscaling.md` holds every measurement taken against real anemometers so far, the
hypotheses each one supports, and the runs that would settle them. The facts most likely
to make a well-meant change wrong:

- **HRRR runs 43-70% fast over the RAWS sample**, on every day scored in either state
  (measurement 12 adds 30 New Mexico stations on four more dates), so any
  multiplicative term is graded on the sign of its gain rather than on its physics until
  that bias is dealt with. A candidate that wins the raw table may only be the one that
  slows the wind down.
- **The bias is proportional, not a fixed offset.** A March day with an observed mean of
  5.14 m/s carries +2.21 m/s where September's 2.14 m/s days carry +0.94 to +1.47 — the
  same 1.4-1.7x, twice the offset. Anything fitted as m/s on one regime will be wrong on
  the next.
- **It is not one bias.** Per station the scale actually needed runs from x0.21 to x1.68,
  and it correlates with aerodynamic roughness at r = -0.02 in Colorado — so a
  per-station roughness, including HRRR's own `SFCR`, buys nothing a single constant does
  not buy. New Mexico is friendlier to the idea (r = -0.41) and still worth only 0.02 m/s
  of debiased score, against 0.17 for an empirical elevation line over the same stations.
  Do not spend another run on z0. `roughness.js` exists for that question and is
  deliberately not imported by the runtime path. Fitted by least squares over the pairs
  rather than as a ratio of means, the same per-station scale runs x0.17 to x2.05 and
  transfers between them; that is measurement 10 and it is the one correction in this
  note with a measured out-of-sample effect.
- **There is a noise floor under every score in that note, and it is bigger than the
  effects being ranked.** Pairing an hourly model with an anemometer at the offsets these
  runs drew costs about 0.85 m/s of speed RMSE and 23° of direction before the model is
  wrong about anything (measurement 13, from NCEI one-minute ASOS). The debiased ablation
  table spans 0.06 m/s and the diverting term moves direction by 0.3°. Quote a candidate's
  gain beside that floor or not at all.
- **The model has its own mountains.** `tools/model-terrain.js` measures HRRR's surface
  orography against the 3DEP ground under a station: about 70 m above the floor of a
  valley station, 41 m below the top of a ridge one. A correction computed against the
  absolute landform therefore re-adds terrain the model has already applied, which is the
  leading explanation for the ridge result.

**Do not change a default, a coefficient or the formula on one state and one day of
observations.** Add a candidate to `tools/score-wind.js --ablate` instead, so the change
is scored beside the others on the same pairs before it is anywhere near a default.

**Read `leverage.stable` before you read the ranking.** Every score in this tool is one
number over whatever stations the run happened to include, and twice a result has turned
out to be a single mast — STOC2 halving the terrain correlation, CIMARRON carrying the New
Mexico elevation line — each found by hand, measurements after the claim. The report now
carries a `leverage` block: each candidate rescored with each station's pairs removed and
the debias refitted on the survivors, the spread of those changes, the station whose
removal costs the most, and which candidate wins with each station held out. If the winner
changes when one station leaves, the run has not produced a ranking and there is nothing
to quote. Below three stations the block is `null`, because leaving one out of two is two
numbers and their difference is about which two stations answered.

**The measured wind is the scarce half, and it no longer has to be.** `archive.js`
reaches 2014 on the model side; the Synoptic token refuses observation history older than
about a week, which is what actually blocks seasons, other states and a station set
chosen by topographic position. `docs/observations.md` surveys the alternatives, all
tested: **USDA FEMS** serves 2,088 RAWS back to 2005 as bulk CSV with no account — eleven
of the thirteen stations already scored, matched to 0.00 km, and thirteen stations for a
full year is 113,892 hourly observations in one 7-second request — and **MADIS** publishes
every network NOAA ingests with a per-observation QC verdict, also with no account. No
paid tier is needed for any question currently open.

`fems.js` reads the first of those, behind the same interface as `synoptic.js`, and
`tools/score-wind.js --source fems` scores against it. **What it costs is calibration,
not money**: only the 68 stations in `data/fems-stations.json` have a measured
transmit minute, and a sixty-ninth needs `tools/fems-stations.js` run against Synoptic
inside its free window before FEMS can date its observations. Widening the station set is
therefore a two-step job, and the second step is the one with a deadline on it. The
Colorado slots re-measured bit-identical three months later, so a calibrated station
stays calibrated.

**Choose the set by the ground, not by the ids already to hand.**
`tools/station-survey.js --source fems --state CO --spread 30` reads 3DEP under every
RAWS in the catalogue and picks a set spaced across the 500 m position index, which is
what measurement 10 asked for. The survey's own finding is the caveat on everything
fitted to it: over 93 readable Colorado RAWS the split is 34 flat, 33 ridge, 19 slope and
**3 valley**, because RAWS are sited on exposed fire-weather ground on purpose. A terrain
regression fitted here is far better constrained on crests than in hollows, and no amount
of spreading fixes a catalogue that has no valleys in it. **Changing state does not fix
it either**: all 56 readable New Mexico RAWS are 33 flat, 15 ridge, 4 slope and 3 valley,
over a position index with the same two ends to within a metre and a half (measurement
12). The sheltered half of the axis has to come from a network that is not RAWS — MADIS
carries the agricultural and hydrological ones, which are in bottoms because that is
where the crops and the streams are.

**Score FEMS with `--tolerance 30`.** Dating a RAWS correctly does not move it closer to
the model's whole hour; it makes the distance visible. At the 10-minute default, five of
the first eleven calibrated stations have no observation inside the window at all — their
slots are :19 to :25 off the hour — and the run reports them rather than shrinking the
sample quietly. The METAR runs never hit this because airports report at :53.

**And do not narrow it to make the pairs tidier.** Measurement 13 prices the window
against NCEI's one-minute ASOS record: at these stations the wind's own change reaches
±2 kt after a median **7.5 minutes**, and the offsets the FEMS runs actually drew —
mean 12.6–14.3 minutes — cost about **0.85 m/s of speed RMS, 1.36 m/s of vector and 23°
of direction** against a 10-minute mean. That is a third to a half of the variance left
in the best per-station correction, and fourteen times the 0.06 m/s that separates every
terrain candidate ever ablated. The offset is a property of the station's transmit slot,
so narrowing the tolerance deletes stations instead of improving pairs. Interpolating the
model between hours to the observation's own minute is still the better answer and still
does not exist — but it is worth about **12%** of the timing term and no more, because
sub-hourly variability is not in an hourly series to recover.

## A weather history is four products, and one of them must never ship

"Keep a weather history and load a matching past day instead of pulling live feeds" is
four separate proposals. `docs/history.md` argues them apart; the part that belongs in
this file is which is which, because the way to get it wrong is to build one and let it
drift into another's job.

- **Serving a matched past day as the current conditions: never.** It saves about 2 KB —
  the live subset behind a default solve is 1,576 bytes, and the seconds in a cold solve
  are terrain, which is already cached with no time in its key. What it costs is a past
  wind wearing a present timestamp, which is the measured-versus-modelled failure with no
  field in the contract able to describe it. A historical day is shown with its own date
  on it or not at all.
- **Correcting today's model with past model-versus-measured pairs: the strongest lead in
  the project.** Measurements 9 and 10 in `docs/downscaling.md`: a per-station correction
  measured on one day and applied to another takes 23-37% off the speed RMSE, against
  0.06 m/s spanning every terrain candidate ever scored. **Fit it as a scale, not an
  offset** — the scale wins all twelve out-of-sample cells and survives six months, where
  March's offsets applied to September are worse than no correction at all. It is not
  shippable yet for a reason that is easy to miss — **a per-station table has no row for
  the pin a user actually clicked** — and the terrain regression that would bridge that
  gap does not survive being tested properly. Measurement 11 put it on 37 stations chosen
  by the ground they stand on rather than 11 chosen by convenience: terrain closes about
  8% of the distance between a pooled scale and the station's own, and removing STOC2
  still halves the correlation on every date. **Do not spend another Colorado run on it**
  — the state's RAWS are 3 valleys in 93, so the sheltered half of the axis is not in
  this catalogue. The one descriptor that has ever bridged the gap is **elevation in New
  Mexico** (measurement 12): 12 of 12 held-out cells and 71% of the distance to the
  station's own factor — and 0 of 12 in Colorado, with a New Mexico line actively
  damaging Colorado. Read that measurement before treating it as more than a lead.
- **Climatology — what the wind usually does here, in March, at 09:00: a mode of its own.**
  Honest because nobody mistakes it for a forecast, provided it is shaped like a
  distribution over a stated period with no `validTime`, rather than a `/v1/field`
  response with old numbers in it.
- **Retaining the last real answer, and shipping the next few days to a device: yes.** The
  same bytes as the first bullet and the opposite verdict, and the entire difference is
  that these say how old they are. A retained field is served **only after the live path
  has failed**, with its own valid time, its age and a `notice` naming the upstream that
  refused — never as a shortcut. An offline pack is honest because a forecast is already
  about a time that is not now.

**Design the degraded mode for a USGS outage, not a NOAA one.** During the hillshade
testing `tnmaccess` returned HTTP 200 with an error object for most of a day: every cold
coordinate looked exactly like "no terrain here", while NOAA was fine. Weather history
would not have helped at all. `listing.js` now handles it: an expired entry is kept 180
days, the network is still tried first, and the kept copy is read **only** after a
refusal, carrying `storedAt`, a per-answer `ageS`, `stale` and the refusal itself out
through `terrain.listing` on `/v1/field`, a header on `/v1/hillshade` and a caption on
the map. Ground nobody has listed is still `no-terrain` — the fallback keeps a real
answer through an outage, it does not invent one. **Do not let `ageS` be stored**: the
terrain is cached and the arithmetic over it is not, so an age frozen at read time reads
as an hour old forever. Still unhandled: `cache.js` drops a stale volume rather than
keeping a separate, explicitly-aged last-good copy. Also **point a health check at the
endpoint that fails** — `/datasets` answered throughout that outage.

**An offline five-day pack cannot be HRRR.** Measured: the 00/06/12/18Z cycles reach
`f48` and every other cycle stops at `f18`. Five days is NBM (`noaa-nbm-grib2-pds`,
`f264`) or GFS, and NBM publishes `WIND`/`WDIR` rather than `UGRD`/`VGRD`, so it is a
decoder change and not a URL change.

**And the database is a table of model/observation pairs, not a copy of the weather.** One
HRRR cycle is 142 MB at the surface and 697 MB on native levels; mirroring what AWS
already hosts for free, with `.idx` byte ranges, buys nothing. The join with the
anemometers is the part NOAA does not have. Store the pairs and not `score-wind.js`
summaries: measurement 9 could reconstruct an additive correction from summaries and could
not score a multiplicative one, which is the form the evidence actually points at.
`tools/score-wind.js --pairs` writes one run's worth of that table — opt-in, alongside the
report, never inside it — and `tools/site-factor.js` reads it. **A run artefact is not the
database**: nothing accumulates, indexes or versions it, and the ingestion tool is still
the unwritten step.

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

**A hillshade is a picture of the ground, not a claim about the wind.** `hillshade.js`
shades the same `derive.slopeAspect()` the downscaling reads, so what the map draws and
what the solver bends the wind with cannot drift apart — but the shading says nothing
about sheltering, and its lit and unlit faces are a sun angle rather than a lee. Do not
grow it into a shadow model and then read shelter off it: directional sheltering is
`derive.js`'s, it is measured against stations, and `docs/downscaling.md` records that it
is the term with the least evidence behind it. A relief that looks like a wind answer is
the same failure as a modelled wind presented as a measured one.

**`/v1/stations` is the only measured thing this service returns, and every line of it is
about keeping that word.** The field, the line, the profile and the relief are all model
output; the stations are anemometers. So the payload carries `modelled: false` and a
`notice` a consumer cannot miss, and the map draws them in a pane above the wind wash
with a legend saying which mark is which. Anything that merges the two — averaging an
observation into the field, nudging the field towards a nearby station, drawing them in
one style — has to be an explicit, labelled correction, not a quiet improvement.

Four distinctions in there are load-bearing, and each one is a claim a tidier
implementation would have destroyed:

- **A station that reported nothing is not calm.** FEMS answers an unknown station, a
  station that is down and an hour that has not happened yet with the same blank row; a
  calm is `speedMps: 0, fromDeg: null, calm: true`. `observation: null` therefore carries
  an `observationNote` and an `observationCode`, and the marker stays on the map as a
  hollow ring rather than being dropped — a network that goes quiet must not be able to
  look like a calm night.
- **`timeIsHourBin` says the timestamp is a label.** FEMS dates a row to the nearest whole
  hour and the real transmit slot runs :08 to :58, so the time can be half an hour out
  where `tools/fems-stations.js` has not measured the station. Never drop the flag to
  tidy the shape; `score-wind.js` pairs on 10–30 minutes, which is smaller than the
  error it hides.
- **`qcChecked: false` is "nothing has looked at this yet", which is not "checked and
  passed".** The flag columns are empty in the last few days and populated in the
  archive, and empty reads the same as `0` to anything that only looks for a value.
- **`sensorHeightM: null` is "the provider did not say", never the model's 10 m.** RAWS
  masts are nominally 6.1 m, so a station reading and a model level are different
  quantities — which is exactly why the popup comparison prints the height note instead
  of a bare ratio.

**A provider outage is answered, not hidden and not fatal.** The station directory is
quasi-static, so a refresh failure serves the retained list with `retrievedAt`, `ageS`,
`stale: true` and the error that stopped it — the `docs/history.md` rule that old data is
allowed exactly when it says how old it is. An observation outage is a `200` with the
markers and `observed: false`; only a directory failure with nothing retained is a `502`.
And the station service is a separate upstream from the field service on purpose: FEMS
being down must not stop a wind solve, and a NOMADS outage must not empty the map of
stations.

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
