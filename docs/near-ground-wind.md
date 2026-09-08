# A wind at 0–3 m over a two-mile box: what stands between here and there

The asked-for product is a map a person zooms into over their own ground — call it a
two-mile radius — showing the wind they are standing in, at 0–3 m above the surface,
drawn over the terrain that shapes it.

Nothing in this repository can do that yet, and the gap is not a rendering job. This note
is the route: what each missing piece is, what it costs, what would falsify it, and which
of them have to be finished before the layer above them means anything. It is written in
dependency order rather than in effort order, because three of these steps make the next
one measurable and the rest are unmeasurable until they are done.

`docs/downscaling.md` is the standing record of what has actually been measured; this note
quotes it rather than repeating it, and adds nothing to it. Nothing here is a claim that
the map is close.

## Contents

- [The four numbers that bound the problem](#the-four-numbers-that-bound-the-problem)
- [Step 1: get the clock out of the error](#step-1-get-the-clock-out-of-the-error)
- [Step 2: observe the layer, or stop claiming it](#step-2-observe-the-layer-or-stop-claiming-it)
- [Step 3: a reference wind per cell, not per box](#step-3-a-reference-wind-per-cell-not-per-box)
- [Step 4: channelling, which is not a perturbation](#step-4-channelling-which-is-not-a-perturbation)
- [Step 5: the 0–3 m layer itself](#step-5-the-03-m-layer-itself)
- [What the map must say about itself](#what-the-map-must-say-about-itself)
- [The thing most likely to be misread](#the-thing-most-likely-to-be-misread)

## The four numbers that bound the problem

Everything below is an attempt to move one of these.

| | size | where it is from |
|---|---|---|
| HRRR's speed bias over the RAWS sample | **+43% to +70%** | measurements 7, 12 |
| What the pairing clock costs, at the offsets actually used | **0.85 m/s speed, 23° direction** | the ASOS one-minute run |
| The whole spread of every terrain candidate ever ablated | **0.06 m/s** | measurement 2 onward |
| What the diverting term does to direction | **0.3°** | measurement 4 |

The order matters more than the values. **The two largest numbers are not about terrain at
all**, and until they are dealt with, a terrain treatment cannot be scored: the third row
is a fifteenth of the second. A 0–3 m field is a terrain-and-surface product, so it sits
at the bottom of that list and every measurement of it inherits the noise of everything
above it.

## Step 1: get the clock out of the error

**Why first:** it is the largest correctable term, it is not physics, and it contaminates
every score used to judge the steps after it.

An hourly model paired against an observation 12.6–14.3 minutes away from it costs
0.85 m/s of speed RMS and 23° of direction before the model is wrong about anything —
measured from 819,249 one-minute ASOS records, not assumed. Two things are known about
fixing it and one is not:

- **Interpolating the model to the observation's minute recovers about 12%** (1.20 → 1.09
  m/s). Sub-hourly variability is not in an hourly series to be recovered, so this is
  worth doing and is not the answer.
- **Ten-minute pre-averaging on both sides recovers about 30%.** It needs an observation
  source that publishes sub-hourly rows; FEMS does not, and MADIS does.
- **Unknown: whether a sub-hourly model helps.** HRRR sub-hourly output exists at 15
  minutes. Nobody here has read it, and it would halve the remaining offset if the
  transmit slots stay where `data/fems-stations.json` says they are.

**Falsifiable by:** rescoring a completed archive day with pre-averaged pairs. If the
debiased spread between candidates does not grow relative to the residual, the clock was
not what was hiding them.

## Step 2: observe the layer, or stop claiming it

**Why second:** there is currently **no observation anywhere in this project below 6.1 m**,
so a 0–3 m field cannot be scored at all. Every number in `docs/downscaling.md` comes from
a RAWS at 6.1 m or an ASOS at 8.2–10.1 m.

Getting from a measured 6.1 m to a drawn 2 m is a surface-layer profile, and its size is
entirely an argument about a quantity nobody here measures per cell:

| roughness z₀ | u(2 m) / u(6.1 m) | u(2 m) / u(10 m) | u(1 m) / u(10 m) |
|---|---|---|---|
| 0.01 m — short grass | 0.83 | 0.77 | 0.67 |
| 0.03 m — grassland | 0.79 | 0.72 | 0.60 |
| 0.10 m — sage, crops | 0.73 | 0.65 | 0.50 |
| 0.25 m — scrub | 0.65 | 0.56 | 0.38 |
| 0.50 m — trees | 0.55 | 0.46 | 0.23 |

Three things fall out of that table, and they are the whole of step 2.

- **The correction is real but modest, and its uncertainty is not.** Over the plausible
  range of ground the ratio to 2 m spans 0.56 to 0.77 — a factor of 1.36, or about ±15%
  on the drawn speed, from an input we do not have per cell. That is five times the whole
  ablation table and a fifth of the HRRR bias.
- **Below about 2 m over anything taller than grass, the log law is not merely uncertain,
  it is invalid.** The bottom rows of that table are inside the roughness sublayer or
  inside the canopy itself, where the profile needs a displacement height and a canopy
  model rather than a logarithm. `u(1 m)/u(10 m) = 0.23` over trees is arithmetic, not
  physics. **A 0 m reading does not exist**: the log law goes to zero at z₀ by
  construction, so the honest bottom of the product is a metre or two, not zero.
- **Roughness has already failed once here, and this is a different question.**
  Measurement 7 killed z₀ as an explanation of the *station factor* (r = -0.02 in
  Colorado). It says nothing about z₀ as the *profile exponent*, which is the only role it
  plays here — that use is a specification, not a hypothesis, and it is why `roughness.js`
  stays out of the runtime path until it is used for this.

### The survey has now been done, and it half-answers this

The ask was: read MADIS' agricultural and hydrological networks for sensor heights, on
the grounds that some measure 2 m *and* 10 m on the same mast and would hand over a
measured profile ratio instead of an assumed one. `docs/observations.md` carries the
catalogue read. Three findings, in order of how much they change this note:

- **Sub-3 m observations exist in quantity and are free.** CoAgMet publishes a per-station
  `anemometerHeight` and has **95 active Colorado stations at 2.0–3.0 m** on a 5-minute
  timestep, 14 of them in 2 km valley bottoms. USCRN's `WIND_1_5` is a documented **1.5 m**
  5-minute mean at 158 US stations — *inside* the drawn layer rather than above it — and
  3DEP under all 116 CONUS sites puts **16 of them in 2 km valley bottoms**, down to
  −158 m at John Day, Oregon. Step 2's "nothing below 6.1 m" is a statement about what
  this project has scored, not about what is available.
- **MADIS itself does not carry a sensor height.** Its `windSpeed10` variable is empty for
  every provider in the hour sampled and no variable in the file states a height, so the
  height comes from each provider separately. A field named for a height is not a
  measurement at that height.
- **No source found measures two heights on one mast.** Not CoAgMet, not USCRN, not any
  provider reachable through MADIS. **The measured profile ratio is not available**, and
  the table above stays an assumption.

### What two nearby masts say instead, and why it is not a profile

The closest substitute is CoAgMet's Fort Collins cluster: `ftc01` at 2.01 m and `fcc01` at
10.0 m, **520 m apart**. Two whole months at 5 minutes, paired on the timestamp, ratios
taken only where the 10 m mast reads ≥ 2 m/s:

```
                                   n    median   p10    p90    day    night   dir RMS
ftc01 2 m / fcc01 10 m, Aug     4697     0.489  0.160  0.778  0.567   0.295      29 deg
ftc01 2 m / fcc01 10 m, Feb     3754     0.602  0.204  0.844  0.666   0.422      33 deg
```

The log-law table above predicts 0.56–0.77 for this step. The August median is **below the
bottom of it**, the February median is inside it, and the same pair of instruments moves
0.11 between two months and 0.24 between day and night — a stable-nocturnal-layer
signature that a neutral log profile does not contain at all. Two controls say how much of
that is even about height:

```
ftc01 2 m / fcl01 10 m, 4.8 km, Feb    2045     1.098  0.414  2.018             47 deg
fcc01 10 m / fcl01 10 m, 5.0 km, Feb   2058     1.515  0.792  2.997             44 deg
```

**A 2 m mast reads *faster* than a 10 m one 4.8 km away, and two 10 m masts 5 km apart
disagree by half.** Siting, irrigation and exposure are larger than the entire height
correction being argued about, so **two nearby stations are not a vertical profile** and
nothing above should be read as a measured z₀. What the 520 m pair does establish is that
the ratio is real, seasonal and diurnal, which is worse news for a single fixed factor
than having no measurement was.

**Falsifiable by:** paired 2 m and 10 m observations on one mast — still the thing that
would settle it, and now known not to exist in the free networks. Failing that, scoring
the solved field directly against USCRN's 1.5 m and CoAgMet's 2 m masts skips the profile
argument entirely: it grades the drawn layer against instruments standing in it, which is
the first time that has been possible here.

### That score has now been run, and it moves this step but does not close it

Measurement 16 in `docs/downscaling.md`: 31 CoAgMet masts at 2–3 m, four archive dates,
11,859 pairs. Three things in it belong to this note.

- **The bias down there is not the bias up here.** HRRR needs ×0.84–1.02 over these masts
  and is unbiased on the windy March day, against ×0.60–0.70 over RAWS at 6.1 m on the same
  dates. The log law accounts for a factor 0.79 of the difference and no more. So the
  headline "HRRR runs 43–70% fast", which this note's first bounding number came from, is a
  property of the RAWS sample rather than of the model.
- **Direction is the weak quantity in this layer, and this note had not said so.** 34° RMSE
  on the windy day, 53–62° on the light ones, against a 17° clock term. Every step above is
  written about speed. A wind arrow at 0–3 m is read for its direction first, and that is
  where the model is worst.
- **It is still not a validation of the drawn layer.** What was graded is HRRR moved to the
  mast by the same untested profile this step is about, so the fitted scale absorbs whatever
  the profile gets wrong. A score against a 2 m mast makes the profile *testable*; it does
  not test it. Two heights on one mast, or a mast the profile was not used to reach, remain
  the thing that would.

## Step 3: a reference wind per cell, not per box

**Why third:** it is the reason a two-mile map looks uniform, and unlike steps 1, 2 and 4
it is a solved engineering problem rather than an open one.

Measured over four real domains through the live `/v1/field`: nine arrows in ten fall
inside a 4.6–8.6° band, because a two-mile box is about one HRRR cell and the whole map is
handed a single reference wind. Every bit of structure it can show comes from the terrain
terms and none from the model. That is an accurate drawing of the field being computed,
and the field is the thing that is wrong.

Solving the box in pieces against HRRR's own gradient puts the model's own structure back
on the map. It cannot fix the physics and it is not a substitute for step 4 — but it stops
the renderer being blamed for something upstream of it, and it is the one item in this
note that could be done now without new observations.

**Done, and off by default — measurement 17.** `field.js` will sample the model per
terrain cell (`perCell`) instead of once at the centre, and the 90% arrow band over the
same four domains widens from 1.2–11.8° to 19.2–43.6°. Three things to carry forward:

- **The new spread is the model's, not the ground's.** The terrain factor for a cell is
  unchanged when that cell's reference wind is, by construction and by test. Nothing about
  step 4 has moved.
- **Displaced model readings score worse, on both networks.** Reading HRRR half a mile,
  one mile and two miles from a mast degrades speed and direction monotonically against
  CoAgMet and against FEMS — while still beating the noise null, so the gradient is real
  information about somewhere else. That is why the default stays at the centre sample.
- **It is loudest where the model is weakest.** The largest per-cell direction spread of
  the four, 84.8° at Boulder, sits on a 3.3 mph wind — the light-wind regime where
  measurement 16 puts the model's own direction RMSE at 53–62°.

## Step 4: channelling, which is not a perturbation

The diverting term is MicroMet's `-0.5·Ωs·sin(2(aspect − wind))`. It caps at 14.3° at the
single steepest cell oriented 45° to the flow, gives 1–2° at a typical one, and measured
against anemometers it moves direction RMSE by 0.3°. A real canyon turns the flow far
harder than that and can reverse it; a weak-perturbation term cannot represent it by
construction, and **no amount of tuning the coefficient turns it into one**.

This is the step that would actually make the map worth zooming into, and the blocker on
it has changed. It was "the catalogue has no hollows in it"; measurement 14 shows that was
a statement about a 500 m disc, and at the 2 km scale a two-mile map is actually about,
15 of the 87 Colorado RAWS readable at both radii are valleys, and the already-scored
pairs restratify to ten valley stations instead of two. Pooled over those ten, HRRR needs
slowing by about 20% more than over the exposed ones (t ≈ 2) — sheltering was visible for
the first time. **It did not survive New Mexico**: pre-registered and scored there,
the same split is −0.010 ± 0.074 against Colorado's −0.157, and the held-out line is worse
than a pooled scale (measurement 15). Per station the landform predicts almost nothing of
it in either state, so a channelling term fitted today would be fitted to a group mean
that only exists in one of them. CoAgMet adds 14 more valley-bottom
sites at 2 m if the term needs testing near the ground rather than at 6.1 m. Fitting one
on ridge stations would still be curve-fitting with a physical-sounding name, which is the
failure mode measurements 6, 10 and 11 were each caught by.

## Step 5: the 0–3 m layer itself

Only after the four above. In order, it is: a reference wind per cell (step 3), the
terrain treatment scored with its leverage visible and the clock out of the residual
(steps 1 and 4), then the profile taken down from 10 m to the drawn height with a per-cell
z₀ from land cover (step 2), and the whole thing scored against masts that actually
measure there.

The one piece of it already built is the leverage reporting in `tools/score-wind.js`:
every candidate rescored with each station's pairs removed, and `leverage.stable` saying
whether the ranking survived losing one mast. That does not move any of the four numbers.
It stops the next thing that does from being credited to a single station, which is how
two leads in this project were lost.

## What the map must say about itself

The same rule the rest of the service already follows: **a field that cannot be defended
is refused, not smoothed.** For this product that means at least

- the drawn height stated on the map, not implied — `heightAglM` is already in the
  contract and already refuses to quietly match a 6.1 m mast;
- speed reaching the eye as arrow *length* and not only as a colour wash — **done**:
  `wind-map.arrowScale` lengths every arrow in proportion to its own speed, so the ±15–25%
  already in the field is legible as a shape rather than as a band of colour. Two things
  it deliberately does not do: it scales to a **stop on the speed legend** rather than to
  the fastest cell on screen, because normalising to the maximum would silently rescale
  every arrow each time the view moved over a gust; and it **clamps short arrows to a
  stub** and says at what speed the clamp starts, because an arrow drawn to scale at
  0.5 mph is a dot and a dot reads as no data, which on this map means a hole;
- the near-ground factor shown as the range it is, not as a number;
- and no near-ground layer at all over ground with no land cover behind it, in the same
  way `no-terrain` is an answer today.

## The thing most likely to be misread

A 0–3 m wind is the wind a person feels, checks against the grass and the flags, and
believes. **It is not the wind above them**, and for anything that travels — a projectile,
a drone, smoke, a drifting boat — the layer that matters is mostly the one this product
does not draw. The profile between 3 m and 50 m is where the difference lives, and it is
larger than every correction in this note.

So the near-ground layer is the part a user can *verify*, which makes it the most valuable
thing to draw and the easiest thing to over-trust. Any consumer integrating along a path
needs the profile, not the ground layer — WindSolver's job is to serve the profile with
its heights stated, and the interpretation of what a path through it does belongs to the
consumer.
