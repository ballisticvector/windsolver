/**
 * GRIB2 reader for what NOMADS and the HRRR archive actually return.
 *
 * Deliberately narrow. It decodes the messages HRRR is served as — Lambert
 * conformal grids (template 3.30) with simple packing (5.0), complex packing
 * (5.2) or complex packing with spatial differencing (5.3) — and **refuses
 * everything else by name** rather than decoding it approximately. A partial
 * decode of an unexpected packing produces plausible numbers, and a plausible
 * wind field that is wrong is the one output this project cannot ship. If NCEP
 * changes the packing, the error says which template arrived.
 *
 * **The two sources are packed differently, and only one of them is simple.**
 * NOMADS' filter re-encodes what it cuts out, and it writes simple packing;
 * NCEP's own files, which is what the AWS archive mirrors byte for byte, are
 * complex-packed with second-order spatial differencing. So a decoder built
 * against NOMADS alone reads the archive as `unsupported-packing`, which is how
 * this arrived: the same variable, the same cycle, the same grid, and a
 * template number that had never been seen because a proxy had been rewriting
 * it.
 *
 * No network, no files: it takes a Buffer. Fetching lives elsewhere so that
 * every bit of bit-twiddling, projection maths and time arithmetic is testable
 * offline, and so the fixture in tests/ is the only GRIB anyone needs.
 *
 * Verified value-by-value and coordinate-by-coordinate against ecCodes
 * (grib_get_data) on a live 1,883-byte HRRR response; see
 * tests/ingestion.test.js.
 */

"use strict";

const SECTION_END = 8;

// Code table 3.2. HRRR sends 6 — a sphere of 6,371,229 m — and that radius has
// to be the one the projection uses, not a WGS84 mean, or the grid walks by
// tens of metres per cell.
const SPHERE_RADII_M = {
  0: 6367470.0,
  6: 6371229.0,
  8: 6371200.0
};

// Code table 4.4. Only the units that appear in a forecast product; anything
// else is refused rather than assumed to be hours.
const TIME_UNIT_SECONDS = {
  0: 60,
  1: 3600,
  2: 86400,
  13: 1
};

// Code table 4.5, the surfaces this project asks for.
const SURFACE_NAMES = {
  1: "surface",
  103: "heightAboveGround",
  100: "isobaricInhPa",
  101: "meanSea"
};

/**
 * (discipline, category, number) -> the NOMADS variable name.
 *
 * Keyed to match `hrrr.DEFAULT_VARIABLES` on purpose: the thing that was asked
 * for and the thing that came back are then the same string, so a message the
 * request did not ask for is visible instead of being silently renamed.
 */
const PARAMETERS = {
  "0/2/2": "UGRD",
  "0/2/3": "VGRD",
  "0/2/22": "GUST",
  "0/2/30": "FRICV",
  "0/0/0": "TMP",
  "0/3/0": "PRES",
  "0/3/18": "HPBL",
  "0/1/1": "RH",
  "0/3/5": "HGT",
  // Discipline 2 is land surface, and the discipline has to be in the key: the
  // land/sea mask is 2/0/0 and temperature is 0/0/0, so a lookup that assumed
  // discipline 0 would hand back a mask of ones and zeroes labelled TMP.
  //
  // SFCR is the model's own aerodynamic roughness length in metres — what HRRR
  // thinks the ground under a station is like, which was an assumption in this
  // codebase until it was read.
  "2/0/1": "SFCR",
  "2/0/0": "LAND",
  "2/0/4": "VEG"
};

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * GRIB stores signed integers as sign-bit-plus-magnitude, not two's complement.
 * Read -4 as 0xFFFC and the binary scale factor is 65532, which comes out as a
 * wind speed of about 10^19700 rather than as an error.
 */
function readSignedMagnitude(buf, offset, bytes) {
  let raw = 0;
  for (let k = 0; k < bytes; k++) raw = raw * 256 + buf.readUInt8(offset + k);
  const signBit = Math.pow(2, bytes * 8 - 1);
  if (raw >= signBit) return -(raw - signBit);
  return raw;
}

function readUInt(buf, offset, bytes) {
  let raw = 0;
  for (let k = 0; k < bytes; k++) raw = raw * 256 + buf.readUInt8(offset + k);
  return raw;
}

/** Reads `bits` at a time, most significant first, which is how GRIB packs. */
function bitReader(buf, offset) {
  let bitPos = 0;
  return function next(bits) {
    let out = 0;
    for (let k = 0; k < bits; k++) {
      const byte = buf.readUInt8(offset + ((bitPos >> 3) | 0));
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      out = out * 2 + bit;
      bitPos++;
    }
    return out;
  };
}

/**
 * The same reader, but able to say where it is and to skip to the next octet.
 *
 * Complex packing is three arrays and then a bitstream, and each array starts
 * on an octet boundary regardless of where the previous one ended. Reading
 * straight through the padding shifts every group width by a few bits, which
 * decodes into a field of the right shape, the right size and the wrong values.
 */
function bitCursor(buf, offset) {
  let bitPos = 0;
  return {
    read(bits) {
      let out = 0;
      for (let k = 0; k < bits; k++) {
        const at = offset + ((bitPos >> 3) | 0);
        // A section that promises more than it carries has to be named. Left to
        // Buffer this is a RangeError about an offset, which reads as a bug in
        // the decoder rather than as a message that arrived incomplete.
        if (at >= buf.length) {
          throw fail("truncated", "section 7 ends before the packed values it declares");
        }
        const byte = buf.readUInt8(at);
        out = out * 2 + ((byte >> (7 - (bitPos & 7))) & 1);
        bitPos++;
      }
      return out;
    },
    readMany(bits, count, into) {
      const out = into || new Array(count);
      for (let k = 0; k < count; k++) out[k] = this.read(bits);
      return out;
    },
    alignToOctet() {
      bitPos = (bitPos + 7) & ~7;
    },
    bitPosition() {
      return bitPos;
    }
  };
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/** Longitude in -180..180. The repo's convention is west negative; GRIB's is 0..360. */
function normalizeLon(lon) {
  let x = lon;
  while (x > 180) x -= 360;
  while (x < -180) x += 360;
  return x;
}

function splitSections(buf, start) {
  if (buf.length - start < 16) throw fail("truncated", "message header runs past the end of the buffer");
  if (buf.toString("ascii", start, start + 4) !== "GRIB") {
    throw fail("not-grib", "expected a GRIB message at byte " + start);
  }
  const edition = buf.readUInt8(start + 7);
  if (edition !== 2) throw fail("unsupported-edition", "GRIB edition " + edition + " is not supported; only 2 is");

  const totalLength = Number(buf.readBigUInt64BE(start + 8));
  if (totalLength <= 0 || start + totalLength > buf.length) {
    throw fail("truncated", "message claims " + totalLength + " bytes but only " + (buf.length - start) + " remain");
  }

  if (buf.toString("ascii", start + totalLength - 4, start + totalLength) !== "7777") {
    throw fail("truncated", "message does not end with the 7777 terminator; the bytes are damaged or short");
  }

  const sections = { 0: { offset: start, length: 16 } };
  let p = start + 16;
  const end = start + totalLength - 4;
  while (p < end) {
    const length = buf.readUInt32BE(p);
    const number = buf.readUInt8(p + 4);
    if (length < 5) throw fail("malformed-section", "section " + number + " claims " + length + " bytes");
    if (number === SECTION_END) break;
    sections[number] = { offset: p, length: length };
    p += length;
  }
  return { sections: sections, totalLength: totalLength };
}

function readIdentification(buf, sec) {
  const o = sec.offset;
  return {
    centre: buf.readUInt16BE(o + 5),
    referenceTime: new Date(Date.UTC(
      buf.readUInt16BE(o + 12),
      buf.readUInt8(o + 14) - 1,
      buf.readUInt8(o + 15),
      buf.readUInt8(o + 16),
      buf.readUInt8(o + 17),
      buf.readUInt8(o + 18)
    ))
  };
}

/**
 * Cone constant and scale for a spherical Lambert conformal projection.
 *
 * Secant (two distinct standard parallels) and tangent (Latin1 == Latin2) are
 * different formulae, and the tangent case is a removable singularity in the
 * secant one — HRRR is tangent at 38.5°, so taking the ratio of logarithms
 * there divides zero by zero.
 */
function lambertConstants(grid) {
  const phi1 = toRad(grid.latin1Deg);
  const phi2 = toRad(grid.latin2Deg);
  const n = Math.abs(grid.latin1Deg - grid.latin2Deg) < 1e-9
    ? Math.sin(phi1) * (grid.southPoleProjection ? -1 : 1)
    : Math.log(Math.cos(phi1) / Math.cos(phi2)) /
      Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  const F = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
  return { n: n, F: F };
}

function lambertRho(grid, k, latDeg) {
  return (grid.radiusMeters * k.F) / Math.pow(Math.tan(Math.PI / 4 + toRad(latDeg) / 2), k.n);
}

function lambertForward(grid, k, latDeg, lonDeg) {
  const rho = lambertRho(grid, k, latDeg);
  const rho0 = lambertRho(grid, k, grid.laDDeg);
  const theta = k.n * toRad(normalizeLon(lonDeg - grid.loVDeg));
  return { x: rho * Math.sin(theta), y: rho0 - rho * Math.cos(theta) };
}

function lambertInverse(grid, k, x, y) {
  const rho0 = lambertRho(grid, k, grid.laDDeg);
  const sign = k.n < 0 ? -1 : 1;
  const rho = sign * Math.sqrt(x * x + (rho0 - y) * (rho0 - y));
  const theta = Math.atan2(sign * x, sign * (rho0 - y));
  const lat = toDeg(2 * Math.atan(Math.pow((grid.radiusMeters * k.F) / rho, 1 / k.n)) - Math.PI / 2);
  const lon = normalizeLon(grid.loVDeg + toDeg(theta / k.n));
  return { lat: lat, lon: lon };
}

function readGridDefinition(buf, sec) {
  const o = sec.offset;
  const template = buf.readUInt16BE(o + 12);
  if (template !== 30) {
    throw fail("unsupported-grid", "grid definition template " + template +
      " is not supported; only 30 (Lambert conformal) is");
  }

  const shape = buf.readUInt8(o + 14);
  let radiusMeters = SPHERE_RADII_M[shape];
  if (shape === 1) {
    radiusMeters = readUInt(buf, o + 16, 4) / Math.pow(10, buf.readUInt8(o + 15));
  }
  if (!radiusMeters) {
    throw fail("unsupported-earth", "shapeOfTheEarth " + shape +
      " is not a sphere this decoder knows; the projection would be off by kilometres");
  }

  const scanningMode = buf.readUInt8(o + 64);
  // Flag table 3.4. HRRR sends 0b01000000: +i (west to east), +j (south to
  // north), i consecutive, all rows the same direction. The other fifteen
  // combinations are legal GRIB and would need their own fixture to be worth
  // claiming; a guess here transposes or mirrors the field, which reads as a
  // wind blowing the wrong way rather than as a bug.
  if (scanningMode !== 0x40) {
    throw fail("unsupported-scanning", "scanningMode 0x" + scanningMode.toString(16) +
      " is not supported; only 0x40 (+i, +j, i consecutive) has been verified");
  }

  const grid = {
    template: template,
    ni: readUInt(buf, o + 30, 4),
    nj: readUInt(buf, o + 34, 4),
    lat1Deg: readSignedMagnitude(buf, o + 38, 4) / 1e6,
    lon1Deg: normalizeLon(readSignedMagnitude(buf, o + 42, 4) / 1e6),
    laDDeg: readSignedMagnitude(buf, o + 47, 4) / 1e6,
    loVDeg: normalizeLon(readSignedMagnitude(buf, o + 51, 4) / 1e6),
    dxMeters: readUInt(buf, o + 55, 4) / 1e3,
    dyMeters: readUInt(buf, o + 59, 4) / 1e3,
    latin1Deg: readSignedMagnitude(buf, o + 65, 4) / 1e6,
    latin2Deg: readSignedMagnitude(buf, o + 69, 4) / 1e6,
    southPoleProjection: (buf.readUInt8(o + 63) & 0x80) !== 0,
    // Flag table 3.3 bit 5. Set means u and v are along the *grid*, not along
    // east and north — the single most expensive octet in the file, because a
    // grid-relative wind used as an earth-relative one is wrong by up to the
    // cone angle and looks entirely reasonable.
    windComponentsRelativeToGrid: (buf.readUInt8(o + 46) & 0x08) !== 0,
    radiusMeters: radiusMeters,
    scanningMode: scanningMode
  };

  if (grid.ni <= 0 || grid.nj <= 0) throw fail("malformed-grid", "grid is " + grid.ni + " x " + grid.nj);
  return grid;
}

function readProduct(buf, sec) {
  const o = sec.offset;
  const template = buf.readUInt16BE(o + 7);
  if (template !== 0) {
    throw fail("unsupported-product", "product definition template " + template +
      " is not supported; only 0 (instant at a level) is");
  }
  const unit = buf.readUInt8(o + 17);
  const seconds = TIME_UNIT_SECONDS[unit];
  if (seconds === undefined) {
    throw fail("unsupported-time-unit", "indicatorOfUnitOfTimeRange " + unit + " is not supported");
  }
  const surfaceType = buf.readUInt8(o + 22);
  return {
    category: buf.readUInt8(o + 9),
    number: buf.readUInt8(o + 10),
    forecastSeconds: readUInt(buf, o + 18, 4) * seconds,
    level: {
      type: surfaceType,
      name: SURFACE_NAMES[surfaceType] || String(surfaceType),
      value: readSignedMagnitude(buf, o + 24, 4) / Math.pow(10, buf.readUInt8(o + 23))
    }
  };
}

function readRepresentation(buf, sec) {
  const o = sec.offset;
  const template = buf.readUInt16BE(o + 9);
  if (template !== 0 && template !== 2 && template !== 3) {
    throw fail("unsupported-packing", "data representation template " + template +
      " is not supported; only 0 (simple), 2 (complex) and 3 (complex with spatial " +
      "differencing) are. JPEG2000 (40) and PNG (41) need a decoder this module " +
      "deliberately does not guess at");
  }

  const rep = {
    template: template,
    count: readUInt(buf, o + 5, 4),
    referenceValue: buf.readFloatBE(o + 11),
    binaryScaleFactor: readSignedMagnitude(buf, o + 15, 2),
    decimalScaleFactor: readSignedMagnitude(buf, o + 17, 2),
    bitsPerValue: buf.readUInt8(o + 19)
  };
  if (template === 0) return rep;

  // Templates 5.2 and 5.3, octets 22 onward. Octet n of the section is at
  // offset o + n - 1.
  rep.groupSplittingMethod = buf.readUInt8(o + 21);
  rep.missingValueManagement = buf.readUInt8(o + 22);
  rep.groupCount = readUInt(buf, o + 31, 4);
  rep.groupWidthReference = buf.readUInt8(o + 35);
  rep.groupWidthBits = buf.readUInt8(o + 36);
  rep.groupLengthReference = readUInt(buf, o + 37, 4);
  rep.groupLengthIncrement = buf.readUInt8(o + 41);
  rep.lastGroupLength = readUInt(buf, o + 42, 4);
  rep.groupLengthBits = buf.readUInt8(o + 46);
  rep.spatialDifferencingOrder = template === 3 ? buf.readUInt8(o + 47) : 0;
  rep.extraDescriptorOctets = template === 3 ? buf.readUInt8(o + 48) : 0;

  // Splitting method 1 is "the encoder chose the groups for you and did not say
  // how", which is the only one NCEP writes. Method 0 is a row-per-group scheme
  // whose descriptors live somewhere else entirely.
  if (rep.groupSplittingMethod !== 1) {
    throw fail("unsupported-packing", "groupSplittingMethod " + rep.groupSplittingMethod +
      " is not supported; only 1 (general group splitting) has been verified");
  }
  // A substituted missing value is a real number standing in for a hole. Decoding
  // one as data puts a plausible reading where there is none, which is the same
  // failure as filling a terrain void with zero.
  if (rep.missingValueManagement !== 0) {
    throw fail("unsupported-packing", "missingValueManagement " + rep.missingValueManagement +
      " is not supported; this decoder does not carry substituted missing values");
  }
  // NCEP writes second order and nothing else, and second order is the only one
  // that can be graded here: ecCodes will re-encode a message as first order on
  // request, but the message it writes declares the order with no extra
  // descriptor octets and ecCodes then reads its own output back as a field
  // diverging quadratically to -4.9e5. An ungraded branch in a decoder is the
  // thing this module exists not to have, so first order is named and refused
  // until a real message and a trustworthy reading of it turn up together.
  if (template === 3 && rep.spatialDifferencingOrder !== 2) {
    throw fail("unsupported-packing", "orderOfSpatialDifferencing " + rep.spatialDifferencingOrder +
      " is not supported; only second order has been graded against ecCodes");
  }
  return rep;
}

/**
 * Section 6. `null` means every point has a value; otherwise a boolean per
 * point, and a false one is a genuine hole that must stay a hole. Filling it
 * with a reference value puts a calm patch in the middle of a wind field.
 */
function readBitmap(buf, sec, count) {
  if (!sec) return null;
  const indicator = buf.readUInt8(sec.offset + 5);
  if (indicator === 255) return null;
  if (indicator !== 0) {
    throw fail("unsupported-bitmap", "bitMapIndicator " + indicator +
      " refers to a pre-defined bitmap this decoder does not carry");
  }
  const next = bitReader(buf, sec.offset + 6);
  const present = new Array(count);
  for (let k = 0; k < count; k++) present[k] = next(1) === 1;
  return present;
}

function unpack(buf, dataSec, rep, bitmap, pointCount) {
  const scale = Math.pow(2, rep.binaryScaleFactor) / Math.pow(10, rep.decimalScaleFactor);
  const reference = rep.referenceValue / Math.pow(10, rep.decimalScaleFactor);
  const values = new Array(pointCount);

  // bitsPerValue 0 is legal and means a constant field: every point is the
  // reference value, and section 7 carries no data at all.
  const next = rep.bitsPerValue > 0 ? bitReader(buf, dataSec.offset + 5) : null;

  let packedIndex = 0;
  for (let k = 0; k < pointCount; k++) {
    if (bitmap && !bitmap[k]) {
      values[k] = null;
      continue;
    }
    if (packedIndex >= rep.count && rep.bitsPerValue > 0) {
      throw fail("truncated", "section 7 ran out of values at point " + k);
    }
    values[k] = rep.bitsPerValue > 0 ? reference + next(rep.bitsPerValue) * scale : reference;
    packedIndex++;
  }
  return values;
}

/**
 * Complex packing, templates 5.2 and 5.3.
 *
 * The field is cut into groups; each group carries its own reference value and
 * its own bit width, so a calm patch costs two bits a point while a jet costs
 * twelve. Section 7 is then: the spatial-differencing seed values, the group
 * references, the group widths, the group lengths, and finally the values —
 * with the first four each starting on an octet boundary.
 *
 * Spatial differencing stores the field as differences of differences, which is
 * why the first one or two values are carried outside the bitstream: they are
 * the initial conditions of a recurrence, and the packed stream reserves
 * positions for them that hold nothing.
 *
 * Graded value-for-value against ecCodes on a real NCEP message; see
 * tests/grib2-complex.test.js.
 */
function unpackComplex(buf, dataSec, rep, bitmap, pointCount) {
  const cursor = bitCursor(buf, dataSec.offset + 5);
  const order = rep.spatialDifferencingOrder;

  // The seeds and the minimum difference are whole octets each, signed as
  // sign-and-magnitude like every other signed integer in GRIB.
  const seeds = [];
  let differenceMinimum = 0;
  if (order > 0) {
    const bytes = rep.extraDescriptorOctets;
    if (!(bytes > 0)) {
      throw fail("malformed-section", "spatial differencing of order " + order +
        " with no extra descriptor octets: the seeds of the recurrence are not in the message");
    }
    for (let k = 0; k < order; k++) seeds.push(cursor.read(bytes * 8));
    const raw = cursor.read(bytes * 8);
    const signBit = Math.pow(2, bytes * 8 - 1);
    differenceMinimum = raw >= signBit ? -(raw - signBit) : raw;
  }

  const groups = rep.groupCount;
  const references = cursor.readMany(rep.bitsPerValue, groups);
  cursor.alignToOctet();
  const widths = cursor.readMany(rep.groupWidthBits, groups);
  cursor.alignToOctet();
  const lengths = cursor.readMany(rep.groupLengthBits, groups);
  cursor.alignToOctet();

  const packed = new Float64Array(rep.count);
  let written = 0;
  for (let g = 0; g < groups; g++) {
    const width = rep.groupWidthReference + widths[g];
    const length = g === groups - 1
      ? rep.lastGroupLength
      : rep.groupLengthReference + lengths[g] * rep.groupLengthIncrement;
    if (written + length > rep.count) {
      throw fail("truncated", "group " + g + " runs past the " + rep.count + " values the section declares");
    }
    // Width 0 is a group whose points are all its reference value — a flat patch
    // costs nothing, which is most of why complex packing is worth the trouble.
    if (width === 0) {
      for (let k = 0; k < length; k++) packed[written + k] = references[g];
    } else {
      for (let k = 0; k < length; k++) packed[written + k] = references[g] + cursor.read(width);
    }
    written += length;
  }
  if (written !== rep.count) {
    throw fail("truncated", "the groups describe " + written + " values but the section declares " + rep.count);
  }

  // The seeds overwrite the first two positions rather than being inserted: the
  // bitstream carries entries for them, and those entries hold nothing.
  if (order === 2) {
    packed[0] = seeds[0];
    packed[1] = seeds[1];
    for (let k = 2; k < rep.count; k++) {
      packed[k] += differenceMinimum + 2 * packed[k - 1] - packed[k - 2];
    }
  }

  const scale = Math.pow(2, rep.binaryScaleFactor) / Math.pow(10, rep.decimalScaleFactor);
  const reference = rep.referenceValue / Math.pow(10, rep.decimalScaleFactor);
  const values = new Array(pointCount);
  let packedIndex = 0;
  for (let k = 0; k < pointCount; k++) {
    if (bitmap && !bitmap[k]) {
      values[k] = null;
      continue;
    }
    if (packedIndex >= rep.count) throw fail("truncated", "section 7 ran out of values at point " + k);
    values[k] = reference + packed[packedIndex] * scale;
    packedIndex++;
  }
  return values;
}

/**
 * Latitude and longitude of every grid point, in the order the values arrive.
 *
 * Computed from the projection rather than interpolated between corners: a
 * Lambert grid is equally spaced in projected metres and not in degrees, so
 * interpolating longitudes puts the far corner hundreds of metres out.
 */
function gridCoordinates(grid) {
  const k = lambertConstants(grid);
  const origin = lambertForward(grid, k, grid.lat1Deg, grid.lon1Deg);
  const latitudes = new Array(grid.ni * grid.nj);
  const longitudes = new Array(grid.ni * grid.nj);
  for (let j = 0; j < grid.nj; j++) {
    for (let i = 0; i < grid.ni; i++) {
      const p = lambertInverse(grid, k, origin.x + i * grid.dxMeters, origin.y + j * grid.dyMeters);
      latitudes[j * grid.ni + i] = p.lat;
      longitudes[j * grid.ni + i] = p.lon;
    }
  }
  return { latitudes: latitudes, longitudes: longitudes };
}

/**
 * True bearing of the grid's +j axis at a longitude, in degrees.
 *
 * On a Lambert grid, "up the grid" is only true north on the reference
 * meridian; the error grows with the cone constant, which is why a
 * grid-relative wind cannot just be relabelled.
 */
function gridNorthBearingDeg(grid, lonDeg) {
  const k = lambertConstants(grid);
  return k.n * normalizeLon(lonDeg - grid.loVDeg);
}

/**
 * Rotate a grid-relative wind into east/north components.
 *
 * `resolutionAndComponentFlags` bit 5 says whether this is needed, and HRRR
 * sets it. Skipping it leaves a wind that is wrong by the grid convergence —
 * a few degrees over CONUS, which is a real windage error and no warning.
 */
function toEarthRelativeWind(grid, lonDeg, uGrid, vGrid) {
  const beta = toRad(gridNorthBearingDeg(grid, lonDeg));
  return {
    east: uGrid * Math.cos(beta) + vGrid * Math.sin(beta),
    north: -uGrid * Math.sin(beta) + vGrid * Math.cos(beta)
  };
}

/**
 * Decode every message in a buffer.
 *
 * Throws on the first message it cannot decode, rather than skipping it: a
 * missing u-component silently dropped from a field is a wind with no easting.
 */
function decode(buffer) {
  if (!Buffer.isBuffer(buffer)) throw fail("not-grib", "expected a Buffer");
  if (buffer.length === 0) throw fail("not-grib", "buffer is empty");
  if (buffer.toString("ascii", 0, 4) !== "GRIB") {
    const head = buffer.toString("ascii", 0, Math.min(buffer.length, 200)).trim();
    // NOMADS answers an invalid request with an HTML error page and HTTP 200,
    // so this is the normal shape of a failed fetch, not an exotic case.
    const looksHtml = /^<(!doctype|html)/i.test(head);
    throw fail("not-grib", looksHtml
      ? "response is an HTML page, not GRIB — NOMADS reports a bad request this way with HTTP 200: " + head.slice(0, 120)
      : "buffer does not start with the GRIB magic; first bytes: " + JSON.stringify(head.slice(0, 40)));
  }

  const records = [];
  let offset = 0;
  while (offset < buffer.length) {
    // Trailing whitespace or a short tail is not a message; anything longer is.
    if (buffer.length - offset < 16) break;
    const { sections, totalLength } = splitSections(buffer, offset);
    for (const required of [1, 3, 4, 5, 7]) {
      if (!sections[required]) throw fail("malformed-section", "message is missing section " + required);
    }

    const ident = readIdentification(buffer, sections[1]);
    const grid = readGridDefinition(buffer, sections[3]);
    const product = readProduct(buffer, sections[4]);
    const rep = readRepresentation(buffer, sections[5]);
    const pointCount = grid.ni * grid.nj;
    const bitmap = readBitmap(buffer, sections[6], pointCount);
    const values = rep.template === 0
      ? unpack(buffer, sections[7], rep, bitmap, pointCount)
      : unpackComplex(buffer, sections[7], rep, bitmap, pointCount);
    const coords = gridCoordinates(grid);
    // The discipline is in section 0, and it is part of the parameter's identity:
    // 0/0/1 is virtual temperature and 2/0/1 is the surface roughness length.
    // Assuming discipline 0 renames one as the other and nothing looks wrong.
    const discipline = buffer.readUInt8(offset + 6);
    const key = discipline + "/" + product.category + "/" + product.number;

    records.push({
      parameter: PARAMETERS[key] || key,
      level: product.level,
      referenceTime: ident.referenceTime,
      validTime: new Date(ident.referenceTime.getTime() + product.forecastSeconds * 1000),
      forecastSeconds: product.forecastSeconds,
      centre: ident.centre,
      discipline: discipline,
      category: product.category,
      number: product.number,
      grid: grid,
      latitudes: coords.latitudes,
      longitudes: coords.longitudes,
      values: values
    });

    offset += totalLength;
  }

  if (records.length === 0) throw fail("not-grib", "no complete GRIB message was found");
  return records;
}

module.exports = {
  PARAMETERS,
  SPHERE_RADII_M,
  decode,
  gridCoordinates,
  gridNorthBearingDeg,
  toEarthRelativeWind,
  normalizeLon,
  lambertConstants,
  lambertForward,
  lambertInverse
};
