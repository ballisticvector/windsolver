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
- [The three providers disagree about when the wind was measured](#the-three-providers-disagree-about-when-the-wind-was-measured)
- [What an adapter has to refuse](#what-an-adapter-has-to-refuse)
- [Using it: fems.js](#using-it-femsjs)
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
- **How far the calibration reaches.** Eleven Colorado stations. `--source fems` refuses
  a station with no map entry rather than falling back to the hour label, so widening the
  study means widening the map first.
- **How far behind the MADIS archive tree actually runs**, and whether the live directory
  is a fixed rolling window.
- **IEM's mesonet holdings.** Its network list has no RAWS entry, but 600 networks were
  not enumerated one by one, and the single data call made returned a capacity error.
- No run in `docs/downscaling.md` has yet been re-scored over a window Synoptic could not
  reach. The adapter is what makes those runs possible; it has not made them.
