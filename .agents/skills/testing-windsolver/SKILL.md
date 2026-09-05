---
name: testing-windsolver
description: Browser-test the WindSolver public map page and /v1/field service, locally or against the live windsolver.com. Covers starting the static+API server, warm vs cold solves, coordinates that reliably produce full / partial / no 3DEP coverage, checking provenance against the raw JSON, the mobile-layout trap, and verifying the API-key gate and its Sec-Fetch-Site same-origin door. Use when verifying anything in public/index.html, public/map.js, public/wind-map.js, auth.js, server.js static serving, or terrain-coverage behaviour.
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
off) and only needs outbound internet. Testing the live site needs no credential either —
every check above is deliberately doable from the public internet, and if a test seems to
need an API key, the test is wrong.
