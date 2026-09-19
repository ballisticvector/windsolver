/**
 * A solved place, on disk.
 *
 * **The solver blocks the event loop, so a service must never run it.** Solving
 * the Whittington Center took 7 minutes 28 seconds of synchronous Gauss-Seidel,
 * during which `/healthz` did not answer — not slowly, at all. A saved place has
 * therefore to arrive already solved, and this is the file it arrives in.
 *
 * What it holds is the part that is expensive and the part that cannot be
 * recomputed without the network:
 *
 * - **the elevation grid**, so loading needs no 3DEP read and works offline;
 * - **the two basis fields**, unit east and unit north, which are the solve.
 *
 * What it deliberately does *not* hold is the mesh and the face areas. Those
 * are one pass over the ground each — milliseconds — and storing them would
 * double the file to save nothing. `rebuild` makes them on load.
 *
 * Every wind over the place is then `east * E + north * N` (see `mass.combine`
 * and the superposition test that keeps that true), so one file answers every
 * wind, every direction of fire and every height, immediately.
 *
 * **A file is only valid for the ground and the options it was solved with.**
 * `keyFor` is what says so: the coordinate, the box, the resolution, the mesh
 * options and the stability. A file whose key does not match the request is
 * refused rather than used, because a basis solved over a different box is not
 * a worse answer for this one — it is an answer to another question.
 */

"use strict";

const fs = require("fs");
const zlib = require("zlib");

const mass = require("./mass.js");
const proj = require("./proj.js");

const MAGIC = "WSBASIS1";
// 2 records what the grid was read at and how much it was averaged, so a
// stored basis can be asked whether this code would still make the same grid
// from the same ground. A version 1 file cannot answer that and is refused
// rather than trusted: see `field.gridDisagreement`.
const SCHEMA_VERSION = 2;

function fail(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) Object.assign(err, detail);
  return err;
}

/**
 * What a stored basis is an answer to.
 *
 * Anything that changes the ground or the discretisation belongs here. A
 * mismatch is a refusal: there is no such thing as a nearly-right basis.
 */
function keyFor(spec, options) {
  const o = options || {};
  return [
    "v" + SCHEMA_VERSION,
    Number(spec.lat).toFixed(6),
    Number(spec.lon).toFixed(6),
    "r" + Number(spec.radiusMiles),
    "res" + (spec.targetResolutionM === undefined ? "auto" : Number(spec.targetResolutionM)),
    "L" + (o.layers === undefined ? "d" : o.layers),
    "S" + (o.stretch === undefined ? "d" : o.stretch),
    "R" + (o.r === undefined ? "d" : o.r),
    "M" + (o.maxSlopeDeg === undefined ? "d" : o.maxSlopeDeg)
  ].join("|");
}

/** The flux or velocity arrays a field of this mesh kind carries. */
function fieldKeys(kind) {
  return kind === "terrain-following" ? ["fx", "fy", "fz"] : ["u", "v", "w"];
}

/**
 * Header, then every array back to back, then gzip.
 *
 * A length-prefixed JSON header rather than a second file: one file cannot be
 * half-copied into a state where the arrays and the shape disagree.
 */
function encode(doc) {
  const kind = doc.basis.kind;
  const keys = fieldKeys(kind);
  const arrays = [{ name: "elevation", values: doc.grid.values }];
  for (const side of ["east", "north"]) {
    for (const key of keys) {
      arrays.push({ name: side + "." + key, values: doc.basis[side][key] });
    }
  }

  const header = {
    magic: MAGIC,
    schemaVersion: SCHEMA_VERSION,
    key: doc.key,
    savedAt: new Date().toISOString(),
    location: doc.location || null,
    spec: doc.spec,
    options: doc.options || {},
    dataset: doc.dataset || null,
    filledFrom: doc.filledFrom || null,
    mesh: {
      kind: kind,
      maxSlopeDeg: doc.basis.maxSlopeDeg,
      steepFraction: doc.basis.steepFraction
    },
    solve: {
      converged: doc.basis.east.converged && doc.basis.north.converged,
      iterations: Math.max(doc.basis.east.iterations, doc.basis.north.iterations)
    },
    grid: {
      epsg: doc.grid.crs.epsg,
      width: doc.grid.width,
      height: doc.grid.height,
      transform: doc.grid.transform,
      resolutionM: doc.grid.resolutionM,
      voidFraction: doc.grid.voidFraction,
      // How this grid came to be, so it can be checked later against the code
      // that would make it now. `resolutionM` is what it ended up at;
      // `readResolutionM` is what the pyramid handed back before averaging.
      readResolutionM: doc.readResolutionM === undefined ? null : doc.readResolutionM,
      coarsenedBy: doc.coarsenedBy === undefined ? null : doc.coarsenedBy,
      box: doc.box || null
    },
    arrays: arrays.map(function (a) { return { name: a.name, length: a.values.length }; })
  };

  const headerBuf = Buffer.from(JSON.stringify(header), "utf8");
  const parts = [Buffer.from(MAGIC, "ascii")];
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32LE(headerBuf.length, 0);
  parts.push(lengthBuf, headerBuf);
  for (const a of arrays) {
    const f32 = a.values instanceof Float32Array ? a.values : Float32Array.from(a.values);
    parts.push(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength));
  }
  return zlib.gzipSync(Buffer.concat(parts));
}

function decode(buf) {
  let raw;
  try {
    raw = zlib.gunzipSync(buf);
  } catch (err) {
    throw fail("bad-basis-file", "not a gzipped basis file: " + err.message);
  }
  if (raw.length < MAGIC.length + 4 || raw.toString("ascii", 0, MAGIC.length) !== MAGIC) {
    throw fail("bad-basis-file", "not a basis file: the magic does not match");
  }
  const headerLength = raw.readUInt32LE(MAGIC.length);
  const headerEnd = MAGIC.length + 4 + headerLength;
  let header;
  try {
    header = JSON.parse(raw.toString("utf8", MAGIC.length + 4, headerEnd));
  } catch (err) {
    throw fail("bad-basis-file", "the header is not JSON: " + err.message);
  }
  if (header.schemaVersion !== SCHEMA_VERSION) {
    throw fail("stale-basis", "basis file is schema " + header.schemaVersion +
      " and this build reads " + SCHEMA_VERSION);
  }

  const values = {};
  let at = headerEnd;
  for (const a of header.arrays) {
    const bytes = a.length * 4;
    if (at + bytes > raw.length) {
      throw fail("bad-basis-file", "truncated: " + a.name + " runs past the end of the file");
    }
    // Copied rather than viewed: a view would keep the whole decompressed file
    // alive for the life of the field, and the file is bigger than the arrays.
    values[a.name] = new Float32Array(raw.buffer.slice(
      raw.byteOffset + at, raw.byteOffset + at + bytes));
    at += bytes;
  }
  return { header: header, values: values };
}

/**
 * A decoded file, back into the shape `mass.combine` takes.
 *
 * The mesh and the faces are rebuilt here rather than stored: they are one pass
 * over the ground each and depend on nothing else.
 */
function rebuild(decoded) {
  const h = decoded.header;
  const crs = proj.crsFromEpsg(h.grid.epsg);
  const grid = {
    crs: crs,
    width: h.grid.width,
    height: h.grid.height,
    transform: h.grid.transform,
    resolutionM: h.grid.resolutionM,
    voidFraction: h.grid.voidFraction,
    values: decoded.values.elevation
  };

  // The same spacing the solve was run with: from the grid, at its middle row.
  const spanX = Math.abs(grid.transform.scaleX);
  const spanY = Math.abs(grid.transform.scaleY);
  const metres = crs.kind === "geographic"
    ? null
    : { x: spanX, y: spanY };
  if (!metres) {
    throw fail("unsupported-crs",
      "a stored basis is written on a projected grid; this one is geographic");
  }

  const terrain = {
    width: grid.width, height: grid.height,
    spacingM: metres, elevation: grid.values
  };
  const opts = Object.assign({}, h.options);
  const following = h.mesh.kind === "terrain-following";
  const mesh = following ? mass.buildTerrainMesh(terrain, opts) : mass.buildMesh(terrain, opts);
  const faces = following ? mass.terrainFaces(mesh, opts) : null;

  const keys = fieldKeys(h.mesh.kind);
  const side = function (name) {
    const field = { converged: h.solve.converged, iterations: h.solve.iterations };
    for (const key of keys) field[key] = decoded.values[name + "." + key];
    return field;
  };

  return {
    header: h,
    grid: grid,
    basis: {
      kind: h.mesh.kind,
      maxSlopeDeg: h.mesh.maxSlopeDeg,
      steepFraction: h.mesh.steepFraction,
      mesh: mesh,
      faces: faces,
      east: side("east"),
      north: side("north")
    }
  };
}

function save(path, doc) {
  fs.writeFileSync(path, encode(doc));
}

/** Read and rebuild. `expectKey` refuses a file solved for something else. */
function load(path, expectKey) {
  const decoded = decode(fs.readFileSync(path));
  if (expectKey !== undefined && decoded.header.key !== expectKey) {
    throw fail("stale-basis",
      "this basis was solved for " + decoded.header.key + " and the request is " + expectKey,
      { storedKey: decoded.header.key, wantedKey: expectKey });
  }
  return rebuild(decoded);
}

module.exports = {
  MAGIC,
  SCHEMA_VERSION,
  keyFor,
  fieldKeys,
  encode,
  decode,
  rebuild,
  save,
  load
};
