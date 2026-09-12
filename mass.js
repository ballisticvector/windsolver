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

/* ------------------------------------------------------------------------ *
 * Terrain-following layers, and the flux form the solve really wants
 * ------------------------------------------------------------------------ *
 *
 * Everything above works on a box of equal cells with the ground cut out of it
 * as a staircase. That is exact and it is the oracle, and it has two faults
 * that matter for the product this is aimed at:
 *
 * - **A drawn height is not a height.** `windAt` finds the first open cell
 *   above a column, and on a staircase that cell's centre stands anywhere from
 *   nothing to a whole layer above *that column's* ground. Asking for 10 m over
 *   a map with 300 m of relief returns a different height in every valley and
 *   on every ridge, which is not a thing to draw.
 * - **Stretching in absolute height does not fix it.** Thin layers near the
 *   floor of the box are only near the ground where the ground is the floor.
 *   Over a ridge they are as coarse as before.
 *
 * So the layers follow the terrain: every column carries the same number, each
 * one a fixed fraction of that column's depth, and the fractions are geometric
 * so the lowest are thin. `heightAglM` then means the same thing everywhere,
 * and the 0-3 m layer is resolved on a ridge as well as in a hollow.
 *
 * **The mesh moves, so the solve moves into flux form.** Minimise the weighted
 * change in the flux through each face rather than in the velocity at each
 * cell, subject to the fluxes balancing:
 *
 *     minimise sum over faces of (F - F0)^2 / (2 c)   subject to   sum F = 0
 *     => F = F0 + c (P_above - P_below)
 *     => sum over neighbours of c (P_n - P_c) = -D0
 *
 * with `c = A / d` for a face of area A whose cell centres are d apart, times
 * `r` for the interfaces. That is the same seven-point problem as before — on a
 * box of equal cells the coefficients divide by the volume to give exactly the
 * `1/dx^2` stencil above — but it carries the face **area**, which is what
 * changes when each column has its own thicknesses. Continuity stays exact
 * because what leaves one cell through a face is what enters the next through
 * the same face, whatever shape the face is.
 *
 * **Two things fall out for free, and they are the reason this is worth the
 * rewrite.** There is no staircase, so no spurious step acceleration. And the
 * ground condition stops being "block the cells underneath" and becomes the one
 * line it should be: the flux through the bottom interface is zero. Because
 * that interface slopes, `F = (w - u dz/dx - v dz/dy) dx dy = 0` says the flow
 * is *tangent to the hillside*, which is the physical statement, rather than
 * "no vertical velocity at a flat step".
 */

/**
 * Layer thicknesses, as fractions of a column's depth, thin end first.
 *
 * Geometric with ratio `stretch`. At 20 layers and 1.25 the lowest is 0.24% of
 * the depth — about 2 m in an 800 m column — and the top one is 21%, which is
 * where nothing is happening anyway. `stretch: 1` gives equal layers and is how
 * this mesh is checked against the box above.
 */
function layerFractions(nz, stretch) {
  if (!(nz >= 2)) throw fail("bad-layers", "layers must be at least 2");
  if (!(stretch > 0)) throw fail("bad-stretch", "stretch must be positive");
  const out = new Float64Array(nz);
  let sum = 0;
  for (let k = 0; k < nz; k++) { out[k] = Math.pow(stretch, k); sum += out[k]; }
  for (let k = 0; k < nz; k++) out[k] /= sum;
  return out;
}

/**
 * Above this, a terrain-following solve is not trusted here.
 *
 * Not a property of the atmosphere — a property of this discretisation. See
 * `maxSlopeDeg` on the mesh for what was measured against the oracle.
 */
const DEFAULT_MAX_SLOPE_DEG = 45;

/** The steepest ground between neighbouring columns, and how much is steep. */
function groundSlope(elevation, nx, ny, dx, dy, dead, steepDeg) {
  const limit = Math.tan((steepDeg * Math.PI) / 180);
  let maxTan = 0;
  let steep = 0;
  let counted = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (dead[j * nx + i]) continue;
      const h = elevation[j * nx + i];
      let worst = 0;
      if (i + 1 < nx && !dead[j * nx + i + 1]) {
        worst = Math.max(worst, Math.abs(elevation[j * nx + i + 1] - h) / dx);
      }
      if (j + 1 < ny && !dead[(j + 1) * nx + i]) {
        worst = Math.max(worst, Math.abs(elevation[(j + 1) * nx + i] - h) / dy);
      }
      counted++;
      if (worst > maxTan) maxTan = worst;
      if (worst > limit) steep++;
    }
  }
  return {
    maxDeg: (Math.atan(maxTan) * 180) / Math.PI,
    steepFraction: counted ? steep / counted : 0
  };
}

/**
 * A mesh whose layers follow the ground.
 *
 * The lid is flat at `max(terrain) + topAboveM`, so a column under a ridge is
 * shallower than one in a valley and its layers are thinner in proportion. That
 * is the standard sigma arrangement, and it is what makes "10 m above ground"
 * one surface rather than a different height in every column.
 *
 * A column whose terrain could not be read is **dead**: no cells, and every
 * face it touches carries no flux and takes no correction. A hole stays a hole,
 * the same answer `/v1/field` already gives.
 */
function buildTerrainMesh(terrain, opts) {
  const o = opts || {};
  if (!terrain || !terrain.elevation || !terrain.width || !terrain.height) {
    throw fail("bad-terrain", "an elevation grid with width, height and elevation is required");
  }
  const nx = terrain.width;
  const ny = terrain.height;
  if (terrain.elevation.length !== nx * ny) {
    throw fail("bad-terrain", "elevation must hold width * height values");
  }
  const dx = Number(terrain.spacingM && terrain.spacingM.x);
  const dy = Number(terrain.spacingM && terrain.spacingM.y);
  if (!(dx > 0) || !(dy > 0)) throw fail("bad-spacing", "spacingM.x and spacingM.y must be positive metres");

  let minZ = Infinity;
  let maxZ = -Infinity;
  const dead = new Uint8Array(nx * ny);
  let holes = 0;
  for (let c = 0; c < nx * ny; c++) {
    const z = terrain.elevation[c];
    if (!Number.isFinite(z)) { dead[c] = 1; holes++; continue; }
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minZ)) throw fail("no-terrain", "every cell of the elevation grid is a hole");

  const relief = maxZ - minZ;
  const above = o.topAboveM === undefined ? Math.max(3 * relief, 200) : o.topAboveM;
  if (!(above > 0)) throw fail("bad-top", "topAboveM must be positive");
  const nz = o.layers === undefined ? 20 : o.layers;
  const stretch = o.stretch === undefined ? 1.25 : o.stretch;
  const fractions = layerFractions(nz, stretch);
  const zTop = maxZ + above;

  // Interface heights above each column's own ground: nz + 1 per column, the
  // first always zero because the first interface is the ground itself.
  const agl = new Float32Array(nx * ny * (nz + 1));
  const thickness = new Float32Array(nx * ny * nz);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (dead[c]) continue;
      const depth = zTop - terrain.elevation[c];
      let running = 0;
      for (let k = 0; k < nz; k++) {
        const t = fractions[k] * depth;
        thickness[(k * ny + j) * nx + i] = t;
        running += t;
        agl[((k + 1) * ny + j) * nx + i] = running;
      }
    }
  }

  const slopeStats = groundSlope(terrain.elevation, nx, ny, dx, dy, dead,
    o.steepDeg === undefined ? DEFAULT_MAX_SLOPE_DEG : o.steepDeg);

  return {
    kind: "terrain-following",
    nx: nx, ny: ny, nz: nz,
    dx: dx, dy: dy,
    zTop: zTop,
    zMin: minZ,
    stretch: stretch,
    elevation: terrain.elevation,
    dead: dead,
    holes: holes,
    reliefM: relief,
    thickness: thickness,
    interfaceAgl: agl,
    // The steepest ground in the domain, and how much of it is steep. A
    // terrain-following mesh is skewed in proportion to the slope it follows,
    // and the seven-point stencil this solve uses is diagonal in the computed
    // coordinate — it drops the cross terms, whose size is second order in that
    // skew. Measured against the staircase oracle the two agree to 0.2 deg at
    // 9 deg of slope, 0.4 at 23, 1.8 at 40, and the answer is visibly wrong by
    // 59. So the number travels with the mesh rather than living in a comment.
    maxSlopeDeg: slopeStats.maxDeg,
    steepFraction: slopeStats.steepFraction,
    // The thinnest layer anywhere, which is what decides whether the layer this
    // product is about is resolved at all. A caller drawing 2 m over a mesh
    // whose first layer is 40 m is interpolating inside one cell and should be
    // told so rather than shown a number.
    firstLayerM: (function () {
      let m = Infinity;
      for (let c = 0; c < nx * ny; c++) {
        if (dead[c]) continue;
        const t = thickness[c];
        if (t < m) m = t;
      }
      return Number.isFinite(m) ? m : null;
    })()
  };
}

function tCol(mesh, i, j) { return j * mesh.nx + i; }
function tCell(mesh, i, j, k) { return (k * mesh.ny + j) * mesh.nx + i; }
function tFx(mesh, i, j, k) { return (k * mesh.ny + j) * (mesh.nx + 1) + i; }
function tFy(mesh, i, j, k) { return (k * (mesh.ny + 1) + j) * mesh.nx + i; }
function tFz(mesh, i, j, k) { return (k * mesh.ny + j) * mesh.nx + i; }

function tLive(mesh, i, j) {
  return i >= 0 && j >= 0 && i < mesh.nx && j < mesh.ny && !mesh.dead[tCol(mesh, i, j)];
}
function tInside(mesh, i, j) {
  return i >= 0 && j >= 0 && i < mesh.nx && j < mesh.ny;
}
/**
 * A face with solid on one side, which is not the same as a face on the edge.
 *
 * Off the edge of the domain the air carries on and the face is open; against a
 * column whose terrain could not be read there is no air and no flux. Treating
 * the second like the first lets a hole breathe, which fills it from its
 * neighbours by another name.
 */
function tFaceSolid(mesh, ai, aj, bi, bj) {
  return (tInside(mesh, ai, aj) && mesh.dead[tCol(mesh, ai, aj)])
    || (tInside(mesh, bi, bj) && mesh.dead[tCol(mesh, bi, bj)]);
}

/** Height above that column's ground, at the centre of one of its cells. */
function tCentreAgl(mesh, i, j, k) {
  const lo = mesh.interfaceAgl[(k * mesh.ny + j) * mesh.nx + i];
  const hi = mesh.interfaceAgl[((k + 1) * mesh.ny + j) * mesh.nx + i];
  return (lo + hi) / 2;
}

/** Physical height of an interface, which is the ground plus its own offset. */
function tInterfaceZ(mesh, i, j, k) {
  return mesh.elevation[tCol(mesh, i, j)] + mesh.interfaceAgl[(k * mesh.ny + j) * mesh.nx + i];
}

/**
 * Face areas and the coefficients the solve needs, once per mesh.
 *
 * A vertical face between two columns is as tall as the two layers either side
 * of it average; an interface is flat in plan whatever it does in height, so
 * its area is `dx dy` and the slope enters through the flux rather than the
 * area. `c = A / d` is the same quantity for both, with the interfaces scaled
 * by `r`.
 *
 * A face on the ground, or against a dead column, gets **zero**: no area, no
 * coefficient, no correction. That single value is the whole no-flow-through
 * condition, and it is why nothing downstream needs a special case for it.
 */
function terrainFaces(mesh, opts) {
  const o = opts || {};
  const r = o.r === undefined ? DEFAULT_R : o.r;
  if (!(r > 0)) throw fail("bad-r", "r must be positive");
  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;

  const ax = new Float32Array((nx + 1) * ny * nz);
  const ay = new Float32Array(nx * (ny + 1) * nz);
  const cx = new Float32Array((nx + 1) * ny * nz);
  const cy = new Float32Array(nx * (ny + 1) * nz);
  const cz = new Float32Array(nx * ny * (nz + 1));

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        if (tFaceSolid(mesh, i - 1, j, i, j)) continue;
        const left = tLive(mesh, i - 1, j);
        const right = tLive(mesh, i, j);
        if (!left && !right) continue;
        const tl = left ? mesh.thickness[tCell(mesh, i - 1, j, k)] : 0;
        const tr = right ? mesh.thickness[tCell(mesh, i, j, k)] : 0;
        // A face on the edge of the domain is as tall as the one cell it has.
        const t = left && right ? (tl + tr) / 2 : tl + tr;
        ax[tFx(mesh, i, j, k)] = mesh.dy * t;
        cx[tFx(mesh, i, j, k)] = (mesh.dy * t) / mesh.dx;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (tFaceSolid(mesh, i, j - 1, i, j)) continue;
        const down = tLive(mesh, i, j - 1);
        const up = tLive(mesh, i, j);
        if (!down && !up) continue;
        const td = down ? mesh.thickness[tCell(mesh, i, j - 1, k)] : 0;
        const tu = up ? mesh.thickness[tCell(mesh, i, j, k)] : 0;
        const t = down && up ? (td + tu) / 2 : td + tu;
        ay[tFy(mesh, i, j, k)] = mesh.dx * t;
        cy[tFy(mesh, i, j, k)] = (mesh.dx * t) / mesh.dy;
      }
    }
  }

  const plan = mesh.dx * mesh.dy;
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!tLive(mesh, i, j)) continue;
        // k = 0 is the ground. No flux, no correction, no exception anywhere
        // else in the module.
        if (k === 0) continue;
        const below = mesh.thickness[tCell(mesh, i, j, k - 1)];
        const above = k < nz ? mesh.thickness[tCell(mesh, i, j, k)] : below;
        const d = (below + above) / 2;
        cz[tFz(mesh, i, j, k)] = d > 0 ? (r * plan) / d : 0;
      }
    }
  }

  return { ax: ax, ay: ay, cx: cx, cy: cy, cz: cz, r: r, plan: plan };
}

/**
 * The first guess, as fluxes through the faces of the terrain-following mesh.
 *
 * Horizontal components are the reference wind on a neutral log profile of
 * height above ground, the same one the box above uses and carrying the same
 * caveat: `docs/near-ground-wind.md` records that nothing in this project has
 * tested that profile below 6.1 m.
 *
 * **The interfaces are where the terrain enters.** An interface follows the
 * ground, so its flux is `(w - u dz/dx - v dz/dy) dx dy`, and with `w0 = 0` a
 * horizontal wind over a slope already carries flux through it. That term is
 * the air being driven into the hillside, and it is what the solve turns into
 * flow around and over. Forcing the ground interface to zero is what makes it
 * have to.
 */
function terrainFluxes(mesh, faces, wind, opts) {
  const o = opts || {};
  const ref = readWind(wind);
  const z0 = o.roughnessM === undefined ? DEFAULT_ROUGHNESS_M : o.roughnessM;
  if (!(z0 > 0)) throw fail("bad-roughness", "roughnessM must be positive");
  const refHeight = o.referenceHeightM === undefined ? 10 : o.referenceHeightM;
  if (!(refHeight > z0)) throw fail("bad-height", "referenceHeightM must be above the roughness length");

  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
  const denom = Math.log(refHeight / z0);
  const profile = function (agl) {
    if (!Number.isFinite(agl) || agl <= z0) return 0;
    return Math.log(agl / z0) / denom;
  };

  const fx = new Float32Array((nx + 1) * ny * nz);
  const fy = new Float32Array(nx * (ny + 1) * nz);
  const fz = new Float32Array(nx * ny * (nz + 1));

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const a = faces.ax[tFx(mesh, i, j, k)];
        if (!(a > 0)) continue;
        const left = tLive(mesh, i - 1, j);
        const right = tLive(mesh, i, j);
        const agl = left && right
          ? (tCentreAgl(mesh, i - 1, j, k) + tCentreAgl(mesh, i, j, k)) / 2
          : (left ? tCentreAgl(mesh, i - 1, j, k) : tCentreAgl(mesh, i, j, k));
        fx[tFx(mesh, i, j, k)] = ref.east * profile(agl) * a;
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = faces.ay[tFy(mesh, i, j, k)];
        if (!(a > 0)) continue;
        const down = tLive(mesh, i, j - 1);
        const up = tLive(mesh, i, j);
        const agl = down && up
          ? (tCentreAgl(mesh, i, j - 1, k) + tCentreAgl(mesh, i, j, k)) / 2
          : (down ? tCentreAgl(mesh, i, j - 1, k) : tCentreAgl(mesh, i, j, k));
        fy[tFy(mesh, i, j, k)] = ref.north * profile(agl) * a;
      }
    }
  }

  for (let k = 1; k <= nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!tLive(mesh, i, j)) continue;
        const agl = mesh.interfaceAgl[(k * ny + j) * nx + i];
        const speed = profile(agl);
        // The interface's own slope, centred where both neighbours exist and
        // one-sided at the edge of the domain. A dead neighbour is not a slope
        // of zero, it is no information, so the other side is used alone.
        const east = tLive(mesh, i + 1, j) ? tInterfaceZ(mesh, i + 1, j, k) : null;
        const west = tLive(mesh, i - 1, j) ? tInterfaceZ(mesh, i - 1, j, k) : null;
        const here = tInterfaceZ(mesh, i, j, k);
        const sx = east !== null && west !== null ? (east - west) / (2 * mesh.dx)
          : east !== null ? (east - here) / mesh.dx
            : west !== null ? (here - west) / mesh.dx : 0;
        const north = tLive(mesh, i, j + 1) ? tInterfaceZ(mesh, i, j + 1, k) : null;
        const south = tLive(mesh, i, j - 1) ? tInterfaceZ(mesh, i, j - 1, k) : null;
        const sy = north !== null && south !== null ? (north - south) / (2 * mesh.dy)
          : north !== null ? (north - here) / mesh.dy
            : south !== null ? (here - south) / mesh.dy : 0;
        fz[tFz(mesh, i, j, k)] = -(ref.east * speed * sx + ref.north * speed * sy) * faces.plan;
      }
    }
  }
  // k = 0 stays zero: that is the ground, and the flow is tangent to it.

  return { fx: fx, fy: fy, fz: fz, reference: ref };
}

/** Net outflow from each cell, in cubic metres a second. Exact on this mesh. */
function terrainDivergence(mesh, f) {
  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
  const out = new Float32Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (!tLive(mesh, i, j)) continue;
        out[tCell(mesh, i, j, k)] =
          (f.fx[tFx(mesh, i + 1, j, k)] - f.fx[tFx(mesh, i, j, k)]) +
          (f.fy[tFy(mesh, i, j + 1, k)] - f.fy[tFy(mesh, i, j, k)]) +
          (f.fz[tFz(mesh, i, j, k + 1)] - f.fz[tFz(mesh, i, j, k)]);
      }
    }
  }
  return out;
}

/**
 * The projection, on the terrain-following mesh.
 *
 * Identical in structure to `solve` above and identical in result on a mesh of
 * equal cells — the coefficients divided by a cell's volume are the same
 * seven-point stencil. What differs is that the areas are real, so a face
 * between two columns of different depth carries the right amount.
 */
function solveTerrain2(mesh, faces, f, opts) {
  const o = opts || {};
  const omega = o.omega === undefined ? DEFAULT_OMEGA : o.omega;
  if (!(omega > 0 && omega < 2)) throw fail("bad-omega", "omega must be in (0, 2)");
  const tolerance = o.tolerance === undefined ? DEFAULT_TOLERANCE : o.tolerance;
  const maxIterations = o.maxIterations === undefined ? DEFAULT_MAX_ITERATIONS : o.maxIterations;

  const nx = mesh.nx, ny = mesh.ny, nz = mesh.nz;
  const d0 = terrainDivergence(mesh, f);
  const before = maxAbs(d0);
  const norm = before;

  const P = new Float64Array(nx * ny * nz);
  let iterations = 0;
  let residual = norm > 0 ? 1 : 0;

  for (; iterations < maxIterations && residual > tolerance; iterations++) {
    let worst = 0;
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          if (!tLive(mesh, i, j)) continue;
          const c = tCell(mesh, i, j, k);

          let sum = 0;
          let diag = 0;
          // Six faces. A coefficient of zero is the ground or a dead column and
          // contributes nothing at all; a live face whose neighbour is outside
          // the domain or above the lid contributes to the diagonal with a
          // multiplier of zero beyond it, which is the open boundary.
          const add = function (coef, ni, nj, nk) {
            if (!(coef > 0)) return;
            diag += coef;
            if (nk < 0 || nk >= nz) return;          // through the lid: P = 0
            if (!tLive(mesh, ni, nj)) return;        // past the edge: P = 0
            sum += coef * P[tCell(mesh, ni, nj, nk)];
          };
          add(faces.cx[tFx(mesh, i, j, k)], i - 1, j, k);
          add(faces.cx[tFx(mesh, i + 1, j, k)], i + 1, j, k);
          add(faces.cy[tFy(mesh, i, j, k)], i, j - 1, k);
          add(faces.cy[tFy(mesh, i, j + 1, k)], i, j + 1, k);
          add(faces.cz[tFz(mesh, i, j, k)], i, j, k - 1);
          add(faces.cz[tFz(mesh, i, j, k + 1)], i, j, k + 1);
          if (diag === 0) continue;

          const err = sum + d0[c] - diag * P[c];
          const size = Math.abs(err);
          if (size > worst) worst = size;
          P[c] += (omega * err) / diag;
        }
      }
    }
    residual = norm > 0 ? worst / norm : 0;
  }

  const fx = Float32Array.from(f.fx);
  const fy = Float32Array.from(f.fy);
  const fz = Float32Array.from(f.fz);
  const at = function (i, j, k) {
    if (k < 0 || k >= nz) return 0;
    if (!tLive(mesh, i, j)) return 0;
    return P[tCell(mesh, i, j, k)];
  };

  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const coef = faces.cx[tFx(mesh, i, j, k)];
        if (coef > 0) fx[tFx(mesh, i, j, k)] += coef * (at(i, j, k) - at(i - 1, j, k));
      }
    }
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i < nx; i++) {
        const coef = faces.cy[tFy(mesh, i, j, k)];
        if (coef > 0) fy[tFy(mesh, i, j, k)] += coef * (at(i, j, k) - at(i, j - 1, k));
      }
    }
  }
  for (let k = 0; k <= nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const coef = faces.cz[tFz(mesh, i, j, k)];
        if (coef > 0) fz[tFz(mesh, i, j, k)] += coef * (at(i, j, k) - at(i, j, k - 1));
      }
    }
  }

  const out = { fx: fx, fy: fy, fz: fz, reference: f.reference };
  const after = maxAbs(terrainDivergence(mesh, out));
  return Object.assign(out, {
    iterations: iterations,
    converged: residual <= tolerance,
    residual: residual,
    maxDivergenceBefore: before,
    maxDivergenceAfter: after,
    r: faces.r
  });
}

/**
 * The wind at a column, at a height above *that column's* ground.
 *
 * Which is now a real question with one answer, rather than whatever the
 * staircase happened to leave at that height. Velocities come back out of the
 * fluxes by dividing by the area they crossed, and the vertical is interpolated
 * between the centres of the two layers the height falls between.
 *
 * `null` above the lid, on a dead column, or below the ground.
 */
function terrainWindAt(mesh, faces, f, i, j, heightAglM, opts) {
  if (!tLive(mesh, i, j)) return null;
  if (!(heightAglM >= 0)) return null;
  const o = opts || {};
  const z0 = o.roughnessM === undefined ? DEFAULT_ROUGHNESS_M : o.roughnessM;
  if (!(z0 > 0)) throw fail("bad-roughness", "roughnessM must be positive");
  const nz = mesh.nz;
  const top = mesh.interfaceAgl[(nz * mesh.ny + j) * mesh.nx + i];
  if (heightAglM > top) return null;

  const centre = function (k) {
    if (k < 0 || k >= nz) return null;
    const al = faces.ax[tFx(mesh, i, j, k)];
    const ar = faces.ax[tFx(mesh, i + 1, j, k)];
    const ad = faces.ay[tFy(mesh, i, j, k)];
    const au = faces.ay[tFy(mesh, i, j + 1, k)];
    const east = ((al > 0 ? f.fx[tFx(mesh, i, j, k)] / al : 0)
      + (ar > 0 ? f.fx[tFx(mesh, i + 1, j, k)] / ar : 0)) / 2;
    const north = ((ad > 0 ? f.fy[tFy(mesh, i, j, k)] / ad : 0)
      + (au > 0 ? f.fy[tFy(mesh, i, j + 1, k)] / au : 0)) / 2;
    // The interface flux is the part of the motion that crosses the sloping
    // surface. Adding back what the horizontal wind contributes along that
    // slope recovers a physical vertical velocity, which is the thing worth
    // reporting: over a hillside most of `w` is the air following the ground.
    const through = ((f.fz[tFz(mesh, i, j, k)] + f.fz[tFz(mesh, i, j, k + 1)]) / 2) / faces.plan;
    return { east: east, north: north, through: through, agl: tCentreAgl(mesh, i, j, k) };
  };

  // Below the middle of the lowest layer there is no cell underneath to
  // interpolate against, and returning that cell instead reads the wind too
  // fast in exactly the layer this product is about: with a 5 m first layer a
  // request for 2 m came back as 2.5 m, worth about 6% of speed. Measured in
  // the first CoAgMet run, where it showed up as a mass-consistent candidate
  // gaining 1.059 over ground the solve had left alone.
  //
  // So the solve says what the terrain does, and the log law says what the
  // profile does between the ground and the first cell it resolved. The same
  // profile the guess was built on, carrying the same caveat: nothing in this
  // project has tested it below 6.1 m.
  const firstAgl = tCentreAgl(mesh, i, j, 0);
  if (heightAglM < firstAgl && firstAgl > z0) {
    const base = centre(0);
    if (!base) return null;
    const ratio = heightAglM <= z0 ? 0
      : Math.log(heightAglM / z0) / Math.log(firstAgl / z0);
    // The flux through the ground is zero by construction, so the vertical part
    // goes to zero with the height rather than with the logarithm.
    const lift = firstAgl > 0 ? base.through * (heightAglM / firstAgl) : 0;
    const e = base.east * ratio;
    const n = base.north * ratio;
    let b = toDeg(Math.atan2(-e, -n));
    if (b < 0) b += 360;
    return {
      east: e, north: n, up: lift,
      speedMps: Math.hypot(e, n), fromDeg: b, heightAglM: heightAglM
    };
  }

  let k = 0;
  while (k < nz - 1 && tCentreAgl(mesh, i, j, k) < heightAglM) k++;
  const hi = centre(k);
  const lo = centre(k - 1);
  let pick = hi;
  if (lo && hi && hi.agl > lo.agl && heightAglM < hi.agl) {
    const t = (heightAglM - lo.agl) / (hi.agl - lo.agl);
    const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
    pick = {
      east: lo.east * (1 - clamped) + hi.east * clamped,
      north: lo.north * (1 - clamped) + hi.north * clamped,
      through: lo.through * (1 - clamped) + hi.through * clamped
    };
  }
  if (!pick) return null;

  const speed = Math.hypot(pick.east, pick.north);
  let from = toDeg(Math.atan2(-pick.east, -pick.north));
  if (from < 0) from += 360;
  return {
    east: pick.east, north: pick.north, up: pick.through,
    speedMps: speed, fromDeg: from, heightAglM: heightAglM
  };
}

/** Mesh, faces, guess, solve — for a caller with one domain and one wind. */
function solveFollowing(terrain, wind, opts) {
  const o = opts || {};
  const mesh = buildTerrainMesh(terrain, opts);
  // Refused rather than returned with a caveat. A field that is visibly wrong
  // and carries a warning is still drawn, and a drawn wind is believed.
  const limit = o.maxSlopeDeg === undefined ? DEFAULT_MAX_SLOPE_DEG : o.maxSlopeDeg;
  if (limit !== null && mesh.maxSlopeDeg > limit) {
    throw fail("too-steep",
      "ground reaches " + mesh.maxSlopeDeg.toFixed(1) + " deg, past the " + limit +
      " deg this terrain-following solve is trusted to; use the staircase mesh, " +
      "coarsen the terrain, or pass maxSlopeDeg to override deliberately",
      { maxSlopeDeg: mesh.maxSlopeDeg, limitDeg: limit, steepFraction: mesh.steepFraction });
  }
  const faces = terrainFaces(mesh, opts);
  const guess = terrainFluxes(mesh, faces, wind, opts);
  return { mesh: mesh, faces: faces, guess: guess, field: solveTerrain2(mesh, faces, guess, opts) };
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
  heightAgl,

  // Terrain-following: the mesh the product actually wants, with the box above
  // kept as the oracle it is checked against.
  DEFAULT_MAX_SLOPE_DEG,
  layerFractions,
  groundSlope,
  buildTerrainMesh,
  terrainFaces,
  terrainFluxes,
  terrainDivergence,
  solveTerrain2,
  terrainWindAt,
  solveFollowing
};
