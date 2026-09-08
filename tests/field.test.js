/**
 * The join between the two halves, tested with no network.
 *
 * `field.js` adds composition and two decisions of its own — how several 3DEP
 * tiles become one grid, and how much ground beyond the requested box has to be
 * read for the derivatives inside it to exist. Both are the kind of thing that
 * produces a perfectly ordinary looking field when it is wrong: a mosaic that
 * resamples the base grid still returns terrain, and a domain read with no
 * margin still returns a wind, just an undefined one round the edge where the
 * user was looking.
 *
 * The atmosphere here is the real 1,883-byte NOMADS response over Boulder that
 * the decoder tests use, so the wind being downscaled is a wind HRRR actually
 * produced rather than one invented to make the arithmetic tidy.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const cog = require("../cog.js");
const geo = require("../geo.js");
const proj = require("../proj.js");
const grib2 = require("../grib2.js");
const volumeModule = require("../volume.js");
const derive = require("../derive.js");
const downscale = require("../downscale.js");
const cacheModule = require("../cache.js");
const field = require("../field.js");

const FIXTURE = path.join(__dirname, "fixtures", "hrrr-20260826t20z-f00-boulder.grib2");
const records = grib2.decode(fs.readFileSync(FIXTURE));
const volume = volumeModule.buildVolume(records);

// The centre of the fixture's grid, so a domain around it is inside the model.
const CENTRE = { lat: 40.4979, lon: -105.5118 };

/** A UTM grid of `width` x `height` pixels centred on a coordinate. */
function gridAt(centre, width, height, spacing, z) {
  const crs = proj.crsFromEpsg(26913);
  const mid = proj.fromGeographic(crs, centre.lat, centre.lon);
  const values = new Float32Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      values[row * width + col] = z((col + 0.5) * spacing, (height - row - 0.5) * spacing);
    }
  }
  const grid = {
    crs: crs,
    width: width,
    height: height,
    values: values,
    resolutionM: spacing,
    transform: {
      originX: mid.x - (width * spacing) / 2,
      originY: mid.y + (height * spacing) / 2,
      scaleX: spacing,
      scaleY: -spacing
    }
  };
  grid.bounds = cog.gridBounds(grid);
  return grid;
}

/** A gentle hill, so slope, aspect and curvature are all defined and signed. */
function hill(width, height, spacing) {
  const span = (width * spacing) / 2;
  return gridAt(CENTRE, width, height, spacing, function (x, y) {
    const dx = x - (width * spacing) / 2;
    const dy = y - (height * spacing) / 2;
    return 1800 + 200 * Math.exp(-(dx * dx + dy * dy) / (2 * (span / 2) * (span / 2)));
  });
}

function boxAround(centre, degrees) {
  return {
    west: centre.lon - degrees,
    east: centre.lon + degrees,
    south: centre.lat - degrees,
    north: centre.lat + degrees
  };
}

describe("paddingMetres", () => {
  test("reaches half a curvature arm, because that is what the arm samples", () => {
    expect(field.paddingMetres({ curvatureLengthM: 500, targetResolutionM: 10 })).toBe(260);
  });

  test("reaches the shelter search when that is further", () => {
    expect(field.paddingMetres({
      curvatureLengthM: 200,
      shelter: { maxDistanceM: 900 },
      targetResolutionM: 10
    })).toBe(910);
  });

  test("asks for no shelter margin when no shelter was asked for", () => {
    const bare = field.paddingMetres({ curvatureLengthM: 400, targetResolutionM: 10 });
    const sheltered = field.paddingMetres({ curvatureLengthM: 400, shelter: true, targetResolutionM: 10 });
    expect(bare).toBe(210);
    expect(sheltered).toBeGreaterThan(bare);
  });
});

describe("domainOf", () => {
  test("turns a coordinate and a radius into a box, and reads a larger one", () => {
    const d = field.domainOf({ lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 1 });
    expect(d.box.north).toBeGreaterThan(d.box.south);
    expect(d.readBox.north).toBeGreaterThan(d.box.north);
    expect(d.readBox.west).toBeLessThan(d.box.west);
    expect(d.centre.lat).toBeCloseTo(CENTRE.lat, 6);
  });

  test("the margin is the padding, on the ground", () => {
    const d = field.domainOf({ lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 1 });
    const northM = (d.readBox.north - d.box.north) * 111320;
    expect(northM).toBeCloseTo(d.paddingM, 0);
  });

  test("takes a box directly", () => {
    const box = boxAround(CENTRE, 0.01);
    expect(field.domainOf({ box: box }).box).toBe(box);
  });

  test("refuses a spec with neither", () => {
    expect(() => field.domainOf({})).toThrow(/box, or a lat\/lon/);
  });
});

describe("mosaic", () => {
  test("one grid comes back unchanged, value for value", () => {
    const g = hill(20, 20, 10);
    const m = field.mosaic([g]);
    expect(m.width).toBe(20);
    expect(Array.from(m.values)).toEqual(Array.from(g.values));
    expect(m.voidFraction).toBe(0);
    expect(m.filledCount).toBe(0);
  });

  test("a hole in the base is filled from the next tile, and the rest is untouched", () => {
    const base = hill(20, 20, 10);
    const other = hill(20, 20, 10);
    const holes = [45, 46, 65];
    const original = Float32Array.from(base.values);
    for (const i of holes) base.values[i] = NaN;

    const m = field.mosaic([base, other]);
    expect(m.filledCount).toBe(holes.length);
    expect(m.voidCount).toBe(0);
    expect(m.filledFrom[0].filled).toBe(holes.length);
    for (const i of holes) expect(m.values[i]).toBeCloseTo(original[i], 3);
    for (let i = 0; i < m.values.length; i++) {
      if (holes.includes(i)) continue;
      expect(m.values[i]).toBe(original[i]);
    }
  });

  test("a hole with no ground under it in any tile stays a hole", () => {
    const base = hill(20, 20, 10);
    const other = hill(20, 20, 10);
    for (let i = 40; i < 60; i++) {
      base.values[i] = NaN;
      other.values[i] = NaN;
    }
    const m = field.mosaic([base, other]);
    expect(m.filledCount).toBe(0);
    expect(m.voidCount).toBe(20);
    expect(Number.isNaN(m.values[45])).toBe(true);
  });

  test("refuses a domain that is mostly holes when a limit is set", () => {
    const base = hill(10, 10, 10);
    for (let i = 0; i < 60; i++) base.values[i] = NaN;
    expect(() => field.mosaic([base], { maxVoidFraction: 0.1 })).toThrow(/holes after mosaicking/);
    expect(field.mosaic([base]).voidFraction).toBeCloseTo(0.6, 6);
  });

  test("refuses to mosaic nothing", () => {
    expect(() => field.mosaic([])).toThrow(/at least one elevation grid/);
  });

  test("grows the canvas to the box when the first tile only covers part of it", () => {
    // Boulder's domain straddles two 1 m tiles north to south, and the tile
    // with the least void is the southern one. Keeping its extent throws away
    // the northern third of the domain before a single derivative is computed.
    const south = gridAt(
      { lat: CENTRE.lat - 0.005, lon: CENTRE.lon },
      20, 20, 10, () => 1800
    );
    const north = gridAt(
      { lat: CENTRE.lat + 0.005, lon: CENTRE.lon },
      20, 20, 10, () => 1900
    );
    const box = boxAround(CENTRE, 0.006);

    const m = field.mosaic([south, north], { box: box });
    expect(m.height).toBeGreaterThan(south.height);
    expect(cog.sampleElevation(m, CENTRE.lat - 0.005, CENTRE.lon)).toBeCloseTo(1800, 6);
    expect(cog.sampleElevation(m, CENTRE.lat + 0.005, CENTRE.lon)).toBeCloseTo(1900, 6);
  });

  test("a grown canvas keeps the first tile's own pixels bit for bit", () => {
    const south = gridAt({ lat: CENTRE.lat - 0.005, lon: CENTRE.lon }, 20, 20, 10, (x, y) => 1800 + x + y);
    const original = Float32Array.from(south.values);
    const m = field.mosaic([south], { box: boxAround(CENTRE, 0.006) });
    for (let i = 0; i < original.length; i++) {
      const px = i % south.width;
      const py = Math.floor(i / south.width);
      const at = cog.pixelCentre(south, px, py);
      const ll = proj.toGeographic(south.crs, at.x, at.y);
      expect(cog.sampleElevation(m, ll.lat, ll.lon)).toBeCloseTo(original[i], 3);
    }
  });
});

describe("heightOf", () => {
  test("reads the height out of a height-above-ground level", () => {
    expect(field.heightOf("heightAboveGround:80")).toBe(80);
  });

  test("a level that is not a height above ground has none", () => {
    expect(field.heightOf("surface")).toBeNull();
    expect(field.heightOf("isobaricInhPa:500")).toBeNull();
  });
});

describe("referenceWind", () => {
  const box = boxAround(CENTRE, 0.01);

  test("is the model wind at the centre of the domain", () => {
    const ref = field.referenceWind(volume, box);
    const direct = volumeModule.sampleWind(volume, CENTRE.lat, CENTRE.lon, "heightAboveGround:10");
    expect(ref.east).toBeCloseTo(direct.east, 9);
    expect(ref.north).toBeCloseTo(direct.north, 9);
    expect(ref.heightAglM).toBe(10);
    expect(ref.validTime).toBe(volume.validTime);
  });

  test("takes the level it is given", () => {
    const ref = field.referenceWind(volume, box, { level: "heightAboveGround:80" });
    expect(ref.heightAglM).toBe(80);
    expect(ref.east).not.toBeCloseTo(field.referenceWind(volume, box).east, 6);
  });

  test("reports how many model cells the domain spans, because one wind stops being enough", () => {
    const small = field.referenceWind(volume, boxAround(CENTRE, 0.01));
    const wide = field.referenceWind(volume, boxAround(CENTRE, 0.2));
    expect(small.cellsAcross).toBeLessThan(1);
    expect(wide.cellsAcross).toBeGreaterThan(10);
  });
});

describe("referenceGrid", () => {
  // Ten kilometres of ground at 100 m, which is three and a bit HRRR cells
  // across the fixture — a domain where the model genuinely has a gradient to
  // give, rather than the two-mile box where it has one number.
  const wide = gridAt(CENTRE, 100, 100, 100, function () { return 1800; });
  const weights = downscale.terrainWeights(derive.derive(wide, { curvatureLengthM: 500 }),
    { curvatureLengthM: 500 });

  test("every cell is the model's own wind where that cell stands", () => {
    // Graded against sampling the volume at every pixel directly, which is the
    // thing the lattice is an optimisation of. The fixture's components are
    // grid-relative, so this also grades the earth-relative rotation: a
    // reference built without it would be out by the grid convergence and
    // every value would still look like a wind.
    expect(volume.grid.windComponentsRelativeToGrid).toBe(true);
    const ref = field.referenceGrid(volume, weights);
    let worst = 0;
    for (let row = 0; row < weights.height; row += 7) {
      for (let col = 0; col < weights.width; col += 7) {
        const at = proj.toGeographic(
          weights.crs,
          weights.transform.originX + (col + 0.5) * weights.transform.scaleX,
          weights.transform.originY + (row + 0.5) * weights.transform.scaleY
        );
        const direct = volumeModule.sampleWind(volume, at.lat, at.lon, "heightAboveGround:10");
        const i = row * weights.width + col;
        worst = Math.max(worst, Math.hypot(ref.east[i] - direct.east, ref.north[i] - direct.north));
      }
    }
    expect(worst).toBeLessThan(0.01);
  });

  test("a coarser lattice is measurably worse, which is why the default is not coarser", () => {
    // The constant is a claim about an approximation's cost, so the cost is
    // measured. Eight samples per HRRR cell is out by ~0.09 m/s, larger than
    // the spread of every terrain candidate ever ablated.
    const coarse = field.referenceGrid(volume, weights, { referenceSampleM: 3000 / 8 });
    const fine = field.referenceGrid(volume, weights);
    let worst = 0;
    for (let i = 0; i < fine.east.length; i++) {
      worst = Math.max(worst, Math.hypot(coarse.east[i] - fine.east[i], coarse.north[i] - fine.north[i]));
    }
    expect(worst).toBeGreaterThan(0.05);
  });

  test("and the model really does vary over that domain, or the grading is of nothing", () => {
    const ref = field.referenceGrid(volume, weights);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < ref.east.length; i++) {
      const s = Math.hypot(ref.east[i], ref.north[i]);
      if (s < min) min = s;
      if (s > max) max = s;
    }
    expect(max - min).toBeGreaterThan(1);
    expect(ref.cellsAcross).toBeGreaterThan(3);
    expect(ref.heightAglM).toBe(10);
    expect(ref.validTime).toBe(volume.validTime);
  });

  test("takes the level it is given, and refuses a sample spacing that is not one", () => {
    const ten = field.referenceGrid(volume, weights);
    const eighty = field.referenceGrid(volume, weights, { level: "heightAboveGround:80" });
    expect(eighty.heightAglM).toBe(80);
    expect(eighty.east[0]).not.toBeCloseTo(ten.east[0], 6);
    expect(() => field.referenceGrid(volume, weights, { referenceSampleM: 0 }))
      .toThrow(/must be positive/);
  });

  test("ground the model does not cover is a hole, not a failed solve", () => {
    // The terrain grid is read wider than the box, and the model's subset is a
    // rectangle in Lambert space, so a corner of a padded grid can fall off the
    // end of a volume that covers the box itself. A live two-mile solve over
    // Big Thompson did exactly that. The corner is outside what the caller
    // asked for, so it is undefined rather than fatal.
    const far = gridAt(
      { lat: CENTRE.lat + 0.6, lon: CENTRE.lon },
      100, 100, 100, function () { return 1800; }
    );
    const outsideWeights = downscale.terrainWeights(
      derive.derive(far, { curvatureLengthM: 500 }), { curvatureLengthM: 500 });
    const ref = field.referenceGrid(volume, outsideWeights);
    expect(ref.samples.outsideVolume).toBeGreaterThan(0);
    expect(Number.isNaN(ref.east[0])).toBe(true);
    // And a grid the volume does cover reports no holes at all, so the count
    // is a measurement rather than something that is always true.
    expect(field.referenceGrid(volume, weights).samples.outsideVolume).toBe(0);
  });
});

describe("modelElevation", () => {
  const box = boxAround(CENTRE, 0.01);

  test("is null when the volume was fetched without the model's own ground", () => {
    expect(field.modelElevation(volume, box)).toBeNull();
  });

  test("is the surface height when it is there", () => {
    const withHgt = Object.assign({}, volume, {
      scalars: Object.assign({}, volume.scalars, {
        HGT: { surface: new Array(volume.pointCount).fill(2100) }
      })
    });
    expect(field.modelElevation(withHgt, box)).toBeCloseTo(2100, 6);
  });

  test("is null when the model carries a height at some other level", () => {
    const elsewhere = Object.assign({}, volume, {
      scalars: Object.assign({}, volume.scalars, {
        HGT: { "heightAboveGround:80": new Array(volume.pointCount).fill(2100) }
      })
    });
    expect(field.modelElevation(elsewhere, box)).toBeNull();
  });

  test("the same reader answers for any surface field, roughness included", () => {
    // HRRR publishes its own aerodynamic roughness as SFCR, and the scoring
    // work in `docs/downscaling.md` needs it because the downscaler asserts
    // one national 0.03 m. It is read through the same sampler as the model's
    // ground rather than a second one: two readers of the same volume drift.
    const withSfcr = Object.assign({}, volume, {
      scalars: Object.assign({}, volume.scalars, {
        SFCR: { surface: new Array(volume.pointCount).fill(0.42) }
      })
    });
    expect(field.modelSurface(withSfcr, box, "SFCR")).toBeCloseTo(0.42, 6);
    expect(field.modelSurface(volume, box, "SFCR")).toBeNull();
  });
});

describe("the model's own surface roughness on an assembled field", () => {
  const spec = { box: boxAround(CENTRE, 0.004), curvatureLengthM: 200 };
  const grid = hill(60, 60, 10);

  test("is absent unless the volume was asked for it", () => {
    // The live service does not request SFCR, so this is null in production
    // and the downscaler's own roughness is untouched by any of it.
    expect(field.DEFAULT_VARIABLES).not.toContain("SFCR");
    const built = field.assemble({ spec: spec, grids: [grid], volume: volume });
    expect(built.modelRoughnessM).toBeNull();
  });

  test("is carried through when it is there", () => {
    const withSfcr = Object.assign({}, volume, {
      scalars: Object.assign({}, volume.scalars, {
        SFCR: { surface: new Array(volume.pointCount).fill(0.31) }
      })
    });
    const built = field.assemble({ spec: spec, grids: [grid], volume: withSfcr });
    expect(built.modelRoughnessM).toBeCloseTo(0.31, 6);
  });
});

describe("assemble", () => {
  const spec = { box: boxAround(CENTRE, 0.004), curvatureLengthM: 200 };
  const grid = hill(60, 60, 10);
  const built = field.assemble({ spec: spec, grids: [grid], volume: volume });

  test("produces an east/north field over every pixel of the terrain", () => {
    expect(built.width).toBe(60);
    expect(built.height).toBe(60);
    expect(built.east.length).toBe(3600);
    expect(built.stats.definedCount).toBe(1600);
  });

  test("the undefined border is no wider than the margin the domain is padded by", () => {
    // 60 x 60 pixels defined over 40 x 40, so ten pixels are undefined round
    // the edge: the curvature arm reaches out of the grid there. The padding
    // exists to put that border outside the box the caller asked about, so a
    // border wider than the padding would leave holes inside the answer.
    const borderPx = (built.width - 40) / 2;
    expect(borderPx * built.terrain.resolutionM).toBeLessThanOrEqual(built.paddingM);
  });

  test("the wind it bent is the model wind at the domain centre", () => {
    const direct = volumeModule.sampleWind(volume, CENTRE.lat, CENTRE.lon, "heightAboveGround:10");
    expect(built.reference.east).toBeCloseTo(direct.east, 9);
    expect(built.reference.north).toBeCloseTo(direct.north, 9);
    expect(built.validTime).toBe(volume.validTime);
  });

  test("every pixel is the reference speed times that pixel's factor", () => {
    const ref = Math.hypot(built.reference.east, built.reference.north);
    let worst = 0;
    for (let i = 0; i < built.factor.length; i++) {
      if (Number.isNaN(built.factor[i])) continue;
      const want = built.factor[i] * ref;
      worst = Math.max(worst, Math.abs(built.speedMps[i] - want) / Math.max(want, 1e-6));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  test("the hilltop is windier than the model, and the field is not uniform", () => {
    expect(built.stats.maxFactor).toBeGreaterThan(1);
    expect(built.stats.minFactor).toBeLessThan(1);
  });

  test("records the domain asked for and the larger one the derivatives needed", () => {
    expect(built.domain).toEqual(spec.box);
    expect(built.readBox.north).toBeGreaterThan(spec.box.north);
    expect(built.paddingM).toBeGreaterThan(0);
    expect(built.terrain.resolutionM).toBe(10);
    expect(built.terrain.voidFraction).toBe(0);
  });

  test("has no terrain offset without the model's own ground, and one with it", () => {
    expect(built.offset).toBeNull();
    const withHgt = Object.assign({}, volume, {
      scalars: Object.assign({}, volume.scalars, {
        HGT: { surface: new Array(volume.pointCount).fill(1800) }
      })
    });
    const offset = field.assemble({ spec: spec, grids: [grid], volume: withHgt }).offset;
    expect(offset.modelElevationM).toBeCloseTo(1800, 6);
    expect(offset.maxM).toBeGreaterThan(100);
    expect(offset.minM).toBeLessThan(20);
  });

  test("is the same answer as running the chain by hand", () => {
    const byHand = downscale.downscale(
      downscale.terrainWeights(derive.derive(grid, spec), spec),
      field.referenceWind(volume, spec.box)
    );
    expect(Array.from(built.east.slice(0, 200))).toEqual(Array.from(byHand.east.slice(0, 200)));
  });
});

describe("assemble with a reference per cell", () => {
  // A domain wide enough for the model to have something to say across it: at
  // the two-mile box `perCell` changes almost nothing, which is itself the
  // honest reason it is not the default there.
  const spec = { box: boxAround(CENTRE, 0.03), curvatureLengthM: 500 };
  const grid = hill(140, 140, 100);
  const uniform = field.assemble({ spec: spec, grids: [grid], volume: volume });
  const perCell = field.assemble({
    spec: Object.assign({ perCell: true }, spec),
    grids: [grid],
    volume: volume
  });

  test("is off unless it is asked for, so today's answer is unchanged", () => {
    expect(uniform.reference.perCell).toBe(false);
    expect(uniform.reference.spread).toBeNull();
    const direct = volumeModule.sampleWind(volume, CENTRE.lat, CENTRE.lon, "heightAboveGround:10");
    expect(uniform.reference.east).toBeCloseTo(direct.east, 9);
  });

  test("carries the model's own gradient into the drawn field", () => {
    expect(perCell.reference.perCell).toBe(true);
    expect(perCell.reference.spread.speedMaxMps - perCell.reference.spread.speedMinMps)
      .toBeGreaterThan(1);
    expect(perCell.reference.spread.fromDegSpanDeg).toBeGreaterThan(20);

    const spanOf = function (f) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < f.speedMps.length; i++) {
        if (Number.isNaN(f.speedMps[i])) continue;
        if (f.speedMps[i] < min) min = f.speedMps[i];
        if (f.speedMps[i] > max) max = f.speedMps[i];
      }
      return max - min;
    };
    expect(spanOf(perCell)).toBeGreaterThan(spanOf(uniform));
  });

  test("the terrain response is untouched: each cell is that cell's wind over this ground", () => {
    // The separation, stated as the invariant it actually is. A terrain factor
    // is a function of the ground *and* the bearing striking it — shelter and
    // the aspect term both are — so per-cell factors are not expected to equal
    // the uniform run's. What must hold is that no new terrain physics appears:
    // a cell of the per-cell field is exactly the cell you get by putting that
    // cell's model wind over the whole domain and reading it there.
    const ref = field.referenceGrid(volume, perCell.weights, spec);
    const probes = [];
    for (let i = 0; i < perCell.factor.length; i += 3137) {
      if (!Number.isNaN(perCell.factor[i])) probes.push(i);
    }
    expect(probes.length).toBeGreaterThan(3);
    for (const i of probes) {
      const asIfUniform = downscale.downscale(perCell.weights, {
        east: ref.east[i],
        north: ref.north[i]
      });
      expect(asIfUniform.factor[i]).toBeCloseTo(perCell.factor[i], 6);
      expect(asIfUniform.divertDeg[i]).toBeCloseTo(perCell.divertDeg[i], 6);
      expect(asIfUniform.speedMps[i]).toBeCloseTo(perCell.speedMps[i], 6);
      expect(asIfUniform.fromDeg[i]).toBeCloseTo(perCell.fromDeg[i], 6);
    }
  });

  test("each cell is that cell's model speed times that cell's terrain factor", () => {
    const ref = field.referenceGrid(volume, perCell.weights, spec);
    let worst = 0;
    for (let i = 0; i < perCell.speedMps.length; i++) {
      if (Number.isNaN(perCell.factor[i])) continue;
      const want = perCell.factor[i] * Math.hypot(ref.east[i], ref.north[i]);
      worst = Math.max(worst, Math.abs(perCell.speedMps[i] - want) / Math.max(want, 1e-6));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  test("reports the provenance a single reference reports, and the sampling", () => {
    expect(perCell.reference.validTime).toBe(volume.validTime);
    expect(perCell.reference.heightAglM).toBe(10);
    expect(perCell.reference.level).toBe("heightAboveGround:10");
    expect(perCell.reference.sampledEveryM).toBeCloseTo(3000 / 32, 6);
    expect(perCell.reference.speedMps).toBeGreaterThan(0);
    expect(perCell.reference.fromDeg).toBeGreaterThanOrEqual(0);
  });
});

describe("createFieldService", () => {
  function fakes(opts) {
    const o = opts || {};
    const calls = { terrain: 0, air: 0, specs: [] };
    const service = field.createFieldService({
      readTerrain: async function (box, spec) {
        calls.terrain++;
        calls.specs.push(spec);
        return {
          dataset: { id: "test-10m" },
          grids: [hill(o.pixels || 40, o.pixels || 40, 10)],
          bytesRead: 12345,
          requests: 3
        };
      },
      atmosphere: {
        get: async function () { calls.air++; return volume; },
        getLatest: async function (spec) {
          calls.air++;
          calls.lastAir = spec;
          return volume;
        },
        summary: function () { return {}; }
      },
      curvatureLengthM: 200
    });
    return { service: service, calls: calls };
  }

  test("reads the ground once and answers twice", async () => {
    const { service, calls } = fakes();
    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    const first = await service.get(spec);
    const second = await service.get(spec);
    expect(calls.terrain).toBe(1);
    expect(calls.air).toBe(2);
    expect(first.terrain.dataset).toBe("test-10m");
    expect(second.east.length).toBe(first.east.length);
  });

  test("a field solved on a retained listing says so, and re-ages it per answer", async () => {
    // The ground is cached and the arithmetic over it is not, so an age
    // measured when the listing was read would still say "one hour" a week
    // later. `storedAt` is the fact that keeps; the age is derived from it.
    const storedAt = new Date(Date.now() - 3600 * 1000).toISOString();
    const service = field.createFieldService({
      readTerrain: async function () {
        return {
          dataset: { id: "test-10m" },
          listing: { retained: true, entries: 1, storedAt: storedAt, ageS: 0, stale: true, error: "503" },
          grids: [hill(40, 40, 10)],
          bytesRead: 1,
          requests: 1
        };
      },
      atmosphere: {
        get: async function () { return volume; },
        getLatest: async function () { return volume; },
        summary: function () { return {}; }
      },
      curvatureLengthM: 200
    });

    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    const out = await service.get(spec);
    expect(out.terrain.listing).toMatchObject({ retained: true, stale: true, error: "503" });
    expect(out.terrain.listing.ageS).toBeGreaterThanOrEqual(3600);
  });

  test("a field solved on a listing The National Map answered carries no note", async () => {
    const { service } = fakes();
    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    expect((await service.get(spec)).terrain.listing).toBeNull();
  });

  test("hands over the ground alone without fetching any air", async () => {
    const { service, calls } = fakes();
    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    const land = await service.terrain(spec);
    expect(calls.terrain).toBe(1);
    // The reason this method exists: a caller that wants the ground — a
    // hillshade, a slope map — should not wait on NOMADS or spend a fetch.
    expect(calls.air).toBe(0);
    expect(land.dataset).toBe("test-10m");
    expect(land.derived.fields.slopeDeg.length).toBe(land.grid.width * land.grid.height);
    expect(land.domain.readBox.north).toBeGreaterThan(land.domain.box.north);
  });

  test("the ground a picture is drawn from is the ground the wind is bent by", async () => {
    // One cache entry between the two, so a hillshade and a field over the
    // same box can never disagree about the slope under them, and asking for
    // both costs one terrain read.
    const { service, calls } = fakes();
    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    const wind = await service.get(spec);
    const land = await service.terrain(spec);
    expect(calls.terrain).toBe(1);
    expect(land.derived.fields.slopeDeg).toBe(wind.derived.fields.slopeDeg);
    expect(land.domain.box).toEqual(wind.domain);
  });

  test("reads terrain over the padded box, not the box that was asked for", async () => {
    const { service, calls } = fakes();
    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    const got = await service.get(spec);
    expect(calls.specs[0].box.north).toBeCloseTo(got.readBox.north, 9);
    expect(got.readBox.north).toBeGreaterThan(got.domain.north);
  });

  test("a coarser domain is a different domain, not a cache hit", async () => {
    const { service, calls } = fakes();
    const base = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    await service.get(base);
    await service.get(Object.assign({}, base, { targetResolutionM: 30 }));
    expect(calls.terrain).toBe(2);
  });

  test("the atmospheric level is not handed to the terrain reader as an overview", async () => {
    // `level` names a height above ground here and a COG overview index in
    // terrain.js. Passing the spec through unedited asks for overview 10 of a
    // tile that has five, and the domain fails with a terrain error naming an
    // atmospheric level.
    const { service, calls } = fakes();
    await service.get({
      lat: CENTRE.lat,
      lon: CENTRE.lon,
      radiusMiles: 0.1,
      curvatureLengthM: 200,
      level: "heightAboveGround:10"
    });
    expect(calls.specs[0].level).toBeUndefined();
  });

  test("asks the model for more than one cell, so the centre can be interpolated", async () => {
    // A one-mile box is a third of an HRRR cell across, and the filter answers
    // it with a single column. Bilinear sampling at the centre then falls
    // "outside" a volume the point is plainly inside.
    const { service, calls } = fakes();
    const got = await service.get({
      lat: CENTRE.lat,
      lon: CENTRE.lon,
      radiusMiles: 0.1,
      curvatureLengthM: 200
    });
    const asked = calls.lastAir.box;
    const widthM = (asked.east - asked.west) * geo.metersPerDegLon(CENTRE.lat);
    expect(asked.north).toBeGreaterThan(got.domain.north);
    expect(widthM).toBeGreaterThan(2 * 3000);
  });

  test("a per-cell solve asks for the model over the padded grid, not just the box", async () => {
    // The centre reference needs one point inside the box; a per-cell one needs
    // the model everywhere the terrain grid reaches, and the grid is read wider
    // than the box for the derivatives. Asking for the box alone leaves that
    // margin as holes on a live solve.
    const { service, calls } = fakes();
    const spec = { lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 };
    await service.get(spec);
    const centreBox = calls.lastAir.box;
    await service.get(Object.assign({}, spec, { perCell: true }));
    const perCellBox = calls.lastAir.box;
    expect(perCellBox.north).toBeGreaterThan(centreBox.north);
    expect(perCellBox.west).toBeLessThan(centreBox.west);
  });

  test("asks the model for its own surface height, so the offset can be reported", async () => {
    const { service, calls } = fakes();
    await service.get({ lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 });
    expect(calls.lastAir.variables).toContain("HGT");
  });

  test("falls back to a coarser product where the finest one is a hole", async () => {
    // TNM lists the 1 m product as covering Boulder in full, and over the
    // northern third of a two-mile box both 1 m projects are nodata — coverage
    // is a footprint calculation and a void is a pixel. Without a fallback the
    // domain comes back with a third of it missing and the listing still says
    // 1 m.
    const calls = [];
    const holed = hill(40, 40, 10);
    for (let i = 0; i < holed.values.length / 2; i++) holed.values[i] = NaN;
    const service = field.createFieldService({
      readTerrain: async function (box, spec) {
        calls.push(spec.only || null);
        if (!spec.only) {
          return { dataset: { id: "1m" }, grids: [holed], bytesRead: 10, requests: 2 };
        }
        return { dataset: { id: "one-third" }, grids: [hill(40, 40, 10)], bytesRead: 5, requests: 1 };
      },
      atmosphere: {
        get: async function () { return volume; },
        getLatest: async function () { return volume; },
        summary: function () { return {}; }
      },
      curvatureLengthM: 200
    });

    const got = await service.get({
      lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("one-third");
    // Not zero: the coarser tile is sampled bilinearly, so a hole on its own
    // outermost row has no square to interpolate in and stays a hole.
    expect(got.terrain.voidFraction).toBeLessThan(0.1);
    expect(got.terrain.filledFromCoarser).toBeGreaterThan(0);
    expect(got.terrain.dataset).toBe("1m");
    expect(got.terrain.coarserDataset).toBe("one-third");
  });

  test("does not go looking for a coarser product when the finest one is whole", async () => {
    const { service, calls } = fakes();
    await service.get({ lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 });
    expect(calls.terrain).toBe(1);
  });

  test("reports what both caches are holding", async () => {
    const { service } = fakes();
    await service.get({ lat: CENTRE.lat, lon: CENTRE.lon, radiusMiles: 0.1, curvatureLengthM: 200 });
    expect(service.summary().ground.loads).toBe(1);
  });
});

describe("the ground is cached on the ground alone", () => {
  test("the key a prepared domain is filed under carries the curvature length", () => {
    const box = boxAround(CENTRE, 0.01);
    expect(cacheModule.weightsKey({ box: box, resolutionM: 10 }))
      .not.toBe(cacheModule.weightsKey({ box: box, resolutionM: 30 }));
  });

  test("a terrain source can be given a wider key than the derivatives' own", async () => {
    const seen = [];
    const source = cacheModule.createTerrainSource({
      key: cacheModule.weightsKey,
      sizeOf: function () { return 8; },
      load: async function (spec) {
        seen.push(spec.curvatureLengthM);
        return { it: spec.curvatureLengthM };
      }
    });
    const box = boxAround(CENTRE, 0.01);
    await source.get({ box: box, curvatureLengthM: 200 });
    await source.get({ box: box, curvatureLengthM: 500 });
    await source.get({ box: box, curvatureLengthM: 200 });
    expect(seen).toEqual([200, 500]);
  });
});
