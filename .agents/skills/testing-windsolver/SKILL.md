---
name: testing-windsolver
description: Browser-test the WindSolver public map page, the /v1/field service and the /v1/hillshade shaded-relief overlay, locally or against the live windsolver.com. Covers starting the static+API server, warm vs cold solves, coordinates that reliably produce full / partial / no 3DEP coverage, checking provenance against the raw JSON, the mobile-layout trap, working around a USGS TNM listing outage, and verifying the API-key gate and its Sec-Fetch-Site same-origin door. Use when verifying anything in public/index.html, public/map.js, public/wind-map.js, auth.js, server.js static serving, hillshade/relief rendering, or terrain-coverage behaviour.
---

# Testing WindSolver in the browser

WindSolver is a general terrain + atmosphere service. It must never mention rifles,
bullets, holds, scopes or reticles — a grep of `public/*.{html,js}` plus a scan of
`document.body.innerText` is the cheap regression check (`radiusMiles` matches a
case-insensitive `MIL` search; that is a false positive).

## Run it

```bash
cd /home/ubuntu/windsolver
npm install                       # usually already done
node tools/serve.js --port 8123   # serves public/ AND the API; --no-static disables the page
```

Page: `http://127.0.0.1:8123/`. Startup logs a JSON line with `staticDir`, `timeoutMs`
(45 s), `maxConcurrent`, `maxQueue`. No auth, no login.

The page needs outbound internet: unpkg (Leaflet CSS/JS with SRI), OpenStreetMap tiles,
USGS 3DEP, NOAA NOMADS. Check reachability with curl **before** judging a grey map as a
bug — a blank grey map means the CDN is blocked, not that the code is broken.

## Testing the deployed site (windsolver.com)

Nothing needs building or serving — `https://windsolver.com` is a droplet behind
nginx. Point the same checks at it. The live box is well warmed, so Boulder comes back
in ~0.4 s rather than the 20–40 s a cold local run takes; do not read a fast answer as a
fake one, read the coordinates and elevation instead.

## The API-key gate, and why it must be tested in a real browser

`/v1/` is closed behind `WINDSOLVER_API_KEYS` (set in the droplet's systemd unit; the
values are not in the repo and must never be read, printed or typed into a browser).
`auth.js` refuses with 401 `no-key` / `bad-key` / `bad-authorization`. `/healthz` and the
static page are never gated.

The public map page cannot hold a key — it runs in a stranger's browser — so it is let
through by `looksLikeThePage()`, which accepts `sec-fetch-site: same-origin`. **curl
cannot prove this works**: curl can set that header by hand, but only a real Chrome shows
whether the CDN/nginx in front preserves `Sec-Fetch-*`. Verify in the browser:

- Solve on the page, then DevTools → Network → the `/v1/field` row → **Headers**. You want
  `Status Code: 200 OK` and `Sec-Fetch-Site: same-origin` in Request Headers, with no
  `authorization` / `x-api-key`. The dock-right panel is too narrow to show General and
  Request Headers together — drag the DevTools splitter left to ~300 px and both fit in
  one screenshot.
- Confirm no key ships to the client with DevTools global search (`Ctrl+Shift+F`) for
  `x-api-key`, `authorization`, `bearer`, `apikey`. **Always follow a "No matches found"
  with a control term that must match** (e.g. `fieldQuery`, which hits 5 times in
  `map.js`/`wind-map.js`) — otherwise an unpopulated search index looks like a clean bill
  of health.
- Cross-origin refusal: open `https://example.com`, and in its console run
  `fetch("https://windsolver.com/v1/field?lat=40.0150&lon=-105.2705&radiusMiles=1&cols=48")`.
  Expect **both** refusals at once — the Network row shows `401`, and because
  `server.js` only echoes `access-control-allow-origin` for an allow-listed `Origin`, JS
  cannot read it and the promise rejects with `TypeError: Failed to fetch`. A resolved
  200 with a readable field would mean the same-origin door is too wide.

Note `/v1/field` takes `radiusMiles` (+ optional `cols`), not `halfWidthM`; a wrong
parameter name still 401s before validation, which can disguise a bad test.

## Cold vs warm solves

A first solve over new ground fetches real terrain + a live HRRR cycle: 20–40 s is
normal and a 45 s `timeout` refusal is designed behaviour, with a fast (<1 s) retry
afterwards. Warm solves report `Solved in 0.0 s.` Deliberately leave one coordinate cold
if you want to film the loading state. Pre-warm a coordinate with curl if you do not.

## Coordinates that reliably produce each case

| Case | lat / lon | radius | Result |
|---|---|---|---|
| Full coverage | 40.0150, -105.2705 (Boulder) | 1 mi | `coveredFraction` 1, 3DEP 1m, elevation 1602–1738 m |
| Partial coverage | 33.9700, -118.5600 (offshore Santa Monica) | 2 mi | `coveredFraction` ≈ 0.28 → panel says "72% of this box has no terrain under it"; the uncovered part must stay transparent |
| No coverage | 48.8566, 2.3522 (Paris) or 30, -140 (mid-Pacific) | any | HTTP 502 `{"ok":false,"code":"no-terrain"}` → red status on the page |

The safety property to check on the partial case: uncovered cells are **skipped**
(basemap shows through), never painted with the 0 mph colour. Zoom into the
painted/unpainted boundary for evidence.

## The shaded-relief overlay (`/v1/hillshade`, `#relief`)

`GET /v1/hillshade?lat&lon&radiusMiles[&width&resolutionM&azimuthDeg&altitudeDeg]` returns
an 8-bit greyscale PNG; byte `0` is a transparent hole where 3DEP has no terrain. Placement
is **only** in response headers (`X-WindSolver-Bounds` south,west,north,east, `-Size`,
`-Resolution-M`, `-Terrain-Resolution-M`, `-Terrain-Dataset`, `-Covered`, `-Sun`), because
the solved domain is padded and snapped relative to the requested box. It fetches no
weather (it calls `field.terrain()`), so it is gated, limited and timed out like
`/v1/field` but fails independently of it.

How to test it in the browser:

- The checkbox is `#relief` ("Shaded relief under the wind"), the caption is `#reliefNote`
  (e.g. `Shaded relief · 3DEP one-third · 8.4 m/px · 68% no terrain`). The image lives in a
  Leaflet pane named `relief` at z-index 350, under `overlayPane` (400).
- Measure rather than eyeball: `document.querySelectorAll('.leaflet-relief-pane img').length`
  is **1** when drawn and **0** after unticking, after moving the pin, and after changing
  radius. `clearRelief()` removes the layer and revokes the blob URL — a `display:none`
  would be a regression.
- Registration is the failure mode that matters. Boulder r=1 cannot discriminate it (the
  requested box, `body.domain` and the header bounds coincide); use r=2 over strong relief
  (Gross Reservoir 39.9469, -105.3575) and check ridges/valleys sit under the OSM roads and
  the reservoir polygon. Cross-check the caption's `m/px` against `X-WindSolver-Resolution-M`
  in the Network panel.
- Partial coverage vs flat lit ground look identical on the basemap. The discriminator is a
  pixel comparison: screenshot the same view with relief on and off and compare a pixel over
  the uncovered part — identical RGB proves transparency, not a flat fill. Santa Monica
  33.9700, -118.5600 r=2 gives `X-WindSolver-Covered: 0.321` → caption `68% no terrain`.
- Non-fatal relief failure is the case a user actually hits: DevTools request blocking on
  `/v1/hillshade` **only**, then solve on good ground. Expect a green `Solved in N s.`, a
  rendered wind field, and the failure confined to `#reliefNote`
  (`No relief here — Failed to fetch`).
- No-terrain ground (Paris 48.8566, 2.3522): both routes 502 and **each refusal must have its
  own words** — the main status carries the wind refusal, `#reliefNote` carries
  `No relief here — …`. This was silent before commit `251e538`, because `solve()`'s refusal
  path called `clearField()` → `clearRelief()`, which aborted the in-flight hillshade so
  `loadRelief()` ended in `AbortError` before writing its note. The split is `clearWind()` on a
  refusal, `clearField()` only for true invalidation (pin moved / box changed). If you touch
  that area, re-test both halves: Paris (note must speak) and a pin move after a good solve
  (relief pane `img` count must go to 0 and `#reliefNote` to "").
- **Known issue (as of `251e538`): a revoked-blob console error on the coordinate-input pin
  move.** Solve on good ground with relief, then edit `#lat` and blur: the relief clears
  correctly but Chrome logs `GET blob:http://…/… net::ERR_FILE_NOT_FOUND`. Moving the pin by
  clicking the map (no recentre) does not do it, so it looks like `URL.revokeObjectURL()`
  racing Leaflet's re-render of the overlay `img`. Cosmetic — nothing stale is drawn — but do
  not call the console clean without checking this path.
- Chrome caches the hillshade PNG (`max-age`), so after switching servers a relief caption can
  show the **previous** server's dataset (e.g. `one-third` when the field says `3DEP 1m`) with
  no `/v1/hillshade` line in the server log at all. Tick DevTools → Network → **Disable cache**
  before judging any caption or provenance mismatch.

## When USGS TNM product listing is down

TNM `/api/v1/products` sometimes returns HTTP 200 with an error object, which makes every
coordinate look like "no terrain" and can wrongly condemn a branch. Check it directly first:

```bash
curl -s "https://tnmaccess.nationalmap.gov/api/v1/products?datasets=National+Elevation+Dataset+%28NED%29+1%2F3+arc-second&bbox=-105.28,40.00,-105.26,40.03&max=2"
```

If it is down, a **test-only** launcher in `/tmp` that intercepts only that listing call and
returns known 1/3-arc-second S3 COG URLs (restricted to CONUS so Paris still has no terrain)
keeps the COG reads, shading, PNG, headers and browser path real. Never edit repo source for
this, and say in the report that the launcher bypasses `listing.js`'s disk cache
(`~/.cache/windsolver/tnm`, TTL 14 days) so nothing observed says anything about that path.
When TNM recovers, `rm -rf ~/.cache/windsolver/tnm` and re-shoot at least one solve through
unmodified `node tools/serve.js` — the stale cache will otherwise keep serving the stub's
answers. Terrain reading as `one-third` instead of `1m` is an outage/dataset artefact, not a
branch change.

To evidence the listing disk cache itself: `rm -rf ~/.cache/windsolver/tnm`, start the stock
server, solve once (files appear, one per dataset — Boulder r=1 writes four), then **restart
the server** so its in-process caches are empty and solve the same box again. A warm solve
that writes no new cache file and mtimes that do not move is the cache hit; wall-clock time is
not, since the COG reads dominate (4.2 s cold vs 4.1 s warm on Boulder).

Backgrounded servers in this environment die when the spawning shell ends; start them with
`setsid nohup … &` and confirm with `curl /healthz` before driving the browser.

## RAWS station markers (`/v1/stations`, `#stations`)

The measured layer is separate from the modelled one all the way down: its own service
(`stations.js`, USDA FEMS, anonymous, no token), its own route, its own Leaflet pane, its
own caption `#stationNote`, its own failure text. Test it as an independent layer.

- Selectors: checkbox `#stations` ("Measured wind at RAWS stations"), caption
  `#stationNote`, markers `.leaflet-stations-pane .station-marker`.
- Pane order is the assertion for "measured on top of modelled": stations **620** >
  overlay (wind wash/arrows) **400** > relief **350**. Probe the pane `style.zIndex`
  rather than eyeballing.
- Reporting station = filled disc + white ring + arrow; non-reporting = `fill="transparent"`
  with `stroke-dasharray="3 2"` and **no** arrow path, title `NAME — not reporting`, and
  the popup must contain `Not calm: nothing was measured.`
- **Find a naturally non-reporting station rather than stubbing.** Query a wide box with
  curl and grep for `"observation":null`. At time of writing **SOUTH REPUBLICAN, id 51301,
  39.62594 / -102.12239** reports no wind and is a reliable natural case; if it recovers,
  re-scan: `curl -s ".../v1/stations?lat=39.5&lon=-105&radiusMiles=200&limit=200"`.
  A 200-mile FEMS query can take more than 30 s the first time (directory download);
  give it a long timeout.
- FEMS timestamps are whole-hour labels, so the popup must read
  `N h ago (…Z) · hour label, ±30 min` and `Not quality-controlled yet.` A bare exact
  minute is a bug (see `AGENTS.md` on FEMS hour labels).
- **Forcing a station-service outage without touching the repo:** DevTools request
  blocking on `/v1/stations` gives `No stations — Failed to fetch` (client-side). To
  exercise the *server's* refusal path instead, `createServer` accepts an injected
  service, so a `/tmp` launcher is enough:
  ```js
  const server = require("/home/ubuntu/windsolver/server.js");
  const broken = { inBox: async () => { const e = new Error("FEMS did not answer (test stub)");
    e.code = "stations-unavailable"; throw e; } };
  server.createServer({ stations: broken, staticDir: "/home/ubuntu/windsolver/public" })
    .listen(8124, "127.0.0.1");
  ```
  Pass `staticDir` or you get the `/healthz` JSON instead of the map page. Expect the note
  to name the refusal while `#status` stays green and the relief still draws.
- A field/terrain refusal (e.g. 33.00 / -121.00) must **not** clear the station layer —
  probe marker count and `#stationNote` before and after the refused solve.
- Movement is debounced 400 ms: expect **one** `/v1/stations` per settled view. Count with
  `performance.getEntriesByType("resource").filter(r => r.name.includes("/v1/stations"))`
  after `performance.clearResourceTimings()` — cheaper and more reliable than reading the
  Network panel.
- An empty area legitimately reads `0 of 0 stations · RAWS via fems · locations only — no
  observations read`; that is not a failure.

## Compare mode: colouring the stations by model ÷ measured (`#compare`)

- Selectors: `#compare` ("Colour them by how far the model is out") inside `#compareRow`
  (gains `.check.off` and `#compare.disabled` when `#stations` is unticked), legend block
  `#compareKey` (hidden unless compare is on), median text appended to `#stationNote`
  (`model N.NN× measured (median of K)`).
- **The comparability rule is time-dependent and will make a correct build look broken.**
  A station is only compared when |observation hour − model hour| ≤ 1 h. HRRR's ~2 h
  publication lag plus a *cached* volume in a long-running server can put the model two
  hours behind the newest FEMS observations, in which case **every** station is
  legitimately uncoloured with "the observation and the model hour are N min apart".
  Restarting `tools/serve.js` makes it pick up the fresh cycle; check
  `model.validTime` in `/v1/stations?...&model=true` before calling it a bug.
- Grade the colours numerically, not by eye: fetch the same `/v1/stations` query with
  `model=true`, compute `model.speedMps / observation.speedMps` per station and compare
  with the marker `fill` and the caption median. Calm (`0 m/s`) must stay
  `fill="transparent"` + `stroke-dasharray="3 2"` with a "not a multiple of nothing"
  popup — never a near-white "agreement" colour.
- Refusal paths worth filming: zoom out until the derived radius (half the view diagonal)
  exceeds **150 mi** (`MAX_MODEL_RADIUS_MILES`) → `model-box-too-large`, all markers
  uncoloured but observations intact; and a box outside the HRRR CONUS domain (Puerto
  Rico `lat=18.2&lon=-66.5&radiusMiles=100`) → `model-unavailable` with the observations
  still present. A per-station `modelNote` is hard to hit naturally — do not block on it.
- Hillshade registration can be graded exactly in the browser: read
  `x-windsolver-bounds` from the `/v1/hillshade` response and compare with
  `map.latLngToContainerPoint()` of the drawn `.leaflet-relief-pane img` corners; agreement
  to well under a pixel is the pass.
- **Mobile screenshots: the DevTools device toolbar gives useless pictures.** Docked
  DevTools scales the emulated viewport (34% is common), so the app is a postage stamp and
  the frame visually clips content that is actually in-bounds. Use the device toolbar only
  for the *measurements* (`innerWidth`, per-element `getBoundingClientRect()`,
  `scrollingElement.scrollWidth === innerWidth`), then close DevTools and
  `wmctrl -i -r <id> -e 0,40,40,500,900` for a legible single-column screenshot.

## Compare provenance with the raw JSON

Run the identical query with curl and diff field by field — the panel is meant to be a
faithful readout, not a summary:

```bash
curl -s "http://127.0.0.1:8123/v1/field?lat=33.97&lon=-118.56&radiusMiles=2&cols=48" > /tmp/f.json
```

Check `source`, `validTime`, `terrain.resolutionM`/`dataset`, `reference.resolutionM`,
`grid.coveredFraction` (→ void %), `grid.elevationM` min/max, speed min/max, `confidence`
(null renders as `Confidence: unstated`). The amber "Modelled, not measured" notice must
be visible without hunting.

## Arrow length and the `#arrowScale` caption

The field arrows are lengthed by their own speed by `arrowScale(cells, {maxPx, floorPx})`
in `public/wind-map.js`, and the caption it produces is written into
`<p id="arrowScale">` under the "Speed, mph" legend. Two properties make this testable
without guessing:

- `fullMph` is **quantised to the lowest non-zero `SPEED_STOPS` entry** (4, 8, 13, 19, 25,
  32, 39) that covers the fastest *drawn* cell — not the on-screen maximum. So the caption
  should step, never track the peak continuously, and it must never claim a full length
  below the fastest cell.
- `floorMph = fullMph * floorPx / maxPx`, and `map.js` calls it with `floorPx = maxPx*0.3`,
  so the stub threshold is always **30% of the full-length speed** (4→1.2, 8→2.4, 32→9.6).

Predict the caption before opening the page, so the browser check is a comparison rather
than an observation. The layer thins with `strideFor(grid, 320)` (stride 3 on a 48x48
grid), so take the peak of the *same subsample*:

```bash
curl -s "http://127.0.0.1:8123/v1/field?lat=40.2549&lon=-105.6151&radiusMiles=4" > /tmp/f.json
node -e 'const g=JSON.parse(require("fs").readFileSync("/tmp/f.json")).grid;
  // NB: grid.speedMps/fromDeg/elevationM are FLAT arrays of rows*cols, indexed
  // r*cols + c — not nested rows. g.speedMps[r][c] silently yields undefined,
  // which reads as "every cell is a hole" and quietly gives a peak of 0.
  const s=Math.max(1,Math.ceil(Math.sqrt(g.rows*g.cols/320)));let p=0;
  for(let r=0;r<g.rows;r+=s)for(let c=0;c<g.cols;c+=s){const v=g.speedMps[r*g.cols+c];
    if(Number.isFinite(v))p=Math.max(p,v*2.2369362920544);}
  const stops=[4,8,13,19,25,32,39];const full=stops.find(x=>p<=x);
  console.log({peakMph:p.toFixed(2),full,floor:(full*0.3).toFixed(1)});'
```

Domains that gave a different stop each, so the quantisation step is visible (values move
with the weather — recompute, do not trust these numbers):
40.0150,-105.2705 r=1 was a genuinely calm 4/1.2; 40.4136,-105.3540 r=1 was 8/2.4;
40.2549,-105.6151 r=4 (Rocky Mountain ridge) was 32/9.6 and is the one worth recording,
because it spans teal stubs and long arrows in a single frame.

Other things worth knowing:

- **`lengthFor` returns `null`, not the floor, for a null/NaN speed**, and the caller skips
  it. The negative check is a partial-coverage domain (33.9700,-118.5600 r=2, ~72% no
  terrain): the uncovered region must carry no wash *and* no stub arrows at all.
- **The caption cannot go stale, because it lives inside `#result`.** `_draw()` returns
  before calling `onScale` when the body is null and nothing resets `#arrowScale`, which
  looks like a stale-caption bug on a code read — but `clearWind()` sets
  `$("result").hidden = true`, which hides the caption with the rest of the panel. Verify
  it in the browser rather than reporting the code read: a pin move, a radius change and a
  no-terrain refusal all hide the whole panel.
- **Zooming re-runs the scale over a different thinned set** but the quantisation should
  hold the caption steady; a caption that changes on a bare zoom is the failure mode.
- **The per-cell reference is not reachable from the page.** `fieldQuery` sends only
  lat/lon/radiusMiles/cols/resolutionM, so there is no `perCell` control to exercise even
  though `field.js` supports the option. Report that rather than calling the API directly
  and presenting it as something the page drew.

## The particle layer (`#particles`, `#particleNote`)

Off by default behind `#particles`; the caption is `#particleNote`; the canvas is
`.leaflet-particles-pane canvas` (pane zIndex 410, `pointer-events:none`, between the
overlay pane 400 and the stations pane 620). Nothing draws until a field is solved *and*
the box is ticked, and `clearWind()` empties both canvas and caption, so a pin move, a
radius change or a refusal should leave zero lit pixels and a zero-length caption.

Measure it, do not eyeball it — the useful probes, all runnable from the console:

- **Is it animating / is it empty?** count pixels with `alpha > 10` in
  `getImageData` on the particle canvas, twice a second apart. Zero = empty layer;
  unchanging = frozen.
- **Which way is it moving?** cross-correlate two frames of the canvas over small (dx,dy)
  shifts and convert the best shift to a bearing; compare with the arrow direction in the
  panel. A 1-second gap is too long at high `motionScale` — use ~150-300 ms.
- **Does a trail cross a coverage hole?** build a boolean mask of the *wash* (overlay
  pane) pixels, dilate it ~3 px for antialiasing, and assert no lit particle pixel falls
  outside it. Always run a control with the mask deliberately shifted ~60 px: it should
  report tens of percent outside, otherwise your mask is meaningless.
- **False respawn streaks?** monkey-patch `ctx.moveTo`/`ctx.lineTo` on the particle canvas
  for a few seconds and record the longest segment. Healthy values are a couple of pixels;
  a streak bug shows up as a segment hundreds of pixels long.
- **Background-tab pause.** Same lineTo instrumentation bucketed per second, then
  `ctrl+t` for ~30 s and `ctrl+1` back (never navigate the map tab away). Expect zero
  segments for the whole hidden window and a normal, non-spiking first second on return.
  Corroborate with renderer CPU from the shell: sum `utime+stime` from `/proc/<pid>/stat`
  over all `pgrep -f "type=renderer"` pids before and during the hidden window (~28% → ~0.15%
  here). Note timers are throttled while hidden, so a `setTimeout` that ends an
  instrumentation window will fire late — read the result after you return.
- **Endurance.** A rAF loop for 180 s recording frame count, frames over 100 ms and
  `performance.memory.usedJSHeapSize` is a cheap responsiveness check (59.4 fps, 0 long
  frames, 22 MB here).

Caption checks: it must name a finite multiplier and both caveats ("not air travelling
over time", "stops at ground with no terrain under it"). The multiplier is computed from
metres-per-pixel, so it **must** change on zoom (93×→48× at higher zoom, 72×→220×→320× as
the view zooms out here). A fixed number across zooms is the failure mode.

A genuinely calm (0 mph) domain often does not exist in the live HRRR cycle — the listed
"calm" coordinates can come back at 3-7 mph. When that happens, say so rather than
claiming the calm case passed, and corroborate at the library level instead:
`WindMapLib.stepParticle(zeroSpeedGrid, p, 10)` must return a particle at the *same*
lat/lon (not `null`), and `WindMapLib.particleField` must still seed the requested count.

### Trail rendering, DPR and reduced motion

Since the trail renderer stopped fading the previous frame (`trailFade` gone) and started
`clearRect`-ing each frame and redrawing a stored polyline per particle (`trailPath()`,
defaults `trailPx 26`, `stepPx 2`, ≤64 points), the checks that matter are different:

- **Haze regression.** The old `destination-out` fade left a permanent low-alpha residue.
  Test it by counting canvas pixels with `0 < alpha < 20` at t≈5 s and again at t≈45-90 s;
  a healthy renderer keeps that count flat, and unticking `#particles` must leave *exactly*
  zero lit pixels. On mobile it presented as "no moving particles on iPhone" because the
  particles were lost in the haze, so a pixel count alone is not the assertion — take a
  zoomed screenshot and check the streaks are separable from the wash.
- **DPR.** `_reset` sizes the backing store by `min(3, devicePixelRatio)` while CSS size is
  unchanged; assert `canvas.width === cssWidth * ratio` (1170 × 1392 for a 390 × 464 map on
  an emulated iPhone 12 Pro). Everything else (`clearRect`, trail points, mask tests) is in
  CSS pixels because of the `setTransform(ratio,…)`.
- **prefers-reduced-motion.** Emulate it from the DevTools command menu, then **untick and
  re-tick `#particles`** — the flag is read in `_start`, so an already-running layer keeps
  the old speed and the caption keeps/loses the "Slowed, because this browser asks for
  reduced motion." sentence only after a restart.
- **Trail length: measure it, do not assume it.** Monkey-patch `moveTo`/`lineTo`, accumulate
  per-path length between `moveTo`s, and report median / p90 / max / fraction under 5 px.
  History worth knowing: when `life` was counted in *frames* (a fixed 120 ≈ 2 s at 60 fps),
  reduced motion (`pxPerSecond` 12 instead of 55) killed a particle before its trail reached
  the 26 px cap — median drawn path 5.8 CSS px against 20.7 px at full speed, ~47% of paths
  under 5 px, i.e. dots. Since `lib.particleLife(scale, {travelPx: 200})` (life =
  `(travelPx / pxPerSecond) * secondsPerSecond`, and `stepParticle` ages by the *seconds*
  advanced, not by 1 per call) a life is a distance over the ground, so it is invariant to
  the drawing speed: measured at 79a0c4a, reduced motion median 21.3 px against 22.8 px
  normal, 5.2% under 5 px in both. Expect roughly the same numbers in both modes; a large
  gap between them is the regression to look for.
  Also note `if (trail.length < 4) continue` means a particle with fewer than two sampled
  points draws *nothing at all* — so a slow field can look sparse as well as short.
- **The lifetime lever has two failure modes on the other side**, and neither shows up in a
  short look: too long a life collapses the cloud onto a few streamlines, and a stationary
  particle accrues no distance so it can only die on a field change. Test both with pixels
  rather than eyes: (a) split the particle canvas into a 16 × 16 grid and compare the count
  of occupied cells at t ≈ 10 s and t ≈ 115 s (95 → 90 of 256 on a 4-mile box at 79a0c4a —
  a real collapse drops it hard); (b) count pixels lit in *all* of 5 frames sampled 2-3 s
  apart — 0 on a strong field, a flat ~1.2% of lit pixels on a 1.3-2.4 mph field. The number
  growing between an early and a late window is the stuck-dot lattice; a flat one is not.
- **Counting drawn particles per frame:** patch `clearRect` (one call per frame) and
  `moveTo` (one per drawn trail) and take the ratio; compare with
  `WindMapLib.particleCount(mapWidthCss, mapHeightCss)` (density `perParticlePx` 900,
  min 90, max 1200 — 201 particles for a 390 × 464 phone map).
- **The terrain mask must be built in the *wash* canvas's own pixels.** The overlay-pane
  canvas is CSS-sized (390 × 464) while the particle canvas is DPR-scaled (1170 × 1392);
  comparing them index-for-index silently reports ~96% of trail pixels "outside coverage"
  and a shifted control that agrees with it, which is the tell. Scale the lookup
  (`wash[floor(y/3)*ww + floor(x/3)]`) and dilate in wash pixels. Correct result on the
  Santa Monica box: 56 of 697,281 lit trail pixels outside, control shifted 40 wash px 19.3%.
- **Known console noise:** revoked hillshade blob URLs log `GET blob:… ERR_FILE_NOT_FOUND`,
  and any `getImageData` instrumentation you add triggers the Canvas2D
  `willReadFrequently` warning. Neither is a renderer defect.
- **Panning to find the box wastes time**: screen coordinates are scaled relative to CSS
  pixels (1600 × 1200 display shown as 1024 × 768), so a drag moves ~1.6× further than it
  looks and the solved box disappears fast. Re-solving does *not* recentre the map — reload
  the page, set lat/lon (bubbling `change`), solve, and the box lands centred.

## Traps

- **Mobile layout is the thing to measure, not reason about.** Historically `#app` used
  `flex-direction: column-reverse` under `@media (max-width: 860px)` with
  `#map { height: 55vh }`, which overflowed *upwards* with no scrollbar and made the
  title, coordinate inputs and even the wind readout unreachable. Whatever the current
  CSS says, measure: `document.scrollingElement.scrollHeight > innerHeight` (the document
  must scroll), `aside.getBoundingClientRect().top + scrollY >= 0` for every control, and
  `map.bottom <= aside.top` (no overlap).
  Chrome will not resize its window narrower than ~500 CSS px (`wmctrl -r :ACTIVE: -e
  0,0,0,500,900` works; 390 is silently ignored). For 390/360 px, maximise the window and
  use the DevTools device toolbar (`F12`, then `Ctrl+Shift+M`) and type the width into the
  Dimensions box.
  If DevTools opens *undocked* (its own window, as it did once here), the device toolbar is
  more trouble than it is worth. A cleaner way to reach a sub-500 px CSS viewport with a
  legible screenshot: size the real window to 500 px and press `Ctrl+=` twice — page zoom
  shrinks the CSS viewport (500 → 400 CSS px at 125%), and `Ctrl+0` restores it. Confirm
  with `innerWidth` in the console.
- **In-flight responses must be invalidated when the user changes the query.** As of
  `48135eb` `clearField()` starts with `if (inFlight) inFlight.abort();`, which covers all
  four invalidators (pin drag, radius, grid, refusal); the abort lands in `solve()`'s catch
  and returns early on `AbortError` without overwriting the invalidator's status. Before
  that fix a slow answer could land after the pin moved and repaint a field for the old box
  under the heading "At the pin". This is the regression to re-check whenever `map.js`
  changes. Reproduce with cold ground (any untouched Colorado
  coordinate), click Solve, drag the pin twice within ~1 s, wait, then measure
  `{paths: document.querySelectorAll('.leaflet-overlay-pane svg path').length,
  resultHidden: result.hidden, status: status.textContent, solveDisabled: solve.disabled}`
  — expect `0 / true / "Pin moved. Solve to read the wind here." / false`. Also compare
  the domain rectangle's bounding box with the marker's:
  `document.querySelector('.leaflet-overlay-pane svg path').getBoundingClientRect()` vs
  `document.querySelector('.leaflet-marker-pane img').getBoundingClientRect()`.
  Timing matters — agent tool latency can let the solve finish before the second action,
  which looks like a pass; batch the Solve click and the pin drag into one action list.
- **If unpkg is blocked, `map.js` now returns early** with a red status naming
  `unpkg.com` and saying `/v1/field` still answers, and `#solve.disabled === true`. If you
  instead see a blank dark map with an empty `#status`, the guard has regressed. Reproduce
  with DevTools → `Ctrl+Shift+P` → "Show Network request blocking" → pattern `unpkg.com`,
  tick "Enable network request blocking", then hard-reload (`Ctrl+Shift+R`). Untick and
  hard-reload again to restore.
- **USGS The National Map is intermittently flaky and that changes what you see.** When
  TNM answers 504, a formerly-fast box (even warm Boulder at 4 mi / 72 cols) can blow the
  45 s service ceiling — the page then shows the designed "did not finish within 45000 ms
  … ask again in a moment" text and re-enables Solve — and the `no-terrain` refusal text
  grows a long `tnmaccess.nationalmap.gov` URL inside `describeConsidered()`. Neither is a
  page bug; check `/v1/field` with curl before blaming the UI, and prefer 1 mi / 48 cols
  over Boulder for a quick warm solve.
- Screenshots are downscaled from a 1600-px virtual display, so 1 px map strokes may be
  invisible in captures. Resize the window to ≤1024 px wide (`wmctrl -r :ACTIVE: -e
  0,0,0,1024,740`) for pixel-accurate evidence.

## Devin Secrets Needed

None. A local checkout runs unauthenticated (no `WINDSOLVER_API_KEYS` means the gate is
off) and only needs outbound internet. To exercise the gate locally, restart the server
with an **invented, non-secret** value — `WINDSOLVER_API_KEYS="localtest:<24+ chars>"`
(`auth.js` requires `name:secret` and a secret of at least 24 characters, and startup logs
`apiKeys:["localtest"]`). Keyless `curl /v1/hillshade` and `/v1/field` then return 401
`no-key` while the page keeps working through the same-origin door. Never read or type a
real key. Testing the live site needs no credential either —
every check above is deliberately doable from the public internet, and if a test seems to
need an API key, the test is wrong.
