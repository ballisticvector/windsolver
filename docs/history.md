# What a weather history is for, and what it is not

The question that started this note, as asked: *could we keep a weather history, find a
previous day whose conditions match today's, and serve that instead of constantly pulling
live feeds?*

Three different products are hiding inside that sentence, and they have three different
answers. This note separates them, because the cheap way to get all three wrong is to
build one thing and let it drift between the roles.

| | what it is | verdict |
| --- | --- | --- |
| **Substitute** | serve a matched past day *as* the current conditions | **No.** It saves about 2 KB and costs the one thing the product cannot spend |
| **Correction** | use past model-vs-measured pairs to correct today's model | **Yes**, and it is the strongest lead in the project — [measurement 9](downscaling.md#measurement-9-how-much-of-the-error-belongs-to-the-station) |
| **Climatology** | answer "what does the wind usually do here, in March, at 09:00" | **Yes**, as its own labelled mode, and no live feed can answer it |
| **Retained** | keep the last real answer, and the next five days, and say how old each is | **Yes** — and it is the *only* answer when the network or the upstream is gone |

The fourth row is the same data as the first and the opposite decision, and the whole
difference is one word on the screen. A past field with its own timestamp on it, offered
as a choice, is honest and sometimes the only thing there is. The same bytes relabelled
`now` are the failure. [Old data, labelled](#old-data-labelled-is-the-right-answer-twice)
sets out the two cases.

**Nothing described here is built.** This is the argument settled in one place before code
exists, in the same spirit as `docs/downscaling.md`: what to build, what not to, and what
would make the answer wrong.

## Contents

- [As a substitute for the live feed: no](#as-a-substitute-for-the-live-feed-no)
- [Old data, labelled, is the right answer twice](#old-data-labelled-is-the-right-answer-twice)
- [As a bias correction: yes, and it is the strongest lead there is](#as-a-bias-correction-yes-and-it-is-the-strongest-lead-there-is)
- [As climatology: a mode, with its own label](#as-climatology-a-mode-with-its-own-label)
- [The database is a table of pairs, not a copy of the weather](#the-database-is-a-table-of-pairs-not-a-copy-of-the-weather)
- [What a row has to carry](#what-a-row-has-to-carry)
- [Order of work](#order-of-work)
- [Things that would poison it](#things-that-would-poison-it)
- [What is not known](#what-is-not-known)

## As a substitute for the live feed: no

**The live feed is not the expensive part.** The measured figures in `README.md`: the HRRR
subset behind a default 2-mile solve is **1,576 bytes on the wire**, 4,800 for a 16-mile
box, 48,668 for 60 miles, and `cache.js` collapses simultaneous callers onto one fetch.
The seconds in a cold solve are terrain — 3DEP product discovery and COG windowing — and
terrain already has no time in its cache key at all, because the ground does not change
between cycles. Swapping today's 2 KB for a matched day's 2 KB saves 2 KB and leaves the
slow half exactly where it was.

**And the saving is bought with the one thing neither product can spend.** A past wind
served as the current wind is a measured-looking number that is not about now. It is the
same failure as a modelled wind presented as a measured one, which `AGENTS.md` names as
the worst thing either product can ship, and it is worse in one respect: `confidence` and
`notice` can describe uncertainty in a model, but nothing in the contract can describe a
value that is honestly about a different day. If a matched historical day is ever shown,
it is shown as a historical day, with its own date on it.

**"Identical conditions" is also not identifiable from what a match would key on.** Two
days can agree on 10 m wind, temperature and pressure and disagree on stability, on how
deep the boundary layer is, on soil moisture, on whether a drainage has broken through —
and the whole reason this service exists is that those are what decide the wind in
terrain. A match keyed on a handful of surface variables is asserting the equality of
everything it did not key on. That is a fine assumption for a *correction*, which only has
to be right on average, and a bad one for a *substitute*, which is asserting it about one
place at one moment.

**What would change this answer:** a live source that is rate-limited or metered per
request, rather than 2 KB of free NOMADS. The response to that is a longer cache and a
graceful degradation to the last real cycle with its age stated — not a different day
wearing today's timestamp.

## Old data, labelled, is the right answer twice

The section above refuses a past day *disguised* as the present. It does not refuse past
data, and there are two cases where old data is the best answer available and a live feed
cannot produce one at all. Both are worth building; neither is an optimisation.

### Degraded mode: the last real answer, with its age on it

**The outage to design for is USGS, not NOAA, and weather history does not help with it.**
This is not hypothetical: during the hillshade browser testing, `tnmaccess` returned
HTTP 200 with `{"error": "Expecting value: line 1 column 1"}` for every query for most of
a day. NOAA was perfectly healthy throughout. What broke was *terrain*, and the symptom
was that every cold coordinate looked exactly like "there is no terrain here" — the
service's honest refusal, produced for a dishonest reason.

So the retention that matters for resilience is asymmetric, and it splits by which
upstream is down:

| upstream down | what is unavailable | what a retained copy buys |
| --- | --- | --- |
| USGS TNM listing | the *discovery* of 3DEP products for a new box | everything: the tiles themselves are on S3 and answer fine |
| USGS S3 / the tiles | the elevation window | the box, if its terrain was kept rather than only its listing |
| NOMADS / AWS HRRR | the current cycle | the previous cycle, which is an hour old and still a good wind |
| the user's network | all of it | whatever is already on the device — see the next section |

Two concrete gaps in what exists today, both small:

- **`listing.js` throws away an expired entry even when the network has just refused.**
  A listing older than fourteen days is counted `stale` and reported as a miss, and the
  solve then fails — but 3DEP publishes new projects monthly-ish, so a fifteen-day-old
  listing is almost certainly still true, and it is unambiguously better than "no
  terrain here". Expiry should mean *prefer a refetch*, not *destroy the fallback*.
- **`cache.js` drops a volume once it is stale rather than keeping it as a last
  resort.** That is right for the normal path — a stale field must never be served
  silently in place of a fresh one — and it means there is nothing to fall back to when
  the fetch fails. The fix is a separate, explicitly-aged last-good entry, not a longer
  freshness window.

The rule for both: a retained answer is served **only after the live path has failed**,
never as a shortcut, and it carries its own valid time, its age, and a `notice` saying
the upstream refused. It is a different answer to the same question, not the same answer
arriving late.

**And a health check has to ask the endpoint that fails.** Through that entire USGS
outage `/datasets` kept answering, so a monitor pointed at it would have reported
everything fine while no cold coordinate in the country could be solved.

### Offline packs: the forecast in the user's pocket

**No signal is the normal condition in the terrain this service is about.** A pack of the
next few days, downloaded while the user still has a connection and read on the device
afterwards, is honest for exactly the reason a substitute is not: a forecast is *already*
about a time that is not now, so it is the one product whose value survives being stored.

The part that is a real decision rather than a download button:

- **Five days cannot be HRRR.** Measured against `noaa-hrrr-bdp-pds`: the 00/06/12/18Z
  cycles reach `f48` and every other cycle stops at `f18` — `hrrr.t13z.wrfsfcf19` is a
  404, `hrrr.t00z.wrfsfcf48` is not. Five days means the National Blend of Models
  (`noaa-nbm-grib2-pds`, CONUS, `f264`, back to 2020) or GFS, both free and both far
  coarser than the 3 km field the downscaling is built on.
- **NBM speaks a different dialect.** It publishes `WIND`/`WDIR` — speed and direction —
  at 10, 30 and 80 m rather than `UGRD`/`VGRD`, so `grib2.js` would need the product
  definitions and the conversion, and the conversion is not free of the same
  grid-vs-true-north trap that already bites on HRRR. It also publishes an ensemble
  standard deviation beside the wind, which is a genuinely better `confidence` than
  anything derivable from a single deterministic run.
- **What ships is downscaled, not raw.** The terrain correction is the reason to use this
  service rather than a weather app, and it is the expensive half. A pack is therefore
  solved server-side over a box and shipped as a field, which also means the device never
  needs 3DEP.
- **A pack has an expiry, and it says so before it is wrong.** `WIND` + `WDIR` at 10 m is
  ~3 MB per lead hour over the whole CONUS NBM grid, so a box-sized pack is small — the
  constraint is not bytes, it is that day five of a five-day pack downloaded three days
  ago is day eight of a forecast, and the device is the one place nobody can push a
  correction to.

Neither case needs the pair database, and neither should wait for it.

## As a bias correction: yes, and it is the strongest lead there is

This is the version worth building, and it is not a hunch:
[measurement 9](downscaling.md#measurement-9-how-much-of-the-error-belongs-to-the-station)
puts a number on it. A per-station offset **measured on one day and applied to another**
takes 23-37% off HRRR's speed RMSE over thirteen Colorado RAWS. One national offset takes
7-18%. Every terrain candidate ever scored in `docs/downscaling.md` spans 0.06 m/s once
the bias is out; this is 0.6-0.9 m/s, out of sample.

The reason it works is that the error repeats: the per-station ratio of modelled to
observed wind correlates at r = 0.90-0.94 between days in the same week and r = 0.68
across six months. **The model's error at a site is substantially a property of the site.**
That is exactly the thing a history can hold and a formula has so far failed to derive —
roughness correlates with what the stations need at r = -0.02.

The literature name for the general version is the **analog ensemble**: for the current
model state at a location, find the past cases where the model said something similar, and
correct today's value by what the anemometers actually did on those days. It is standard
treatment for exactly this problem, and it has one property that matters here more than
the accuracy — **it does not require choosing a functional form.** Measurement 8 found the
bias is proportional rather than additive; measurement 9 found that an additive correction
fitted on a windy March day makes a calm September day *worse than no correction at all*.
Every fitted form is a chance to pick the wrong one. A lookup conditioned on the model's
own value cannot make that mistake.

**What it needs before it can ship, and neither is optional.**

1. **More than thirteen stations in one state over four days.** The debiased table in
   `docs/downscaling.md` has already caught two candidates that were winning only by
   slowing the model down. An analog correction fitted on this sample would be
   curve-fitting with more machinery. FEMS makes the observation side free back to 2005
   and `archive.js` makes the model side free back to 2014, so this is work, not money.
2. **A way to answer at a pin, not only at a station.** This is the harder half and it is
   easy to miss: a per-station table has no row for the ridge a user actually clicked on.
   Getting from a station table to a map means predicting the site factor from terrain —
   the same job the downscaling is failing at, but now with a target that is measurably
   repeatable, which is a much better-posed regression than "which candidate scores best".
   Until that is solved, the correction is a research instrument and a per-station API at
   most.

## As climatology: a mode, with its own label

"What does the wind usually do in this drainage at 09:00 in March" is a real question for
a hiker planning a route, a sailor picking a week, a fire crew writing a burn plan and a
hunter choosing a stand. **No live feed and no forecast can answer it**, and it is the one
of the three that is a feature rather than an optimisation.

It is honest for the same reason the substitute is not: nobody mistakes "typically 4-7 m/s
downslope in the morning" for a forecast, provided the answer says so. Concretely that
means it is a **different mode with different fields**, not a `/v1/field` response with
older numbers in it: a distribution rather than a value, the period it was computed over,
the number of years and hours behind it, and no `validTime` — because it is not valid at a
time, which is the whole point.

`AGENTS.md` already describes WindSolver as serving "live, forecast, historical and
climatology modes". This is the note saying what the fourth one is allowed to be.

## The database is a table of pairs, not a copy of the weather

**Do not mirror NOAA.** One HRRR cycle's surface file is 142 MB, the pressure-level file
395 MB and the native-level file 697 MB — measured with range requests against
`noaa-hrrr-bdp-pds`. Hourly, that is 1.2, 3.5 and 6.1 TB per year respectively, for one
model, to avoid a request that costs 2 KB and is free. AWS already hosts all of it, with
`.idx` sidecars, so `archive.js` can read any cycle back to 2014 by byte range.

What is worth storing is the **join** — the thing NOAA does not have, because it involves
the anemometers as well as the model:

> one row per (model prediction, observation) pair, at a station, at an hour.

That table is small, and the cost of building it is a transfer cost paid once rather than
a storage cost paid forever. The measured arithmetic:

| | measured | for one year |
| --- | --- | --- |
| 10 m `UGRD` + `VGRD`, one cycle, by byte range | 2,381,615 + 2,143,472 B | ~40 GB of transfer, f00 only |
| every RAWS in CONUS, hourly | 2,088 stations | ~18 M pairs |
| FEMS observations, 13 stations x 1 year | 10 MB in 7 s | ~1.6 GB for all 2,088 |

**One CONUS field serves every station in it**, which is why the model side is 40 GB and
not 2,088 separate fetches per hour: about 2 KB of transfer per thousand pairs. The pairs
themselves are of the order of a gigabyte a year written plainly, which is arithmetic on
the row count rather than a measurement of a file that exists.

**Why the pairs and not the summaries.** `tools/score-wind.js --out` already writes
per-station means and RMSEs, and measurement 9 got a surprising distance on those alone.
It also hit the wall exactly where the summary ends: it could not score a *multiplicative*
correction, because `mean(model^2)` is not in a summary, and could not condition on hour
or stability, because the summary is already averaged over them. Both are the analog
method's core moves. **The pairs are the smallest thing that does not have to be
re-derived from the network every time a question changes.**

## What a row has to carry

Each field is here because leaving it out has a specific failure mode.

- **`stationId`, `lat`, `lon`, `elevationM`, `sensorHeightM`** — the pairing is geometric
  and the height correction is applied per sensor. A 6.1 m RAWS mast and a 10 m field are
  not the same wind.
- **`observedTime`, not the hour it belongs to** — FEMS labels an observation with the
  *nearest* whole hour and drops the minute, and the real GOES transmit slots across
  eleven calibrated stations run :08 to :58. Storing the label rather than the time bakes
  a diurnal-cycle error into everything downstream, and every candidate carries it
  equally, so the tables still look consistent. `docs/observations.md` has the detail.
- **`observedSpeedMps`, `observedDirDeg`, and the source's own QC verdict** — a broken
  vane and a sheltered site are the same number and must not become the same row.
- **`model`, `cycleTime`, `forecastHour`, `validTime`** — f00 is not independent of the
  observation, because NCEP assimilates these stations; measurement 7 measured f00's bias
  as 0.17-0.49 m/s smaller than f06's from the same cycle. A table that does not record
  the lead time cannot separate a correction from an assimilation fit.
- **`modelU`, `modelV` at the model's own level**, and the interpolation used to get to
  the station. Storing a speed alone throws away the direction error, and DYGC2 ran 151°
  from the model for 24 consecutive hours.
- **Terrain descriptors at the station**: slope, aspect, the fine landform index, the
  model's own orography at that point. These are time-independent, so they could be joined
  later — but recording them with the row is what makes a query reproducible after
  `derive.js` changes.
- **`sourceVersion` and the calibration provenance** — which transmit-minute table dated
  this row, and which reader version wrote it. `fems.js` refuses a station it has no
  measured minute for; a row written before a station was calibrated must be
  distinguishable from one written after.
- **Nothing rifle-shaped.** Same line as everywhere else: if a column needs a bullet, a
  barrel or a hold, it belongs in BallisticVector.

## Order of work

Deliberately smallest-first, and each step is useful even if the next one never happens.

1. **`/v1/stations` and RAWS markers on the map.** The overlay currently draws the ground;
   this puts the measurements on it. It is also the cheapest way to make "HRRR is 1.4-1.7x
   fast here" a thing a person can see rather than a table in a markdown file.
2. **A pair-ingestion tool**, writing the table above from `archive.js` and `fems.js`, for
   a station set chosen by *topographic position* rather than by which ids were to hand.
3. **A year, several states.** This is the input everything else is blocked on, and it is
   free.
4. **Regress the site factor on terrain**, which is the question measurement 9 makes
   well-posed and the only route from a station table to a map.
5. **Analog correction**, graded out of sample against held-out stations *and* held-out
   dates, on the debiased table, beside the existing candidates in `--ablate`.
6. **Climatology**, which is an aggregate over the same rows and should not be started
   before there are enough of them to be honest about.

**Degraded mode and offline packs are not in that list on purpose.** They share nothing
with the pair database but the word *history*, they are blocked on nothing, and the two
gaps named above — `listing.js` destroying its own fallback on expiry, `cache.js` keeping
no last-good volume — are small changes to modules that already exist. Do them whenever
they are wanted, in either order, without waiting for a single pair to be written.

## Things that would poison it

- **Fitting and grading on the same station-days.** Measurement 9's hindsight column beats
  its own out-of-sample column by 15% within a week and by 33% across the seasonal gap. A
  correction graded in sample will look like a triumph and will be a mirror.
- **Grading against f00.** The analysis assimilates these stations. A correction can score
  well by rediscovering the assimilation rather than the terrain.
- **Letting a station's fault become a site factor.** LSTC2's modelled wind is 4-6x its
  observed. That may be a deeply sheltered mast, or an anemometer that no longer starts.
  An analog method will happily learn either, and then serve it as the wind at that place.
  MADIS's per-observation QC exists for this and is free.
- **Pairing on the hour label.** See `observedTime` above. This one is invisible: it moves
  every score by the same amount, so the table stays self-consistent while being wrong.
- **Letting the climatology mode and the live mode share a response shape.** The moment a
  climatological number can be returned by the field endpoint, it will eventually be
  returned by it.
- **Serving an analog as a forecast**, which is the first item of this note, and is worth
  writing twice because it is the failure that would arrive as a performance improvement.

## What is not known

- **Whether the site factor is a terrain fact at all.** It repeats, which is measured. That
  it is caused by sheltering, roughness or exposure rather than by mast siting and sensor
  condition is *not* measured, and roughness has already failed the test.
- **Whether it repeats anywhere but Colorado**, or in winter, or on a synoptic day rather
  than a thermally driven one. Four days, thirteen stations, one state.
- **Whether an analog method beats a fitted scale here.** Nobody has run one. The argument
  above is that it cannot pick the wrong functional form, which is a reason to try it, not
  a result.
- **How many analog days are enough** at a station, and whether the answer survives when
  the current model state is unlike anything in the record — which is exactly the storm
  day a user most wants an answer for.
- **What the QC flags in FEMS actually mean.** `docs/observations.md` lists that as open.
- **How coarse an offline pack is allowed to be.** NBM's grid over CONUS is 2.5 km and
  its wind is a blend rather than a convection-allowing run; whether a terrain-downscaled
  NBM field is still worth carrying at day four has not been scored against anything, and
  the pairs table is exactly the instrument that would score it.
- **Nothing here has been costed against a real deployment.** The transfer figures are
  measured; the row counts are arithmetic; no ingestion has been run, no table has been
  written, and no query has been timed.
