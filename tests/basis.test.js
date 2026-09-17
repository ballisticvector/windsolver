/**
 * A solved place, written and read back.
 *
 * The file exists because the solver blocks the event loop — 7 minutes 28
 * seconds for the Whittington Center, during which `/healthz` did not answer at
 * all. So the only question that matters here is whether a field that came off
 * disk is the same field that went onto it, because if it is not, a service is
 * serving a wind nobody solved.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const basis = require("../basis.js");
const mass = require("../mass.js");
const proj = require("../proj.js");

/** A small projected grid over a hill, in the shape `field.groundOnly` returns. */
function ground(nx, ny, spacingM, reliefM) {
  const values = new Float32Array(nx * ny);
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const r2 = (i - cx) * (i - cx) + (j - cy) * (j - cy);
      values[j * nx + i] = 1000 + reliefM * Math.exp(-r2 / (2 * 5 * 5));
    }
  }
  return {
    crs: proj.crsFromEpsg(26913),
    width: nx, height: ny,
    transform: { originX: 500000, originY: 4000000, scaleX: spacingM, scaleY: -spacingM },
    resolutionM: spacingM,
    voidFraction: 0,
    values: values
  };
}

function docFor(opts) {
  const grid = ground(28, 28, 30, 120);
  const terrain = {
    width: grid.width, height: grid.height,
    spacingM: { x: 30, y: 30 }, elevation: grid.values
  };
  const spec = { lat: 36.77, lon: -104.49, radiusMiles: 2, targetResolutionM: 30 };
  return {
    key: basis.keyFor(spec, opts),
    spec: spec,
    options: opts,
    location: { id: "test", name: "Test" },
    dataset: "1 metre DEM",
    grid: grid,
    basis: mass.solveBasis(terrain, opts)
  };
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wsbasis-")), "basis.bin");
}

describe("a basis on disk", () => {
  const opts = { layers: 10, topAboveM: 400, stretch: 1.25, maxIterations: 20000 };

  test("a wind read off disk is the wind that was solved", () => {
    const doc = docFor(opts);
    const file = tmpFile();
    basis.save(file, doc);
    const back = basis.load(file, doc.key);

    expect(back.basis.kind).toBe(doc.basis.kind);
    expect(back.grid.width).toBe(doc.grid.width);

    for (const spec of [{ speedMps: 10, fromDeg: 225 }, { speedMps: 4, fromDeg: 40 }]) {
      const live = mass.combine(doc.basis, spec);
      const disk = mass.combine(back.basis, spec);
      for (const cell of [[14, 14], [4, 14], [22, 14]]) {
        const a = mass.sampleAt(live, cell[0], cell[1], 10);
        const b = mass.sampleAt(disk, cell[0], cell[1], 10);
        expect(b.speedMps).toBeCloseTo(a.speedMps, 6);
        expect(b.fromDeg).toBeCloseTo(a.fromDeg, 6);
      }
    }
  });

  test("the mesh and the faces are rebuilt rather than stored", () => {
    // Storing them would double the file to save a pass over the ground. What
    // this checks is that the rebuild produces the same mesh the solve ran on —
    // if it did not, the fields would be indexed against the wrong geometry.
    const doc = docFor(opts);
    const file = tmpFile();
    basis.save(file, doc);
    const back = basis.load(file);

    expect(back.basis.mesh.nx).toBe(doc.basis.mesh.nx);
    expect(back.basis.mesh.ny).toBe(doc.basis.mesh.ny);
    expect(back.basis.mesh.nz).toBe(doc.basis.mesh.nz);
    expect(back.basis.mesh.firstLayerM).toBeCloseTo(doc.basis.mesh.firstLayerM, 6);
    expect(back.basis.faces.ax.length).toBe(doc.basis.faces.ax.length);
  });

  test("a basis solved for other ground is refused, not used", () => {
    // There is no such thing as a nearly-right basis: one solved over a
    // different box is an answer to another question, and quietly serving it
    // is the failure this whole repository is built to avoid.
    const doc = docFor(opts);
    const file = tmpFile();
    basis.save(file, doc);

    const elsewhere = basis.keyFor({ lat: 40.015, lon: -105.2705, radiusMiles: 2, targetResolutionM: 30 }, opts);
    expect(() => basis.load(file, elsewhere)).toThrow(/solved for/);
    try {
      basis.load(file, elsewhere);
    } catch (err) {
      expect(err.code).toBe("stale-basis");
    }
  });

  test("changing an option that changes the answer changes the key", () => {
    const spec = { lat: 36.77, lon: -104.49, radiusMiles: 2, targetResolutionM: 30 };
    const base = basis.keyFor(spec, opts);
    expect(basis.keyFor(spec, Object.assign({}, opts, { layers: 12 }))).not.toBe(base);
    expect(basis.keyFor(spec, Object.assign({}, opts, { stretch: 1.2 }))).not.toBe(base);
    expect(basis.keyFor(spec, Object.assign({}, opts, { r: 0.1 }))).not.toBe(base);
    expect(basis.keyFor(Object.assign({}, spec, { radiusMiles: 3 }), opts)).not.toBe(base);
    // maxIterations does not: it changes how long, not what.
    expect(basis.keyFor(spec, Object.assign({}, opts, { maxIterations: 99 }))).toBe(base);
  });

  test("a truncated or corrupt file is refused with a reason", () => {
    const doc = docFor(opts);
    const file = tmpFile();
    basis.save(file, doc);
    const whole = fs.readFileSync(file);

    fs.writeFileSync(file, whole.subarray(0, Math.floor(whole.length / 2)));
    expect(() => basis.load(file)).toThrow();

    fs.writeFileSync(file, Buffer.from("not a basis file at all"));
    expect(() => basis.load(file)).toThrow(/gzipped|basis file/);
  });
});
