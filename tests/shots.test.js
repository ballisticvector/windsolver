"use strict";

// A saved engagement: two pins and the line between them.
//
// A box is where the wind is solved; a shot is the thing the shooter is
// actually looking along. Keeping them separate matters because the failure
// this exists to prevent has already happened once: the King of 2 Miles
// engagement began 54 m inside the five-mile domain's western wall and ended
// 1,445 m outside it, so the map on the firing line was drawing ground the
// solver had never read, at the one place in the domain where the numbers are
// least trustworthy.
//
// So the test that matters here is not that the arithmetic is right. It is that
// a shot whose ends are not inside the box that solves it is refused.

const geo = require("../geo.js");
const locations = require("../data/locations.json");

describe("range and bearing between two pins", () => {
  // The King of 2 Miles engagement, measured independently of the code under
  // test: 2205 m on 317.2 degrees, worked out from the coordinates by hand.
  const shooter = { lat: 36.792028, lon: -104.579632 };
  const target = { lat: 36.806557, lon: -104.596452 };

  test("agrees with the engagement it was built from", () => {
    const rb = geo.rangeAndBearing(shooter.lat, shooter.lon, target.lat, target.lon);
    expect(rb.rangeM).toBeGreaterThan(2195);
    expect(rb.rangeM).toBeLessThan(2215);
    expect(rb.bearingDeg).toBeGreaterThan(316);
    expect(rb.bearingDeg).toBeLessThan(318);
  });

  test("is zero to itself, and not NaN", () => {
    const rb = geo.rangeAndBearing(shooter.lat, shooter.lon, shooter.lat, shooter.lon);
    expect(rb.rangeM).toBeCloseTo(0, 6);
    expect(Number.isFinite(rb.bearingDeg)).toBe(true);
  });

  test.each([
    ["due north", 0.01, 0, 0],
    ["due east", 0, 0.01, 90],
    ["due south", -0.01, 0, 180],
    ["due west", 0, -0.01, 270]
  ])("reads %s as the compass does", (_name, dLat, dLon, expected) => {
    const rb = geo.rangeAndBearing(36.8, -104.5, 36.8 + dLat, -104.5 + dLon);
    expect(rb.bearingDeg).toBeCloseTo(expected, 1);
  });

  test("a bearing is never negative", () => {
    // 0 to 360, because that is what `/v1/line` takes and what a shooter reads
    // off a compass. A -42.8 would be silently accepted and drawn backwards.
    for (const [dLat, dLon] of [[1, -1], [-1, -1], [-1, 1], [1, 1]]) {
      const rb = geo.rangeAndBearing(36.8, -104.5, 36.8 + dLat * 0.01, -104.5 + dLon * 0.01);
      expect(rb.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(rb.bearingDeg).toBeLessThan(360);
    }
  });
});

describe("the saved shots", () => {
  const withShots = locations.locations.filter((l) => Array.isArray(l.shots) && l.shots.length);

  test("there is at least one, and it is the one that was asked for", () => {
    const ids = withShots.flatMap((l) => l.shots.map((s) => s.id));
    expect(ids).toContain("ko2m-1");
  });

  // The whole point. A shot is drawn from a solved field, so both ends have to
  // be in the box that was solved — and not merely inside it, but far enough in
  // that the answer is not the boundary talking. The edge artifact was measured
  // at nearly twice the interior maximum.
  const MARGIN_M = 500;

  for (const loc of withShots) {
    for (const shot of loc.shots) {
      describe(loc.id + " / " + shot.id, () => {
        const box = geo.boundingBox(loc.lat, loc.lon, loc.radiusMiles);

        test.each([["shooter"], ["target"]])("its %s is inside the solved box", (end) => {
          expect(geo.containsPoint(box, shot[end].lat, shot[end].lon)).toBe(true);
        });

        test.each([["shooter"], ["target"]])("its %s is clear of the boundary", (end) => {
          const p = shot[end];
          const perLon = geo.metersPerDegLon(p.lat);
          const margin = Math.min(
            (p.lat - box.south) * geo.METERS_PER_DEG_LAT,
            (box.north - p.lat) * geo.METERS_PER_DEG_LAT,
            (p.lon - box.west) * perLon,
            (box.east - p.lon) * perLon
          );
          expect(margin).toBeGreaterThan(MARGIN_M);
        });

        test("its stated range matches its pins", () => {
          const rb = geo.rangeAndBearing(
            shot.shooter.lat, shot.shooter.lon, shot.target.lat, shot.target.lon);
          // The note is prose and drifts; the pins are the truth. This is here
          // so a hand-typed yardage cannot quietly disagree with the geometry.
          if (shot.rangeM !== undefined) {
            expect(Math.abs(rb.rangeM - shot.rangeM)).toBeLessThan(5);
          }
          expect(rb.rangeM).toBeGreaterThan(0);
        });
      });
    }
  }

  test("every shot id is unique within its location", () => {
    for (const loc of withShots) {
      const ids = loc.shots.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  test("a shot id is filename- and URL-safe, like a location id", () => {
    for (const loc of withShots) {
      for (const shot of loc.shots) {
        expect(shot.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      }
    }
  });
});
