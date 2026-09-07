# Why the terrain downscaling does not yet earn its place

A working note, not a conclusion. It records what has been measured against real
anemometers, what those measurements do and do not license anyone to say, and the
specific things that would settle the open questions. **No default and no formula has
been changed on the strength of anything in here**, and none should be until at least
the repeats in [What would settle it](#what-would-settle-it) have been run.

If you are picking this up cold: `downscale.js` is the module in question,
`tools/score-wind.js` is the harness, `tools/station-survey.js` chooses the stations and
`tools/model-terrain.js` produced the orography comparison below.

## Contents

- [The question](#the-question)
- [What the downscaling actually does](#what-the-downscaling-actually-does)
- [Measurement 1: the terms, one at a time](#measurement-1-the-terms-one-at-a-time)
- [Measurement 2: the same scores with each candidate's own bias removed](#measurement-2-the-same-scores-with-each-candidates-own-bias-removed)
- [Measurement 3: split by the ground the station stands on](#measurement-3-split-by-the-ground-the-station-stands-on)
- [Measurement 4: the ground the model thinks it is blowing over](#measurement-4-the-ground-the-model-thinks-it-is-blowing-over)
- [Measurement 5: subtracting that ground, and scoring it](#measurement-5-subtracting-that-ground-and-scoring-it)
- [Measurement 6: the curvature term's two halves, through the debiased table](#measurement-6-the-curvature-terms-two-halves-through-the-debiased-table)
- [Measurement 7: six runs off the archive, and what roughness does to the bias](#measurement-7-six-runs-off-the-archive-and-what-roughness-does-to-the-bias)
- [Measurement 8: the first day Synoptic would not sell](#measurement-8-the-first-day-synoptic-would-not-sell)
- [Measurement 9: how much of the error belongs to the station](#measurement-9-how-much-of-the-error-belongs-to-the-station)
- [Measurement 10: a scale instead of an offset, and the station the fit never saw](#measurement-10-a-scale-instead-of-an-offset-and-the-station-the-fit-never-saw)
- [Measurement 11: the same question on 37 stations chosen by the ground](#measurement-11-the-same-question-on-37-stations-chosen-by-the-ground)
- [Measurement 12: a second state, and a descriptor that works in one of them](#measurement-12-a-second-state-and-a-descriptor-that-works-in-one-of-them)
- [Measurement 13: how much of every score was only the clock](#measurement-13-how-much-of-every-score-was-only-the-clock)
- [Measurement 14: the valleys were there all along, at a radius nobody asked at](#measurement-14-the-valleys-were-there-all-along-at-a-radius-nobody-asked-at)
- [The hypotheses, and how much weight each one carries](#the-hypotheses-and-how-much-weight-each-one-carries)
- [What would settle it](#what-would-settle-it)
- [Things that would poison the answer](#things-that-would-poison-the-answer)
- [Worth exploring, unranked](#worth-exploring-unranked)
- [What is not known](#what-is-not-known)
- [Claude's review](#claudes-review) - appended, per the review convention in `AGENTS.md`

## The question

Scored against RAWS stations it was not fitted to, the terrain downscaling is **no
better than raw HRRR overall and clearly worse on ridges.** That is the opposite of what
a terrain correction is for, and it happens on precisely the ground the correction
exists to handle.

The first version of that result was reported as "the downscaling is worse". It was not
wrong, but it was close to meaningless, for reasons in the next two sections. By
[measurement 6](#measurement-6-the-curvature-terms-two-halves-through-the-debiased-table)
the "clearly worse on ridges" half of the sentence has gone the same way: it is the
model's speed bias being multiplied on the stratum with the least room for it, and it
disappears when that bias is divided out.

## What the downscaling actually does

`downscale.js` bends a model wind with four separable pieces:

```js
const f = (1 + gains.slope * os + gains.curvature * oc) * (1 - gains.shelter * ox);
```

- **slope** — speed-up along the component of the slope facing the wind, `os`;
- **curvature** — speed-up over convex ground and slow-down in concave ground, `oc`.
  Those are two claims on one coefficient, and `curvatureConvex` / `curvatureConcave`
  grade them apart; each defaults to `curvature`, so naming neither changes nothing;
- **shelter** — a reduction by an upwind exposure/shelter index `Sx`, `ox`. **It is only
  derived when a caller asks for it**, so in every ordinary run this multiplies by one
  and the coefficient in the defaults is inert;
- **diversion** — a rotation of the direction, `-0.5 * os * sin(2 * (aspect - theta))`,
  which changes the bearing and not the speed.

Each is scored on its own by `tools/score-wind.js --ablate`.

## Measurement 1: the terms, one at a time

13 Colorado RAWS, 24 hours, forecast hour 6, 312 observations, one station-hour each.
Same stations, same hours, same domains, same 6.1 m sensor height for every candidate.

```
candidate          obs  spd bias  spd rmse  dir bias  dir rmse  vec rmse  gain
HRRR alone         312      1.49      2.64       9.5      70.5      3.63  x1.000
downscaled         312      1.61      2.67       9.9      70.8      3.70  x1.034
slope only         312      1.52      2.67       9.9      70.8      3.67  x1.007
curvature only     312      1.58      2.63       9.9      70.8      3.66  x1.031
no diverting       312      1.61      2.67       9.9      70.5      3.69  x1.034
diverting only     312      1.49      2.64       9.9      70.5      3.64  x1.000
shelter only       312      1.47      2.60       9.9      70.8      3.60  x0.994
no shelter         312      1.61      2.67       9.9      70.8      3.70  x1.038
```

**Read the `gain` column before the error columns.** HRRR's mean wind over these
stations is 3.63 m/s where the anemometers measure 2.15 — it runs about 70% fast — so
while an error that size dominates, every multiplicative candidate is being graded on
its *sign* and not on its physics. Every one of the five candidates with a gain above 1
scores worse than HRRR, the one with a gain below 1 scores better, and the one that
leaves the speed alone scores the same — in that order, and regardless of the ground the
station stands on. That is a ranking of gains, not a ranking of terrain models.

## Measurement 2: the same scores with each candidate's own bias removed

Same 312 pairs; each candidate's own mean observed/modelled speed ratio divided out
before scoring, direction untouched.

```
candidate          spd rmse  vec rmse
HRRR alone             1.75      2.60
downscaled             1.68      2.56
slope only             1.75      2.60
curvature only         1.69      2.56
no diverting           1.68      2.55
diverting only         1.75      2.60
shelter only           1.73      2.59
no shelter             1.69      2.56
```

- **Curvature carries the whole of the terrain correction.** Slope-only reproduces raw
  HRRR to three figures: as scored, it is doing nothing.
- **Diversion has no skill here and costs a little.** Direction RMSE is 70.5° with it off
  and 70.8° with it on in every stratum, and debiased it is the only candidate worse than
  the model.
- **Shelter is nearly inert even when a real `Sx` field is derived** — x0.994, six tenths
  of one per cent. It topped the raw table only because it is the one candidate that
  slows the wind down.

**This is an in-sample diagnostic and not validation.** The scale factor is fitted on the
same observations it is then scored against; it says which candidate has the better
*shape* once the mean is granted, which is a different and weaker claim than skill.

## Measurement 3: split by the ground the station stands on

Landform from `derive.positionIndexAt` over a 500 m disc: ridge at ≥ +15 m, valley at
≤ −15 m.

```
stratum   n    spd bias   vec rmse HRRR → downscaled
valley    96      +2.09       3.80 → 3.46
slope     72      +2.01       3.53 → 3.62
flat      48      +1.86       3.54 → 3.44
ridge     96      +0.30       3.58 → 4.05
```

**HRRR is already close to right on ridges and about 2 m/s too fast everywhere else.**
The downscaling improves valleys and flats, and on ridges — the one stratum where the
model had nothing left to give — it turns 3.58 into 4.05 by speeding an already
sufficient wind up further. That is exactly what a convex speed-up term is built to do.

## Measurement 4: the ground the model thinks it is blowing over

`tools/model-terrain.js`, HRRR surface orography for the same cycle against the 3DEP
ground under each station's published coordinate. Live run, 2026-09-04T18:00Z f06:

```
station    3DEP m  model m  model-3DEP    tpi500m   model tpi7.5km
PCPC2        2715     2774          59      -15.1            -13.2
TS578        2094     2202         108      -19.1            144.8
TS723        2252     2344          93      -17.5            108.5
TT532        2700     2722          21      -26.4            349.2
STOC2        2638     2552         -85       97.0            123.4
KSHC2        3101     3035         -66       40.5            -44.2
PKLC2        2835     2928          93       22.4             76.6
RRAC2        2810     2706        -104       33.7            160.1
LSTC2        3240     3220         -20       11.7            -20.8
DYGC2        2339     2266         -73       10.8           -184.2
SODC2        2905     3001          96      -10.0            -90.0
BMOC2        2719     2632         -87       12.8            148.4
ESPC2        2395     2415          19       -9.2           -176.6
```

By stratum:

```
stratum   n   mean model − 3DEP   mean tpi500m   mean model tpi7.5km
valley    4             +70 m           -19.5                +147.3
middle    5             -13 m             +3.2                 -64.7
ridge     4             -41 m            +48.4                 +78.9
```

That is the signature of smoothing, measured rather than assumed: **the model's ground
sits 70 m above the floor of a valley station and 41 m below the top of a ridge
station.** And the two landform indices agree in sign at only 7 of 13 stations — at the
model's scale, four of the four valley stations sit on *high* ground, because a gulch cut
into a plateau is a plateau to a 3 km grid.

**This is a disagreement, not an error on either side.** HRRR's orography is the ground
its dynamics actually ran over and is correct for that purpose; 3DEP is the ground the
anemometer stands on. The difference is the part of the landform the model could not see
— which is the only part a downscaling has any business adding.

## Measurement 5: subtracting that ground, and scoring it

The run measurement 4 asked for. `tools/score-wind.js --anomaly` derives the terrain
weights from the fine DEM **minus a smoothed regional surface** — `derive.smooth` over a
disc, `derive.anomaly` sampling it back by position — so the correction adds only the
landform the model could not resolve. Station elevation and the ridge/valley
classification still come from the unmodified DEM. Same 13 stations, same 24 hours, same
312 pairs, f06.

Ridge and valley vector RMSE, in m/s, at two smoothing radii:

```
candidate                 ridge (96)   valley (96)
HRRR alone                      3.58          3.80
downscaled                      3.97          3.59
fixed scales                    4.02          3.56
terrain anomaly, 3 km           3.93          3.62
terrain anomaly, 1 km           3.92          3.61
anomaly, fixed scales, 3 km     3.98          3.60
anomaly, fixed scales, 1 km     3.96          3.59
anomaly slope only              3.62          3.86
```

**The subtraction does not rescue the ridges.** 3.97 becomes 3.93, against 3.58 for the
raw model; halving the radius from 3 km to 1 km moves it by another 0.01. The terrain
anomaly is a strictly better-motivated input than the absolute landform, and on this
sample it buys about 1% of the ridge penalty.

The reason is a scale mismatch that measurement 4 did not expose: **the curvature term
reads a 500 m length and the slope term reads hillslope gradients, and neither of those
wavelengths is in a 1–3 km regional mean.** Removing the mean removes the part of the
landform the terms were already blind to. So the ridge penalty is not the model's own
orography being added twice through this pathway, and hypothesis 1 as written is not
supported.

Two things the run did show, neither of which is a result:

- **The slope term is the whole of the ridge penalty.** `anomaly slope only` scores 3.62
  on ridges against the model's 3.58, while every candidate carrying curvature sits near
  3.95. In measurement 2 curvature looked like the term doing the useful work; split by
  ground it is the term doing the damage, on the one stratum where the model needed no
  help.
- **A domain-relative weight hides a change in its own input.** Normalised against the
  domain's extremes, the residual and the DEM it came from each divide by their own
  largest value, so the anomaly gain (x1.040) and the absolute gain (x1.038) are almost
  the same number for visibly different terrain. The fixed-scale rows exist so the
  subtraction is graded rather than the divisor.

Artefacts: `--ablate --scales --anomaly` and the same with `--anomaly 1000
--anomaly-resolution 30`.

## Measurement 6: the curvature term's two halves, through the debiased table

The run [Claude's review](#claudes-review) parked, and the one measurement 5 asked for.
`Wc*Oc` makes two claims with one coefficient — a crest speeds the wind up, a hollow
slows it down — and the sign of `omegaC` separates them for nothing.
`downscale.js` now takes `curvatureConvex` and `curvatureConcave`, each defaulting to
`curvature`, so an ordinary field is unchanged; `--ablate` scores four more rows.

**This is not the same 312 pairs as measurements 1-5.** NOMADS had expired most of that
window's cycles by the time the split existed, so this is 13 stations x 24 hours ending
2026-09-05T19:00Z, f06 — the same stations, a different day. It is a repeat as well as a
split, which is worth having and is also why nothing below should be read as the same
sample moving.

Vector RMSE, m/s. `raw` is as scored; `debiased` divides each candidate's own overall
speed bias out, one scale over every pair.

```
                        overall            ridge (96)         valley (96)
candidate            raw   debiased     raw   debiased     raw   debiased
HRRR alone          3.22       2.25    3.23       2.54    3.39       2.17
downscaled          3.22       2.19    3.46       2.54    3.16       2.03
curvature only      3.24       2.20    3.49       2.55    3.18       2.04
no convex speed-up  3.12       2.22    3.20       2.54    3.16       2.08
no concave slow-down 3.29      2.20    3.46       2.53    3.37       2.10
convex only         3.31       2.21    3.49       2.54    3.39       2.11
concave only        3.14       2.23    3.23       2.55    3.18       2.10
```

**Raw, the whole ridge penalty is the convex half, and dropping it returns the ridge
column to the model's own score**: 3.46 becomes 3.20 against HRRR's 3.23. The concave
half is inert there, which is partly arithmetic — a ridge station's own pixel is convex
by the same 500 m operator that classifies it — and the mirror holds in valleys, where
the concave half carries the whole of the gain and the convex half does nothing at all.

**Debiased, none of it survives.** Every one of the ten candidates lands between 2.53 and
2.55 on ridges, HRRR included. That is the test the debiased table was added for, and it
comes back negative: the ridge penalty was the gain — convex ground is where the term
speeds the wind up, and speeding up a wind that is already about 1.7x too fast costs
vector RMSE wherever it happens. It is not a fact about where the term puts the wind, so
**hypothesis 1 as written is not supported**, and a candidate that clips the convex
response would be fitting the bias rather than the physics.

Two things that do not follow the same way:

- **The valley gain is not the concave half either.** Debiased, the whole term scores
  2.03 in valleys and each half alone scores 2.10 and 2.11, against HRRR's 2.17. Both
  signs contribute, and neither reproduces the pair.
- **Debiased, the whole ablation spans 0.06 m/s** — 2.19 to 2.25 against an error of
  2.2 m/s. Once the bias is out, on this sample, none of the terrain terms is doing much
  of anything in either direction. That is a smaller claim than "the correction hurts"
  and a smaller one than "the correction helps".

A second run over the *original* window agrees on the part that matters, on the 156 of
312 pairs whose cycles NOMADS still had: ridge raw 3.50 model, 3.62 downscaled, 3.49 with
the convex half dropped; ridge debiased 3.32, 3.30, 3.31. Same shape, same disappearance.

*Measured. Caveats that do not shrink: a different day from measurements 1-5, so the
strata are not in the same condition — the overall speed bias is +1.29 m/s here against
+1.62, and the ridge stratum is +0.81 against +0.30. 312 observations are 13 stations x 24
consecutive hours. The debias scale is fitted on the pairs it is then scored against.
"Convex" is the sign of `omegaC` at a 500 m length scale, which is a property of that
operator and not of the landform.*

Artefacts: `--ablate` over both windows.

## Measurement 7: six runs off the archive, and what roughness does to the bias

Two things arrived together. `archive.js` reads HRRR out of the AWS Open Data bucket a
message at a time, so a cycle NOMADS has forgotten can still be scored and "does it
repeat" stops being a question about the last two days. And `roughness.js` gives the
harness Davenport roughness classes and Wieringa's two-surface exposure correction, so
the single national `z0 = 0.03 m` in `downscale.heightFactor` can be scored against
alternatives instead of argued about. **Neither changes a default**: `roughness.js` is
research-only, nothing imports it from the runtime path, and `nomads.js` is untouched.

Six runs, all `--archive --exposure --ablate`: 2026-08-31, 09-02 and 09-04, each at f00
and f06, 13 Colorado RAWS x 24 hours, 30-minute pairing tolerance. 1776 pairs. The new
candidates all keep the default downscaling and change only the surface the wind is
brought down over: `z0 0.25/1.0 m` are one-step log-law substitutions for the 0.03 m
default, `z0 = SFCR` uses **HRRR's own published surface roughness at the station**, and
the `exposure` rows go up to a 60 m blending height over HRRR's surface and back down
over an asserted site surface, which is the correction Wieringa's method is actually for.

Overall vector RMSE, m/s, and each candidate's own speed bias:

```
                 08-31 f00   08-31 f06   09-02 f00   09-02 f06   09-04 f00   09-04 f06
candidate        bias  vec   bias  vec   bias  vec   bias  vec   bias  vec   bias  vec
HRRR alone       0.94 3.12   1.43 3.92   1.08 3.03   1.42 3.47   1.30 3.24   1.47 3.62
downscaled       1.10 3.14   1.60 4.00   1.20 3.02   1.54 3.50   1.42 3.27   1.59 3.69
z0 0.25 m        0.95 3.04   1.43 3.86   1.05 2.92   1.38 3.37   1.24 3.16   1.41 3.56
z0 = SFCR        0.89 2.99   1.35 3.79   0.99 2.90   1.31 3.34   1.18 3.12   1.34 3.52
z0 1.0 m         0.70 2.90   1.14 3.65   0.80 2.78   1.10 3.17   0.95 3.00   1.10 3.37
exposure rough   1.07 3.14   1.57 4.01   1.16 2.97   1.49 3.41   1.35 3.23   1.51 3.62
exposure v.rough 0.75 2.92   1.20 3.70   0.83 2.74   1.13 3.13   1.00 2.97   1.14 3.32
exposure closed  0.33 2.70   0.71 3.34   0.40 2.50   0.65 2.80   0.52 2.68   0.65 2.98
```

Three results, in increasing order of how much they should change anyone's mind.

**The bias repeats, and forecast hour is not incidental to it.** Observed mean is
2.13-2.15 m/s on all three days; HRRR is between +0.94 and +1.47 m/s fast, so "about 70%
fast" was the top of a range that runs from about 44%. **On every date the f06 bias is
0.17-0.49 m/s larger than the f00 bias from the same day.** These stations feed the
analysis, so f00 is graded on a field that has already been pulled toward them; the gap
is the size of that pull, and the f06 column is the honest one. Every earlier number in
this note taken at f00 understates the bias by roughly that much.

**Raw, the roughest exposure candidate wins every single run** — 0.4 to 0.6 m/s off the
vector RMSE, 13-16%, on three days and two lead times without exception. It is the
largest improvement anything in this investigation has produced.

**Debiased, it buys nothing.** Divide each candidate's own overall scale out and the
whole roughness family collapses onto the plain downscaling:

```
debiased vector RMSE       08-31 f00  08-31 f06  09-02 f00  09-02 f06  09-04 f00  09-04 f06
HRRR alone                      2.63       2.97       2.41       2.54       2.42       2.60
downscaled                      2.54       2.92       2.33       2.49       2.36       2.56
z0 = SFCR                       2.55       2.92       2.36       2.51       2.39       2.59
z0 1.0 m                        2.57       2.94       2.37       2.52       2.43       2.62
exposure closed                 2.57       2.94       2.34       2.48       2.41       2.59
```

Every roughness row is within 0.03 m/s of the plain downscaling and in most runs very
slightly *worse* than it. The fitted scales say the same thing from the other side: the
sample needs about x0.60, the roughest defensible exposure correction supplies x0.77-0.87,
and what it supplies is a **constant**. A per-station correction that behaves like a
constant is not measuring the station.

That is worth testing directly rather than inferring, so: per station, pooled over all
six runs, the scale that station actually needs — its observed mean over its modelled
mean — against HRRR's surface roughness under it.

```
station  class    n   SFCR   needs   z0=SFCR factor
LSTC2    slope  144  0.633   0.208            0.821
TS578    valley 144  0.154   0.303            1.000
TT532    valley 144  0.156   0.310            1.000
ESPC2    flat   144  0.241   0.402            0.867
PKLC2    ridge  144  0.678   0.453            0.816
KSHC2    ridge  144  0.311   0.507            0.858
DYGC2    slope  144  0.173   0.587            0.878
SODC2    slope  144  0.693   0.589            0.815
PCPC2    valley 144  0.477   0.758            0.838
BMOC2    flat   144  0.175   0.834            0.878
TS723    valley  48  0.225   0.835            0.576
RRAC2    ridge  144  0.623   1.225            0.822
STOC2    ridge  144  0.251   1.676            0.866
```

**The stations do not need one bias; they need scales from x0.21 to x1.68**, and the
correlation between what a station needs and the roughness under it is **r = -0.02**.
Not weak — absent. The correction the model's own roughness field prescribes correlates
with the correction the station wants at r = -0.27, which is the wrong sign. The +0.9 to
+1.5 m/s "bias" is the mean of a distribution eight times wider than itself, containing
two stations the model is too *slow* over, and aerodynamic roughness predicts no part of
where a station sits in it.

**Hypothesis 3's roughness half is therefore not supported.** SFCR over these thirteen
runs 0.15-0.69 m against the national 0.03 m, so the default really is wrong as a
description of the ground — and correcting it does not make the wind land in a better
place. It only slows everything down, and a single tuned constant does that better.

One thing did correlate, and it is not offered as a result. Against the 500 m
topographic position index the same needed scales give **r = +0.70**: sheltered ground
needs the wind slowed hard, exposed ground barely at all, which is the sheltering signal
the inert `Sx` term is supposed to carry. Then the leave-one-out checks: **drop STOC2 and
r falls to 0.31** — one station of thirteen carries it — and predicting a held-out
station's scale from the other twelve beats predicting the sample mean by 0.363 against
0.427, a 15% improvement on a two-parameter fit. **That is a hypothesis with one leverage
point under it, not a finding**, and it is the first thing more stations would settle.

*Measured, except where noted. Caveats: the exposure candidates' site roughness is an
asserted Davenport class, not a land-cover lookup at the station — "closed" is a
statement that these towers stand in something like closed forest, which for a Colorado
RAWS is a guess made to bracket the arithmetic. Three days is not a season, thirteen
stations is not a region, and 24 consecutive hours are not 24 independent samples. f00
is not independent of the analysis at all. The debias scale is fitted on the pairs it is
scored against. Pairing tolerance is 30 minutes here against 10 in earlier runs, which
changes which observations are in the sample.*

*The archive can reach 2014. The observation account cannot: Synoptic refused history
older than about six days with `does not have access to the requested history`, which is
why three recent dates were scored rather than three seasons. Archive-backed repeats over
arbitrary history are unblocked in the code and blocked on that token.* — *no longer:
`fems.js` reads the same RAWS back to 2005 without an account, and
[measurement 8](#measurement-8-the-first-day-synoptic-would-not-sell) is the first run
through it.*

Artefacts: `--archive --exposure --ablate`, six runs, JSON kept outside the repo.

## Measurement 8: the first day Synoptic would not sell

The last line of measurement 7 is that the archive reaches 2014 and the observation
account reaches about six days. `fems.js` removes that half of the wall: USDA FEMS serves
the same RAWS back to 2005 with no account. This is the first score in this note taken
over a window Synoptic refuses.

**2026-03-14 19:00Z to 2026-03-15 18:00Z, f00, archive HRRR, eleven calibrated Colorado
RAWS, 264 pairs, `--tolerance 30`** — roughly six months before any run above, and a
different season:

```
candidate      obs   spd bias  spd rmse  vec rmse        debiased: spd rmse  vec rmse
HRRR alone     264       2.21      4.54      5.92                      3.72      4.90
downscaled     264       2.50      4.35      5.81                      3.38      4.63

valley hrrr     48       5.13      6.26      7.27                      3.98      5.04
valley down     48       4.36      5.46      6.53                      3.32      4.43
ridge hrrr      96       0.44      4.49      5.63                      4.84      5.62
ridge down      96       1.49      4.42      5.73                      4.43      5.35
```

**The bias repeats in another season, and it is multiplicative rather than additive.**
This is the most useful thing in the run, and it needed a windy day to see. The observed
mean here is 5.14 m/s against 2.13-2.15 m/s on all six September runs — a genuinely
different regime, not another sample of the same one — and the bias goes up with it:

```
                observed   bias   model / observed
September runs      2.14   0.94-1.47      1.44-1.70x
March run           5.14   2.21           1.43x
```

An additive offset fitted on September would have predicted about +1.2 m/s in March and
under-read the error by a factor of two. A multiplicative one predicts 1.4-1.7x and lands.
Seven runs over two seasons and a 2.4x range of observed wind speed now say **HRRR is
proportionally fast, not fast by a fixed amount** — which is what makes the debiased table
the right instrument rather than a convenience, and which no amount of scoring inside one
week could have shown.

**The ridge penalty is present raw and absent debiased, for the third time.** 4.49 → 5.73
raw, 5.62 → 5.35 debiased. Measurement 6 concluded that on a different sample; it holds on
a sample from a different season, which is the first thing in this note to survive that
test.

**And the valley gain is the largest yet** — 5.04 → 4.43 debiased, 0.61 m/s, against
0.06 m/s spanning the entire ablation in measurement 6. Whatever the terrain terms do,
they do it in hollows and on a windier day.

One station is worth naming rather than averaging away. **DYGC2, Dry Gulch, ran 151° from
the model for all 24 hours** — mean absolute direction error 118°, within 30° on one hour
out of 24, observed 2.8 m/s against a modelled 6.6. That is what a drainage does to a
gradient wind, and **the downscaling cannot represent it at all: it scales speed and never
veers.** It is not a reader fault — FEMS and Synoptic agree on every direction this station
reported in the five overlapping days — but it is a March day read through a September
calibration, and a vane that had been knocked round would look identical. Directional
skill in channelled terrain is untested and this is the first evidence about it.

*Caveats: one day, one state, eleven stations, 24 consecutive hours. The 30-minute
tolerance is not optional here — at the 10-minute default, five of the eleven stations
have no observation inside the window at all, because their transmit slots are :19 to :25
off the hour. The transmit minutes were measured this September and applied to March;
nothing checks that a GOES slot never moved. f00 is not independent of the analysis, and
these are RAWS, which the analysis assimilates. The debias scale is fitted on the pairs it
is scored against.*

Artefacts: `--source fems --archive --tolerance 30`, JSON kept outside the repo.

## Measurement 9: how much of the error belongs to the station

Every measurement above asks what a *formula* can do with the terrain. This one asks the
prior question: **how much of the error is a property of the site at all, rather than of
the day?** If a station's error is the same next week, something can be learned from
history and looked up. If it is not, there is nothing to store.

It needed no new run. `tools/site-factor.js` reads the run summaries measurements 7 and 8
already wrote and reconstructs what a score *would* have been with a constant subtracted
from every error, out of the mean and the RMSE alone:

```
mean((d - c)^2) = rmse^2 - 2*c*bias + c^2
```

exactly, because the cross term is `n * bias` by definition. So an offset measured on one
day can be scored against a different day with no pairs and no re-fetch. `pooled` below
is one offset shared by every station; `station` is a per-station offset **measured on the
run in the second column and applied to the run in the first**, which is out of sample
whenever those differ.

```
scored on              corrected by                       pairs     raw   pooled  station
2026-08-31-f0-t30      2026-09-02-f0-t30                    288   2.515    2.334    1.929
2026-08-31-f0-t30      2026-09-04-f0-t30                    288   2.515    2.334    1.913
2026-08-31-f0-t30      itself (hindsight, not a result)     288   2.515    2.334    1.625
2026-09-02-f0-t30      2026-08-31-f0-t30                    288   2.344    2.078    1.746
2026-09-02-f0-t30      2026-09-04-f0-t30                    288   2.344    2.078    1.581
2026-09-02-f0-t30      itself (hindsight, not a result)     288   2.344    2.078    1.403
2026-09-04-f0-t30      2026-08-31-f0-t30                    288   2.404    1.974    1.678
2026-09-04-f0-t30      2026-09-02-f0-t30                    288   2.404    1.974    1.526
2026-09-04-f0-t30      itself (hindsight, not a result)     312   2.318    1.922    1.300
```

**A one-line-per-station table, learned on a different day, takes 23-37% off the speed
RMSE. One national offset takes 7-18%.** That is the largest effect anywhere in this note,
and it is out of sample: the correction is twelve numbers measured on 31 August and
graded on 4 September. Every terrain candidate scored in measurements 1-8 spans 0.06 m/s
debiased. This is 0.6-0.9 m/s.

The offsets are not noise being fitted, and the repeatability says so directly:

```
pair                                     stations   bias r  ratio r
2026-08-31 vs 2026-09-02                       12     0.80     0.94
2026-08-31 vs 2026-09-04                       12     0.84     0.90
2026-09-02 vs 2026-09-04                       12     0.90     0.91
2026-09-04 vs 2026-03-14 (fems)                11     0.77     0.68
```

The **ratio** — modelled mean over observed mean — is the more repeatable of the two
within a week, r = 0.90-0.94, which agrees with measurement 8's finding that the bias is
proportional. It runs from x0.45 at STOC2 to x6.17 at LSTC2. One national scale factor
cannot be thirteen numbers spanning fourteen-fold, and measurement 7 already showed the
thirteen are not sorted by the roughness under them (r = -0.02).

**Across a season it decays but does not vanish**, and the decay is asymmetric in a way
that matters:

```
scored on              corrected by                       pairs     raw   pooled  station
fems-march30           2026-09-04-f0-t30                    264   4.542    3.969    3.394
fems-march30           itself (hindsight, not a result)     264   4.542    3.969    2.283
2026-09-04-f0-t30      fems-march30                         264   2.342    1.986    2.858
```

September's offsets still take 25% off March — better than March's own pooled offset — but
**March's offsets applied to September are worse than no correction at all**, 2.34 → 2.86.
That is exactly what a proportional error looks like when it is corrected additively: an
offset fitted on a 5.14 m/s day is far too large for a 2.14 m/s one, while one fitted on a
calm day is merely too small. The right form is a scale, and a scale cannot be scored from
these summaries — `mean(model^2)` is not in them. **That is the argument for storing the
pairs**, made in `docs/history.md` and acted on in measurement 10.

**What this does not license.** It is not a correction that can ship, for one reason that
no amount of extra data fixes on its own: it only exists *at a station*. A user drops a pin
on ground with no anemometer, and the per-station table has no row. Turning it into a
product means predicting the site factor from terrain — which is the same job the
downscaling has been failing at, now with a target that is measurably repeatable and
therefore worth regressing against. **The finding is that the target exists**, not that
anything has hit it. Measurement 10 takes the shot and reports what it hit.

*Caveats: speed RMSE only, not vector — a speed offset says nothing about the 151°
direction error at DYGC2. Thirteen Colorado stations, four days, one of them in another
season; the same stations are used to fit and to grade, so this bounds a per-station
calibration and says nothing about an unvisited site. 24 consecutive hours are not 24
independent samples, and the three September dates share a synoptic regime. The hindsight
rows are fitted and scored on the same numbers and are printed as a ceiling, not a result.
The identity is exact arithmetic on stored output; no scoring was re-run, so any error in
measurements 7 and 8 is inherited whole.*

Artefacts: `node tools/site-factor.js <run>.json …` over the measurement 7 and 8 JSON,
kept outside the repo.

## Measurement 10: a scale instead of an offset, and the station the fit never saw

Measurement 9 ended on two things it could not do. It could not score a **multiplicative**
correction, because `mean(model^2)` is not in a summary; and it could not say anything
about a pin, because a per-station table has no row for ground with no anemometer. Both
are answered here, and they do not come out the same way.

`tools/score-wind.js --pairs` now writes the model/observation pairs it previously threw
away after summarising — one row per station per hour, carrying the observation as the
station published it, the matched model sample's own valid time, the pairing offset, every
candidate's speed and direction, and the station's terrain. It is opt-in and separate from
`--out`; nothing about the aggregate report changed. `tools/site-factor.js` reads either
kind. A pairs document collapses on the way in to six numbers per station — `n` and the
sums of `obs`, `obs^2`, `model`, `model^2` and `obs*model` — over which

```
scale = sum(model * obs) / sum(model^2)          (the least-squares fit)
mean((k*model - obs)^2) = (k^2*sum(model^2) - 2*k*sum(model*obs) + sum(obs^2)) / n
```

are both exact. Each family is fitted by the rule that minimises the score it is then
graded on, so the comparison is offset against scale and not one fitting rule against
another.

Four runs, all f00, 11 FEMS stations, 24 hours each: 31 August, 2 and 4 September, and
14 March. **The scale beats the offset in all twelve out-of-sample cells**, and the
cross-season pair is the one worth reading:

```
scored on   corrected by                       pairs     raw   offset:pooled  station    scale:pooled  station
aug31       sep02                                262   2.455          2.321    1.916           2.146    1.656
aug31       sep04                                262   2.455          2.321    1.896           2.146    1.651
aug31       mar14                                262   2.455          2.321    3.093           2.146    1.439
aug31       itself (hindsight, not a result)     262   2.455          2.321    1.584           2.146    1.301
sep02       aug31                                264   2.332          2.120    1.801           1.863    1.493
sep02       sep04                                264   2.332          2.120    1.629           1.863    1.290
sep02       mar14                                264   2.332          2.120    3.242           1.863    1.405
sep02       itself (hindsight, not a result)     264   2.332          2.120    1.442           1.863    1.160
sep04       aug31                                262   2.329          1.981    1.716           1.702    1.505
sep04       sep02                                262   2.329          1.981    1.559           1.702    1.305
sep04       mar14                                262   2.329          1.981    2.861           1.702    1.337
sep04       itself (hindsight, not a result)     262   2.329          1.981    1.363           1.702    1.138
mar14       aug31                                264   4.542          3.970    3.496           3.715    2.246
mar14       sep02                                264   4.542          3.970    3.694           3.715    2.562
mar14       sep04                                264   4.542          3.970    3.391           3.715    2.395
mar14       itself (hindsight, not a result)     264   4.542          3.970    2.283           3.715    1.708
```

**March's offsets applied to September are worse than no correction at all** — 2.33 → 3.24
and 2.46 → 3.09 — while **March's scales survive the season**: on 31 August they are the
best of the three corrections available, and on the other two days they are within 0.12 of
the best, which is another September day three days away. That is the measurement 8 claim
tested rather than asserted: the error is proportional, an offset fitted on a 5.14 m/s day
is simply the wrong size on a 2.14 m/s one, and a scale is not. Six months does less
damage to a scale than six months does to an offset.

The scales themselves, per station, over the same four runs:

```
station  aug31  sep02  sep04  mar14
BMOC2    x0.730 x0.762 x0.798 x0.868
DYGC2    x0.728 x0.809 x0.468 x0.409
ESPC2    x0.393 x0.393 x0.437 x0.525
KSHC2    x0.401 x0.422 x0.752 x0.392
LSTC2    x0.182 x0.223 x0.259 x0.377
PCPC2    x0.617 x1.189 x0.964 x0.642
PKLC2    x0.489 x0.411 x0.406 x0.510
RRAC2    x1.083 x1.420 x1.160 x1.199
SODC2    x0.633 x0.703 x0.573 x0.679
STOC2    x2.054 x1.229 x1.157 x1.612
TT532    x0.266 x0.332 x0.280 x0.166
```

### The pin, and why this still cannot ship

A table of eleven rows is not a correction for ground a user chose. The only honest test
is to predict a station's scale from **terrain alone, with that station absent from the
fit** — leave one station out, regress `log(scale)` on one terrain descriptor over the
remaining ten, and score the prediction on a *different day's* pairs at the held-out
station. `--holdout` prints exactly that, for five descriptors: the 500 m topographic
position index, the 3×3 one, slope, HRRR's orography offset, and elevation as a control.

```
scored on  fitted on  predictor        stns   pairs     raw  pooled  predicted     own
sep04      aug31      positionIndexM     11     262   2.329   1.849      1.647   1.505
sep04      aug31      tpi                11     262   2.329   1.849      1.595   1.505
sep04      aug31      slopeDeg           11     262   2.329   1.849      2.033   1.505
sep04      aug31      modelOffsetM       11     262   2.329   1.849      2.181   1.505
sep04      aug31      demElevationM      11     262   2.329   1.849      2.112   1.505
mar14      sep04      positionIndexM     11     264   4.542   3.960      3.072   2.395
mar14      sep04      tpi                11     264   4.542   3.960      2.943   2.395
mar14      sep04      slopeDeg           11     264   4.542   3.960      4.301   2.395
mar14      sep04      modelOffsetM       11     264   4.542   3.960      4.290   2.395
mar14      sep04      demElevationM      11     264   4.542   3.960      4.090   2.395
```

Read alone, that is the result the project has been looking for: both topographic-position
descriptors beat the pooled scale in all six fit/eval combinations and close about half
the distance to the station's own fitted scale, while slope, the model offset and the
elevation control are all *worse* than pooling. It is out of sample in both axes at once —
a station the fit never saw, on a day the fit never saw.

**It does not survive dropping one station.** Remove STOC2 — the leverage point
measurement 7 already flagged, whose 500 m TPI of +97 m is triple any other station's —
and the terrain prediction lands exactly on the pooled scale:

```
without STOC2, 10 stations       raw  pooled  pred 500 m  pred 3x3     own
sep04 <- aug31                 2.361   1.707       1.705     1.930   1.195
aug31 <- sep04                 2.180   1.558       1.533     1.565   1.201
sep02 <- aug31                 2.376   1.919       1.929     2.168   1.263
mar14 <- sep04                 4.442   3.105       3.046     3.214   2.105
```

The 3×3 index becomes worse than pooling in three rows of four. So the honest reading is
**one station of eleven is carrying the entire terrain signal**, which is the same
sentence measurement 7 wrote about r = +0.70 falling to +0.31, now measured on the thing
that matters — out-of-sample RMSE — rather than on a correlation. The correlations of
`log(scale)` against the 500 m index over these four runs are r = 0.63, 0.34, 0.53, 0.63,
lower than measurement 7's figure because this scale is least-squares over pairs rather
than a ratio of means.

**What does survive STOC2's removal is the per-station scale itself**: 2.361 raw → 1.591
pooled → 1.195 transferred on the ten remaining stations. The site factor is real and
repeatable; predicting it from terrain is not yet supported by anything.

*Caveats, and one of them is new. Choosing the best of five predictors on eleven stations
is selection, not validation: the leave-one-out loop holds out the station but not the
choice of descriptor, so the predicted column is optimistic by an amount this sample
cannot estimate. Speed only, not vector. Eleven Colorado stations, four days, one
season boundary; 24 consecutive hours are not 24 independent samples and the three
September days share a regime. All four runs are f00, which grades an analysis fit — the
site factor may partly be a measure of how hard the assimilation pulled at each station,
and an f06 pair set would separate those. `own` is the held-out station's own fitted
scale on the fit run: a ceiling, not a prediction. Nothing here has moved a default;
`downscale.js` is untouched.*

Artefacts: `node tools/score-wind.js --source fems --archive --forecast 0 --tolerance 30
--hours 24 --pairs <run>.pairs.json …` for the four dates, then
`node tools/site-factor.js --holdout <run>.pairs.json …`, kept outside the repo.

## Measurement 11: the same question on 37 stations chosen by the ground

Measurement 10 ended by asking for more stations rather than a better regression. This is
that run, and **it answers the question the other way**: the terrain regression does not
survive the sample it asked for.

`tools/station-survey.js --source fems --state CO --spread 30` read 3DEP under the whole
Colorado RAWS catalogue and picked 30 stations spaced across the 500 m position index;
`tools/fems-stations.js` calibrated a transmit minute for each against Synoptic's free
window, taking `data/fems-stations.json` from 11 stations to 38. `DMTC2` calibrates but
its domain returns `outside-tile`, so **37 stations scored**, on the same four archive
dates as measurement 10 — three September days and one March day — at f00 with
`--tolerance 30`. About 885 observations a day instead of 262, over a position index
running −26 m to +97 m: the same extremes as the eleven-station set, three times as
densely filled between them.

The model behaves exactly as the eleven-station sample said it does. HRRR is fast on all
four days — speed bias +0.91, +1.02, +1.30 and +2.26 m/s, each one about a x0.70 debias —
and the downscaling is 0.07 to 0.13 m/s worse than raw HRRR on every one of them before
debiasing. Nothing in the wider sample rescues the terms.

**The held-out terrain prediction is now a wash.** Twelve fit/eval combinations, five
descriptors, leave-one-station-out, scored on a different day at the station left out:

```
scored on <- fitted on      raw  pooled  pos500     tpi   slope     own
aug31 <- sep02            2.191   1.753   1.744   1.744   1.770   1.474
aug31 <- sep04            2.191   1.750   1.695   1.743   1.772   1.462
aug31 <- mar14            2.191   1.766   1.667   1.750   1.772   1.420
sep02 <- aug31            2.034   1.525   1.605   1.521   1.549   1.349
sep02 <- sep04            2.034   1.522   1.539   1.512   1.538   1.306
sep02 <- mar14            2.034   1.529   1.569   1.509   1.530   1.402
sep04 <- aug31            2.169   1.496   1.513   1.474   1.518   1.351
sep04 <- sep02            2.169   1.497   1.497   1.469   1.513   1.308
sep04 <- mar14            2.169   1.518   1.498   1.472   1.511   1.368
mar14 <- aug31            4.036   3.125   3.012   3.154   3.221   2.253
mar14 <- sep02            4.036   3.094   3.067   3.077   3.125   2.544
mar14 <- sep04            4.036   3.120   2.979   3.116   3.190   2.447
```

Averaged over the twelve cells, against the pooled scale: the 500 m position index is
**0.026 m/s better**, the 3×3 index 0.013 m/s better, slope 0.026 m/s *worse*, HRRR's
orography offset and the elevation control 0.010 and 0.006 m/s worse. The station's own
fitted scale is 0.33 m/s better than pooling over the same cells. **So terrain closes
about 8% of the distance between a pooled scale and the station's own**, where on eleven
stations it closed half of it.

And it is still the same station holding up what is left. Drop STOC2 and the two
topographic-position descriptors land on the pooled scale exactly as they did on ten
sites — 500 m index 0.009 m/s *worse* on average, 3×3 index 0.004 m/s better, best cell
0.019 m/s. The in-sample correlation tells the same story on every date:

```
                      r(scale, 500 m position index)
                   37 stations   without STOC2
aug31                    0.515           0.223
sep02                    0.243           0.064
sep04                    0.313           0.156
mar14                    0.470           0.253
```

**Twenty-six more stations did not dilute the leverage point; they left it exactly as
load-bearing as it was.** That is the strongest version of the result available: the
sample it was supposed to be tested against now exists, and the correlation still halves
when one of 37 stations is removed.

Why one station can still do that is visible in the per-station table. STOC2's fitted
scale on 31 August is **x2.05, against x1.34 for the next highest and a median of
x0.52**; HRRR is slow there by −3.58 m/s where the next largest negative bias in the set
is −1.37 and thirty of the 37 are on the fast side. Its observed mean is 6.54 m/s against
a sample median near 1.9. It is not an extreme of the terrain axis carrying an ordinary
error — it is the extreme of the terrain axis, the wind axis and the error axis at once,
and a regression on 37 points with one of them there is closer to a two-point fit than
the scatter plot suggests.

**What survives is what survived before, and it is now measured on a real sample.** The
per-station scale transfers between days and across the season boundary:

```
scored on   corrected by            pairs     raw   scale:pooled   scale:station
aug31       sep04                     885   2.191          1.738           1.462
sep02       sep04                     889   2.034          1.506           1.306
sep04       aug31                     885   2.169          1.476           1.351
mar14       sep04                     889   4.036          3.039           2.447
```

and it survives dropping STOC2 (sep04 ← aug31: 2.174 raw → 1.437 pooled → 1.258
station). The site factor is real, repeatable and worth about a quarter of the pooled
RMSE. **Reading it off the ground under a pin is not supported by this sample**, and this
sample was designed to be the one that decided it.

*Caveats. The catalogue cannot be spread evenly: 34 flat, 33 ridge, 19 slope and 3 valley,
because RAWS are sited on exposed fire-weather ground on purpose, so the negative half of
the position axis is thin no matter how the set is chosen — a regression that fails here
has not been shown to fail on a balanced sample, only on the best one Colorado offers.
Colorado only, four days, one season boundary, 24 consecutive hours per day. All four runs
are f00 and therefore grade an analysis the stations were assimilated into. Choosing the
best of five descriptors is still selection, not validation; the correction here is that
the best of the five is now worth 0.026 m/s. `own` is a hindsight ceiling, not a
prediction. No default moved.*

Artefacts: `tools/score-wind.js --source fems --archive --forecast 0 --tolerance 30
--hours 24 --pairs <run>.pairs.json` for the four dates over the 38-station list, then
`tools/site-factor.js --holdout`, kept outside the repo.

## Measurement 12: a second state, and a descriptor that works in one of them

Measurement 11 ended by asking for terrain with hollows in it, and named New Mexico as
the candidate. This is that run. It answers a question nobody asked instead of the one
that was asked, and the answer is the most useful thing in this note since measurement 9
— **and it must not be shipped**, for a reason the last two measurements have taught.

**The valley question died in the catalogue, not in the run.** `station-survey.js` read
3DEP under all 2,088 FEMS RAWS and found 57 in New Mexico, 56 of them readable:

```
              read   flat  ridge  slope  valley    position index
Colorado        93     34     33     19       3   -30.8 .. +97.0 m
New Mexico      56     33     15      4       3   -31.8 .. +95.2 m
```

Fifty-six is the whole state, not a sample of it. **Three valleys again, and the axis has
the same two ends to within a metre and a half.** This is not a fact about Colorado's
topography; it is a fact about where a fire-weather agency puts a mast. No amount of
state-hopping fills the sheltered half of the position axis, and the cheap way to learn
that was ten minutes of 3DEP rather than four archive days.

Thirty stations were chosen spread across the index anyway, matched to Synoptic at
0.00 km, and calibrated: `data/fems-stations.json` goes 38 → 68. **The 38 Colorado
transmit minutes came back bit-identical on a second calibration three months later**,
which is the first evidence that a GOES slot is stable rather than merely measured once.
Four archive dates at f00, `--tolerance 30`, 24 hours each: 720, 720, 717 and 719 pairs.

**Everything measurement 11 found about the model is still true in a second state.** HRRR
is fast on all four days — speed bias +1.00, +0.93, +1.14 and +2.69 m/s, each about a
x0.61–0.69 debias — and the downscaling is 0.11 to 0.32 m/s *worse* than raw HRRR on
every one of them, landing within 0.01 m/s of it once each candidate's own bias is out.
The per-station scale transfers here too, and across the season boundary: over the twelve
held-out cells a station's own fitted scale is 0.244 m/s better than a pooled one
(Colorado: 0.312).

**A single pooled scale is not even state-specific.** Substituting Colorado's pooled
scale for New Mexico's own changes the held-out score by +0.003 m/s on average, and the
reverse by −0.006. Whatever the gross bias is, it is not local.

### What is new: elevation predicts the New Mexico station factor

Leave-one-station-out, fitted on one date and scored on another, mean over the twelve
cells against the pooled scale — positive is better than pooling:

```
predictor              New Mexico            Colorado
                     cells    gain        cells    gain
demElevationM        12/12  +0.173 m/s     0/12  -0.031 m/s
positionIndexM        0/12  -0.034          6/12  -0.004
tpi                   0/12  -0.020          5/12  -0.001
slopeDeg              6/12  -0.015          0/12  -0.050
modelOffsetM          0/12  -0.030          1/12  -0.041
the station's own    12/12  +0.244         12/12  +0.312
```

**Elevation closes 71% of the distance between a pooled scale and the station's own**, in
every one of the twelve cells, where every terrain descriptor tried so far has closed
about 8% at best. The in-sample correlation is −0.65 to −0.71 on each of the four dates
separately and −0.73 on the four-date mean scale. It is not one or two stations: dropping
the two extremes (GRSN5, JARN5) leaves +0.141 m/s, dropping CIMARRON leaves +0.156, and
the correlation survives inside both halves of the sample (−0.43 below 2,000 m on nine
stations, −0.47 above it on twenty-one), so it is not a two-population artefact either.

The mechanism is visible and it is not elevation:

```
                    stations   observed   HRRR   ratio
New Mexico  <2000 m        9    3.57       4.03   1.13
            >=2000 m      21    2.15       4.01   1.86
Colorado    <2000 m        5    3.64       4.22   1.16
            >=2000 m      32    3.00       4.50   1.50
```

**HRRR's wind barely changes with elevation (r = +0.14 in New Mexico, +0.10 in Colorado);
the anemometers' does (−0.67 against −0.19).** The model blows much the same wind over
the desert and over the mountains, and the mountains are where it is wrong — on New
Mexico's plains it is 13% fast, which is close to right. Colorado shows the same contrast
between its two elevation bands and has five lowland stations to draw the line with,
which is why elevation is r = −0.18 there and nothing in a regression.

### Why it still must not ship

**Each state's best descriptor is useless in the other.** Colorado's position index is
0 of 12 in New Mexico; New Mexico's elevation is 0 of 12 in Colorado. Fitting the
elevation line in one state and applying it in the other, mean gain over pooling:

```
scored   fitted on          cells    gain
NM       New Mexico         12/12  +0.173 m/s
NM       Colorado           10/12  +0.056
NM       all 67 stations    12/12  +0.115
CO       Colorado            0/12  -0.031
CO       New Mexico          0/12  -0.156
CO       all 67 stations     4/12  -0.011
```

A relationship learned in New Mexico actively damages Colorado, by five times more than
Colorado's own line does — and a pin does not come labelled with which state's behaviour
it will follow.

**The mechanism scores an order of magnitude worse than the proxy.** If elevation stands
in for canopy — high New Mexico ground is forest, low ground is desert — then HRRR's own
roughness should carry it. `--exposure` on 31 August: SFCR reads 0.075–0.699 m over the
30 stations, correlates with elevation at +0.57 and with the fitted scale at −0.41, and
scoring the roughness physics explicitly buys **0.02 m/s** debiased where the empirical
elevation line buys 0.17. A descriptor that outperforms the mechanism it supposedly
stands for is a descriptor that is standing for something else.

**And it is the best of five, chosen after looking at all five.** That is the selection
this note has already been burned by twice — measurement 10's r = +0.70 and measurement
11's position index both looked like this from the inside.

### Cimarron, and the Whittington Center

There is **no RAWS on or near the NRA Whittington Center**. The nearest are CIMARRON at
54.3 km, Bosque (Colorado) at 57.0 km and Mills Canyon at 72.9 km, so nothing measured
speaks for that ground.

CIMARRON is worth its own line anyway: it is the most sheltered station in New Mexico at
−31.8 m, one of the three valleys, and its fitted scale is **x0.341, x0.341, x0.330 and
x0.330** on the four dates. HRRR is three times too fast there, by the same factor in
March at an observed mean of 2.85 m/s as in September at 1.15–1.30, with at most 2 of 24
hours flagged calm — so it is not the cup anemometer's stall threshold, which is the trap
two other stations in this set fall into (GRSN5 and JARN5 average 0.30–1.06 m/s in
September with 6 to 14 of 24 hours calm, and their x0.14–0.33 is partly an instrument
floor; they are the pair dropped in the sensitivity run above). A blank direction column
for GRSN5 on 2 September is those calms, not a failure.

*Caveats. Two states, four days, one season boundary, 24 consecutive hours per day, all
f00 and therefore grading an analysis these stations were assimilated into. `own` is a
hindsight ceiling, not a prediction. The elevation result is one descriptor out of five
on one state and needs a third state before it is anything more than a lead — the
difference from the previous two leads is that it is 12 of 12 rather than 6 of 12, and
that its failure mode in Colorado is measured rather than assumed. No default moved, and
`downscale.js` is untouched.*

Artefacts: `tools/station-survey.js --source fems --state NM --spread 30`,
`tools/fems-stations.js` over the 68-station list, then `tools/score-wind.js --source
fems --archive --forecast 0 --tolerance 30 --hours 24 --pairs <run>.pairs.json` for the
four dates and `tools/site-factor.js --holdout`, kept outside the repo.

## Measurement 13: how much of every score was only the clock

Every number above pairs an hourly model with an observation taken at some other minute.
`--tolerance 30` allows half an hour of that, and the size of the mistake it admits has
never been measured — it has only ever been argued about. NCEI's one-minute ASOS record
(DSI-6405, see `docs/observations.md`) measures it: **how far the wind moves away from
itself as the gap grows**, at real stations, one minute at a time.

14 stations across Colorado, New Mexico, Utah, Montana and Nevada, two months six seasons
apart (September 2024 and March 2026), **26 station-months and 819,249 minutes** with a
wind in them, 14,835 minutes absent, none malformed. Two station-months were refused
rather than scored: `KCAO` September 2024, where NCEI answers 200 with an HTML 404, and
`KABQ` March 2026, which is 36,568 well-formed records with `M` in every wind field.

```
lag (min)   speed RMS   vector RMS   direction RMS      over 10-minute means
    1          0.48        0.67          8 deg          0.12 / 0.18
    5          0.96        1.49         21 deg          0.49 / 0.75
   10          1.13        1.80         27 deg          0.79 / 1.25
   15          1.24        2.00         31 deg          0.96 / 1.54
   30          1.48        2.44         39 deg          1.27 / 2.09
   60          1.80        3.01         48 deg          1.64 / 2.73
   90          2.03        3.41         54 deg          1.89 / 3.17
```

**The wind's own change reaches ASOS's ±2 kt after a median 7.5 minutes** — 2.8 minutes
at LEADVILLE, 27.1 at SPRINGFIELD, and inside 10 for 20 of the 26 station-months. A
pairing window of 30 minutes is therefore three to four times the interval over which the
wind stops being the same wind, at these stations.

The right number is not the window, though — it is the offsets a run **actually drew**,
because a FEMS station's offset is a property of its GOES transmit slot and not of the
tolerance. `tools/wind-decorrelation.js --offsets <run>.pairs.json` reads the offsets out
of a `score-wind.js --pairs` artefact and prices them against the pooled curve:

```
run                              mean offset   max   speed  vector  direction
11 Colorado stations, Aug 31        12.7 min    25    1.15    1.84     28 deg
  ... over 10-minute means                            0.84    1.36     23 deg
38 Colorado stations, Aug 31        12.6 min    30    1.15    1.84     28 deg
  ... over 10-minute means                            0.85    1.36     23 deg
30 New Mexico stations, Aug 31      14.3 min    28    1.20    1.93     30 deg
  ... over 10-minute means                            0.92    1.48     25 deg
```

The second line of each pair is the one to quote against a RAWS run: FEMS reports a
10-minute mean, and averaging removes the part of the minute-to-minute change that a
10-minute mean would never have seen. **So the clock alone put roughly 0.85 m/s of speed
RMS, 1.36 m/s of vector RMS and 23° of direction RMS into every score in this note.**

### What that does to the table

Timing error and model error are close enough to independent to subtract in quadrature.
Taking measurement 10's four-run table at face value and removing a 0.85 m/s clock:

```
                                   as scored   less the clock   share of the variance
raw HRRR, 31 August                  2.455         2.303                12%
raw HRRR, 14 March                   4.542         4.462                 3%
station scale from March, on Aug     1.439         1.161                35%
station scale from Sep 4, on Sep 2   1.290         0.971                43%
the same day on itself (hindsight)   1.301         0.985                43%
```

Two readings come out of that, and the second is the one that matters.

**The raw bias is not a timing artefact.** 12% of the variance on a September day and 3%
on the March one: HRRR really does run 43–70% fast over these stations, and no pairing
rule was ever going to explain it away.

**The best correction this project has has already reached the noise floor.** Once the
per-station scale is applied, **a third to a half of what is left is the clock**, not the
model — and the debiased ablation table that separates every terrain candidate ever tried
spans **0.06 m/s**, against 0.85 of timing noise sitting under all of them. A ranking
taken at that spread was never resolving physics. The same holds on direction, where the
clock contributes 23° against the 70.5° scored at these stations, and measurement 4's
diverting term moves the direction RMSE by **0.3°**.

### Narrowing the window is the wrong lever

Three pairing rules, over the same 26 station-months:

```
                                        speed  vector  direction
a 30 minute pairing window               1.22    1.97     31 deg
the same, averaged over 10 min first     0.94    1.52     26 deg
the nearest whole hour                   1.20    1.94     30 deg
interpolated between the two hours       1.09    1.70     27 deg
```

Interpolating the model in time to the observation's own minute — the fix
`docs/observations.md` has recommended since the transmit slots were measured — is worth
about **12% of the vector term** and no more. That is the honest ceiling on it: linear
interpolation between two hourly samples cannot recover variability that is not in an
hourly series in the first place. **The floor is a property of pairing an hourly model
with an anemometer, and it does not go away by choosing a better minute.**

Nor does narrowing `--tolerance`. The offset is set by the station's transmit slot, so a
10-minute window does not make the surviving pairs better matched — it deletes the
stations whose slot falls outside it, which is exactly the five-of-eleven result in
`docs/observations.md`. **`--tolerance 30` stays, and the number above travels with it.**

### By how hard the wind is blowing

```
mean wind        pairs     speed  vector   relative
0-2 m/s         154257      0.92    1.66     69% of the wind
2-4 m/s         313950      1.36    2.32     46%
4-6 m/s         194093      1.58    2.53     32%
6+  m/s         136246      2.04    3.21     25%
```

In absolute terms a light wind moves less; in relative terms it moves far more, and the
RAWS sample's observed mean is 2.1 m/s. Scaling the 0–2 m/s bin's ratio onto the offsets
above puts a regime-matched floor nearer **0.53 m/s** of speed RMS, which is the lower end
of the honest range — 14% rather than 35% of the corrected score's variance. Both ends of
that range are large next to 0.06 m/s.

*Caveats, and they are the same shape as everything else in this note. These are
**airports**: flat, exposed, and chosen by aviation — they bound the timing term for the
runs already done and they cannot re-open the terrain question. ASOS reports a 2-minute
mean where FEMS reports a 10-minute one, which is why both rows are given rather than
one. The sample means run 3.6–6.2 m/s against the RAWS sample's 2.1, so the unadjusted
floor is an over-estimate and the regime-scaled one is an estimate rather than a
measurement. The quadrature subtraction assumes timing error is uncorrelated with model
error, which is approximately but not exactly true — a model is worst in the conditions
that change fastest. Two months, and no default, coefficient or tolerance moved.*

Artefacts: `node tools/wind-decorrelation.js --stations … --month 2024-09,2026-03 --cache
~/asos1min --offsets <run>.pairs.json --out report.json`, kept outside the repo.

## Measurement 14: the valleys were there all along, at a radius nobody asked at

Measurements 11 and 12 both closed on the same objection: the RAWS catalogue has no
hollows in it, 3 valleys in 93 in Colorado and 3 in 56 in New Mexico, so the sheltered
half of the terrain axis cannot be tested and the search should move to another network.
**That objection was a statement about a 500 m disc**, which is the default in
`tools/station-survey.js` and was never chosen for this question. The product being
designed is a two-mile box. Asked at that scale, the same catalogue answers differently.

`tools/station-survey.js --source fems --state CO --position 2000 --radius 2.5` re-read
3DEP under the whole Colorado catalogue. Over the 87 stations readable at both radii:

```
                     500 m disc     2 km disc
flat                        33            15
ridge                       33            51
slope                       19             6
valley                       2            15
position index    -30.8 .. +97.0   -185.7 .. +363.6
```

Thirty-four of the 87 change class and **fourteen change sign**. PICKLE GULCH is +22.4 m
over its 500 m surroundings and −22.6 m over its 2 km ones; BEULAH is +8.1 and −50.8.
Neither number is wrong and neither is more correct: a 500 m disc measures the bank a mast
stands on, a 2 km disc measures the valley that bank is in, and a knoll inside a gulch is
both. **A class is a statement about a radius**, and every count in this note before now
was quoted without one. `--position` and the new `--threshold` are recorded on every
station for that reason.

### Restratifying the pairs that were already scored

The same 3,548 stored pairs from the 37-station Colorado set, four archive dates, nothing
re-fetched — only the label changed:

```
by the 500 m index (as scored in measurements 10-12)
stratum      pairs   stns    hrrr    down   hrrr*   down*   scale
valley         192      2    3.74    3.30    1.89    1.84    0.46
slope          862      9    2.52    2.62    1.61    1.62    0.62
flat          1154     12    2.71    2.75    1.76    1.65    0.66
ridge         1340     14    2.72    2.98    2.38    2.31    0.79

by a 2 km index
valley         954     10    2.73    2.78    1.46    1.47    0.59
slope          192      2    2.48    2.66    1.43    1.39    0.63
flat           288      3    2.38    2.32    2.16    1.87    0.84
ridge         2018     21    2.66    2.86    2.19    2.13    0.74
```

The valley stratum goes from two stations to ten. **The downscaling is still no better
than raw HRRR in any stratum at either radius** — `down` beats `hrrr` nowhere except flat
ground, by 0.06 m/s, and the debiased columns are within 0.05 m/s of each other in every
row. Nothing here rescues the terms.

### What the wider valley stratum does say

Fitting each station's own speed scale by least squares and grouping by the 2 km index:

```
valley (index <= -15 m)      n=10  mean scale 0.598  sd 0.117  se 0.037
between                      n= 5  mean scale 0.741  sd 0.305  se 0.136
ridge  (index >= +15 m)      n=21  mean scale 0.756  sd 0.323  se 0.071
valley - ridge = -0.157  se 0.080  t = -1.97
Spearman rho(scale, 2 km index) = 0.228 over 36 stations
```

**HRRR is about 20% faster over the sheltered stations than over the exposed ones, at
t ≈ 2 on 31 masts.** That is the sheltering signal this note has been looking for since
measurement 3, and it is the first time it has appeared with more than two stations under
it. It is also, at t ≈ 2 with the radius chosen after seeing that the smaller one gave
nothing, exactly the strength of evidence that produced the last two dead leads.

**And it does not predict an individual station.** Held out one station at a time,
predicting that station's fitted scale from a line through the others:

```
2 km position index    20/36 better   mean |err| 0.224 -> 0.212   closes  5.3%
500 m position index   20/36 better   0.224 -> 0.225              closes -0.5%
slope                  22/36 better   0.224 -> 0.223              closes  0.4%
elevation              18/36 better   0.224 -> 0.226              closes -1.1%
```

5.3% against measurement 11's 8% at 500 m, and 20 of 36 is a coin toss. So the honest
reading is two statements that both have to be carried: **pooled, sheltered ground needs
the model slowed further; per station, the landform still cannot say by how much.** A
group mean is not a pin, and the pin is what the product has to answer.

### What this changes and what it does not

- **The catalogue objection is withdrawn as stated.** "RAWS has no valleys" was true of a
  500 m index and is false of a 2 km one, and both of measurements 11 and 12 closed on it.
  A run that wants sheltered Colorado ground can have ten stations of it today, and 15 of
  the 87 the survey could read at both radii.
- **It does not withdraw the case for a non-RAWS network.** These are still masts sited
  for fire-weather exposure; a station in a 2 km hollow is not a station in a sheltered
  spot, which is why the pooled effect is 20% and not the factor of two a canyon does.
  The near-ground question is untouched by any of it — every one of these anemometers is
  still at 6.1 m.
- **No default, coefficient or classification threshold moved.** `verify.classifyTerrain`
  still defaults to a 500 m-derived ±15 m, because changing it would silently relabel
  every stratified table already in this note. What changed is that the radius and the
  threshold now travel with the class.
- **The next run is pre-registerable, and should be.** Fit the valley/ridge scale split on
  Colorado at 2 km, state it in writing, then score New Mexico's 30 stations against it
  without looking. Three descriptors have now been chosen after seeing their own results
  — `Sx`, elevation in New Mexico, and this radius — and all three looked about this
  strong at this stage.

*Caveats. The 2 km radius was chosen because the 500 m one produced no valleys, which is
selection on the outcome. `t = -1.97` on 31 stations is one station from nothing, and the
groups are unbalanced 10 against 21. The scales are fitted on the same four dates the
strata are compared on, so this is in-sample except for the held-out column. Every pair
carries the 0.85 m/s clock term from measurement 13, which is larger than the effect being
discussed. Nothing was re-fetched: the terrain is a fresh 3DEP read, the pairs are the
stored ones.*

Artefacts: the 2 km survey and the restratification were run outside the repository
against `tools/station-survey.js` and `verify.js`; the surveys are reproducible with
`--position 2000 --radius 2.5`.

## The hypotheses, and how much weight each one carries

Roughly in the order the evidence supports them.

1. **The curvature term is wrong on convex ground — tested, and not supported.**
   Measurements 3 and 5 put about 0.4 m/s of ridge penalty on the candidates carrying
   curvature, and measurement 6 shows it is all of it on the convex half and none of it
   left once each candidate's own speed bias is divided out: ten candidates inside
   0.02 m/s on ridges. The term is not misplacing the wind on crests; it is multiplying
   a wind that is already too fast, on the stratum with the least room for it. This is
   hypothesis 3 wearing hypothesis 1's clothes.
2. **Double counting on ridges — tested, and not supported through this pathway.** The
   model has resolved part of the landform, measurably: 41 m of ridge at these four
   stations. Subtracting a 1–3 km regional surface before deriving the weights recovers
   0.04 of the 0.39 m/s ridge penalty (measurement 5), because the terms read 500 m and
   hillslope wavelengths that a regional mean does not contain. It stays on the list
   because the mechanism is real and only one implementation of it has been scored — a
   subtraction at the wavelength the *terms* work at, rather than at HRRR's grid scale,
   has not been.
3. **The gain is the wrong thing to tune while the bias is 70%.** Whatever the terrain
   terms do, they are multiplying a wind that is far too fast over most of this sample.
   The siting half of this — a RAWS tower stands in brush, not on the mown grass the
   default `z0 = 0.03 m` assumes — was **tested in measurement 7 and is not supported**:
   the default is wrong about the ground (HRRR's own SFCR reads 0.15-0.69 m at these
   stations) and correcting it improves nothing that a single constant does not improve
   more. What the stations need runs from x0.21 to x1.68 and correlates with roughness at
   r = -0.02. The bias is real, it repeats on three days, and it is **not** one bias: it
   is a per-station offset eight times wider than its own mean that nothing measured so
   far predicts.
4. **The sheltering signal rests on one station, and 26 more did not change that —
   tested twice, and not supported.** The per-station scales correlate with the 500 m
   topographic position index at r = +0.70 on eleven stations, which is the shape `Sx`
   claims and 1/50th of the amplitude it applies. Measurement 10 took that from a
   correlation to an out-of-sample score and found it landing on the pooled scale once
   STOC2 was removed; measurement 11 ran the wider set that was supposed to settle it and
   found the same thing on 37 stations, where terrain closes 8% of the distance to a
   station's own scale and the correlation still halves when STOC2 goes. Measurement 12
   scored 30 New Mexico stations and the position index went 0 of 12 held-out cells
   there. **This is not where the next station should go, in any state** — New Mexico's
   RAWS are 3 valleys in 56 against Colorado's 3 in 93, so the sheltered half of the axis
   is missing from the catalogue rather than from the sample.
5. **The station factor is predictable from something, and elevation is the first
   descriptor that has looked like it — in one state.** Measurement 12: fitting the New
   Mexico scale on elevation beats a pooled scale in 12 of 12 held-out cells and closes
   71% of the distance to the station's own factor, where every terrain descriptor before
   it closed 8%. It is 0 of 12 in Colorado, a line fitted in one state damages the other,
   and HRRR's own roughness — the mechanism elevation would be standing in for — scores
   0.02 m/s where the proxy scores 0.17. It is on this list as the best open lead and
   **not** as something to put in `downscale.js`; a third state decides it.
6. **The slope term does nothing as scored.** `os = alongWind / (2 * maxSlope)` is
   normalised by the domain's own steepest slope, so a station on a 20° slope in a domain
   containing a 50° cliff reads as gentle ground. Fixed physical scales exist now
   (`slopeScaleRad`, `curvatureScale`, `shelterScaleDeg`) but are off by default.
7. **Diversion is unearned.** It is a plausible piece of physics with no measured support
   in this sample and a small measured cost. It should either be justified against a
   station set where it can show itself, or turned off.
8. **The shelter term is the wrong shape for wind.** `Sx` in this form comes from the
   snow-redistribution literature; a term that moves the answer by 0.6% is either
   mis-scaled, mis-signed, or measuring something that does not limit surface wind.

## What would settle it

In cost order.

- ~~**Score a curvature term that cannot speed up a ridge.**~~ Run: measurement 6. The
  clipped candidate wins the raw ridge column and is indistinguishable from every other
  candidate once the bias is out, which is the curve-fitting this bullet warned about,
  caught by the debiased table rather than by judgement. **The successor question is the
  bias itself**, since that is now the only thing the ridge column was measuring.
- **Repeat measurement 5 at the terms' own wavelength.** The subtraction was done at 1 km
  and 3 km, which is HRRR's scale and not the terms' scale. A high-pass at 300–500 m
  would change the curvature input rather than leave it alone, and that is the version of
  hypothesis 2 that has not been scored.
- ~~**Repeat on other days.**~~ Run: measurement 7. `archive.js` reads
  `noaa-hrrr-bdp-pds` through the `.idx` byte ranges, so the model side is unblocked back
  to 2014; three dates x two lead times agree on the bias and on the roughness result.
  **What was still blocked is the observation side** — the Synoptic token refuses history
  older than about six days. It does not need an account: `docs/observations.md` measures
  USDA FEMS serving eleven of these thirteen stations back to 2005, free, 113,892 hourly
  rows for thirteen stations x one year in a single 7-second request. Read that note's
  timestamp section before pairing anything from it.
- **Repeat on other terrain.** Partly run: measurement 12 scored 30 New Mexico stations
  over the same four dates, and the bias, the scale form and the failure of the position
  index all reproduce. What it also shows is that the descriptor that works there does
  not work in Colorado, so **a third state is now the deciding run** rather than a
  confirming one — the Cascades, the Appalachians and the Great Basin are still different
  problems, and one of them settles whether the elevation relationship is physics or
  New Mexico.
- ~~**Score with a per-station roughness** instead of one constant.~~ Run: measurement 7,
  using HRRR's own SFCR as well as fixed Davenport classes. It survives all of it: the
  correction is a constant in disguise and correlates with what the stations need at
  r = -0.02. A land-cover source would be a better roughness and there is no longer a
  reason to expect it to matter.
- ~~**Put stations where the sheltering hypothesis can be tested.**~~ Run: measurement 11.
  `tools/station-survey.js` read 3DEP under all 2,088 FEMS RAWS and chose 30 Colorado
  stations spread across the position index; 37 scored over the same four dates. It kills
  the lead rather than promoting it — terrain closes about 8% of the distance to a
  station's own scale instead of half of it, and removing STOC2 still halves the
  correlation on every date. **The successor is not another Colorado station**: the
  catalogue is 34 flat, 33 ridge, 19 slope and 3 valley, so the sheltered half of the axis
  cannot be filled from this state at all. **Half-withdrawn by measurement 14** — that
  split is what a 500 m disc says, and at 2 km the same catalogue has 15 valleys and the
  scored set has ten. The sheltered stratum can be had after all; what it buys is a pooled
  20% and no per-station skill.
- **Pre-register the 2 km sheltering split and score New Mexico against it.** Measurement
  14 found it at t ≈ 2 after choosing the radius that produced it, which is the same
  position `Sx` and the New Mexico elevation line were both in before they died. Write the
  Colorado valley/ridge scale ratio down, then run the 30 New Mexico stations once. This
  is the cheapest deciding run currently available — the pairs and the terrain are both
  already stored.
- **Score against a network that measures below 3 m.** `docs/observations.md` now has the
  catalogue: CoAgMet at 2 m over 95 Colorado sites and USCRN at a documented 1.5 m over
  116 CONUS sites, 16 of them in 2 km valley bottoms, both free and both 5-minute. Every
  measurement in this note is against a 6.1 m mast or an 8.2-10.1 m one, and the product
  being designed draws 0-3 m. Neither has an adapter; that is the work.
- **Separate the height correction from the terrain correction in the scoring** so a
  change in one cannot be credited to the other.
- ~~**Regress the per-station scale on terrain, now that the scale is known to repeat.**~~
  Run: measurement 10, with `score-wind.js --pairs` and `site-factor.js --holdout`. The
  scale form is confirmed — it beats the offset in all twelve out-of-sample cells and,
  unlike the offset, it survives six months. The terrain regression is not: it beats a
  pooled scale on eleven stations and is indistinguishable from one on ten. **The
  successor is more stations, not a better regression** — picking one of five descriptors
  on eleven sites is selection rather than validation, and the fix for both problems is
  the same station set spread across the position index. Superseded by measurement 11,
  which ran it: the scale form still holds, the terrain regression does not.

## Things that would poison the answer

Written down because each one has already nearly happened here.

- **An observation timestamp is not the time of the observation.** For one RAWS report
  MADIS and Synoptic both say `12:54`; FEMS says `13:00`, having rounded up to the
  following hour and dropped the minute. The pairing tolerance here is 10-30 minutes,
  smaller than that disagreement, so a source swap made without a per-station transmit
  offset would put a diurnal-cycle error into the column being measured — and every
  candidate would carry it equally, so the table would still look consistent.
- **312 observations are not 312 independent samples.** They are 13 stations × 24
  consecutive hours; a station's error at 14:00 is most of its error at 15:00. Any
  significance claim has to account for that, and none in this document does.
- **Forecast hour 0 grades an analysis fit, not a forecast.** NCEP assimilates surface
  observations, and measurement 7 puts a size on it: the f00 speed bias is 0.17-0.49 m/s
  smaller than the f06 bias from the same cycle on the same day. An f00 run is worth
  having beside an f06 one as a measure of that pull; it is not worth quoting alone.
- **A terrain read that fails is not a model error.** `DMTC2` is excluded from the set
  because its domain returns `outside-tile`; counting it as a miss would flatter or
  damage the model at random.
- **A published station coordinate can be wrong.** `station-survey.js` flags a station
  whose published elevation disagrees with the 3DEP ground beneath it by more than 50 m.
  A station scored at the wrong coordinate is filed as model error.
- **Fitting a scale factor on the observations you then score against is a diagnostic.**
  Measurement 2 is useful and is not validation.
- **The normalisation used to depend on the size of the box requested.** Terrain terms
  were divided by the extremes *within the requested domain*, so the same coordinate over
  the same ground answered differently depending on how much neighbourhood came with the
  request — 9.95 m/s over an 800 m half-width against 8.13 m/s over 3200 m. Fixed scales
  are available now; the default is still the old behaviour, so two stations scored over
  different domains are still not strictly comparable unless `--scales` is passed.

## Worth exploring, unranked

Ideas that have not been costed and may be bad.

- **Blend by scale rather than choosing.** Take the synoptic flow from HRRR and the
  fine structure from the DEM anomaly, rather than multiplying one by a function of the
  other.
- **A stability-dependent correction.** Terrain channels and decouples very differently in
  a stable nocturnal boundary layer than in a convective afternoon one, and both HPBL and
  the surface temperature are already in the fetched fields. Splitting the existing
  scores by hour of day would show whether it is worth the complexity — the data for that
  split is already on disk.
- **Score the direction and the speed against different terms.** Diversion is a direction
  term being graded inside a vector RMSE dominated by a speed bias.
- **Compare against WindNinja** on the same domains. It is the reference implementation
  of mass-consistent terrain downscaling; if its mass-conserving solution shows the same
  ridge behaviour, the problem is not this formula. **Licensing:** WindNinja's momentum
  solver is OpenFOAM/GPL-3 — fine to run for research, a decision to be made before any
  self-hosted product ships. See `AGENTS.md`.
- **Use the model's own wind at multiple levels.** HRRR carries 10 m and 80 m; the shear
  between them says more about the local boundary layer than a fixed log profile with a
  constant roughness does.
- **Check whether the ridge stations are simply at their site's local maximum.** An
  anemometer on the very top of a ridge is in the accelerated flow the model is already
  producing at that height; the error may be a sampling-height problem rather than a
  terrain one.
- **Gust as a diagnostic.** HRRR's `GUST` is already fetched and RAWS publish gusts. A
  model that is too fast in the mean but right in the gust is telling a different story
  from one that is too fast in both.

## What is not known

- Whether any of this repeats outside one state and one day. **Nothing here has been
  reproduced on a second date.**
- Whether the valley result survives more than four stations.
- How much of the remaining +1.25 m/s is siting and roughness rather than model error.
- Whether curvature's sign and normalisation are physically right, or whether it is
  currently acting as an accidental proxy for something else.
- What a defensible `confidence` number would be. It is still `null`, and on this
  evidence it should stay `null`.

---

# Claude's review

Added by Claude Code on top of the working note above, per the review convention in
`AGENTS.md`. Same standard: each claim says whether it was measured or reasoned about.
Nothing above this line was changed except one Contents entry.

**Verdict: measurement 5 is a stronger result than it is written up as.** It reads as a
null — the subtraction did not rescue the ridges — but combined with the shape of the
curvature operator it closes hypothesis 2 rather than leaving it open, and it rules out
the follow-up the note proposes for it. It also relocates the ridge penalty away from
the terrain input and onto the base state the correction assumes.

## The curvature operator is a band-pass, and that bounds the whole anomaly experiment

`scaleCurvature` measures, per axis, `(z0 - (z(-eta) + z(+eta)) / 2) / (2 * eta)` with
`eta = curvatureLengthM / 2`. That is a linear filter, so its response to a wavelength is
closed form:

```
R(lambda) = (1 - cos(2 * pi * eta / lambda)) / (2 * eta)
```

At `curvatureLengthM = 500` m:

| wavelength | % of peak response |
| --- | --- |
| 250 m | **0.0%** — a null |
| 500 m | **100%** — the peak |
| 1 km | 50.0% |
| 2 km | 14.6% |
| 3 km | 6.7% |
| 6 km | 1.7% |
| 50 km | 0.0% |

**The term is a band-pass centred on its own length, not a high-pass.** A linear ramp
gives exactly zero by construction, and so does a 250 m ripple.

Three things follow, and the first two are the note's own results explained rather than
merely recorded:

- **Measurement 5 was bounded to be almost a no-op before it ran.** Smoothing at radius
  `Rs` removes wavelengths longer than about `2 * Rs`. At `Rs = 3` km that is everything
  beyond 6 km, where the operator passes **1.7%** of peak; at `Rs = 1` km, beyond 2 km,
  where it passes 14.6%. A subtraction can only take away what the term was reading, and
  the term was barely reading it. Hence 3.97 to 3.93, and hence 1 km moving it by another
  0.01.
- **The double-counting mechanism was never available through this term.** HRRR's
  orography carries structure down to about 3 km; the curvature term passes 6.7% of that
  wavelength. The 41 m of resolved ridge in measurement 4 is real, but it sits almost
  entirely in a band the curvature term is deaf to. So hypothesis 2 is not merely
  unsupported by the run — the mechanism cannot reach this term. It should move to the
  bottom of the list, or off it.
- **The follow-up the note proposes for hypothesis 2 would delete the term, not correct
  it.** "A subtraction at the wavelength the terms work at" means `Rs` near 250–500 m,
  which removes wavelengths beyond 500–1000 m — where the operator passes 100% and 50%
  of peak. That does not sharpen the input; it subtracts the signal. Do not run it.

*Measured: the closed form and the table, computed from `scaleCurvature`'s own
arithmetic. Reasoned: that this is why measurement 5 came out where it did — the
prediction matches the measurement, which is not the same as having isolated the cause.*

## Where that leaves the ridge penalty

If the input surface is not the problem, the remaining candidates are the gain, the
normalisation, and the base state. The note's stratified speed biases point at the third:

```
stratum   HRRR speed bias
valley          +2.09
slope           +2.01
flat            +1.86
ridge           +0.30
```

**HRRR is not terrain-blind.** It is nearly seven times better on ridges than in
valleys, which means it already produces terrain-driven speed variation — not through
resolving the 500 m landform, but because a 3 km cell containing a ridge is dominated by
exposed ground and its wind reflects that. The downscaling multiplies as though the base
state carried none of this, so on the one stratum where the model needed no help it adds
help anyway.

That is a different claim from hypothesis 1 as written. "The curvature term is wrong on
convex ground" suggests the term's shape or sign is wrong. The evidence is equally
consistent with the term being right about the terrain and wrong about what it is
multiplying — which would predict exactly the observed asymmetry, because the headroom
for a correction is +2.09 in valleys and +0.30 on ridges.

The two are distinguishable, and the run that separates them is cheap: **score the
convex and concave halves of the curvature term separately.** If the term is wrong on
convex ground, the positive-curvature half hurts and the negative half helps. If the
base state is the problem, both halves are correctly signed and the convex one merely
has nothing left to correct. `omegaC` already carries the sign.

*Measured: the biases, from measurement 3. Reasoned, not measured: everything about what
HRRR's wind already contains — nothing here interrogated the model's own terrain
response.*

## The diversion row does not say what the note reads off it

The note reads the direction column as 70.5 degrees with the turning off and 70.8 with
it on, and hypothesis 5 rests on that. The table does not say it. Against the candidate
definitions in `tools/score-wind.js`:

| candidate | divert | speed weights | dir rmse |
| --- | --- | --- | --- |
| HRRR alone | — | — | 70.5 |
| no diverting | **off** | all on | 70.5 |
| diverting only | **on** | all zero | **70.5** |
| slope only | on | slope | 70.8 |
| curvature only | on | curvature | 70.8 |
| downscaled | on | all on | 70.8 |

`divertOnly` zeroes every gain but leaves `divert` at its default of true, and the
diverting angle does not depend on the gains. So the row that isolates the turning has
the turning **on**, and it costs nothing. 70.8 appears exactly when diversion *and* a
non-zero speed weight are both active — most likely `windAt`, which interpolates
east/north bilinearly, so once neighbouring cells carry different speeds the sampled
bearing is pulled toward the faster one.

**Hypothesis 5 is not supported by these rows.** The row that isolates diversion shows
no cost at all. Judging the term needs a direction score taken at the cell rather than
through a speed-weighted interpolation.

*Measured: the candidate definitions and the gain-independence of the diverting angle,
read from the code. Reasoned: the interpolation mechanism.*

## Roughness cannot carry hypothesis 3

The log law as `downscale.heightFactor` applies it, 10 m to a 6.1 m sensor:

| z0 | surface | factor | residual bias |
| --- | --- | --- | --- |
| 0.03 m | mown grass (current default) | x0.915 | x1.54 |
| 0.50 m | tall brush, scattered trees | x0.835 | x1.41 |
| 1.00 m | open forest | x0.785 | x1.33 |
| 3.00 m | city centre / tall forest | x0.589 | x1.00 |

Closing the x1.688 bias through the height correction alone needs **z0 near 3 m**, which
is not a RAWS site in Colorado. Grass to brush buys 8 points of a 69-point gap. A
per-station roughness is worth having on its own merits and it is not the explanation.

*Measured: the log law at the heights and roughness the harness uses. The z0 labels are
conventional values, not a land-cover lookup.*

*Run — [measurement 7](#measurement-7-six-runs-off-the-archive-and-what-roughness-does-to-the-bias),
with HRRR's own SFCR as well as fixed classes, and with Wieringa's two-surface form as
well as the one-step law. This section is right and understates itself: roughness cannot
carry hypothesis 3 even when the roughness is measured rather than assumed, because what
the stations need does not correlate with it at all.*

## The missing cell now exists

Every ridge number in this note is a raw score, with a 70% gain still in it — the
condition measurement 2 established contaminates a ranking. `score-wind.js` now reports
`debiasedByTerrain`: the same split as `byTerrain`, with each candidate's overall bias
divided out, one scale fitted over every pair and never refitted inside a stratum.

Run it before drawing anything further from the ridge column. If the ridge penalty
survives the debias it is a fact about where the term puts the wind; if it does not, it
was the gain all along and hypothesis 1 is chasing an artifact.

*Run — [measurement 6](#measurement-6-the-curvature-terms-two-halves-through-the-debiased-table).
It does not survive: ten candidates inside 0.02 m/s on the ridge column once the bias is
out. It was the gain.*

## What I did not verify

- **I ran none of the scoring.** Every number quoted from measurements 1-5 is the note's.
  The new table has unit tests and has not been run against a station.
- The band-pass table is arithmetic on the operator, not a measurement of terrain. Real
  ground is not a sinusoid; the filter response is exact, its consequence for these
  thirteen domains is inference.
- Nothing here tests what HRRR's wind already contains on a ridge. The base-state
  explanation is the most plausible remaining candidate, not a measured one.
- No claim about 3DEP coverage, the shelter term, or WindNinja.
