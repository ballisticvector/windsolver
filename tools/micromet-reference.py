#!/usr/bin/env python3
"""Reference MicroMet downscaling, written from the paper, in numpy.

This exists so `downscale.js` is graded against something other than its own
arithmetic. It is a *second implementation* — same author, different language,
written from Liston & Elder (2006) equations 15-19 rather than by translating
the JavaScript — not a third-party model. Where a third-party implementation
exists it is used instead: `tools/horizon-reference.py` grades the sheltering
against topocalc, and `tools/make-cog-fixtures.sh` grades slope and aspect
against GDAL.

The synthetic DEMs are written out alongside the answers so both sides read
exactly the same elevations; nothing is regenerated independently on the JS
side, which would only add a second chance to disagree about a pixel centre.

Usage:
    python3 tools/micromet-reference.py tests/fixtures
"""

import json
import sys

import numpy as np

SPACING_M = 10.0
# Shorter than SnowModel's 500 m default only so the fixtures stay small: at
# 10 m pixels a 500 m rose needs a 100-cell margin before anything is defined.
CURVATURE_LENGTH_M = 300.0
GAMMA_S = 0.5
GAMMA_C = 0.5


def gaussian_hill(n=81, height=200.0, sigma=100.0):
    """One smooth hill in the middle of the domain."""
    idx = (np.arange(n) + 0.5) * SPACING_M
    east, north = np.meshgrid(idx, idx[::-1])
    centre = n * SPACING_M / 2.0
    r2 = (east - centre) ** 2 + (north - centre) ** 2
    return height * np.exp(-r2 / (2.0 * sigma ** 2))


def ridge_and_rocks(n=81):
    """A ridge running north-south, with metre-scale roughness on top of it.

    The point of this one is the length scale: the rocks dominate a 3x3
    curvature and are invisible to a few-hundred-metre one.
    """
    idx = (np.arange(n) + 0.5) * SPACING_M
    east, north = np.meshgrid(idx, idx[::-1])
    centre = n * SPACING_M / 2.0
    ridge = 150.0 * np.exp(-((east - centre) ** 2) / (2.0 * 120.0 ** 2))
    rocks = 1.5 * np.sin(east / 13.0) * np.cos(north / 11.0)
    return ridge + rocks


def horn(dem, dx, dy):
    """Slope in degrees and downhill aspect in degrees, Horn's 3x3."""
    slope = np.full(dem.shape, np.nan)
    aspect = np.full(dem.shape, np.nan)
    rows, cols = dem.shape
    for r in range(1, rows - 1):
        for c in range(1, cols - 1):
            w = dem[r - 1:r + 2, c - 1:c + 2]
            gx = ((w[0, 2] + 2 * w[1, 2] + w[2, 2]) - (w[0, 0] + 2 * w[1, 0] + w[2, 0])) / (8 * dx)
            gy = ((w[0, 0] + 2 * w[0, 1] + w[0, 2]) - (w[2, 0] + 2 * w[2, 1] + w[2, 2])) / (8 * dy)
            slope[r, c] = np.degrees(np.arctan(np.hypot(gx, gy)))
            if gx == 0 and gy == 0:
                continue
            aspect[r, c] = np.degrees(np.arctan2(-gx, -gy)) % 360.0
    return slope, aspect


def bilinear(dem, px, py):
    """Elevation at a fractional pixel (column, row), NaN outside."""
    rows, cols = dem.shape
    if not (0 <= px <= cols - 1 and 0 <= py <= rows - 1):
        return np.nan
    x0 = min(cols - 2, int(np.floor(px)))
    y0 = min(rows - 2, int(np.floor(py)))
    fx = px - x0
    fy = py - y0
    top = dem[y0, x0] * (1 - fx) + dem[y0, x0 + 1] * fx
    bot = dem[y0 + 1, x0] * (1 - fx) + dem[y0 + 1, x0 + 1] * fx
    return top * (1 - fy) + bot * fy


def scale_curvature(dem, length_m, spacing=SPACING_M):
    """Liston & Elder eq. 17: mean of four opposing pairs, eta metres out."""
    eta = length_m / 2.0
    diag = eta / np.sqrt(2.0)
    e = eta / spacing
    d = diag / spacing
    pairs = [(0, -e, 0, e), (-e, 0, e, 0), (-d, -d, d, d), (d, -d, -d, d)]
    rows, cols = dem.shape
    out = np.full(dem.shape, np.nan)
    for r in range(rows):
        for c in range(cols):
            total = 0.0
            ok = True
            for ax, ay, bx, by in pairs:
                a = bilinear(dem, c + ax, r + ay)
                b = bilinear(dem, c + bx, r + by)
                if np.isnan(a) or np.isnan(b):
                    ok = False
                    break
                total += (dem[r, c] - (a + b) / 2.0) / (2.0 * eta)
            if ok:
                out[r, c] = total / 4.0
    return out


def downscale(dem, speed_mps, from_deg, length_m=CURVATURE_LENGTH_M):
    slope, aspect = horn(dem, SPACING_M, SPACING_M)
    curv = scale_curvature(dem, length_m)

    max_curv = np.nanmax(np.abs(curv)) if np.any(~np.isnan(curv)) else 0.0
    omega_c = curv / (2 * max_curv) if max_curv > 0 else np.zeros_like(curv)

    max_slope = np.radians(np.nanmax(np.abs(slope)))
    theta = np.radians(from_deg)
    slope_rad = np.radians(slope)
    aspect_rad = np.radians(aspect)

    along = np.where(np.isnan(aspect_rad), 0.0, slope_rad * np.cos(theta - aspect_rad))
    omega_s = along / (2 * max_slope) if max_slope > 0 else np.zeros_like(along)

    factor = 1 + GAMMA_S * omega_s + GAMMA_C * omega_c
    divert = np.where(np.isnan(aspect_rad), 0.0, -0.5 * omega_s * np.sin(2 * (aspect_rad - theta)))

    # A cell without a slope or without a curvature has no answer at all.
    undefined = np.isnan(slope_rad) | np.isnan(omega_c)
    factor = np.where(undefined, np.nan, factor)
    divert = np.where(undefined, np.nan, divert)

    speed = factor * speed_mps
    direction = np.degrees(theta + divert) % 360.0
    return {
        "slopeDeg": slope,
        "aspectDeg": aspect,
        "curvature": curv,
        "omegaC": np.where(np.isnan(curv), np.nan, omega_c),
        "factor": factor,
        "speedMps": speed,
        "fromDeg": direction,
        "divertDeg": np.degrees(divert),
        "maxCurvature": float(max_curv),
        "maxSlopeDeg": float(np.degrees(max_slope)),
    }


CASES = [
    ("hill", gaussian_hill, 8.0, 270.0, CURVATURE_LENGTH_M),
    ("hill-se", gaussian_hill, 5.0, 135.0, CURVATURE_LENGTH_M),
    ("ridge", ridge_and_rocks, 12.0, 250.0, CURVATURE_LENGTH_M),
    ("ridge-short", ridge_and_rocks, 12.0, 250.0, 30.0),
]


def main(out_dir):
    index = []
    for name, build, speed, from_deg, length in CASES:
        dem = build().astype(np.float32)
        ref = downscale(dem.astype(np.float64), speed, from_deg, length)
        stem = "micromet-" + name
        dem.tofile(f"{out_dir}/{stem}.dem.f32")
        for field in ("curvature", "factor", "fromDeg"):
            ref[field].astype(np.float32).tofile(f"{out_dir}/{stem}.{field}.f32")
        index.append({
            "name": name,
            "width": int(dem.shape[1]),
            "height": int(dem.shape[0]),
            "spacingM": SPACING_M,
            "curvatureLengthM": length,
            "speedMps": speed,
            "fromDeg": from_deg,
            "gammaSlope": GAMMA_S,
            "gammaCurvature": GAMMA_C,
            "maxCurvature": ref["maxCurvature"],
            "maxSlopeDeg": ref["maxSlopeDeg"],
        })
        print(f"{name}: factor {np.nanmin(ref['factor']):.3f}..{np.nanmax(ref['factor']):.3f}, "
              f"divert {np.nanmin(ref['divertDeg']):.2f}..{np.nanmax(ref['divertDeg']):.2f} deg")

    with open(f"{out_dir}/micromet-reference.json", "w") as fh:
        json.dump({
            "source": "Liston & Elder (2006), MicroMet, eqs 15-19",
            "generator": "tools/micromet-reference.py",
            "cases": index
        }, fh, indent=2)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
