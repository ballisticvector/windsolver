# Where the measured wind comes from

A survey, and now the adapter it recommended. `synoptic.js`'s free tier refuses history
older than about a week — which is the wall every remaining question in
`docs/downscaling.md` runs into, now that `archive.js` reaches 2014 on the model side.
This note records what else exists, what was actually tested rather than read off a
marketing page, what an adapter has to refuse, and what `fems.js` does about it.

**The short version: the two sources Synoptic itself redistributes are public, need no
account, and go back further than the tier that was about to be bought.** Thirteen
Colorado RAWS for a full year — 113,892 hourly observations — came back in 7 seconds
from one anonymous GET.

## Contents

- [What the source has to do](#what-the-source-has-to-do)
- [The candidates, measured](#the-candidates-measured)
- [FEMS: the RAWS system of record](#fems-the-raws-system-of-record)
- [MADIS: everything NOAA ingests, with QC attached](#madis-everything-noaa-ingests-with-qc-attached)
- [Which networks measure below 3 m, and where they stand](#which-networks-measure-below-3-m-and-where-they-stand)
- [The three providers disagree about when the wind was measured](#the-three-providers-disagree-about-when-the-wind-was-measured)
- [What the instrument did before anyone scored it](#what-the-instrument-did-before-anyone-scored-it)
- [A one-minute record, and what the pairing window costs](#a-one-minute-record-and-what-the-pairing-window-costs)
- [What an adapter has to refuse](#what-an-adapter-has-to-refuse)
- [Using it: fems.js](#using-it-femsjs)
- [Using it: coagmet.js](#using-it-coagmetjs)
- [Recommendation](#recommendation)
- [What is not known](#what-is-not-known)

## What the source has to do

The observations exist for one job: grade a modelled wind against a measured one, at
stations the model was not fitted to, on ground the downscaling is about. That job sets
the requirements, and they are not the requirements a weather app has.

1. **History, in years.** `archive.js` reaches 2014. Seasons, other states and
   leave-one-out over a larger station set are all blocked on the observation side, not
   the model side.
2. **Stations chosen for terrain, not for aviation.** An ASOS sits on a deliberately
   unobstructed airfield — the ground a 3 km model already gets right.
3. **Coordinates and elevation per station**, because the pairing is geometric.
4. **The measurement time, not the hour it belongs to.** See
   [below](#the-three-providers-disagree-about-when-the-wind-was-measured); this turned
   out to be the sharpest difference between the candidates.
5. **A refusal that is distinguishable from calm, and from no station.**
6. **No sales call**, and no per-request pricing that makes a 100,000-pair run a
   budgeting decision.

A commercial "historical weather API" typically fails 2 and 4, and several of them fail
something worse: they return a *model reanalysis* interpolated to a coordinate, which as
a yardstick for a model is circular. Nothing in this note recommends grading HRRR
against anything that is not an anemometer.

## The candidates, measured

Everything in this table was exercised from this box on 2026-09-06 unless the row says
otherwise.

| Source | Stations | History | Cadence | Account | What it is good for |
| --- | --- | --- | --- | --- | --- |
| **USDA FEMS** | 2,088 RAWS, all 50 states, 96 in Colorado | 2005 → now, ~1 h behind live | hourly | none | **The RAWS system of record.** Bulk CSV, 13 stations x 1 year in one 7-second request |
| **MADIS** (`madisPublic1`) | 173,053 records in one hour's file, 2,493 of them RAWS, plus MesoWest, HADS, CoAgMet, NJWxNet, NC-ECONet … | 2001 → now | hourly files | none | **Per-observation QC**, real observation times, every network in one place |
| **NCEI ISD** (`global-hourly`) | global, mostly airports | 1901 → now | sub-hourly | none | A large independent sample on flat ground; the wrong ground for this question |
| **IEM** | ASOS archive, some mesonets; no RAWS network in its 600-network list | decades | 1 min – 1 h | none | ASOS convenience; returned `server over capacity` on the one call tried |
| **Synoptic free** (current) | RAWS + everything else | **~6 days** | as reported | token | Live and recent-past convenience, which is what it is still good at |
| **Synoptic paid** | as above | longer | as reported | single-user tier, or "contact us" | Not needed for any question currently open |

The bottom row is the point of the exercise. **Synoptic is a redistributor.** The RAWS
records it serves originate with the land-management agencies and reach NOAA through
MADIS; both of those are public, and both hold more history than the tier that was about
to be bought.

## FEMS: the RAWS system of record

The Fire and Environmental Monitoring System, `fems.fs2c.usda.gov`. The web UI runs on
an Apollo GraphQL endpoint at `/api/climatology/graphql`; introspection is off, but the
queries are in the public front-end bundle. There is also a plain CSV route, which is
the one worth using.

Station metadata — `stationMetaData(returnAll: true)` — returns 2,088 stations with
`station_id`, `wrcc_id`, `latitude`, `longitude`, `elevation`, `agency`, `network_name`
and, usefully, `period_record_start` / `period_record_stop`. Every one is `RAWS`.

Observations:

```
GET https://fems.fs2c.usda.gov/api/climatology/download-weather
      ?stationIds=50406,51508,53005
      &startDate=2026-09-04T00:00:00Z&endDate=2026-09-04T23:59:00Z
      &dataFormat=csv&dataset=observation
```

CSV with `WindSpeed(mph)`, `WindAzimuth(degrees)`, `GustSpeed(mph)`, `GustAzimuth`,
temperature, RH, precipitation, solar, and a `WSflag`/`WAflag`/… family. Measured:

- **13 stations x 365 days = 113,892 rows, 10 MB, 7.0 s.** 20 stations x 30 days took
  10 s. Ninety-six station ids in one query returns `400 Large requests must be sent as
  a POST HTTP Protocol` — the service refuses rather than truncating, which is the right
  failure.
- **2006, 2015, 2023, 2025 and yesterday all return data** for the same station.
- Latest observation was 1 hour old at the time of writing, so this is not archive-only.
- **Eleven of the thirteen stations in `docs/downscaling.md` are present, to 0.00 km.**
  `PCPC2 → 50406 CPOR`, `STOC2 → 51508 CSKU`, `KSHC2 → 53005 CKEN`, and so on. The two
  that are missing are `TS578` and `TS723`, which are portable incident stations rather
  than RAWS — `TS723` is the station that only ever contributed 48 pairs.

So the existing scored sample can be re-run over 20 years without changing which
stations it is.

Two properties to design around. Speeds are **integer mph**, so the series is quantised
at 0.447 m/s and a "0" is a calm below about a fifth of a metre per second, not a zero.
And the QC flag columns are **empty for the most recent days and populated for older
ones** — QC is a later pass, so a near-real-time FEMS observation is unchecked.

## MADIS: everything NOAA ingests, with QC attached

`madis-data.ncep.noaa.gov/madisPublic1`, hourly gzipped netCDF, no login for the public
subset. One `LDAD/mesonet` file is 35 MB gzipped, 383 MB open, and contains 173,053
observations from every network NOAA takes — RAWS among them, and MesoWest, which is
Synoptic's own upstream.

What it has that neither of the others does:

- **A real observation time per record.** `observationTime` is the transmission, to the
  minute: `KSHC2 2026-09-04T12:54`, `PCPC2 12:57`, `STOC2 12:58`.
- **Per-observation QC verdicts.** `windSpeedDD` is `V` passed / `S` failed the spatial
  check / `Q` failed / `Z` not checked; in the hour sampled, 74 of 2,481 RAWS wind
  observations were not `V`. A spatial-consistency check is something no other candidate
  here offers.
- Every station in one file, so a station set chosen by topographic position rather than
  by which ids were already known costs no extra requests.

The cost is the shape: 383 MB per hour scored, and the archive tree runs a few days
behind the live directory (`archive/2026/09/04/` held only `0000` while
`data/LDAD/mesonet/netCDF/` held the recent hours). For 24 hours of one day that is
about 840 MB of download to extract a few thousand rows. Fine occasionally, wrong as the
default puller.

## Which networks measure below 3 m, and where they stand

`docs/near-ground-wind.md` step 2 asked for this: nothing scored in this project is
below 6.1 m, so a 0–3 m product cannot be graded at all, and the lead was that
agricultural mesonets measure at 2 m and some carry 2 m *and* 10 m on one mast. This is
the catalogue read. **One of the two halves is there and the other is not.**

### MADIS does not carry the height

The generic `LDAD/mesonet` file has a `windSpeed10` variable beside `windSpeed`, which
reads like the paired-height field the search was for. In the hour sampled
(`20260907_1600`, 204,226 records over 221 variables) **`windSpeed10` is empty for every
record of every provider**, and no variable in the file states a sensor height at all. So
MADIS is the right index of *which networks exist* — CoAgMet, NC-ECONet, MOComAgNet, HADS,
CA-Hydro, NRCS and the rest are all in the provider list — and it is not a source of
measurement height. **The height has to come from the provider, one provider at a time**,
and a field named `windSpeed10` is not evidence that anything was measured at 10 m.

### CoAgMet: 95 stations at 2–3 m, with the height published per station

`coagmet.colostate.edu/data/metadata.json`, no account, and `anemometerHeight` **in feet**
against elevations in feet — converting is the whole trap. 129 stations, 101 active, and
of the 100 whose 3DEP ground agrees with their published elevation:

```
2.01 m    72        5-minute timestep     99 of 100
2.99 m    22        published height      97
2.19 m     1        at or below 3 m       95
10.00 m    2
none       3
```

Landform under all of them, through the same `tools/station-survey.js` path (`--radius
2.5 --position 2000`): **79 flat, 14 valley, 5 ridge, 2 slope**, index −82.4 to +29.5 m.
All 14 valley stations are at or below 3 m — Gunnison, Carbondale, Eagle, Pagosa Springs,
Kremmling, Meeker, Ridgway, Granby, Cortez, Hayden, Cañon City, Gypsum, Durango, Clark.
Over a 500 m disc the same catalogue is 95 flat of 98, index −14.2 to +18.1 m, and **not
one valley** — which is measurement 14's point again: a farm on the floor of the Gunnison
valley is flat ground inside a hollow, and both readings are true.

`coagmet.js` reads this network — see [Using it: coagmet.js](#using-it-coagmetjs), which
asks for metric units and so sees the same heights in metres.

That is a real answer to half the problem — **sub-3 m wind in western-slope valley
bottoms, 5-minute, free, with per-station heights** — and a partial one to the other half:
these are irrigated farm sites, which is a land cover, an exposure and a diurnal regime of
its own, and one state.

### USCRN measures at 1.5 m, nationally, and says so in the specification

`WIND_1_5` in the sub-hourly product is a 5-minute mean at **1.5 m**, documented rather
than inferred, over 158 operational US stations, 116 of them in CONUS. It is the only
source found anywhere in this survey that measures *inside* the layer the product is
about rather than above it.

3DEP under all 116 (`--radius 2.5`, the same `station-survey.js` path): 113 readable, 3
`outside-tile`, and of the 103 whose published elevation agrees with the DEM to 50 m —

```
              500 m disc    2 km disc
flat                  84           72
valley                 3           16
slope                 13           10
ridge                  3            5
index range  -32.7..+22.4  -158.5..+39.6
```

Sixteen valley-bottom stations at 1.5 m, including John Day OR at −158.5 m, Lander WY,
Darrington WA and Moose WY. The trap in the catalogue: **`ELEVATION` in
`crn_stations.tsv` is feet**, unlabelled, beside latitudes and longitudes in degrees —
read as metres it puts every station 3.3x too high and every elevation cross-check fails.

It is sparse — 4 in Colorado, 2 in New Mexico, about 33 across the eleven western states —
so it is a **validation set and could never be an input field**. That is the right shape
for the question here: it is the only way to score a drawn near-ground wind against an
instrument standing in it.

#### What the adapter has to get right

`uscrn.js` reads it behind the same `search` / `station` / `observations` interface as
`synoptic.js`, `fems.js` and `coagmet.js`, and `tools/score-wind.js --source uscrn` scores
against it. The product is plain text from
`https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01/`, one file per
station-year, no account and no key. Five things in it are traps:

- **There is no direction.** `WIND_1_5` is a speed and the sub-hourly product has no
  bearing field at all, so a normalized record carries `fromDeg: null` rather than a
  fabricated one — and a run against USCRN is a **speed score**, which the summary now
  says in words rather than leaving three empty columns to be read as a good result.
- **Missing is `-99.00`, and the flag does not mark it.** In one Boulder station-year 24
  rows carry the sentinel with `WIND_FLAG=0`, so missingness has to be tested on the value
  independently of the flag. It is an absence, never a calm.
- **`WIND_FLAG=3` is "erroneous", and the number beside it still looks like a wind.**
  Las Cruces 20 N (WBAN 03074) has *every* row of 2026 either missing or flagged, and the
  flagged values average 2.02 m/s with peaks to 15 m/s — an ordinary-looking record that
  the network says is wrong. Read without the flag it would have scored as a healthy
  station. The reader rejects flag 3 by default (`keepFlagged` opts back in) and counts
  what it rejected, so a station that contributes nothing shows up as a gap.
- **A timestamp ends a five-minute interval**, as in CoAgMet. Both bounds are kept and the
  scoring time is the midpoint.
- **The catalogue's `ELEVATION` is feet**, as above. `station()` converts it, and
  `{ refine: true }` replaces the catalogue's 0.01° coordinates with HOMR's 0.0001° ones
  when the two agree, recording which was used.

### Nothing found measures two heights on one mast

Neither CoAgMet nor USCRN nor any provider reachable through MADIS publishes a second
anemometer on the same tower. CoAgMet's two 10 m sites are separate stations. So the
measured profile ratio step 2 asked for **does not exist in these networks**, and the
nearest thing to it is two stations at different heights close together, which is a
different measurement — see `docs/near-ground-wind.md`, where the controls say how
different.

## The three providers disagree about when the wind was measured

This is the finding that matters most, and it was nearly missed.

Same station, same day, the same three numbers, asked of all three sources:

```
KSHC2                       wind        direction   timestamp
MADIS      observationTime  0.0 m/s     200°        2026-09-04T12:54
Synoptic   date_time        0.0 m/s     200°        2026-09-04T12:54
FEMS       DateTime         0.0 m/s     200°        2026-09-04T13:00
```

MADIS and Synoptic agree to the minute. **FEMS labels the observation with a whole hour
and discards the minute.** PCPC2 transmits at :57 and STOC2 at :58, so for those the FEMS
label is 3 and 2 minutes late — which made "it rounds up to the following hour" look like
the rule until eleven stations were measured. It is not; see *Measuring it changed the
rule* below. Either way nothing in the FEMS response says which minute it came from.

`tools/score-wind.js` pairs on a 10-30 minute tolerance. **That tolerance is smaller than
the disagreement between providers about when the measurement happened**, so a FEMS-fed
run would silently pair some stations against the wrong model hour — a diurnal-cycle
error dressed as a model error, on exactly the quantity being measured.

It is fixable and cheaply: the transmit minute is a fixed GOES slot per station, so one
MADIS hour, or one Synoptic call inside the free window, recovers a per-station offset
that can be subtracted from every FEMS timestamp for the following twenty years. An
adapter that does not do this should say in its own header that its times are hour bins.

**Measuring it changed the rule.** `tools/fems-stations.js` recovered the slot for eleven
stations against 72 hours of Synoptic, and the slots are spread right across the hour
rather than clustered near the top of it:

```
LSTC2 :08   PKLC2 :24   ESPC2 :24   RRAC2 :35   DYGC2 :38   TT532 :41
KSHC2 :54   SODC2 :56   BMOC2 :56   PCPC2 :57   STOC2 :58
```

So FEMS does not round *up*; it labels the **nearest** whole hour. A :57 observation is
labelled 13:00 and belongs to 12:57, but a :08 observation is labelled 13:00 and belongs
to 13:08. Eight of the eleven fall on the first side and three — Lost Park, Pickle Gulch,
Estes Park — on the second.

The first two stations sampled were PCPC2 at :57 and STOC2 at :58, which is exactly the
sample that makes "the label is the hour after the measurement" look like the rule. Taken
as the rule it is a full hour wrong at those three stations and right at the other eight,
which is the failure worth naming: not a wrong report, a report that is right in most
columns.

### Dating them correctly costs half the stations at the default tolerance

Reconstructing the true minute does not make a FEMS station easier to pair — it makes the
mismatch visible. `score-wind.js` defaults to a 10 minute window around the model's valid
hour, and a slot at :24 or :35 is nowhere near it. A 24-hour run over the eleven
calibrated stations scored six of them and reported the rest rather than quietly shrinking
the sample:

```
5 station(s) reported, and none of it landed inside the 10 minute window:
  TT532 ROAN PLATEAU   — nearest model hour 19 minutes away
  PKLC2 PICKLE GULCH   — nearest model hour 24 minutes away
  RRAC2 RAMPART RANGE  — nearest model hour 25 minutes away
  DYGC2 DRY GULCH      — nearest model hour 22 minutes away
  ESPC2 ESTES PARK     — nearest model hour 24 minutes away
```

`--tolerance 30` admits all eleven, and that is the right setting for a FEMS-fed run, but
it is a real widening and not a formality: it pairs an observation up to half an hour old
with a model hour. The alternative — interpolating the model between hours to the
observation's own minute — is the better answer and has not been built.

The uncomfortable version of this is that the METAR runs were never affected because
airports report at :53, close enough to the hour that a 10 minute window works by
accident. RAWS transmit whenever their GOES slot falls.

## What the instrument did before anyone scored it

Every number above is about *which* wind and *when*. This section is about what the
anemometer had already done to it, and it is read off the
[ASOS User's Guide](https://www.weather.gov/media/asos/aum-toc.pdf) (March 1998) rather
than inferred, because the first five-station run in `docs/downscaling.md` was scored
against ASOS/AWOS METARs through `observations.js`.

| | ASOS, as specified | What it does to a score |
| --- | --- | --- |
| Averaging | 2-minute running mean of 5-second averages | An hourly model is paired with two minutes of wind, not with an hour of it |
| Starting threshold | 2 kt | Below it the cups do not turn |
| Calm | "winds measured at 2 kt or less are reported as calm" | `00000KT` means somewhere in **0–1.03 m/s**, not 0 |
| Speed accuracy | ±2 kt (**±1.03 m/s**) | Larger than every candidate difference ever measured here |
| Speed resolution | 1 kt (0.51 m/s) | 0.15 m/s of RMSE from rounding alone |
| Direction accuracy | ±5° above 5 kt | |
| Direction resolution | 1° (10° in the METAR) | 2.9° of RMSE from the METAR's rounding alone |
| Sensor height | **33 ft or 27 ft**, by local siting | 10.1 m or 8.2 m: the airport runs were never height-matched either |
| Gusts | not reported below 14 kt | A blank gust field is not a gust-free wind |

Three of those change how a number in this repository should be read.

**A calm is censored, not measured.** Scoring `00000KT` as 0.0 drags the observed mean
down and makes every model look faster than it is — and the RAWS sample's observed mean is
about 2.1 m/s, which is on top of the censoring rather than safely above it. `verify.js`
still scores the reported 0, because inventing a replacement would put a guess inside the
arithmetic, and reports two things beside it instead: `calmCeilingMps`, the ceiling the
report really means, and `speed.biasCensoringMps`, the **most** the calms in that sample
could have added to the speed bias. Both are bounds. Neither is subtracted from anything.

**The tolerance is not the resolution, and it is the larger of the two.** `verify.js` has
always reported a quantisation floor — the RMS of the observer's rounding, which a perfect
model cannot score below. That floor is 0.15 m/s for a whole knot. The instrument's own
stated accuracy is ±1.03 m/s, seven times it, and about seventeen times the 0.06 m/s that
spans every terrain candidate ever ablated. `score().instrument` carries it so that a
ranking cannot be quoted without the slack it was read out of. It is an interval and not
an error term: it cannot be subtracted from a score, only held up beside one.

**An ASOS is not at 10 m.** The RAWS masts' 6.1 m has always been corrected for; the
airports were quietly assumed to be the clean case and they are not. Elnahla, Guo & Wu
(2026) date the fix from the instrument side: the Belfort cups sat "primarily at 10
meters, though some were positioned at 7.9 meters", and the Vaisala sonics that
standardised the height at 10 m were fully adopted by 2010 — so a pre-2010 ASOS series has
a sensor-height *and* a sensor-type change buried in it.

### CoAgMet's cups, and why the figures are the network's rather than the station's

CoAgMet documents two anemometers across the network and the API does not say which one
answered:

| | R.M. Young 05103 Wind Monitor | R.M. Young 03002 Wind Sentry |
| --- | --- | --- |
| Speed accuracy | ±0.3 m/s or 1% | ±0.5 m/s |
| Direction accuracy | ±3° | ±5° |
| Speed starting threshold | 1.0 m/s | 0.5 m/s |
| Direction starting threshold | ~1.1 m/s | ~0.8 m/s |

Nothing in `metadata.json` names the instrument at a site, so `coagmet.js` exports one
conservative set rather than a per-station claim: **±0.5 m/s and ±5°** from the worse
sensor, and a calm ceiling of **1.0 m/s** from the *higher* of the two starting
thresholds, since a reported 0.0 could have come from either mast and the wider bound is
the one that cannot be too small. `COAGMET_QUANTISATION` is separate and much finer —
the archive stores 0.01 m/s and 0.1° — which is the same distinction the ASOS table
draws: the rounding is not the tolerance, and the tolerance is seven to fifty times it.

### USCRN's cup, and a tolerance read off the worse half of one line

USCRN documents a single instrument — the **Met One 014A cup anemometer** — in
`documentation/site/sensors/wind/Descriptions/Anemometer.pdf`, so unlike CoAgMet there is
no ambiguity about which sensor answered:

| | Met One 014A, as specified |
| --- | --- |
| Speed accuracy | "±0.25 mph or 1.5% FS" on a 100 mph range — **0.11 m/s or 0.67 m/s** |
| Starting threshold | 1.0 mph (**0.447 m/s**) |
| Distance constant | 15 ft |
| Direction | none: there is no vane in the sub-hourly product |

`uscrn.js` exports the **larger** of the two accuracy figures, 0.67 m/s, on the same
principle as CoAgMet's worse cup: a wider tolerance makes a candidate harder to call
significant, not easier. The calm ceiling is the starting threshold, **0.447 m/s** — and
on a 1.5 m mast that is not a corner case but the regime, which is why `verify.js` prints
what the calms could have contributed to the bias and subtracts none of it.
`dirToleranceDeg` is null because there is nothing to be wrong about, and a run against
this network prints a dash in the direction and vector columns rather than a number.

**A RAWS is not an ASOS, and none of this transfers to one.** No equivalent specification
has been read for the RAWS network, so `tools/score-wind.js` passes the FEMS and Synoptic
readers a null tolerance — "nobody has looked this up" — rather than borrowing ±2 kt and
attaching a citation to the wrong network. The one figure that can be derived is the calm
ceiling: FEMS speeds are whole miles per hour, so a 0 is anything below 0.22 m/s. That is
a **lower** bound on the censoring, since the cup's own starting threshold is larger and
unmeasured, so a run leaning on it understates the effect.

## A one-minute record, and what the pairing window costs

Everything above says an hourly model is paired with an observation whose own minute had
to be reconstructed, and that `--tolerance 30` was chosen by feel. NCEI publishes the
record that turns that into a measurement: **DSI-6405**, one-minute ASOS wind, a 2-minute
mean and a 5-second peak at every minute, back to 2000, about a thousand stations, free
and unauthenticated.

```
https://www.ncei.noaa.gov/data/automated-surface-observing-system-one-minute-pg1/access/YYYY/MM/asos-1min-pg1-<ID>-YYYYMM.dat
https://www.ncei.noaa.gov/pub/data/asos-onemin/td6405.txt   — the layout
```

`asos1min.js` reads page 1 and `tools/wind-decorrelation.js` scores it. What the parser
had to decide, because each one is a way of getting the answer wrong:

| | Decision |
| --- | --- |
| Layout | Fixed width, not delimited: direction at 70–74, speed at 74–79, peak direction 79–84, peak 84–89, in a 112-character record |
| Time | The local stamp gives the date and the clock; the UTC field gives the offset. Both are used, because the local stamp alone is ambiguous across a DST boundary |
| Missing | `M` is **absent**, not calm. Those minutes are counted and dropped, never read as zero |
| Calm | A numeric `0` stays 0 in the arithmetic and is flagged, because ASOS calm is censored at 2 kt and not measured |
| Direction | Pairs involving a calm are excluded from direction statistics and kept in speed statistics — a calm has a speed bound but no bearing |
| Not records | An NCEI 200 carrying an HTML 404, and an empty body, are both refused by name rather than parsed into an empty weather history |

That last one is not hypothetical: the cached `KCAO` September 2024 file is a 404 page,
and it had already been parsed once as a station with no wind in it. And `KABQ` March 2026
is a real hole of the other kind — 36,568 well-formed records in which every wind field is
`M`. Neither is an observation of calm; both are reported as refused.

The measurement itself — how fast the wind at these stations stops resembling itself, and
how much of every score in `docs/downscaling.md` was only the clock — is
[measurement 13](downscaling.md#measurement-13-how-much-of-every-score-was-only-the-clock).
The short version, over 819,249 minutes at 14 stations:

- the wind's own change reaches ASOS's ±2 kt after a **median 7.5 minutes** (2.8 to 27.1 by station);
- the runs in that note drew mean offsets of 12.6–14.3 minutes, which prices at **1.36–1.48 m/s of vector RMS and 23–25° of direction** against a 10-minute mean;
- interpolating between hours instead of taking the nearest one recovers about **12%** of it, and no pairing rule can recover the rest, because the sub-hourly variance is not in an hourly series at all.

The caveat that limits all of it: these are airports. Flat ground, a 2-minute mean rather
than a RAWS 10-minute mean, and a 3.6–6.2 m/s sample mean against the RAWS sample's 2.1.
It bounds the timing term for the runs already done; it cannot re-open the terrain
question, and it is not a RAWS specification.

## What an adapter has to refuse

FEMS answers an unknown station with **HTTP 200 and a blank row**:

```
"StationName","DateTime","ObservationType","Temperature(F)",…,"StationId","VPD(Pa)"
,,,,,,,,,,,,,,,,,,,,"999999",
```

It emits the same blank row for an hour inside the requested range that has no
observation, and for hours in the future. So "this station does not exist", "this
station was down" and "you asked about tomorrow" are the same response, and all three
look like a quiet, well-formed answer — the same shape as NOMADS' HTML-with-200 and
Synoptic's `RESPONSE_CODE`, and the reason both of those are checked explicitly. Any
adapter here must treat a blank row as absence of data and a fully blank station as a
refusal, and must not let either arrive at the scorer as an observation.

The rest of the checklist is the one `synoptic.js` already meets: normalise to the
records `observations.js` produces, keep the provider on the record, keep the station
metadata and the sensor-height assumption visible, decide units from the response rather
than from the request, and commit a real captured fixture so the suite is offline.

**Nobody publishes anemometer height.** Neither FEMS's metadata nor the MADIS mesonet
file carries it for RAWS. Synoptic does, for these stations, and that is why the
calibration map carries `sensorHeightM` with `sensorHeightSource: "synoptic"` beside it
rather than `fems.js` inventing one: the height moves the model wind by about 8.5%, in
the direction that makes HRRR look fast, so where the number came from has to survive the
change of provider.

## Using it: fems.js

```bash
# once per station, inside Synoptic's free window; no token is needed after this
SYNOPTIC_API_TOKEN=… node tools/fems-stations.js \
  --stations PCPC2,TT532,STOC2,KSHC2,PKLC2,RRAC2,LSTC2,DYGC2,SODC2,BMOC2,ESPC2 \
  --days 3 --out data/fems-stations.json

# then any window archive.js can reach, with no account at all
node tools/score-wind.js --source fems --archive \
  --stations PCPC2,STOC2,KSHC2 --end 2019-07-14T18:00:00Z --hours 24
```

`data/fems-stations.json` is committed. It is measured data with its provenance attached
rather than a cache — each entry records the hours checked, the agreement, and how far
apart the two services put the mast — and it cannot be regenerated by anyone without a
Synoptic token.

**Do the two services agree?** `tools/fems-agree.js` asks it of every hour rather than a
sample. Over the eleven stations and the five days Synoptic will still serve
(2026-09-01 → 09-06):

```
1318 hours in both services
worst speed disagreement     0.0005 m/s
worst direction disagreement 0°
hours only FEMS has          0 inside the window
hours only Synoptic has      2
```

Every direction identical, and the whole speed disagreement is Synoptic rounding the mph
conversion to 0.447 where this reader uses 0.44704. Scoring the same six hours end to end
through `tools/score-wind.js` gives the same report from either source, every row within
0.02 m/s — which grades the timestamps as well as the values, since a mispaired hour
would move the score and not the series.

It grades **the reader, not the archive**: both services are downstream of the same WIMS
feed, and Synoptic cannot reach the years FEMS is here for.

## Using it: coagmet.js

```bash
node tools/station-survey.js --source coagmet --state CO --limit 6 --position 2000
node tools/score-wind.js --source coagmet --stations gun01,alt01 --hours 3 --tolerance 30
```

No account, no token, and the same three methods `fems.js` and `synoptic.js` expose.
What the reader has to know about the service, all of it measured against the live API
and captured into `tests/fixtures/coagmet-*.json` by `tools/make-coagmet-fixtures.sh`:

| | What the API does | What `coagmet.js` does about it |
| --- | --- | --- |
| Units | `units=us` by default — heights in **feet**, speeds in mph | Asks for `units=m` and **refuses a reply whose declared `units` is not `m`** rather than converting on trust |
| Timestamp | `2026-08-01T21:00`, no offset in the string | Uses the reply's own `tzOffset`, never the runtime's zone |
| Interval | The label **ends** the averaging interval | Keeps `intervalStartMs`/`intervalEndMs`/`averagingSeconds`, and scores at the **midpoint** |
| Frequency | `/5min/` and `/hourly/`; a station has one native timestep | Reads `timestep` from the catalogue and asks for the product that station actually publishes |
| Missing number | `-999` | Refused as absent — never rounded to 0 and never scored as calm |
| Missing timestamp | empty string, with `-999` beside it | Refused as absent; a window of them is an empty series, not a calm hour |
| Zero speed | `windSpeed 0.0` with `windDir 0.0` beside it | `calm: true`, **`fromDeg: null`** — a 0 direction under a 0 speed is not a north wind |
| Unknown station | HTTP 400, `{"error": "Bad Request: Unknown station id zzz99"}` | A typed `unknown-station`, refused before any window is fetched |
| Wrong case | `5min/GUN01.json` answers the bare string `Invlid request` — not JSON, no error field | Catalogue keyed lower-case, and the **catalogue's** id is what goes into the URL |
| QC | defaults to the QC product and says so in `which` | Recorded as the source's own statement; no row-level QC is claimed on top of it |
| Raw | the documented raw syntax is ambiguous, and the endpoint guessed at returned QC data | **Unsupported.** A product that cannot be confirmed is not offered |

**The interval convention was proved from the data rather than read.** The hourly value
labelled `21:00` equals the mean of the twelve five-minute values labelled `20:05` through
`21:00` to within the archive's own 0.01 m/s quantisation — so both labels close their
interval, and a reader that took them as interval *starts* would sit an hour and five
minutes out at the hourly product. That comparison is a test, not a note.

**Height is published per station and is not defaulted.** `anemometerHeight` comes back
in the requested unit system — metres here, feet if anyone asks for `units=us` — and the
three active stations that publish none get `sensorHeightM: null` rather than the 2 m the
rest of the network would suggest. A station that will not say how high it is cannot have
its model wind moved to it.

**A score from it is not a validated near-ground field, and the summary now says so.**
Bringing HRRR's 10 m wind down to a 2 m mast is a log-law extrapolation *below* every
height this project has ever checked, and it moves the model by about **x0.72** — more
than every terrain candidate ever ablated, combined. `tools/score-wind.js` prints
"below anything this profile has been checked at" against any station under 3 m for
exactly that reason. And whether the HRRR analysis assimilates these masts has not been
established either way, so an f0 CoAgMet run reports its independence as **UNKNOWN**
rather than borrowing the airports' answer.

## Recommendation

**Do not buy anything yet.** Nothing currently open needs a paid tier:

1. **FEMS as the history source** for archive-backed scoring — same stations, 20 years,
   bulk CSV, no account. It unblocks seasons, regions and a station set chosen by
   topographic position, which is the run that would settle whether the `Sx` sheltering
   lead in `docs/downscaling.md` is real or is one leverage point.
2. **MADIS as the arbiter** — for the per-station transmit minute, for a QC verdict on a
   suspicious series, and for reaching networks FEMS does not carry.
3. **Keep the free Synoptic token** for live and recent-past work, which is what it is
   good at and where its account limit does not bite.
4. **CoAgMet and USCRN** — 2 m and 1.5 m respectively, 5-minute, no account, and the only
   instruments found that stand inside the 0–3 m layer `docs/near-ground-wind.md` is
   about. Both now have adapters. What either one grades is the model brought *down* to
   the mast by an untested profile, not a near-ground field, because there is not one
   yet — and USCRN, being national and directionless, is a **second independent check on
   the same bias** rather than a second input.

If a commercial source is wanted later, the question to ask a vendor is not coverage or
price but **"is this an anemometer or a reanalysis, and what timestamp convention is on
it"** — the second one is what nearly poisoned this comparison, and it is not on anyone's
pricing page.

## What is not known

- **The FEMS QC flag semantics.** The columns exist and carry `0`, `1` and `2`; nothing
  in the public bundle says what they mean. `fems.js` keeps flagged rows, labels them
  (`quality: "WS=2"`) and counts them, and drops them only for a caller that has decided
  what a flag means. **So a FEMS-fed run is unfiltered by QC**, where the Synoptic runs
  it is compared against dropped flagged rows — a difference that did not show up above
  only because those five days contain no flagged rows.
- **Whether a transmit slot has always been that slot.** It is measured this week and
  applied back to 2005. A station whose GOES assignment changed carries up to an hour of
  error before the change and none after it, and neither service announces it. MADIS
  keeps the minute back years and would settle it; that has not been done.
- **FEMS rate limits and terms of use.** No documented limit was found and none was
  provoked; the request pattern used here was a handful of calls. It is a US federal
  system, so the data is public domain, but "no published limit" is not "no limit", and
  a 20-year 96-station pull should be batched and cached rather than repeated.
- **Whether they disagree outside the overlap.** They cannot be compared where it
  matters: the years FEMS is being used for are exactly the years Synoptic will not
  serve. MADIS is the only way to check a historical FEMS value against anything.
- **The FEMS elevation unit.** `elevation` is unitless in the metadata and is read as
  feet, which agrees with Synoptic and with the published elevation at all eleven matched
  stations. That is an inference from agreement, not from documentation.
- **The RAWS instrument specification.** The NWCG/NFDRS standards behind the 6.1 m mast
  should state a starting threshold, an averaging period and an accuracy the way the ASOS
  User's Guide does. They have not been read, so twelve of the twelve measurements in
  `docs/downscaling.md` are scored against a network whose own tolerance is unknown.
  Until they are, `RAWS_INSTRUMENT` in `tools/score-wind.js` carries nulls.
- **How far the calibration reaches.** Eleven Colorado stations. `--source fems` refuses
  a station with no map entry rather than falling back to the hour label, so widening the
  study means widening the map first.
- **How far behind the MADIS archive tree actually runs**, and whether the live directory
  is a fixed rolling window.
- **Whether `windSpeed10` is ever populated.** It is empty for every provider in the one
  hour opened, and one hour is not the archive. Nothing was found in the file's variable
  attributes that states a sensor height either, so the conclusion "MADIS does not carry
  the height" rests on a single 383 MB sample.
- **What CoAgMet's QC actually checks.** The reply says `which: "qc"` and that is the
  whole of what is documented: no per-row flag, no list of tests, no way to tell a value
  that passed from one that was never examined. `coagmet.js` records the mode and claims
  nothing more, which is the FEMS flag problem again in a different shape.
- **CoAgMet's raw product.** The documented syntax for it is ambiguous and the endpoint
  guessed at returned QC data, so the reader offers QC only. Any comparison of raw against
  QC — the one measurement that would say what the QC does — is therefore not available.
- **CoAgMet terms of use and rate limits.** None published, none provoked; the traffic
  here was a handful of calls and a fixture capture.
- **Which anemometer is at which CoAgMet station**, which is why one conservative
  network-level tolerance is exported rather than a per-station one.
- **Which Met One 014A is at which USCRN mast, and when it was last calibrated** — the
  network documents one anemometer, so the exported tolerance is the specification's
  larger figure (±1.5% of a 100 mph full scale = ±0.67 m/s, not the ±0.25 mph line), and
  no per-station claim is made.
- **Why WBAN 03074 has been flagged wholesale since 2024** — the flag is honoured, the
  cause is unread.
- **Whether HRRR assimilates USCRN.** As with CoAgMet, NCEP's use list has not been read,
  so an f0 run reports UNKNOWN independence.
- **Whether HRRR assimilates CoAgMet.** NCEP's mesonet use and rejection lists have not
  been read, so an f0 run against these masts is reported as UNKNOWN independence rather
  than as an analysis fit or as a clean out-of-sample score.
- No run in `docs/downscaling.md` has been scored against a mast below 6.1 m as evidence
  about the downscaling; the CoAgMet smoke run exists to exercise the reader.
- **What a CoAgMet 2 m mast on irrigated ground represents.** The metadata carries an
  `irrigation` field with `full`, `part` and `dry` in it, which is a statement about the
  surface and the stability directly under the anemometer. Nothing here has used it, and
  the 520 m Fort Collins pair straddles it — `ftc01` is `part`, `fcc01` is `dry`.
- **IEM's mesonet holdings.** Its network list has no RAWS entry, but 600 networks were
  not enumerated one by one, and the single data call made returned a capacity error.
- No run in `docs/downscaling.md` has yet been re-scored over a window Synoptic could not
  reach. The adapter is what makes those runs possible; it has not made them.
