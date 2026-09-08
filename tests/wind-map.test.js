"use strict";

const lib = require("../public/wind-map.js");

/** A small field answer shaped like the one `/v1/field` really returns. */
function answer(overrides) {
  const grid = {
    cols: 3,
    rows: 2,
    order: "row-major, north to south, west to east",
    lats: [40.02, 40.01],
    lons: [-105.28, -105.27, -105.26],
    eastMps: [-3, -3, -3, -3, -3, null],
    northMps: [0, 1, 2, 0, 0, null],
    speedMps: [3, 3.1622776601683795, 3.605551275463989, 3, 3, null],
    fromDeg: [90, 108, 124, 90, 90, null],
    elevationM: [1601, 1650, 1700, 1610, 1620, NaN],
    coveredFraction: 5 / 6
  };
  return Object.assign({
    ok: true,
    schemaVersion: 1,
    domain: { west: -105.28, south: 40.01, east: -105.26, north: 40.02 },
    heightAglM: 10,
    grid: grid,
    validTime: "2026-09-04T18:00:00.000Z",
    source: "WindSolver HRRR 2026-09-04T18:00:00.000Z + 3DEP 1m",
    modelled: true,
    notice: "Modelled, not measured: HRRR downscaled onto 3DEP terrain.",
    reference: { source: "HRRR", resolutionM: 3000, speedMps: 3.5 },
    terrain: { dataset: "1m", resolutionM: 8 },
    confidence: null
  }, overrides || {});
}

describe("speed in the units a person reads", () => {
  test("m/s becomes mph, and a hole stays a hole", () => {
    expect(lib.mph(10)).toBeCloseTo(22.369362920544, 9);
    expect(lib.mph(null)).toBeNull();
    expect(lib.mph(NaN)).toBeNull();
    expect(lib.mph(undefined)).toBeNull();
  });

  test("the colour ramp is monotone in speed and starts at its first stop", () => {
    // A ramp that goes backwards anywhere reads as a wind that drops where it
    // rises, which no viewer would question.
    let previous = -1;
    for (const stop of lib.SPEED_STOPS) {
      expect(stop.mph).toBeGreaterThan(previous);
      previous = stop.mph;
    }
    expect(lib.speedColor(0)).toBe(lib.SPEED_STOPS[0].color);
  });

  test("each stop's colour is the colour just above its boundary", () => {
    for (const stop of lib.SPEED_STOPS) {
      const justAbove = (stop.mph + 0.5) / lib.MPS_TO_MPH;
      expect(lib.speedColor(justAbove)).toBe(stop.color);
    }
  });

  test("a cell with no wind has no colour, rather than the colour of calm", () => {
    // The bug this forbids: an uncovered cell drawn in the 0 mph colour, which
    // is a measurement of calm air over ground nobody has read.
    expect(lib.speedColor(null)).toBeNull();
    expect(lib.speedColor(NaN)).toBeNull();
    expect(lib.speedColor(0)).not.toBeNull();
  });
});

describe("cellsOf", () => {
  test("flattens the grid onto its own coordinates", () => {
    const cells = lib.cellsOf(answer().grid);
    expect(cells).toHaveLength(6);
    expect(cells[0]).toMatchObject({ row: 0, col: 0, lat: 40.02, lon: -105.28, covered: true });
    expect(cells[0].speedMph).toBeCloseTo(6.71, 2);
    expect(cells[2]).toMatchObject({ lat: 40.02, lon: -105.26 });
  });

  test("an uncovered cell is marked uncovered, not zeroed", () => {
    const cells = lib.cellsOf(answer().grid);
    const hole = cells[5];
    expect(hole.covered).toBe(false);
    expect(hole.speedMps).toBeNull();
    expect(hole.fromDeg).toBeNull();
    expect(hole.elevationM).toBeNull();
  });

  test("stride thins the arrows without moving them", () => {
    const cells = lib.cellsOf(answer().grid, { stride: 2 });
    expect(cells.map((c) => [c.row, c.col])).toEqual([[0, 0], [0, 2]]);
    expect(cells[1].lon).toBe(-105.26);
  });

  test("refuses a grid it cannot place on the ground", () => {
    expect(() => lib.cellsOf({ rows: 2, cols: 2 })).toThrow(/lats and lons/);
  });
});

describe("strideFor", () => {
  test("draws every cell when there are few of them", () => {
    expect(lib.strideFor({ rows: 12, cols: 12 }, 400)).toBe(1);
  });

  test("thins a big grid to about the target", () => {
    const stride = lib.strideFor({ rows: 100, cols: 100 }, 400);
    expect(stride).toBe(5);
    const drawn = Math.ceil(100 / stride) * Math.ceil(100 / stride);
    expect(drawn).toBeLessThanOrEqual(400);
  });
});

describe("arrowScale: length carries the speed the wash was hiding", () => {
  const cells = [{ speedMph: 2 }, { speedMph: 6 }, { speedMph: 11 }];

  test("the longest arrow is a stop on the speed legend, not the field's own maximum", () => {
    // Quantised so that panning the map does not silently rescale every arrow:
    // 11 mph tops out at the 13 mph stop, and so does 12.9.
    expect(lib.arrowScale(cells, { maxPx: 20 }).fullMph).toBe(13);
    expect(lib.arrowScale([{ speedMph: 12.9 }], { maxPx: 20 }).fullMph).toBe(13);
    expect(lib.arrowScale([{ speedMph: 3 }], { maxPx: 20 }).fullMph).toBe(4);
  });

  test("length is proportional to speed, so two arrows can be compared by eye", () => {
    const scale = lib.arrowScale(cells, { maxPx: 26, floorPx: 0 });
    expect(scale.lengthFor(6) / scale.lengthFor(2)).toBeCloseTo(3, 6);
    expect(scale.lengthFor(13)).toBeCloseTo(26, 6);
  });

  test("below the floor every arrow is the same stub, and the scale says where that is", () => {
    const scale = lib.arrowScale(cells, { maxPx: 20, floorPx: 5 });
    expect(scale.floorMph).toBeCloseTo(13 * 5 / 20, 6);
    expect(scale.lengthFor(0.1)).toBe(5);
    expect(scale.lengthFor(0)).toBe(5);
    expect(scale.caption).toMatch(/13 mph/);
    expect(scale.caption).toMatch(/3\.3 mph/);
  });

  test("a hole has no length at all, and is not a calm stub", () => {
    const scale = lib.arrowScale(cells, { maxPx: 20 });
    expect(scale.lengthFor(null)).toBeNull();
    expect(scale.lengthFor(NaN)).toBeNull();
  });

  test("a field with nothing in it still gives a usable scale", () => {
    const scale = lib.arrowScale([{ speedMph: null }], { maxPx: 20 });
    expect(scale.fullMph).toBe(lib.SPEED_STOPS[1].mph);
    expect(scale.lengthFor(1)).toBeGreaterThan(0);
  });

  test("a wind past the top of the legend is drawn at full length, not off the end", () => {
    const scale = lib.arrowScale([{ speedMph: 80 }], { maxPx: 20 });
    expect(scale.fullMph).toBe(lib.SPEED_STOPS[lib.SPEED_STOPS.length - 1].mph);
    expect(scale.lengthFor(200)).toBe(20);
  });
});

describe("the ground", () => {
  test("elevationRange ignores the holes", () => {
    expect(lib.elevationRange(answer().grid)).toEqual({ minM: 1601, maxM: 1700 });
  });

  test("all-void ground has no range rather than a range of zero", () => {
    expect(lib.elevationRange({ elevationM: [NaN, null] })).toEqual({ minM: null, maxM: null });
  });
});

describe("centreWind", () => {
  test("reads the covered cell nearest the pin", () => {
    const wind = lib.centreWind(answer().grid);
    expect(wind.speedMph).toBeCloseTo(7.07, 2);
    expect(wind.fromDeg).toBe(108);
    expect(wind.elevationM).toBe(1650);
  });

  test("skips a hole at the centre instead of reporting calm", () => {
    const grid = answer().grid;
    grid.speedMps = [4, null, null, null, null, null];
    grid.fromDeg = [270, null, null, null, null, null];
    const wind = lib.centreWind(grid);
    expect(wind.fromDeg).toBe(270);
    expect(wind.lat).toBe(40.02);
  });

  test("a field with nothing in it has no centre wind", () => {
    const grid = answer().grid;
    grid.speedMps = [null, null, null, null, null, null];
    expect(lib.centreWind(grid)).toBeNull();
  });
});

describe("compassOf", () => {
  test("names the point a caption would use", () => {
    expect(lib.compassOf(0)).toBe("N");
    expect(lib.compassOf(90)).toBe("E");
    expect(lib.compassOf(191.25)).toBe("SSW");
    expect(lib.compassOf(359)).toBe("N");
    expect(lib.compassOf(-90)).toBe("W");
    expect(lib.compassOf(NaN)).toBeNull();
  });
});

describe("summarise", () => {
  test("always carries the source, both resolutions and the notice", () => {
    const s = lib.summarise(answer());
    expect(s.lines.join(" | ")).toContain("WindSolver HRRR");
    expect(s.lines.join(" | ")).toContain("terrain 8 m (3DEP 1m)");
    expect(s.lines.join(" | ")).toContain("weather model 3000 m");
    expect(s.notice).toContain("Modelled, not measured");
    expect(s.modelled).toBe(true);
  });

  test("a resampled resolution is rounded to the centimetre, not printed raw", () => {
    // The payload carries 7.996805191693154 m; the digits past the centimetre
    // are arithmetic, and on screen they read as false precision.
    const body = answer({ terrain: { dataset: "1m", resolutionM: 7.996805191693154 } });
    const joined = lib.summarise(body).lines.join(" | ");
    expect(joined).toContain("terrain 8 m (3DEP 1m)");
    expect(joined).not.toContain("7.99680");
  });

  test("says the ground it covers and how much of it is missing", () => {
    const joined = lib.summarise(answer()).lines.join(" | ");
    expect(joined).toContain("Ground 1601 to 1700 m");
    expect(joined).toContain("17% of this box has no terrain under it");
  });

  test("a fully covered box says nothing about coverage", () => {
    const body = answer();
    body.grid.coveredFraction = 1;
    expect(lib.summarise(body).lines.join(" | ")).not.toContain("no terrain under it");
  });

  test("a null confidence is reported as unstated, not omitted", () => {
    // Omitting it makes an unknown confidence and a high one look the same.
    expect(lib.summarise(answer()).lines).toContain("Confidence: unstated");
    expect(lib.summarise(answer({ confidence: 0.4 })).lines).toContain("Confidence: 0.4");
  });

  test("says when the ground was chosen from a listing nobody could refresh", () => {
    const body = answer({
      terrain: {
        dataset: "1m",
        resolutionM: 8,
        listing: { retained: true, storedAt: "2026-09-04T15:00:00.000Z", ageS: 10800, stale: true }
      }
    });
    const joined = lib.summarise(body).lines.join(" | ");
    expect(joined).toContain("Terrain product list last read 3 h ago");
    // And it stays a caption about the terrain listing: the wind on this
    // screen is as current as it ever was, and must not read as three hours old.
    expect(joined).toContain("WindSolver HRRR 2026-09-04T18:00:00.000Z");
  });

  test("a fresh listing is not mentioned at all", () => {
    expect(lib.summarise(answer()).lines.join(" | ")).not.toContain("Terrain product list");
  });

  test("refuses to caption an answer that is not one", () => {
    expect(() => lib.summarise({ ok: false })).toThrow(/successful field answer/);
  });
});

describe("explain", () => {
  test("keeps the service's own words and adds what to do", () => {
    const e = lib.explain({
      ok: false,
      code: "timeout",
      error: "the solve did not finish within 45000 ms"
    }, 504);
    expect(e.code).toBe("timeout");
    expect(e.text).toContain("did not finish within 45000 ms");
    expect(e.text).toContain("ask again in a moment");
    expect(e.retryable).toBe(true);
  });

  test("a caller's mistake is not offered as retryable", () => {
    const e = lib.explain({ ok: false, code: "bad-parameter", error: "lat is required" }, 400);
    expect(e.retryable).toBe(false);
    expect(e.text).toContain("lat is required");
  });

  test("an unmapped failure says so rather than inventing a cause", () => {
    const e = lib.explain(null, 502);
    expect(e.text).toContain("502");
    expect(e.retryable).toBe(true);
  });

  test("no answer at all is not dressed up as one", () => {
    expect(lib.explain(null, null).text).toContain("could not be reached");
  });
});

describe("fieldQuery", () => {
  test("uses the parameter names the service actually reads", () => {
    const q = lib.fieldQuery({ lat: 40.0150, lon: -105.2705, radiusMiles: 1, cols: 48 });
    expect(q).toBe("/v1/field?lat=40.015&lon=-105.2705&radiusMiles=1&cols=48");
  });

  test("rounds the pin to a sane number of places", () => {
    const q = lib.fieldQuery({ lat: 40.01500000001, lon: -105.27049999999, radiusMiles: 2 });
    expect(q).toContain("lat=40.015");
    expect(q).toContain("lon=-105.2705");
  });
});

describe("hillshadeQuery", () => {
  test("asks for the ground under the same box the wind is solved over", () => {
    const spec = { lat: 40.0150, lon: -105.2705, radiusMiles: 2 };
    const shade = lib.hillshadeQuery(Object.assign({ width: 768 }, spec));
    const field = lib.fieldQuery(spec);
    // The two pictures are drawn on top of each other. A hillshade over a
    // different box is a mis-registration that looks like terrain.
    for (const key of ["lat=40.015", "lon=-105.2705", "radiusMiles=2"]) {
      expect(shade).toContain(key);
      expect(field).toContain(key);
    }
    expect(shade.startsWith("/v1/hillshade?")).toBe(true);
    expect(shade).toContain("width=768");
  });

  test("leaves the sun out when the caller has no opinion about it", () => {
    const q = lib.hillshadeQuery({ lat: 40, lon: -105, radiusMiles: 1 });
    expect(q).not.toContain("azimuthDeg");
    expect(q).not.toContain("altitudeDeg");
  });
});

describe("hillshadePlacement", () => {
  function headers(map) {
    return { get: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } };
  }

  test("places the picture on the domain the service reports", () => {
    const p = lib.hillshadePlacement(headers({
      "x-windsolver-bounds": "39.99,-105.29,40.04,-105.25",
      "x-windsolver-covered": "0.82",
      "x-windsolver-resolution-m": "4.31",
      "x-windsolver-terrain-dataset": "1m"
    }));
    expect(p).toEqual({
      south: 39.99,
      west: -105.29,
      north: 40.04,
      east: -105.25,
      coveredFraction: 0.82,
      resolutionM: 4.31,
      dataset: "1m"
    });
  });

  test("refuses to place a picture the service did not locate", () => {
    // The alternative is falling back on the requested box, which is the
    // padded domain shifted by a few hundred metres — terrain that lines up
    // with nothing and still looks like a map.
    expect(lib.hillshadePlacement(headers({}))).toBeNull();
    expect(lib.hillshadePlacement(headers({ "x-windsolver-bounds": "39.99,-105.29,40.04" }))).toBeNull();
    expect(lib.hillshadePlacement(headers({ "x-windsolver-bounds": "a,b,c,d" }))).toBeNull();
    // Inside out: north below south would draw the relief upside down.
    expect(lib.hillshadePlacement(headers({
      "x-windsolver-bounds": "40.04,-105.29,39.99,-105.25"
    }))).toBeNull();
    expect(lib.hillshadePlacement(null)).toBeNull();
  });

  test("a bounds without the rest of the headers is still placeable", () => {
    const p = lib.hillshadePlacement(headers({ "x-windsolver-bounds": "39.99,-105.29,40.04,-105.25" }));
    expect(p.coveredFraction).toBeNull();
    expect(p.resolutionM).toBeNull();
    expect(p.dataset).toBeNull();
  });
});

describe("hillshadeCaption", () => {
  test("says how much of the picture is ground nobody read", () => {
    const caption = lib.hillshadeCaption({
      coveredFraction: 0.6, resolutionM: 4.312, dataset: "1m"
    });
    expect(caption).toContain("3DEP 1m");
    expect(caption).toContain("4.3 m/px");
    // A transparent hole looks exactly like flat ground on a dark basemap.
    expect(caption).toContain("40% no terrain");
  });

  test("says nothing about coverage when the whole box is covered", () => {
    expect(lib.hillshadeCaption({ coveredFraction: 1, resolutionM: 4, dataset: "10m" }))
      .not.toContain("no terrain");
  });

  test("a picture that could not be placed says so", () => {
    expect(lib.hillshadeCaption(null)).toBe("Relief unavailable.");
  });
});

describe("the parts of the page a unit test cannot run", () => {
  // map.js is Leaflet, a canvas and the DOM, so these are read off the source.
  // Both guard a failure that was measured in a browser and that looks entirely
  // correct in the file: neither shows up as an error anywhere.
  const fs = require("fs");
  const path = require("path");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "map.js"), "utf8");
  const clearField = /function clearField\(\) \{([\s\S]*?)\n {2}\}/.exec(js);
  const clearWind = /function clearWind\(\) \{([\s\S]*?)\n {2}\}/.exec(js);

  test("clearing the field abandons the answer still on its way", () => {
    // Otherwise a solve that lands after the pin has moved paints a field for
    // the old box under a heading that says "At the pin".
    expect(clearWind).not.toBeNull();
    expect(clearWind[1]).toContain("inFlight.abort()");
    expect(clearField).not.toBeNull();
    expect(clearField[1]).toContain("clearWind()");
  });

  test("a Leaflet that never loaded is said out loud, not left blank", () => {
    expect(js).toMatch(/typeof L === "undefined"/);
  });

  test("the relief is drawn under the wind, not over it", () => {
    // Leaflet's overlay pane is z-index 400 and holds the wind canvas. A relief
    // above it hides the answer, and the page still looks like it is working.
    const pane = /createPane\("relief"\)[\s\S]{0,200}?zIndex = (\d+)/.exec(js);
    expect(pane).not.toBeNull();
    expect(Number(pane[1])).toBeLessThan(400);
    expect(Number(pane[1])).toBeGreaterThan(200);
  });

  test("the relief is placed on the headers, never on the requested box", () => {
    const load = /async function loadRelief\(([\s\S]*?)\n {2}\}/.exec(js);
    expect(load).not.toBeNull();
    expect(load[1]).toContain("hillshadePlacement(response.headers)");
    expect(load[1]).toContain("URL.createObjectURL");
    // A relief that will not load must not read as a failed solve.
    expect(load[1]).toContain("No relief here");
    expect(load[1]).not.toContain("setStatus(");
  });

  test("an old relief is taken off the map, and its blob released", () => {
    const clear = /function clearRelief\(\) \{([\s\S]*?)\n {2}\}/.exec(js);
    expect(clear).not.toBeNull();
    expect(clear[1]).toContain("removeLayer");
    // Every solve makes a new object URL; without this a long session on one
    // map leaks a PNG per pin.
    expect(clear[1]).toContain("revokeObjectURL");
    expect(clearField[1]).toContain("clearRelief()");
    // And the src is dropped before the URL is: Leaflet re-renders the overlay
    // when the map recentres, and an element still holding a revoked blob asks
    // for it again. Measured by editing the latitude field, which recentres.
    expect(clear[1].indexOf("removeAttribute(\"src\")"))
      .toBeLessThan(clear[1].indexOf("revokeObjectURL"));
  });

  test("each arrow is drawn at its own cell's length, and a hole is skipped", () => {
    const draw = /const scale = lib\.arrowScale\(([\s\S]*?)ctx\.globalAlpha = 1;/.exec(js);
    expect(draw).not.toBeNull();
    expect(draw[1]).toContain("scale.lengthFor(cell.speedMph)");
    // A cell the scale will not measure is left undrawn rather than given the
    // stub: a stub is a slow wind, and a hole is not a slow wind.
    expect(draw[1]).toContain("if (length === null) continue;");
  });

  test("the scale the arrows were drawn at is the scale the caption states", () => {
    // Written by the layer that drew them, because the thinning decides which
    // cells the scale saw and the page cannot know that.
    expect(js).toContain("fieldLayer.onScale = function (scale)");
    expect(js).toContain("$(\"arrowScale\")");
    expect(js).toContain("el.textContent = scale.caption");
    const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
    expect(html).toContain("id=\"arrowScale\"");
  });

  test("a cleared wind takes its arrow scale with it", () => {
    // `_draw` returns before `onScale` when there is no field, so nothing
    // rewrites this caption on the way out. Hiding `#result` covers it today;
    // the explicit clear is what stops that from being load-bearing.
    const clear = /function clearWind\(\) \{([\s\S]*?)\n {2}\}/.exec(js);
    expect(clear).not.toBeNull();
    expect(clear[1]).toContain("$(\"arrowScale\").textContent = \"\"");
  });

  test("a refused wind does not silence the relief's own refusal", () => {
    // Measured at Paris, where both routes 502 no-terrain: clearing the relief
    // on a field refusal aborts the hillshade mid-flight, so its request ends
    // in an AbortError and the note it would have written is never written.
    // The wind saying "no terrain" in full while the relief line says nothing
    // is the one failure here that is invisible.
    const refusal = /const explained = lib\.explain\(body, response\.status\);([\s\S]*?)return setStatus\(explained/.exec(js);
    expect(refusal).not.toBeNull();
    expect(refusal[1]).toContain("clearWind()");
    expect(refusal[1]).not.toContain("clearField()");
  });
});

describe("the page's narrow layout", () => {
  const fs = require("fs");
  const path = require("path");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const narrow = /@media \(max-width: 860px\) \{([\s\S]*?)\n {2}\}/.exec(html);

  test("has a rule for narrow screens at all", () => {
    expect(narrow).not.toBeNull();
  });

  test("never stacks the column in reverse", () => {
    // A column-reverse flex column overflows at its top, where no scrollbar
    // reaches: on a phone the controls and the answer went above the fold with
    // no way back down to them. Measured in Chrome at 500 CSS px.
    expect(narrow[1]).not.toMatch(/flex-direction:\s*column-reverse/);
  });

  test("lets the page grow past the viewport instead of pinning it", () => {
    expect(narrow[1]).toMatch(/html, body \{ height:auto; \}/);
    expect(narrow[1]).toMatch(/#app \{[^}]*height:auto/);
  });
});

/**
 * The stations.
 *
 * The field half of this module can be wrong by a number; the station half can
 * be wrong by a claim, which is worse and quieter. Each test below is one
 * sentence the page must not be able to say: that an anemometer which reported
 * nothing was calm, that an hour-old reading is now, that an hour *label* is a
 * measurement time, or that a 6.1 m mast and a 10 m model wind are the same
 * quantity.
 */
function stationOf(overrides) {
  return Object.assign({
    id: "50604",
    name: "SUGARLOAF",
    network: "RAWS",
    provider: "fems",
    lat: 40.018,
    lon: -105.361,
    elevationM: 2052.2,
    sensorHeightM: null,
    state: "CO",
    agency: "USFS",
    distanceM: 8123,
    observation: {
      time: "2026-09-04T17:00:00.000Z",
      timeIsHourBin: true,
      transmitMinute: null,
      hourLabel: "2026-09-04T17:00:00.000Z",
      speedMps: 1.34112,
      fromDeg: 110,
      calm: false,
      gustMps: 3.57632,
      qcChecked: false,
      qcFlags: null,
      ageS: 600
    },
    observationNote: null,
    observationCode: null
  }, overrides || {});
}

describe("asking for the stations on screen", () => {
  test("the query is the view, capped, with the corners inside it", () => {
    const spec = lib.viewSpec({ north: 40.1, south: 39.9, east: -105.1, west: -105.4 });
    expect(spec.lat).toBeCloseTo(40.0, 6);
    expect(spec.lon).toBeCloseTo(-105.25, 6);
    // Half the diagonal, not half the height: a station in the corner of the
    // screen has to be inside the circle the box is cut from.
    expect(spec.radiusMiles).toBeGreaterThan(6.9);
    expect(spec.capped).toBe(false);
    expect(lib.stationsQuery(spec)).toMatch(/^\/v1\/stations\?lat=40&lon=-105\.25&radiusMiles=/);
  });

  test("a continental view is capped and says so", () => {
    const spec = lib.viewSpec({ north: 49, south: 25, east: -67, west: -125 });
    expect(spec.radiusMiles).toBe(250);
    expect(spec.capped).toBe(true);
  });

  test("observations are only opted out of, never silently skipped", () => {
    expect(lib.stationsQuery({ lat: 40, lon: -105, radiusMiles: 25 }))
      .not.toContain("observed=");
    expect(lib.stationsQuery({ lat: 40, lon: -105, radiusMiles: 25, observed: false }))
      .toContain("observed=false");
  });

  test("the model beside the stations is opted in to, never asked for by default", () => {
    // It costs an HRRR subset over the whole view, where the markers alone are
    // a filter over a cached list.
    expect(lib.stationsQuery({ lat: 40, lon: -105, radiusMiles: 25 }))
      .not.toContain("model=");
    expect(lib.stationsQuery({ lat: 40, lon: -105, radiusMiles: 25, model: true }))
      .toContain("model=true");
  });
});

describe("what a station marker is allowed to say", () => {
  test("a reporting station carries its speed, its direction and its age", () => {
    const view = lib.stationView(stationOf());
    expect(view.reporting).toBe(true);
    expect(view.speedMph).toBeCloseTo(3.0, 1);
    expect(view.towardDeg).toBe(290);
    expect(view.ageS).toBe(600);
    expect(view.stale).toBe(false);
    expect(view.title).toMatch(/measured 3\.0 mph, from 110° ESE/);
    expect(view.lines.join("\n")).toMatch(/gusting 8\.0/);
  });

  test("a station that reported nothing is not calm, and keeps its marker", () => {
    // FEMS answers an unknown station, a dead station and a quiet hour with the
    // same blank row. Drawing that as a zero is the one mistake on this map
    // that a viewer cannot detect.
    const view = lib.stationView(stationOf({
      observation: null,
      observationNote: "FEMS answered with a blank row"
    }));
    expect(view.reporting).toBe(false);
    expect(view.calm).toBe(false);
    expect(view.speedMph).toBeNull();
    expect(view.color).toBeNull();
    expect(view.lines.join("\n")).toContain("Not calm: nothing was measured.");
    expect(view.lines.join("\n")).toContain("blank row");
  });

  test("a real calm keeps its zero and loses its arrow", () => {
    const view = lib.stationView(stationOf({
      observation: Object.assign(stationOf().observation,
        { speedMps: 0, fromDeg: null, calm: true })
    }));
    expect(view.reporting).toBe(true);
    expect(view.calm).toBe(true);
    expect(view.towardDeg).toBeNull();
    expect(view.title).toMatch(/0\.0 mph, calm/);
  });

  test("an hour label is labelled as one", () => {
    const view = lib.stationView(stationOf());
    expect(view.approximateTime).toBe(true);
    expect(view.lines.join("\n")).toContain("hour label, ±30 min");

    const calibrated = lib.stationView(stationOf({
      observation: Object.assign(stationOf().observation,
        { timeIsHourBin: false, transmitMinute: 23 })
    }));
    expect(calibrated.lines.join("\n")).not.toContain("hour label");
  });

  test("an old observation is marked stale rather than drawn as now", () => {
    const view = lib.stationView(stationOf({
      observation: Object.assign(stationOf().observation, { ageS: 3 * 3600 })
    }));
    expect(view.stale).toBe(true);
    expect(view.lines.join("\n")).toContain("3 h ago");
  });

  test("an age missing from the payload is worked out, not assumed to be zero", () => {
    const obs = Object.assign(stationOf().observation, { ageS: null });
    const view = lib.stationView(stationOf({ observation: obs }),
      { nowMs: Date.parse("2026-09-04T18:00:00.000Z") });
    expect(view.ageS).toBe(3600);
  });

  test("a near-real-time row says nothing has checked it", () => {
    // Empty QC columns and a `0` are both "no flag" to a reader that only looks
    // for a value; "unchecked" and "checked and passed" are different claims.
    expect(lib.stationView(stationOf()).lines.join("\n"))
      .toContain("Not quality-controlled yet.");
  });
});

describe("the measured wind beside the modelled one", () => {
  const inBox = stationOf({
    lat: 40.0105, lon: -105.27,
    observation: Object.assign(stationOf().observation,
      { speedMps: 2, fromDeg: 100, ageS: 0 })
  });

  test("says the ratio, the veer and that the heights do not match", () => {
    const view = lib.stationView(inBox);
    const body = answer({ validTime: new Date().toISOString() });
    const cmp = lib.compareStationToField(view, body, { nowMs: Date.now() });
    expect(cmp.comparable).toBe(true);
    // The whole reason both layers are on one map: HRRR runs 43-70% fast over
    // this network, and a ratio next to the arrow is that sentence without a
    // table.
    expect(cmp.ratio).toBeCloseTo(1.5, 6);
    expect(cmp.directionDeltaDeg).toBe(-10);
    expect(cmp.heightNote).toMatch(/10 m AGL, RAWS nominally 6\.1 m/);
  });

  test("refuses, by name, a station outside the solved box", () => {
    const view = lib.stationView(stationOf());
    const cmp = lib.compareStationToField(view, answer());
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toMatch(/outside the solved box/);
  });

  test("refuses a cell with no terrain under it", () => {
    const view = lib.stationView(stationOf({ lat: 40.01, lon: -105.26,
      observation: Object.assign(stationOf().observation, { ageS: 0 }) }));
    const cmp = lib.compareStationToField(view, answer());
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toMatch(/no terrain/);
  });

  test("refuses when the observation and the model hour are far apart", () => {
    const view = lib.stationView(Object.assign({}, inBox, {
      observation: Object.assign({}, inBox.observation, { ageS: 6 * 3600 })
    }));
    const cmp = lib.compareStationToField(view, answer({
      validTime: new Date().toISOString()
    }), { nowMs: Date.now() });
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toMatch(/apart/);
  });

  test("refuses a station that measured nothing, rather than comparing a blank", () => {
    const view = lib.stationView(stationOf({ observation: null }));
    const cmp = lib.compareStationToField(view, answer());
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toMatch(/reported nothing/);
  });

  test("a bearing difference is signed and shortest-way-round", () => {
    expect(lib.signedDegrees(7 - 350)).toBe(17);
    expect(lib.signedDegrees(350 - 7)).toBe(-17);
  });
});

describe("the station against the model at the same coordinate", () => {
  const NOW = Date.parse("2026-09-06T16:10:00.000Z");

  function withModel(overrides) {
    return Object.assign({
      ok: true,
      model: {
        source: "HRRR", validTime: "2026-09-06T16:00:00.000Z", heightAglM: 10,
        downscaled: false, notice: "…", code: null, error: null
      }
    }, overrides || {});
  }

  function reporting(overrides) {
    return stationOf(Object.assign({
      model: { speedMps: 3, fromDeg: 120 },
      modelNote: null,
      observation: Object.assign(stationOf().observation,
        { speedMps: 2, fromDeg: 100, ageS: 600 })
    }, overrides || {}));
  }

  test("gives the ratio, the veer, and the two ways the numbers are not alike", () => {
    const station = reporting();
    const cmp = lib.compareStationToModel(
      lib.stationView(station, { nowMs: NOW }), station, withModel(), { nowMs: NOW });
    expect(cmp.comparable).toBe(true);
    expect(cmp.ratio).toBeCloseTo(1.5, 6);
    expect(cmp.directionDeltaDeg).toBe(20);
    // Both caveats, on every answer: the heights differ and this is the raw
    // model rather than the downscaled field the rest of the map draws.
    expect(cmp.heightNote).toMatch(/10 m AGL, RAWS nominally 6\.1 m/);
    expect(cmp.heightNote).toMatch(/not downscaled onto the terrain/);
  });

  test("a calm measurement has no ratio, rather than an enormous one", () => {
    const station = reporting({
      observation: Object.assign(stationOf().observation,
        { speedMps: 0, fromDeg: null, calm: true, ageS: 600 })
    });
    const cmp = lib.compareStationToModel(
      lib.stationView(station, { nowMs: NOW }), station, withModel(), { nowMs: NOW });
    expect(cmp.comparable).toBe(true);
    expect(cmp.measuredCalm).toBe(true);
    expect(cmp.ratio).toBeNull();
    // And therefore no colour: 3 m/s over a calm anemometer is a real
    // disagreement, and it is not "infinitely fast".
    expect(lib.ratioColor(cmp.ratio)).toBeNull();
  });

  test("a station the model has no wind for keeps the model's own reason", () => {
    const station = reporting({ model: null, modelNote: "outside the model grid" });
    const cmp = lib.compareStationToModel(
      lib.stationView(station, { nowMs: NOW }), station, withModel(), { nowMs: NOW });
    expect(cmp.comparable).toBe(false);
    expect(cmp.modelSpeedMph).toBeNull();
    expect(cmp.reason).toBe("outside the model grid");
  });

  test("a model outage is one refusal for every station, in the model's words", () => {
    const station = reporting();
    const body = withModel({
      model: { error: "NOMADS answered 503", code: "model-unavailable" }
    });
    const cmp = lib.compareStationToModel(
      lib.stationView(station, { nowMs: NOW }), station, body, { nowMs: NOW });
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toBe("NOMADS answered 503");
  });

  test("an observation from another hour is refused, not ratioed", () => {
    const station = reporting({
      observation: Object.assign(stationOf().observation,
        { speedMps: 2, fromDeg: 100, ageS: 6 * 3600 })
    });
    const cmp = lib.compareStationToModel(
      lib.stationView(station, { nowMs: NOW }), station, withModel(), { nowMs: NOW });
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toMatch(/apart/);
    // The model's number is still carried out: a reader who is shown both has
    // compared them whatever this function decided.
    expect(cmp.modelSpeedMph).toBeCloseTo(6.7, 1);
  });

  test("a station that reported nothing is not compared with anything", () => {
    const station = reporting({ observation: null });
    const cmp = lib.compareStationToModel(
      lib.stationView(station, { nowMs: NOW }), station, withModel(), { nowMs: NOW });
    expect(cmp.comparable).toBe(false);
    expect(cmp.reason).toMatch(/reported nothing/);
  });
});

describe("the disagreement ramp", () => {
  test("agreement is the pale band, and the two ways out of it differ", () => {
    expect(lib.ratioColor(1)).toBe("#e8e8e8");
    expect(lib.ratioColor(0.95)).toBe("#e8e8e8");
    // The measured case: HRRR runs 43-70% fast over this network.
    expect(lib.ratioColor(1.5)).toBe("#c26076");
    expect(lib.ratioColor(0.4)).toBe("#00429d");
    expect(lib.ratioColor(9)).toBe("#93003a");
  });

  test("no ratio is no colour, so nothing can be coloured by accident", () => {
    expect(lib.ratioColor(null)).toBeNull();
    expect(lib.ratioColor(0)).toBeNull();
    expect(lib.ratioColor(NaN)).toBeNull();
    expect(lib.ratioColor(-1)).toBeNull();
  });

  test("it shares no colour with the speed ramp it sits beside", () => {
    const speeds = new Set(lib.SPEED_STOPS.map((s) => s.color));
    for (const stop of lib.RATIO_STOPS) expect(speeds.has(stop.color)).toBe(false);
  });
});

describe("what the comparable stations say together", () => {
  test("the median, so one becalmed anemometer is not the headline", () => {
    const summary = lib.modelSummary([
      { comparable: true, ratio: 1.2 },
      { comparable: true, ratio: 1.4 },
      { comparable: true, ratio: 1.6 },
      // measurement 11's lesson, in one row: a near-zero measurement makes a
      // ratio of twenty, and a mean that is about that station alone.
      { comparable: true, ratio: 20 }
    ]);
    expect(summary.compared).toBe(4);
    expect(summary.medianRatio).toBeCloseTo(1.5, 6);
    expect(summary.text).toBe("model 1.50\u00d7 measured (median of 4)");
  });

  test("stations that were not compared are not counted as agreeing", () => {
    const summary = lib.modelSummary([
      { comparable: false, ratio: null },
      { comparable: true, measuredCalm: true, ratio: null }
    ]);
    expect(summary.compared).toBe(0);
    expect(summary.text).toBeNull();
  });
});

describe("the caption under the stations toggle", () => {
  const body = {
    ok: true, matched: 24, returned: 10, observed: true, errors: [],
    directory: { provider: "fems", network: "RAWS", stale: false, ageS: 12 }
  };

  test("says how many there were, not just how many are drawn", () => {
    expect(lib.stationsCaption(body)).toBe("10 of 24 stations · RAWS via fems");
  });

  test("a retained station list is dated out loud", () => {
    const caption = lib.stationsCaption(Object.assign({}, body, {
      directory: { provider: "fems", network: "RAWS", stale: true, ageS: 3 * 86400 }
    }));
    expect(caption).toContain("station list is 3 days ago and could not be refreshed");
  });

  test("an observation outage is named rather than read as a quiet network", () => {
    const caption = lib.stationsCaption(Object.assign({}, body, {
      observed: false,
      errors: [{ code: "observations-unavailable", error: "FEMS answered 502" }]
    }));
    expect(caption).toContain("locations only");
    expect(caption).toContain("FEMS answered 502");
  });

  test("the disagreement is in the caption, not only in twenty popups", () => {
    const caption = lib.stationsCaption(body, lib.modelSummary([
      { comparable: true, ratio: 1.4 }, { comparable: true, ratio: 1.6 }
    ]));
    expect(caption).toContain("model 1.50\u00d7 measured (median of 2)");
  });

  test("a model the service would not sample is said out loud once", () => {
    const caption = lib.stationsCaption(Object.assign({}, body, {
      model: { error: "the model is only sampled … within 150 miles", code: "model-box-too-large" }
    }));
    expect(caption).toContain("only sampled");
    // Still a station caption: the markers and their observations are fine.
    expect(caption).toContain("10 of 24 stations");
  });

  test("a model error already in errors is not said twice", () => {
    const caption = lib.stationsCaption(Object.assign({}, body, {
      errors: [{ code: "model-unavailable", error: "NOMADS answered 503" }],
      model: { error: "NOMADS answered 503", code: "model-unavailable" }
    }));
    expect(caption.match(/NOMADS answered 503/g)).toHaveLength(1);
  });

  test("an empty view says so, without a clause about observations it has none of", () => {
    const caption = lib.stationsCaption(Object.assign({}, body, {
      matched: 0, returned: 0, observed: false
    }));
    expect(caption).toBe("No stations in this view · RAWS via fems");
    expect(caption).not.toContain("locations only");
  });
});

describe("the station layer on the page", () => {
  const fs = require("fs");
  const path = require("path");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "map.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

  test("the stations sit above the wind wash, not under it", () => {
    // Leaflet's overlay pane is 400 and the relief is deliberately below it. A
    // measurement hidden under a model output is the wrong way round here.
    const pane = /createPane\("stations"\);([\s\S]*?)zIndex = (\d+);/.exec(js);
    expect(pane).not.toBeNull();
    expect(Number(pane[2])).toBeGreaterThan(400);
  });

  test("a station with no observation still gets a marker, without an arrow", () => {
    const icon = /function stationIcon\(view, comparison\) \{([\s\S]*?)\n {2}\}/.exec(js);
    expect(icon).not.toBeNull();
    expect(icon[1]).toContain("view.reporting && !view.calm");
    // Compare mode changes the fill and nothing else: the hollow ring, the
    // dimmed ring for a stale reading and the arrow all still mean what they
    // meant.
    expect(icon[1]).toContain("lib.ratioColor(comparison.ratio)");
  });

  test("the popup is built when it opens, so a later solve is in it", () => {
    expect(js).toContain("return stationPopup(view, comparison);");
  });

  test("the markers and the caption are coloured from one pass, not two", () => {
    // Two passes is how the map and the sentence under it come to disagree.
    expect(js).toContain("const comparisons = drawStations(body, compare);");
    expect(js).toContain("lib.modelSummary(comparisons)");
  });

  test("turning the comparison on refetches, because the model is a second half", () => {
    expect(js).toContain("$(\"compare\").addEventListener(\"change\", loadStations)");
    const load = /async function loadStations\(\)([\s\S]*?)\n {2}\}/.exec(js);
    expect(load[1]).toContain("model: compare");
  });

  test("a station outage does not read as a failed solve", () => {
    const load = /async function loadStations\(\)([\s\S]*?)\n {2}\}/.exec(js);
    expect(load).not.toBeNull();
    expect(load[1]).toContain("No stations");
    expect(load[1]).not.toContain("setStatus(");
  });

  test("the page says which marks were measured and which were computed", () => {
    expect(html).toContain("Measured and modelled");
    expect(html).toMatch(/Hollow: the station is there and reported nothing\. Not calm\./);
    expect(html).toMatch(/modelled, not measured/);
  });

  test("the disagreement ramp is explained where it is used, caveats included", () => {
    expect(html).toContain("id=\"compareKey\"");
    expect(html).toMatch(/Model speed ÷ measured speed/);
    expect(html).toMatch(/not downscaled onto the terrain/);
    expect(html).toMatch(/own height rather than the anemometer's 6\.1 m/);
  });
});

/**
 * A 5 x 5 field with a hole in it, at a latitude where a degree of longitude is
 * a convenient fraction of a degree of latitude. Every cell blows the same way
 * unless `speeds`/`bearings` say otherwise, so a test that moves a particle is
 * testing the advection and not the field.
 */
function flowField(overrides) {
  const o = overrides || {};
  const rows = 5;
  const cols = 5;
  const lats = [40.04, 40.03, 40.02, 40.01, 40.0];
  const lons = [-105.04, -105.03, -105.02, -105.01, -105.0];
  const speedMps = [];
  const fromDeg = [];
  for (let i = 0; i < rows * cols; i++) {
    speedMps.push(o.speeds && i in o.speeds ? o.speeds[i] : 10);
    fromDeg.push(o.bearings && i in o.bearings ? o.bearings[i] : 270);
  }
  for (const i of o.holes || []) {
    speedMps[i] = NaN;
    fromDeg[i] = null;
  }
  return { rows: rows, cols: cols, lats: lats, lons: lons, speedMps: speedMps, fromDeg: fromDeg };
}

describe("sampleField: what the air is doing at a point that is not a cell centre", () => {
  test("a point inside a cell reads that cell, not the one it is nearest in index", () => {
    const grid = flowField({ speeds: { 12: 4 } });
    // 40.0203/-105.0198 is inside the centre cell, off its centre in both axes.
    const cell = lib.sampleField(grid, 40.0203, -105.0198);
    expect(cell.row).toBe(2);
    expect(cell.col).toBe(2);
    expect(cell.speedMps).toBe(4);
  });

  test("a hole is not a wind, and does not borrow one from next door", () => {
    const grid = flowField({ holes: [12] });
    expect(lib.sampleField(grid, 40.02, -105.02)).toBeNull();
    expect(lib.sampleField(grid, 40.02, -105.01)).not.toBeNull();
  });

  test("off the grid is nothing, and the edge cell keeps its own half-width", () => {
    const grid = flowField();
    expect(lib.sampleField(grid, 40.044, -105.02)).not.toBeNull();
    expect(lib.sampleField(grid, 40.06, -105.02)).toBeNull();
    expect(lib.sampleField(grid, 40.02, -104.9)).toBeNull();
  });
});

describe("stepParticle: a trail is cut rather than drawn across a hole", () => {
  test("the particle goes the way the air is going, not the way it is from", () => {
    const grid = flowField();               // from 270: a westerly, moving east
    const moved = lib.stepParticle(grid, { lat: 40.02, lon: -105.02 }, 10);
    expect(moved.lon).toBeGreaterThan(-105.02);
    expect(moved.lat).toBeCloseTo(40.02, 9);
    // 10 m/s for 10 s is 100 m east, which at 40°N is 0.001172° of longitude.
    expect(moved.lon).toBeCloseTo(-105.02 + 0.0011722, 5);
  });

  test("a step that would land on a hole kills the particle instead of interpolating", () => {
    // Cell 13 is the next one east of 12. A particle in 12 blown east into it
    // must stop at the boundary: filling a hole from its neighbours is the one
    // thing this map refuses to do, and an animation would do it invisibly.
    const grid = flowField({ holes: [13] });
    expect(lib.stepParticle(grid, { lat: 40.02, lon: -105.02 }, 60)).toBeNull();
  });

  test("a step off the edge of the field kills it too", () => {
    const grid = flowField();
    expect(lib.stepParticle(grid, { lat: 40.02, lon: -105.001 }, 60)).toBeNull();
  });

  test("a particle already standing on a hole is dead where it stands", () => {
    const grid = flowField({ holes: [12] });
    expect(lib.stepParticle(grid, { lat: 40.02, lon: -105.02 }, 1)).toBeNull();
  });

  test("calm air holds the particle still and alive: still is what calm looks like", () => {
    const grid = flowField({ speeds: { 12: 0 } });
    const still = lib.stepParticle(grid, { lat: 40.02, lon: -105.02, age: 3 }, 10);
    expect(still.lat).toBeCloseTo(40.02, 12);
    expect(still.lon).toBeCloseTo(-105.02, 12);
    expect(still.age).toBe(4);
  });
});

describe("particleField: the field keeps its own particles, and reseeds them", () => {
  /** A rand() that walks a fixed list, so a seeded field is reproducible. */
  function cycle(values) {
    let i = 0;
    return function () { return values[i++ % values.length]; };
  }

  test("particles are only ever seeded on covered ground", () => {
    const grid = flowField({ holes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const field = lib.particleField(grid, { count: 40, rand: Math.random });
    expect(field.particles).toHaveLength(40);
    for (const p of field.particles) {
      expect(lib.sampleField(grid, p.lat, p.lon)).not.toBeNull();
    }
  });

  test("a reseeded particle carries no previous point, so no line joins its two lives", () => {
    // The renderer draws a segment only when `from` is set. Without that a
    // respawn draws a streak clean across the map that no wind produced.
    const grid = flowField({ holes: [13, 14] });
    const field = lib.particleField(grid, {
      count: 1, life: 100, rand: cycle([0.5]),
      seed: [{ lat: 40.02, lon: -105.02 }]
    });
    expect(field.particles[0].from).toBeNull();
    field.advance(60);
    expect(field.particles[0].from).toBeNull();
    expect(lib.sampleField(grid, field.particles[0].lat, field.particles[0].lon)).not.toBeNull();
  });

  test("a live step carries the point it came from, so the segment is the wind", () => {
    const grid = flowField();
    const field = lib.particleField(grid, {
      count: 1, life: 100, rand: cycle([0.5]),
      seed: [{ lat: 40.02, lon: -105.03 }]
    });
    field.advance(10);
    const p = field.particles[0];
    expect(p.from).not.toBeNull();
    expect(p.from.lon).toBeCloseTo(-105.03, 9);
    expect(p.lon).toBeGreaterThan(p.from.lon);
  });

  test("a particle does not live for ever, or the field settles into a few streamlines", () => {
    const grid = flowField();
    const field = lib.particleField(grid, {
      count: 1, life: 2, rand: cycle([0.5]),
      seed: [{ lat: 40.02, lon: -105.03 }]
    });
    field.advance(1);
    field.advance(1);
    expect(field.particles[0].from).toBeNull();
    expect(field.particles[0].age).toBe(0);
  });

  test("a field with no covered cell has no particles at all, and does not throw", () => {
    const grid = flowField({ holes: Array.from({ length: 25 }, (_, i) => i) });
    const field = lib.particleField(grid, { count: 10, rand: Math.random });
    expect(field.particles).toHaveLength(0);
    expect(function () { field.advance(1); }).not.toThrow();
  });
});

describe("motionScale: how much faster than the air the drawing is", () => {
  test("the exaggeration is the drawn speed over the real one, and is stated", () => {
    // 8 mph full scale is 3.576 m/s; 40 px/s over 20 m/px is 800 m/s drawn.
    const scale = lib.motionScale(8, 20, { pxPerSecond: 40 });
    expect(scale.drawnMps).toBeCloseTo(800, 6);
    expect(scale.speedup).toBeCloseTo(800 / (8 / lib.MPS_TO_MPH), 6);
    expect(scale.caption).toMatch(/faster than the air/);
    expect(scale.caption).toMatch(/not air travelling over time/);
  });

  test("the simulated seconds per drawn second is the exaggeration itself", () => {
    const scale = lib.motionScale(13, 12, { pxPerSecond: 30 });
    expect(scale.secondsPerSecond).toBeCloseTo(scale.speedup, 9);
  });

  test("a scale with no wind in it does not divide by nothing", () => {
    const scale = lib.motionScale(0, 20, { pxPerSecond: 40 });
    expect(scale.speedup).toBeNull();
    expect(scale.caption).toMatch(/not air travelling over time/);
  });
});

describe("the particle layer on the page", () => {
  const fs = require("fs");
  const path = require("path");
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "map.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

  test("it is a toggle, and it is off until somebody asks for it", () => {
    expect(html).toMatch(/<input id="particles" type="checkbox">/);
    expect(html).not.toMatch(/<input id="particles" type="checkbox" checked>/);
    expect(js).toContain("$(\"particles\").addEventListener(\"change\"");
  });

  test("the drawing skips a particle with nowhere to come from", () => {
    // The reseed contract only holds if the renderer honours it.
    const frame = /_frame: function \(now\) \{([\s\S]*?)\n {4}\}/.exec(js);
    expect(frame).not.toBeNull();
    expect(frame[1]).toContain("if (!p.from) continue;");
  });

  test("the caption is written by the layer that draws them, and cleared with it", () => {
    expect(html).toContain("id=\"particleNote\"");
    expect(js).toContain("particleLayer.onScale");
    const reset = /_reset: function \(\) \{([\s\S]*?)\n {4}\}/g;
    const bodies = js.match(reset) || [];
    expect(bodies.some(function (b) { return b.includes("this.onScale(null)"); })).toBe(true);
  });

  test("the wind and its particles are taken off the map together", () => {
    const clear = /function clearWind\(\) \{([\s\S]*?)\n {2}\}/.exec(js);
    expect(clear[1]).toContain("particleLayer.clear()");
    expect(js).toContain("particleLayer.setField(body)");
  });

  test("the particles sit above the wash and below the anemometers", () => {
    // A measurement under an animation is the wrong way round on this map.
    const particles = /getPane\("particles"\)\.style\.zIndex = (\d+)/.exec(js);
    const stations = /getPane\("stations"\)\.style\.zIndex = (\d+)/.exec(js);
    expect(Number(particles[1])).toBeGreaterThan(400);
    expect(Number(particles[1])).toBeLessThan(Number(stations[1]));
  });

  test("nothing animates in a background tab", () => {
    expect(js).toContain("visibilitychange");
    expect(js).toContain("document.hidden");
  });
});
