#!/usr/bin/env python3
"""Third-party horizon angles, as a reference for Winstral sheltering.

`derive.shelter` computes Sx: the largest angle above horizontal to any ground
within a search distance along a bearing. With the search distance set past the
edge of the domain that is exactly the *horizon angle*, which is a classical
quantity with independent implementations — Dozier & Frew's, as shipped in
topocalc (USDA-ARS-NWRC, CC0). That closes the one gap left open when the
derivatives landed: sheltering had no reference but our own trigonometry.

Only the four cardinal bearings are written out. topocalc reaches the diagonals
by skewing the raster and interpolating, which is a different sampling scheme
from ray-marching and would compare an interpolation against an interpolation;
along a row or a column both methods land on the pixel centres and there is
nothing left in the difference but the formula.

topocalc is not a runtime or test dependency: this writes a fixture that CI
compares against. Regenerate with

    python3 -m venv /tmp/tcenv && /tmp/tcenv/bin/pip install "numpy<2" "cython<3"
    /tmp/tcenv/bin/pip install topocalc==0.5.0        # needs python3-dev
    /tmp/tcenv/bin/python tools/horizon-reference.py tests/fixtures
"""

import json
import sys

import numpy as np
from topocalc.horizon import horizon

SPACING_M = 10.0

# topocalc's azimuth convention: 0 is south, positive through east.
# Ours is a compass bearing the wind comes *from*, so looking upwind along
# bearing B is topocalc's horizon in the direction B.
BEARINGS = {"north": 180.0, "east": 90.0, "south": 0.0, "west": -90.0}


def bowl_and_walls(n=81):
    """Ground with something to hide behind in every direction.

    A broad bowl, so most cells see rising ground all round, plus one sharp
    wall, so at least one bearing has a horizon that a formula error would
    place at the wrong angle rather than merely at the wrong pixel.
    """
    idx = (np.arange(n) + 0.5) * SPACING_M
    east, north = np.meshgrid(idx, idx[::-1])
    centre = n * SPACING_M / 2.0
    bowl = 0.0006 * ((east - centre) ** 2 + (north - centre) ** 2)
    wall = np.where(np.abs(east - (centre + 200.0)) < 15.0, 60.0, 0.0)
    return bowl + wall


def main(out_dir):
    dem = bowl_and_walls().astype(np.float32)
    dem.tofile(f"{out_dir}/horizon-bowl.dem.f32")

    for name, azimuth in BEARINGS.items():
        # cos of the angle from zenith, which is sin of the angle above
        # horizontal; topocalc clamps at 0, so a cell with nothing but falling
        # ground upwind reads as a flat horizon rather than a negative one.
        hcos = horizon(azimuth, dem.astype(np.float64), SPACING_M)
        angle = np.degrees(np.arcsin(np.clip(hcos, -1.0, 1.0)))
        angle.astype(np.float32).tofile(f"{out_dir}/horizon-bowl.{name}.f32")
        print(f"{name:5s} azimuth {azimuth:6.1f}  horizon {angle.min():.3f}..{angle.max():.3f} deg")

    with open(f"{out_dir}/horizon-reference.json", "w") as fh:
        json.dump({
            "source": "topocalc 0.5.0, topocalc.horizon.horizon (Dozier & Frew 1990)",
            "generator": "tools/horizon-reference.py",
            "width": int(dem.shape[1]),
            "height": int(dem.shape[0]),
            "spacingM": SPACING_M,
            "bearings": BEARINGS,
            "note": "angles are above horizontal, degrees, clamped at zero by topocalc"
        }, fh, indent=2)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "tests/fixtures")
