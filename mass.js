/**
 * A wind that obeys continuity over real ground.
 *
 * `downscale.js` multiplies a model wind by a function of the terrain's shape.
 * That is a diagnostic weighting: each cell is computed on its own, nothing
 * couples a cell to its neighbour, and `docs/downscaling.md` records what it is
 * worth against anemometers — every candidate ever ablated spans 0.06 m/s
 * against a 2.27 m/s residual, and the term that turns the wind moves direction
 * by 0.3 degrees.
 *
 * This module is the other family. It does not weight a wind; it **solves for
 * one**, by taking an initial guess and finding the nearest field to it that
 * conserves mass over the actual ground. Channelling is then not a term with a
 * coefficient — it is what continuity does when a valley narrows, and it comes
 * out whether or not anyone asked for it. That is the one thing a per-cell
 * weight cannot produce by construction, and the reason this exists.
 *
 * The method is the variational one: Sasaki (1958), in the form Ross et al.
 * (1988) and a generation of mass-consistent models use. Minimise
 *
 *     E = integral of  ah^2 ((u-u0)^2 + (v-v0)^2) + av^2 (w-w0)^2
 *
 * over the domain, subject to div(u) = 0. The Euler-Lagrange equations give a
 * Poisson problem for one multiplier field, and the adjusted wind is the
 * initial one plus that field's gradient:
 *
 *     d2P/dx2 + d2P/dy2 + r d2P/dz2 = -div(u0)
 *     u = u0 + dP/dx      v = v0 + dP/dy      w = w0 + r dP/dz
 *
 * with `r = (ah/av)^2` the one physical knob. **r is the stability parameter in
 * disguise.** Small r makes vertical displacement expensive and the flow goes
 * *around* a hill, which is what stable air does; r = 1 is isotropic; large r
 * lets it go *over*. Nothing here estimates r from the atmosphere — it is an
 * input, and a caller that does not know it should say so rather than take the
 * default for an answer.
 *
 * **The ground is a staircase here, and that is deliberate for now.** Cells
 * whose centre is below the terrain are blocked and every face they touch
 * carries zero flux, so continuity is enforced exactly on the real cell faces
 * and the ground boundary condition is exact rather than approximated. The
 * price is that a smooth hill is represented by steps, which puts a small
 * spurious acceleration at each step. A terrain-following mesh removes that and
 * introduces metric terms that are easy to get subtly wrong; the sequence this
 * repository has used before — see `docs/reference/wind-lateral-reference.py`
 * on the BallisticVector side — is to build the crude version whose correctness
 * can be demonstrated, then use it as the oracle for the refined one. This is
 * the crude version. Do not ship its output as a terrain-following solve.
 *
 * **Measured on the first day, and it decides what may be quoted.** Over a 200 m
 * Gaussian hill the crest speed-up at 20 m AGL is x2.00 with the lid 400 m above
 * the summit, x1.86 at 1600 m, x1.57 at 6400 m, and it has not converged there.
 * The lid is a wall: put it close and the flow is squeezed against it, and the
 * squeeze is a property of the box rather than of the hill. So
 *
 * - **the turning is structure and the amplification is not, yet.** Channelling
 *   comes from the walls carrying no flux, which is geometry — a valley turns a
 *   45-degree wind 48 degrees onto its axis and the cross-valley component goes
 *   to about zero whatever the lid. The crest *magnitude* moves 28% over the
 *   range above and needs a convergence study, or a lid condition that is not a
 *   wall, before any number from it is defensible;
 * - **`topAboveM` is a physical input, not a performance dial.** A caller who
 *   lowers it to save iterations is changing the answer.
 *
 * No network, no cache, and nothing here knows what a rifle is. It takes an
 * elevation grid and a wind, and returns a wind.
 */

"use strict";

/** Isotropic. Flow goes over and around a hill in equal measure. */
const DEFAULT_R = 1;

/**
 * Short grass — the same default `downscale.js` carries.
 *
 * Von Karman does not appear: the profile is used as a *ratio* between two
 * heights, and the constant cancels out of it. It would only be needed to
 * recover a friction velocity, which nothing here asks for.
 */
const DEFAULT_ROUGHNESS_M = 0.03;

/**
 * Over-relaxation factor for the solve.
 *
 * 1.0 is plain Gauss-Seidel. The optimum for a Poisson problem of this shape is
 * near 2 - 2*pi/n for an n-cell side, so 1.85 is a reasonable middle for the
 * 50-200 cell domains this is built for. Above 2 the iteration diverges.
 */
const DEFAULT_OMEGA = 1.85;

/**
 * When to stop.
 *
 * The residual is measured as the largest remaining divergence in the domain,
 * in units of 1/s, scaled by a velocity and a length so the number means "how
 * much mass is still being created in the worst cell, relative to the flow
 * through it". `solve` reports what it reached, and whether it converged, so a
 * caller can refuse a field rather than draw an unconverged one.
 */
const DEFAULT_TOLERANCE = 1e-4;
const DEFAULT_MAX_ITERATIONS = 4000;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

/**
 * The mesh a solve runs on: a Cartesian box over an elevation grid.
 *
 * `elevation` is row-major, `width * height`, in metres, and NaN where the
 * terrain could not be read. A column with no ground is refused rather than
 * guessed: a hole in the DEM is a hole, and filling it from the neighbours
 * would invent a wall or a canyon that is not there.
 *
 * The vertical is uniform for now. The layer that matters most for this
 * product is the lowest one or two, so a stretched grid buys accuracy exactly
 * where it is needed and is the first refinement to make.
 */
function buildMesh(terrain, opts) {
  const o = opts || {};
  if (!terrain || !terrain.elevation || !terrain.width || !terrain.height) {
    throw fail("bad-terrain", "an elevation grid with width, height and elevation is required");
  }
  const nx = terrain.width;
  const ny = terrain.height;
  const n2 = nx * ny;
  if (terrain.elevation.length !== n2) {
    throw fail("bad-terrain", "elevation must hold width * height values");
  }
  const dx = Number(terrain.spacingM && terrain.spacingM.x);
  const dy = Number(terrain.spacingM && terrain.spacingM.y);
  if (!(dx > 0) || !(dy > 0)) throw fail("bad-spacing", "spacingM.x and spacingM.y must be positive metres");

  let minZ = Infinity;
  let maxZ = -Infinity;
  let holes = 0;
  for (let i = 0; i < n2; i++) {
    const z = terrain.elevation[i];
    if (!Number.isFinite(z)) { holes++; continue; }
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minZ)) throw fail("no-terrain", "every cell of the elevation grid is a hole");

  // The lid has to sit far enough above the tallest ground that holding it
  // undisturbed is not itself shaping the answer. Three times the relief is the
  // usual rule of thumb in this family of models; a flat domain still gets a
  // real box, because a zero-height domain has nowhere for the flow to go.
  const relief = maxZ - minZ;
  const above = o.topAboveM === undefined ? Math.max(3 * relief, 200) : o.topAboveM;
  if (!(above > 0)) throw fail("bad-top", "topAboveM must be positive");
  const layers = o.layers === undefined ? 20 : o.layers;
  if (!(layers >= 2)) throw fail("bad-layers", "layers must be at least 2");

  const zMin = minZ;
  const zTop = maxZ + above;
  const nz = layers;
  const dz = (zTop - zMin) / nz;

  // A cell is blocked when its centre is under the ground beneath it. A column
  // whose terrain is a hole is blocked all the way up: no flux through it, and
  // no pretending it is air.
  const blocked = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    const z = zMin + (k + 0.5) * dz;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const h = terrain.elevation[j * nx + i];
        if (!Number.isFinite(h) || z < h) blocked[(k * ny + j) * nx + i] = 1;
      }
    }
  }

  return {
    nx: nx, ny: ny, nz: nz,
    dx: dx, dy: dy, dz: dz,
    zMin: zMin, zTop: zTop,
    elevation: terrain.elevation,
    blocked: blocked,
    holes: holes,
    reliefM: relief
  };
}

/** Cell index. */
function cellAt(mesh, i, j, k) { return (k * mesh.ny + j) * mesh.nx + i; }
/** True when the cell is outside the box or under the ground. */
function solidAt(mesh, i, j, k) {
  if (i < 0 || j < 0 || k < 0 || i >= mesh.nx || j >= mesh.ny || k >= mesh.nz) return false;
  return mesh.blocked[cellAt(mesh, i, j, k)] === 1;
}
function insideAt(mesh, i, j, k) {
  return i >= 0 && j >= 0 && k >= 0 && i < mesh.nx && j < mesh.ny && k < mesh.nz;
}

/**
 * The height above ground of a cell centre, for the column it stands in.
 *
 * Negative under the terrain, which is how a blocked cell reads.
 */
function heightAgl(mesh, i, j, k) {
  const h = mesh.elevation[j * mesh.nx + i];
  const z = mesh.zMin + (k + 0.5) * mesh.dz;
  return Number.isFinite(h) ? z - h : NaN;
}

/**
 * The first guess: one wind, given a vertical profile, laid over the ground.
 *
 * Horizontal components come from the reference wind scaled by a neutral log
 * profile on height above ground; the vertical component starts at zero. The
 * profile is the same one `downscale.heightFactor` applies and carries the same
 * caveat — neutral stability is an assumption, and `docs/near-ground-wind.md`
 * records that no measurement in this project has tested it below 6.1 m.
 *
 * **This field does not conserve mass and is not meant to.** Laying a
 * horizontal wind over a hill drives air into the slope; the divergence that
 * creates is exactly the signal `solve` turns into flow around and over it. A
 * caller that skips the solve and draws this has drawn `downscale.js` with
 * extra steps.
 *
 * Velocities live on cell faces — u on the x-faces, v on the y, w on the z —
 * so that the divergence of a cell is an exact sum of what crosses its walls.
 * A face touching solid carries zero, which is the ground boundary condition
 * and needs no special case anywhere else.
 */
function initialField(mesh, wind, opts) {
  const o = opts || {};
  const ref = readWind(wind);
  const z0 = o.roughnessM === undefined ? DEFAULT_ROUGHNESS_M : o.roughnessM;
  if (!(z0 > 0)) throw fail("bad-roughness", "roughnessM must be positive");
  const refHeight = o.referenceHeightM === undefined ? 10 : o.referenceHeightM;
  if (!(refHeight > z0)) throw fail("bad-height", "referenceHeightM must be above the roughness length");

  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
  const u = new Float32Array((nx + 1) * ny * nz);
  const v = new Float32Array(nx * (ny + 1) * nz);
  const w = new Float32Array(nx * ny * (nz + 1));

  const denom = Math.log(refHeight / z0);
  // Below the roughness length the log profile is negative and then undefined.
  // The honest floor is z0 itself: the profile says the wind is zero there by
  // construction, and anything under it is inside the roughness, not above it.
  const profile = function (agl) {
    if (!Number.isFinite(agl) || agl <= z0) return 0;
    return Math.log(agl / z0) / denom;
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        // An x-face between two columns takes the profile of whichever side is
        // air; a face with solid on either side carries nothing.
        const leftSolid = solidAt(mesh, i - 1, j, k) || !insideAt(mesh, i - 1, j, k);
        const rightSolid = solidAt(mesh, i, j, k) || !insideAt(mesh, i, j, k);
        if (solidAt(mesh, i - 1, j, k) || solidAt(mesh, i, j, k)) continue;
        const a = insideAt(mesh, i - 1, j, k) ? heightAgl(mesh, i - 1, j, k) : NaN;
        const b = insideAt(mesh, i, j, k) ? heightAgl(mesh, i, j, k) : NaN;
        const agl = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2
          : (Number.isFinite(a) ? a : b);
        if (leftSolid && rightSolid) continue;
        u[(k * ny + j) * (nx + 1) + i] = ref.east * profile(agl);
      }
    }
  }

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (solidAt(mesh, i, j - 1, k) || solidAt(mesh, i, j, k)) continue;
        const a = insideAt(mesh, i, j - 1, k) ? heightAgl(mesh, i, j - 1, k) : NaN;
        const b = insideAt(mesh, i, j, k) ? heightAgl(mesh, i, j, k) : NaN;
        const agl = Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2
          : (Number.isFinite(a) ? a : b);
        v[(k * (ny + 1) + j) * nx + i] = ref.north * profile(agl);
      }
    }
  }

  return { u: u, v: v, w: w, reference: ref };
}

/** East/north in m/s, from either spelling. Meteorological "from" bearing. */
function readWind(wind) {
  if (!wind) throw fail("no-wind", "a reference wind is required");
  if (typeof wind.speedMps === "number" && typeof wind.fromDeg === "number") {
    if (!(wind.speedMps >= 0)) throw fail("bad-wind", "speedMps must not be negative");
    const towards = toRad(wind.fromDeg + 180);
    return {
      speedMps: wind.speedMps,
      fromDeg: ((wind.fromDeg % 360) + 360) % 360,
      east: wind.speedMps * Math.sin(towards),
      north: wind.speedMps * Math.cos(towards)
    };
  }
  if (typeof wind.east === "number" && typeof wind.north === "number") {
    const speed = Math.hypot(wind.east, wind.north);
    let from = toDeg(Math.atan2(-wind.east, -wind.north));
    if (from < 0) from += 360;
    return { speedMps: speed, fromDeg: from, east: wind.east, north: wind.north };
  }
  throw fail("bad-wind", "give a wind as {speedMps, fromDeg} or {east, north} in m/s");
}

/**
 * How much mass each cell is creating, per second.
 *
 * Exact on this mesh: the faces a cell owns are the faces its neighbours own,
 * so what leaves one enters the next and nothing is lost to interpolation. A
 * blocked cell reads zero because every face it touches is zero.
 */
function divergence(mesh, f) {
  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
  const out = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (mesh.blocked[cellAt(mesh, i, j, k)]) continue;
        const du = f.u[(k * ny + j) * (nx + 1) + i + 1] - f.u[(k * ny + j) * (nx + 1) + i];
        const dv = f.v[(k * (ny + 1) + j + 1) * nx + i] - f.v[(k * (ny + 1) + j) * nx + i];
        const dw = f.w[((k + 1) * ny + j) * nx + i] - f.w[(k * ny + j) * nx + i];
        out[cellAt(mesh, i, j, k)] = du / mesh.dx + dv / mesh.dy + dw / mesh.dz;
      }
    }
  }
  return out;
}

/** The largest magnitude in a field, ignoring anything not finite. */
function maxAbs(values) {
  let m = 0;
  for (let i = 0; i < values.length; i++) {
    const a = Math.abs(values[i]);
    if (a > m && Number.isFinite(a)) m = a;
  }
  return m;
}

/**
 * The solve: find the nearest mass-conserving wind to the first guess.
 *
 * Gauss-Seidel with over-relaxation on the multiplier field, then one pass to
 * add its gradient to the velocities. Boundary conditions, which are the whole
 * physics of the thing:
 *
 * - **Ground and any blocked cell: Neumann.** The multiplier's normal gradient
 *   is zero there, which is implemented by leaving that neighbour out of the
 *   stencil entirely. No flux crosses a solid face, so the flow has to go round
 *   or over — this line is where channelling comes from.
 * - **Lid and the four sides: Dirichlet, zero.** The flow is undisturbed far
 *   above and free to enter and leave at the edges. A closed side would make
 *   the domain a wind tunnel and pile the air up against its own boundary.
 *
 * Returns the adjusted field with the divergence before and after, the
 * iterations spent, and whether it converged. **A caller must read
 * `converged`**: an unconverged field still has mass appearing in it, and
 * drawing one is drawing an answer the solver refused to stand behind.
 */
function solve(mesh, f, opts) {
  const o = opts || {};
  const r = o.r === undefined ? DEFAULT_R : o.r;
  if (!(r > 0)) throw fail("bad-r", "r must be positive");
  const omega = o.omega === undefined ? DEFAULT_OMEGA : o.omega;
  if (!(omega > 0 && omega < 2)) throw fail("bad-omega", "omega must be in (0, 2)");
  const tolerance = o.tolerance === undefined ? DEFAULT_TOLERANCE : o.tolerance;
  const maxIterations = o.maxIterations === undefined ? DEFAULT_MAX_ITERATIONS : o.maxIterations;

  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
  const dx2 = mesh.dx * mesh.dx;
  const dy2 = mesh.dy * mesh.dy;
  const dz2 = mesh.dz * mesh.dz;

  const div0 = divergence(mesh, f);
  const before = maxAbs(div0);

  // The residual is judged against the divergence the guess started with, so
  // the bar means "how much of the imbalance is left" rather than a number of
  // 1/s that would move with every domain size and wind speed. A guess that was
  // already mass-consistent — a uniform wind over flat ground — has nothing to
  // normalise against and nothing to do, and converges on the spot.
  const norm = before;
  const P = new Float64Array(nx * ny * nz);
  let iterations = 0;
  let residual = norm > 0 ? 1 : 0;

  for (; iterations < maxIterations && residual > tolerance; iterations++) {
    let worst = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = cellAt(mesh, i, j, k);
          if (mesh.blocked[c]) continue;

          let sum = 0;
          let diag = 0;
          // Six neighbours. Outside the box laterally or above is Dirichlet
          // zero — it contributes to the diagonal and nothing to the sum.
          // Solid, and the floor of the box, are Neumann: left out of both.
          const nb = [
            [i - 1, j, k, 1 / dx2], [i + 1, j, k, 1 / dx2],
            [i, j - 1, k, 1 / dy2], [i, j + 1, k, 1 / dy2],
            [i, j, k - 1, r / dz2], [i, j, k + 1, r / dz2]
          ];
          for (let m = 0; m < 6; m++) {
            const ni = nb[m][0], nj = nb[m][1], nk = nb[m][2], coef = nb[m][3];
            if (insideAt(mesh, ni, nj, nk)) {
              if (mesh.blocked[cellAt(mesh, ni, nj, nk)]) continue;   // Neumann
              sum += coef * P[cellAt(mesh, ni, nj, nk)];
              diag += coef;
            } else if (nk < 0) {
              continue;                                              // the floor: Neumann
            } else {
              diag += coef;                                          // Dirichlet zero
            }
          }
          if (diag === 0) continue;

          // How far this cell is from satisfying the equation, in the units
          // the divergence is already in. Measured before the update, so it is
          // the error being corrected rather than what is left after.
          const err = sum + div0[c] - diag * P[c];
          const size = Math.abs(err);
          if (size > worst) worst = size;
          P[c] += (omega * err) / diag;
        }
      }
    }
    residual = norm > 0 ? worst / norm : 0;
  }

  const u = Float32Array.from(f.u);
  const v = Float32Array.from(f.v);
  const w = Float32Array.from(f.w);

  // This has to mirror the stencil above exactly. Where the solve treated a
  // neighbour as Neumann it added no correction through that face, so the
  // update must add none either; where it was Dirichlet zero, the update reads
  // zero. The floor of the box is the case that is easy to get wrong — it is
  // solid, like the ground, and not an open side.
  const phiAt = function (i, j, k) {
    if (k < 0) return null;                               // the floor: solid
    if (!insideAt(mesh, i, j, k)) return 0;               // open sides and lid
    if (mesh.blocked[cellAt(mesh, i, j, k)]) return null; // solid ground
    return P[cellAt(mesh, i, j, k)];
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const a = phiAt(i - 1, j, k);
        const b = phiAt(i, j, k);
        const idx = (k * ny + j) * (nx + 1) + i;
        if (a === null || b === null) { u[idx] = 0; continue; }
        u[idx] += (b - a) / mesh.dx;
      }
    }
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = phiAt(i, j - 1, k);
        const b = phiAt(i, j, k);
        const idx = (k * (ny + 1) + j) * nx + i;
        if (a === null || b === null) { v[idx] = 0; continue; }
        v[idx] += (b - a) / mesh.dy;
      }
    }
  }
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = phiAt(i, j, k - 1);
        const b = phiAt(i, j, k);
        const idx = (k * ny + j) * nx + i;
        if (a === null || b === null) { w[idx] = 0; continue; }
        w[idx] += (r * (b - a)) / mesh.dz;
      }
    }
  }

  const out = { u: u, v: v, w: w, reference: f.reference };
  const after = maxAbs(divergence(mesh, out));

  return Object.assign(out, {
    iterations: iterations,
    converged: residual <= tolerance,
    residual: residual,
    maxDivergenceBefore: before,
    maxDivergenceAfter: after,
    r: r
  });
}

/**
 * The wind at a column, at a height above that column's ground.
 *
 * Faces are averaged to the cell they bound, and the vertical is interpolated
 * between cell centres. `null` where the column has no terrain or the height
 * asked for is inside it — a hole stays a hole, in the same way `/v1/field`
 * already refuses a cell it could not read.
 */
function windAt(mesh, f, i, j, heightAglM) {
  if (!insideAt(mesh, i, j, 0)) return null;
  const h = mesh.elevation[j * mesh.nx + i];
  if (!Number.isFinite(h) || !(heightAglM >= 0)) return null;

  const z = h + heightAglM;
  const kf = (z - mesh.zMin) / mesh.dz - 0.5;
  const k0 = Math.floor(kf);
  const t = kf - k0;

  const centre = function (k) {
    if (k < 0 || k >= mesh.nz) return null;
    if (mesh.blocked[cellAt(mesh, i, j, k)]) return null;
    const nx = mesh.nx, ny = mesh.ny;
    return {
      east: (f.u[(k * ny + j) * (nx + 1) + i] + f.u[(k * ny + j) * (nx + 1) + i + 1]) / 2,
      north: (f.v[(k * (ny + 1) + j) * nx + i] + f.v[(k * (ny + 1) + j + 1) * nx + i]) / 2,
      up: (f.w[(k * ny + j) * nx + i] + f.w[((k + 1) * ny + j) * nx + i]) / 2
    };
  };

  const a = centre(k0);
  const b = centre(k0 + 1);
  // Above the lid or inside the ground there is nothing to interpolate; one
  // side alone is the honest answer at the edges of the box.
  const pick = a && b
    ? { east: a.east * (1 - t) + b.east * t, north: a.north * (1 - t) + b.north * t, up: a.up * (1 - t) + b.up * t }
    : (a || b);
  if (!pick) return null;

  const speed = Math.hypot(pick.east, pick.north);
  let from = toDeg(Math.atan2(-pick.east, -pick.north));
  if (from < 0) from += 360;
  return { east: pick.east, north: pick.north, up: pick.up, speedMps: speed, fromDeg: from };
}

/** `buildMesh` then `initialField` then `solve`, for a caller with one domain. */
function solveTerrain(terrain, wind, opts) {
  const mesh = buildMesh(terrain, opts);
  const guess = initialField(mesh, wind, opts);
  return { mesh: mesh, field: solve(mesh, guess, opts) };
}

module.exports = {
  DEFAULT_R,
  DEFAULT_OMEGA,
  DEFAULT_TOLERANCE,
  DEFAULT_ROUGHNESS_M,
  buildMesh,
  initialField,
  readWind,
  divergence,
  solve,
  windAt,
  solveTerrain,
  heightAgl
};
