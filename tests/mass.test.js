/**
 * The mass-consistent solve, against cases whose answers are known without it.
 *
 * These are analytic and synthetic on purpose. `docs/downscaling.md` records
 * what scoring a terrain treatment against anemometers is worth right now — the
 * whole ablation table spans 0.06 m/s against a 2.27 m/s residual — so a real
 * station cannot yet tell a correct solver from a broken one. What a hill and a
 * valley can tell is whether continuity is being enforced at all, which is the
 * claim this module makes and the one `downscale.js` cannot make.
 *
 * The valley case is the reason the module exists. A per-cell weighting turns
 * the wind by MicroMet's diverting angle, measured at 0.3 degrees of direction
 * RMSE against anemometers and capped at 14.3 degrees at the single steepest
 * cell. Channelling here is not a term and has no coefficient: it is what the
 * flow has to do when the walls carry no flux.
 */

"use strict";

const mass = require("../mass.js");

/** Flat ground at one elevation. */
function flat(nx, ny, elevationM, spacingM) {
  return {
    width: nx,
    height: ny,
    spacingM: { x: spacingM, y: spacingM },
    elevation: new Float32Array(nx * ny).fill(elevationM)
  };
}

/** A Gaussian hill, centred, so it never touches the open sides. */
function hill(nx, ny, baseM, reliefM, spacingM, sigmaCells) {
  const out = new Float32Array(nx * ny);
  const cx = (nx - 1) / 2;
  const cy = (ny - 1) / 2;
  const s2 = 2 * sigmaCells * sigmaCells;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const r2 = (i - cx) * (i - cx) + (j - cy) * (j - cy);
      out[j * nx + i] = baseM + reliefM * Math.exp(-r2 / s2);
    }
  }
  return { width: nx, height: ny, spacingM: { x: spacingM, y: spacingM }, elevation: out };
}

/**
 * A straight valley running north-south: high walls east and west, floor in the
 * middle, and the same cross-section at every y so the axis is unambiguous.
 */
function valley(nx, ny, floorM, wallM, spacingM) {
  const out = new Float32Array(nx * ny);
  const cx = (nx - 1) / 2;
  const halfWidth = nx / 6;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const d = Math.abs(i - cx) / halfWidth;
      const rise = d >= 1 ? 1 : d * d;
      out[j * nx + i] = floorM + wallM * rise;
    }
  }
  return { width: nx, height: ny, spacingM: { x: spacingM, y: spacingM }, elevation: out };
}

/** Smallest angle between two bearings, signed toward the second. */
function turn(fromDeg, toDeg) {
  let d = toDeg - fromDeg;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

describe("the mesh", () => {
  test("a column's cells are blocked up to its own ground and no further", () => {
    const terrain = hill(20, 20, 1000, 100, 30, 4);
    const mesh = mass.buildMesh(terrain, { layers: 20 });

    for (let j = 0; j < mesh.ny; j++) {
      for (let i = 0; i < mesh.nx; i++) {
        const h = terrain.elevation[j * mesh.nx + i];
        let firstOpen = -1;
        for (let k = 0; k < mesh.nz; k++) {
          const blocked = mesh.blocked[(k * mesh.ny + j) * mesh.nx + i] === 1;
          const centre = mesh.zMin + (k + 0.5) * mesh.dz;
          expect(blocked).toBe(centre < h);
          if (!blocked && firstOpen < 0) firstOpen = k;
        }
        // Once a column opens it stays open: a cave is not a thing a DEM has.
        for (let k = firstOpen; k < mesh.nz; k++) {
          expect(mesh.blocked[(k * mesh.ny + j) * mesh.nx + i]).toBe(0);
        }
      }
    }
  });

  test("a hole in the terrain blocks its whole column rather than being filled", () => {
    const terrain = flat(10, 10, 1000, 30);
    terrain.elevation[5 * 10 + 5] = NaN;
    const mesh = mass.buildMesh(terrain, { layers: 8 });

    expect(mesh.holes).toBe(1);
    for (let k = 0; k < mesh.nz; k++) {
      expect(mesh.blocked[(k * mesh.ny + 5) * mesh.nx + 5]).toBe(1);
    }
  });

  test("a grid with no readable ground anywhere is refused, not solved", () => {
    const terrain = flat(6, 6, 1000, 30);
    terrain.elevation.fill(NaN);
    expect(() => mass.buildMesh(terrain)).toThrow(/every cell/);
  });
});

describe("the solve", () => {
  test("a uniform wind over flat ground is already mass-consistent and is returned unchanged", () => {
    // The invariant that makes every other result readable: if the solver moves
    // this case, whatever it does to a hill is not the terrain talking.
    const mesh = mass.buildMesh(flat(24, 24, 1000, 30), { layers: 12 });
    const guess = mass.initialField(mesh, { speedMps: 8, fromDeg: 270 });

    expect(mass.divergence(mesh, guess).every(function (d) { return Math.abs(d) < 1e-9; })).toBe(true);

    const solved = mass.solve(mesh, guess);
    expect(solved.converged).toBe(true);
    for (let i = 0; i < guess.u.length; i++) expect(solved.u[i]).toBeCloseTo(guess.u[i], 6);
    for (let i = 0; i < guess.v.length; i++) expect(solved.v[i]).toBeCloseTo(guess.v[i], 6);
    for (let i = 0; i < guess.w.length; i++) expect(solved.w[i]).toBeCloseTo(guess.w[i], 6);
  });

  test("a wind driven into a hill starts by creating mass, and the solve removes it", () => {
    const mesh = mass.buildMesh(hill(36, 36, 1000, 120, 30, 5), { layers: 18 });
    const guess = mass.initialField(mesh, { speedMps: 8, fromDeg: 270 });
    const solved = mass.solve(mesh, guess, { maxIterations: 6000 });

    // Laying a flat wind over a hill drives air into the slope. That is the
    // signal, not a bug in the guess.
    expect(solved.maxDivergenceBefore).toBeGreaterThan(1e-3);
    expect(solved.converged).toBe(true);
    // Two orders is the bar: the remaining divergence has to be small against
    // what it started as, or the field still has air appearing inside it.
    expect(solved.maxDivergenceAfter).toBeLessThan(solved.maxDivergenceBefore / 100);
  });

  test("no flux crosses the ground", () => {
    const mesh = mass.buildMesh(hill(28, 28, 1000, 150, 30, 4), { layers: 16 });
    const solved = mass.solve(mesh, mass.initialField(mesh, { speedMps: 10, fromDeg: 225 }));

    const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i <= nx; i++) {
          const leftSolid = i > 0 && mesh.blocked[(k * ny + j) * nx + i - 1];
          const rightSolid = i < nx && mesh.blocked[(k * ny + j) * nx + i];
          if (leftSolid || rightSolid) expect(solved.u[(k * ny + j) * (nx + 1) + i]).toBe(0);
        }
      }
    }
    // And the lid of every blocked column: the ground's own top face.
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (mesh.blocked[(k * ny + j) * nx + i]) {
            expect(solved.w[(k * ny + j) * nx + i]).toBe(0);
          }
        }
      }
    }
  });
});

describe("what continuity produces on its own", () => {
  test("flow speeds up over a crest, because the section it passes through is squeezed", () => {
    // No term in this module mentions a crest. The acceleration is the lid and
    // the hill narrowing the gap between them.
    const terrain = hill(40, 40, 1000, 200, 30, 5);
    const mesh = mass.buildMesh(terrain, { layers: 20, topAboveM: 400 });
    const solved = mass.solve(mesh, mass.initialField(mesh, { speedMps: 10, fromDeg: 270 }),
      { maxIterations: 8000 });
    expect(solved.converged).toBe(true);

    const mid = Math.floor(mesh.ny / 2);
    const crest = mass.windAt(mesh, solved, Math.floor(mesh.nx / 2), mid, 20);
    const upwind = mass.windAt(mesh, solved, 3, mid, 20);

    expect(crest).not.toBeNull();
    expect(upwind).not.toBeNull();
    expect(crest.speedMps).toBeGreaterThan(upwind.speedMps * 1.05);
  });

  test("a valley turns the wind toward its own axis, with no diverting term anywhere", () => {
    // The case `downscale.js` cannot represent. Its diverting angle is a
    // per-cell function of the local slope, capped at 14.3 degrees at the
    // steepest cell in a domain and worth 0.3 degrees of direction RMSE against
    // anemometers. Here the walls simply carry no flux and the air has nowhere
    // else to go.
    const terrain = valley(36, 36, 1000, 300, 30);
    const mesh = mass.buildMesh(terrain, { layers: 20, topAboveM: 500 });

    // From the south-west: blowing toward the north-east, at 45 degrees to a
    // valley whose axis runs north-south.
    const guess = mass.initialField(mesh, { speedMps: 10, fromDeg: 225 });
    const solved = mass.solve(mesh, guess, { maxIterations: 8000 });
    expect(solved.converged).toBe(true);

    const floorI = Math.floor(mesh.nx / 2);
    const floorJ = Math.floor(mesh.ny / 2);
    const before = mass.windAt(mesh, guess, floorI, floorJ, 10);
    const after = mass.windAt(mesh, solved, floorI, floorJ, 10);

    // Not exactly 225: the x-faces at the floor straddle columns whose ground
    // differs, so the log profile weights them slightly differently. The swing
    // below is measured from whatever the guess actually was.
    expect(Math.abs(turn(225, before.fromDeg))).toBeLessThan(3);

    // A wind blowing north-east, channelled by a north-south valley, turns
    // toward blowing due north — so the bearing it comes *from* swings from 225
    // toward 180. Negative is that direction.
    const swing = turn(before.fromDeg, after.fromDeg);
    expect(swing).toBeLessThan(-5);

    // And the cross-valley component is cut hard, which is the same statement
    // in the frame that matters: the wall is in the way.
    expect(Math.abs(after.east)).toBeLessThan(Math.abs(before.east) * 0.7);
  });

  test("the turning is the terrain's, not the solver's: flat ground of the same size does not turn", () => {
    // The control for the case above. Same box, same wind, no walls.
    const mesh = mass.buildMesh(flat(36, 36, 1000, 30), { layers: 20, topAboveM: 500 });
    const guess = mass.initialField(mesh, { speedMps: 10, fromDeg: 225 });
    const solved = mass.solve(mesh, guess, { maxIterations: 8000 });

    const before = mass.windAt(mesh, guess, 18, 18, 10);
    const after = mass.windAt(mesh, solved, 18, 18, 10);
    expect(Math.abs(turn(before.fromDeg, after.fromDeg))).toBeLessThan(0.5);
  });

  test("the crest speed-up depends on where the lid is, so it is not yet a number to quote", () => {
    // Measured, and the reason `mass.js` says the amplification is not
    // defensible while the turning is. A close lid squeezes the flow against
    // itself; the squeeze belongs to the box, not to the hill. Pinned here so
    // that a later lid condition has to move it, and so nobody quotes a
    // speed-up without having chosen a domain height on purpose.
    const speedUpAt = function (topAboveM, layers) {
      const mesh = mass.buildMesh(hill(40, 40, 1000, 200, 30, 5), { layers: layers, topAboveM: topAboveM });
      const solved = mass.solve(mesh, mass.initialField(mesh, { speedMps: 10, fromDeg: 270 }),
        { maxIterations: 20000 });
      expect(solved.converged).toBe(true);
      const mid = Math.floor(mesh.ny / 2);
      return mass.windAt(mesh, solved, Math.floor(mesh.nx / 2), mid, 20).speedMps
        / mass.windAt(mesh, solved, 3, mid, 20).speedMps;
    };

    const close = speedUpAt(400, 20);
    const far = speedUpAt(3200, 70);

    // Both are a real speed-up — the hill does accelerate the flow.
    expect(close).toBeGreaterThan(1.2);
    expect(far).toBeGreaterThan(1.2);
    // And they differ by more than a tenth, which is the whole point.
    expect(close - far).toBeGreaterThan(0.1);
  });

  test("the valley's turning is not lid-dependent the way the hill's speed-up is", () => {
    // The other half of the same claim: what continuity does to *direction* in
    // a channel is geometry, and survives the box being opened up.
    const turnAt = function (topAboveM, layers) {
      const mesh = mass.buildMesh(valley(36, 36, 1000, 300, 30), { layers: layers, topAboveM: topAboveM });
      const guess = mass.initialField(mesh, { speedMps: 10, fromDeg: 225 });
      const solved = mass.solve(mesh, guess, { maxIterations: 20000 });
      expect(solved.converged).toBe(true);
      const i = Math.floor(mesh.nx / 2);
      const j = Math.floor(mesh.ny / 2);
      return turn(mass.windAt(mesh, guess, i, j, 10).fromDeg,
        mass.windAt(mesh, solved, i, j, 10).fromDeg);
    };

    const close = turnAt(500, 20);
    const far = turnAt(3000, 60);
    expect(close).toBeLessThan(-30);
    expect(far).toBeLessThan(-30);
    expect(Math.abs(close - far)).toBeLessThan(10);
  });

  test("r decides whether the air goes over the hill or around it", () => {
    // The stability knob, and the only physical parameter in the module. Small
    // r makes vertical displacement expensive, which is what a stable layer
    // does; the flow should then carry more of its adjustment sideways.
    const terrain = hill(36, 36, 1000, 250, 30, 4);
    const mesh = mass.buildMesh(terrain, { layers: 20, topAboveM: 500 });
    const guess = mass.initialField(mesh, { speedMps: 10, fromDeg: 270 });

    const over = mass.solve(mesh, guess, { r: 4, maxIterations: 8000 });
    const around = mass.solve(mesh, guess, { r: 0.05, maxIterations: 8000 });
    expect(over.converged).toBe(true);
    expect(around.converged).toBe(true);

    const mid = Math.floor(mesh.ny / 2);
    const crestI = Math.floor(mesh.nx / 2);
    const liftOver = Math.abs(mass.windAt(mesh, over, crestI, mid, 30).up);
    const liftAround = Math.abs(mass.windAt(mesh, around, crestI, mid, 30).up);

    expect(liftOver).toBeGreaterThan(liftAround);
  });
});
